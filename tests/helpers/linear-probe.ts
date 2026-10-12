import { containsSecret, detectSecretKinds, redactDeep, redactIdentifier, redactSecrets, setWorkBudget } from "../../src/domain/redaction.js";

/**
 * Child-process probe for tests/unit/review-round7-linear.test.ts (the parent kills it after a wall-clock limit, so a call that
 * never returns is a failed assertion).
 *
 *   families                 the names of the hostile shapes (each was quadratic before round 7)
 *   scale <family> <n1> <n2> the time of one family at n1 and at n2 characters (best of two each)
 *   chain <repeats>          `Authorization%3AA` then `%0A)` repeated, then a credential with a planted value: time, and whether it is shown
 *   budget <length>          a text that makes many small reads, with the work budget forced tiny by the environment
 */

const S = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const FAMILIES: Record<string, (n: number) => string> = {
  "property run: token:! repeated": (n) => "token:!".repeat(Math.ceil(n / 7)),
  "property run: %20Authorization:! repeated": (n) => "%20Authorization:!".repeat(Math.ceil(n / 18)),
  "property run: Authorization:=!token%20 repeated": (n) => "Authorization:=!token%20".repeat(Math.ceil(n / 24)),
  "value-first pair: value= repeated": (n) => "value=".repeat(Math.ceil(n / 6)),
  "gap comment: ': #%3D[\\\"DB_PASSWORD' repeated": (n) => ": #%3D[\\\"DB_PASSWORD".repeat(Math.ceil(n / 20)),
  "gap comment: ':= #bearerxapi_key' repeated": (n) => ":= #bearerxapi_key".repeat(Math.ceil(n / 18)),
  "block header after =: '#Basic pin=|' repeated": (n) => "#Basic pin=|".repeat(Math.ceil(n / 12)),
  "bare pair scan: 'name: password' and a run of backslashes": (n) => `name: password${"\\".repeat(n)}`,
};

let refused = false;
const time = (text: string): number => {
  let best = Infinity;
  for (let i = 0; i < 2; i += 1) {
    const started = process.hrtime.bigint();
    const out = redactSecrets(text);
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    // A text that the work budget gave up on is hidden whole, and fast: that must not pass for linear scanning of the shape.
    if (out === "[REDACTED: value too large to scan]") refused = true;
  }
  return best;
};

const [mode, a, b, c] = process.argv.slice(2);
if (mode === "families") {
  console.log(JSON.stringify(Object.keys(FAMILIES)));
} else if (mode === "scale") {
  const make = FAMILIES[a as string] as (n: number) => string;
  const small = time(make(Number(b)));
  const large = time(make(Number(c)));
  console.log(JSON.stringify({ small_ms: small, large_ms: large, refused }));
} else if (mode === "chain") {
  const text = `Authorization%3AA${"%0A)".repeat(Number(a))}%0Aclientsecret%3D${S}`;
  const started = process.hrtime.bigint();
  const out = redactSecrets(text);
  console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - started) / 1e6, shown: out.includes(S) }));
} else if (mode === "budget") {
  // The work budget is forced tiny (`b` characters of work per input character and a floor of `c`): the scan must give up and hide the whole text.
  setWorkBudget(Number(b), Number(c));
  const text = `${"token:!".repeat(Number(a))} password=${S} and more text`;
  const out = redactSecrets(text);
  // redacting the result again, with the same tiny budget and with the default one, changes nothing (a fixed point)
  const marker = "[REDACTED: value too large to scan]";
  // every path that reads a text treats it the same way: the import validator's detector says `oversize` (a refusal), the object redactor and the
  // identifier redactor hide it whole
  const kinds = detectSecretKinds(text);
  const contains = containsSecret(text);
  const deep = (redactDeep({ a: text }) as { a: string }).a === marker;
  const identifier = redactIdentifier(text) === marker;
  const twice = redactSecrets(out);
  setWorkBudget(64, 65_536);
  const thrice = redactSecrets(out);
  console.log(JSON.stringify({ length: out.length, hidden_whole: out === marker, shown: out.includes(S), stable: twice === out && thrice === out, kinds, contains, deep, identifier }));
} else if (mode === "consecutive") {
  // two consecutive calls on different texts and a call in between on a third, each compared with the result of a fresh process (no state between calls)
  const texts = [`token:!${"a".repeat(50)} pw=${S}`, `value=${S} name=password`, `token: #${S}\nk: v`, `sid[bearer: #${S}]:'`, `password: &a #${S}`];
  const first = texts.map((t) => redactSecrets(t));
  const reversed = [...texts].reverse().map((t) => redactSecrets(t)).reverse();
  const interleaved = texts.map((t, i) => redactSecrets(`${texts[(i + 1) % texts.length]} ${t}`).includes(S));
  console.log(JSON.stringify({ same: JSON.stringify(first) === JSON.stringify(reversed), none_shown: first.every((o) => !o.includes(S)), interleaved_none_shown: interleaved.every((shown) => !shown) }));
} else if (mode === "budget-default") {
  // The default budget: an ordinary text of about 1 MiB is scanned in full and comes back with its secret hidden.
  const text = `${"ordinary words and numbers 12345 ".repeat(Math.ceil(Number(a) / 32))} password=${S} tail`;
  const out = redactSecrets(text);
  console.log(JSON.stringify({ hidden_whole: out === "[REDACTED: value too large to scan]", shown: out.includes(S), kept: out.startsWith("ordinary words") }));
}
void a;
void b;
void c;
