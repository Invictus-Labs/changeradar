import { detectSecretKinds, redactDeep, redactIdentifier, redactIdentifiers, redactSecrets, safeReportText } from "../../src/domain/redaction.js";

/**
 * Child-process probe for tests/unit/review-round5-robustness.test.ts: runs the redactor on a corpus and prints one JSON line.
 * The parent kills this process with SIGKILL after a wall-clock limit, so a call that never returns is a failed assertion.
 *
 *   fixed            the ordinary words that were once a hang in a sibling product (key, name, value, header, valueFrom, ...)
 *   random <seed>    100,000 pseudo-random ordinary strings (a per-call time cap, and a fixed point check on every one)
 *   scale <shape>    the time of one shape at 256 KiB and at 4 MiB (best of two each)
 */

const mode = process.argv[2] ?? "fixed";

function fixed(): void {
  const strings = [
    `{"key":"value"}`, `{"name":"value"}`, `{"header":"value"}`, `{"name":"default_value"}`, `{"ParameterKey":"ParameterValue"}`, `{"name":"valueFrom"}`,
    `{"name":"value","value":"x"}`, `{"Name":"Value"}`, `{"key":"key","value":"value"}`, `{"value":"a","name":"b","key":"c","header":"d"}`,
    `name=value value=name`, `name: value, value: name`, `- name: value\n  value: name`, `key=key value=value`, `["name","value"]`, `[["key","value"]]`,
    `{"name":"value","valueFrom":"value"}`, `value: value\nname: name`, `{"ParameterKey":"password","ParameterValue":"value"}`,
  ];
  const results: { text: string; unchanged: boolean }[] = [];
  for (const text of strings) {
    const object = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    })();
    redactSecrets(text);
    redactIdentifier(text);
    detectSecretKinds(text);
    redactDeep(text);
    redactDeep(object);
    redactIdentifiers(object);
    safeReportText(text);
    results.push({ text, unchanged: redactSecrets(text) === text });
  }
  console.log(JSON.stringify({ mode, results }));
}

function random(seed: number): void {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const pick = <T,>(items: readonly T[]): T => items[next() % items.length] as T;
  const words = ["key", "name", "value", "header", "token", "password", "default_value", "valueFrom", "id", "label", "text", "data", "env", "sid", "pin", "secret", "the", "a", "of", "billing", "service", "true", "12", "0", "x"];
  const joins = [": ", "=", "=>", ":=", ", ", "; ", " ", "\n", "\n  ", "\n- ", ":\n  ", "\\n", "%3D", "%26", "\"", "'", "[", "]", "{", "}", "|", ">", "&a ", "!!str ", "# ", "--", "-p=", "ENV "];
  let worst = 0;
  let notFixedPoint = 0;
  for (let n = 0; n < 100_000; n += 1) {
    let text = "";
    const parts = 2 + (next() % 9);
    for (let p = 0; p < parts; p += 1) text += pick(words) + pick(joins);
    const t0 = process.hrtime.bigint();
    const once = redactSecrets(text);
    if (once !== text) {
      const twice = redactSecrets(once);
      if (redactSecrets(twice) !== twice) notFixedPoint += 1;
    }
    redactIdentifier(text);
    detectSecretKinds(text);
    if (n % 10 === 0) {
      redactDeep(text);
      redactDeep({ [pick(words)]: text, [pick(words)]: pick(words), [pick(words)]: [text] });
    }
    worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(JSON.stringify({ mode, seed, worst_ms: worst, not_fixed_point: notFixedPoint }));
}

const SHAPES: Record<string, string> = {
  "pair gap with nested objects": `{"name":"DB_PASSWORD","a":{"b":{"c":1}},"x":[1,2,3],`,
  "bare pairs": "name=password ",
  "value keys with groups": `"value":[`,
  "block scalars": "password: |\n  x\n",
  "block header only": "password: |\n",
  "anchors": "password: &a ",
  "nested flow groups": "password: [[[[[[[[",
  "long flags": "--db-password ",
  "environment lines": "ENV PASSWORD ",
  "comment lines": "password:  # note\n",
  "yaml list pairs": "- name: password\n  value: x\n",
  "backslash runs before a name": `${"\\".repeat(200)}"name":"password",`,
  "one long backslash run": "\\".repeat(4096),
  "percent copy": "%41%3D",
  "percent copy with a credential name": "password%3Dab%26",
  // Round 6: the scan goes on inside a bare value and a block scalar, and a decoded value is read once.
  "decoded separators between keys": "token=%20password=%0A",
  "decoded separators between long words": `token=${"x".repeat(150)}%20password=`,
  "keys inside bare values": "pin: apikey :",
  "one word that is a chain of keys": "password=token=secret=",
  "block scalars ending at a quote": `token:|\\n auth="`,
};

/** Shapes that are ONE long piece (not a unit repeated): a single very long key, the stall of review round 6. */
const WHOLE: Record<string, (bytes: number) => string> = {
  "one long quoted key of credential words then a block scalar": (bytes) => `"${"password".repeat(Math.ceil(bytes / 8))}": |\n  x\n`,
  "one long quoted key of credential words then a value": (bytes) => `"${"token".repeat(Math.ceil(bytes / 5))}": abcdefgh`,
  "one long quoted key of credential words, no value": (bytes) => `"${"secret".repeat(Math.ceil(bytes / 6))}"`,
};

function scale(shape: string): void {
  const unit = SHAPES[shape];
  const whole = WHOLE[shape];
  if (unit === undefined && whole === undefined) throw new Error(`unknown shape ${shape}`);
  const make = (bytes: number): string => (whole !== undefined ? whole(bytes) : (unit as string).repeat(Math.ceil(bytes / (unit as string).length)).slice(0, bytes));
  const best = (bytes: number): number => {
    const text = make(bytes);
    let least = Infinity;
    for (let run = 0; run < 2; run += 1) {
      const t0 = process.hrtime.bigint();
      redactSecrets(text);
      least = Math.min(least, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return least;
  };
  console.log(JSON.stringify({ mode, shape, small_ms: best(256 * 1024), large_ms: best(4 * 1024 * 1024) }));
}

if (mode === "fixed") fixed();
else if (mode === "random") random(Number(process.argv[3] ?? 1));
else if (mode === "scale") scale(process.argv[3] ?? "");
else if (mode === "shapes") console.log(JSON.stringify([...Object.keys(SHAPES), ...Object.keys(WHOLE)]));
