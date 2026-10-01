import { containsSecret, detectSecretKinds, redactDeep, redactSecrets, setWorkBudget } from "../../src/domain/redaction.js";

/**
 * Child-process probe for tests/unit/review-round7-flag-scaling.test.ts (the parent kills it after a wall-clock limit).
 *
 *   units                 the repeated command-line shapes
 *   scale <index>         for one shape: CPU time of the four entry points at 16,384 and at 262,144 characters (best of three)
 *   budget <kind> <n>     a text of n repeats with the work budget forced tiny: what each entry point answers, and whether the planted value is shown
 */

const S = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const UNITS = [
  "--password=", "--token=", "--secret=", "--api_key=", "-Password=", "--pw=", "-p--password=", "\\n--password%3D", "-p=", "-u=", "=-u", "={-u", "=--user", "--user=", "-u ", "--user ",
  "--password= ", "--password=x ", "-u=x ", "--password=\"", "-p='",
];
const ENTRY_POINTS: Record<string, (text: string) => unknown> = {
  redactSecrets: (text) => redactSecrets(text),
  redactDeep: (text) => redactDeep({ a: text, b: [text] }),
  detectSecretKinds: (text) => detectSecretKinds(text),
  containsSecret: (text) => containsSecret(text),
};

const textOf = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** CPU time, not wall time: a loaded host stretches the wall clock of a child, not the work it does. */
const cpuMs = (run: () => unknown): { ms: number; out: unknown } => {
  const before = process.cpuUsage();
  const out = run();
  const used = process.cpuUsage(before);
  return { ms: (used.user + used.system) / 1000, out };
};
const refusal = (out: unknown): boolean => out === "[REDACTED: value too large to scan]" || (Array.isArray(out) && out[0] === "oversize");

const [mode, a, b] = process.argv.slice(2);
if (mode === "units") {
  console.log(JSON.stringify(UNITS));
} else if (mode === "scale") {
  const unit = UNITS[Number(a)] as string;
  const rows: Record<string, { small: number; large: number; refused: boolean }> = {};
  for (const [name, call] of Object.entries(ENTRY_POINTS)) {
    const best = (size: number): number => {
      const text = textOf(unit, size);
      let low = Infinity;
      for (let i = 0; i < 3; i += 1) low = Math.min(low, cpuMs(() => call(text)).ms);
      return low;
    };
    const small = best(16_384);
    const large = best(262_144);
    rows[name] = { small, large, refused: refusal(call(textOf(unit, 262_144))) };
  }
  console.log(JSON.stringify({ unit, rows }));
} else if (mode === "budget") {
  // Each repeat is a flag that is not a credential flag (`plain`), a declaration of a name that is not a credential (`env`) or the short password flag (`secret`): the budget is forced tiny, so the scan must
  // give up and hide the whole text, whatever the planted value behind the repeats.
  setWorkBudget(0, 100);
  const unit = a === "plain" ? "--a " : a === "env" ? "ENV a " : "-p=";
  const text = `${unit.repeat(Number(b))}password=${S}`;
  const marker = "[REDACTED: value too large to scan]";
  const out = redactSecrets(text);
  const deep = (redactDeep({ a: text }) as { a: string }).a;
  console.log(JSON.stringify({ kinds: detectSecretKinds(text), contains: containsSecret(text), hidden_whole: out === marker, deep_hidden_whole: deep === marker, shown: out.includes(S) || deep.includes(S) }));
}
