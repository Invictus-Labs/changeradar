import { describe, expect, it } from "vitest";
import { detectSecretKinds, OVERSIZE_REDACTED, redactDeep, redactSecrets, setWorkBudget } from "../../src/domain/redaction.js";

/**
 * Review round 8, security delta (P2): the verbatim-tag lookahead (`!<tag:yaml.org,2002:str>` ends at its `>`) searched to the END of the text for every `!<` start, and
 * the work budget did not count it: `password: !<` repeated cost 0.4 s of CPU at 256 KiB and 4 s at 1 MiB (quadratic), in `redactSecrets`, `detectSecretKinds` and `redactDeep`
 * alike. The search is now bounded to the longest verbatim tag (256 characters from the `!` to the `>`) and counted. A verbatim tag of up to that length is read as before.
 * Fake secrets are assembled at run time. Timing uses CPU time (process.cpuUsage), best of three: a wall-clock overrun under load is never a finding.
 */

const S = ["Zx9K", "q2Lm7Pw4"].join("");
const SHAPE = "password: !<";
const cpuMs = (run: () => unknown): number => {
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
};
const best = (run: () => unknown): number => Math.min(cpuMs(run), cpuMs(run), cpuMs(run));
const repeated = (bytes: number): string => SHAPE.repeat(Math.ceil(bytes / SHAPE.length));

describe("R8 (security P2): the verbatim-tag lookahead is bounded and counted", () => {
  it("`password: !<` repeated to 1 MiB is scanned in linear time (the quadratic form took 4 s of CPU)", () => {
    // (a text that holds this shape densely spends the work budget on its lookaheads and is hidden whole, which is as fast as scanning it: either way it is linear)
    const text = repeated(1_048_576);
    const ms = best(() => redactSecrets(text));
    expect(ms, "CPU milliseconds for 1 MiB").toBeLessThan(1500);
  }, 120_000);

  it("the same shape through detectSecretKinds and redactDeep (the import validator and the object redactor share the scan)", () => {
    const text = repeated(1_048_576);
    expect(best(() => detectSecretKinds(text)), "detectSecretKinds, CPU milliseconds for 1 MiB").toBeLessThan(1500);
    expect(best(() => redactDeep({ a: text })), "redactDeep, CPU milliseconds for 1 MiB").toBeLessThan(1500);
  }, 180_000);

  it("the lookahead is counted against the work budget: a budget of 16 steps per character (floor 1,024) is spent by 1,000 starts of 256 characters", () => {
    const text = SHAPE.repeat(1000);
    try {
      setWorkBudget(16, 1024);
      expect(redactSecrets(text), "the scan gave up and hid the text whole").toBe(OVERSIZE_REDACTED);
    } finally {
      setWorkBudget(64, 65_536);
    }
    // an ordinary document with a verbatim tag on every line spends only the length of each tag, and is scanned in full by the default budget
    const ordinary = `password: !<tag:yaml.org,2002:str> ${S}\n`.repeat(1000);
    const out = redactSecrets(ordinary);
    expect(out, "scanned, not given up on").not.toBe(OVERSIZE_REDACTED);
    expect(out.includes(S), "and every value hidden").toBe(false);
  });

  it("a verbatim tag keeps its behaviour: the tag ends at its `>` (commas and colons inside it), the value behind it is hidden", () => {
    for (const text of [`password: !<tag:yaml.org,2002:str> ${S}`, `password: !<a,b:c> ${S}`, `password:\n  !<tag:yaml.org,2002:str> ${S}`]) {
      const out = redactSecrets(text);
      expect(out.includes(S), out).toBe(false);
    }
  });

  it("the longest verbatim tag is 256 characters from the `!` to the `>`: at that length the value behind it is hidden, one longer is not read as a tag (documented limit)", () => {
    const tag = (bodyLength: number): string => {
      const body = `${"a,".repeat(Math.floor(bodyLength / 2))}${bodyLength % 2 === 1 ? "b" : ""}`;
      return `!<${body}>`;
    };
    expect(tag(254).length - 1, "from the bang to the closing bracket: 256").toBe(256);
    expect(redactSecrets(`password: ${tag(254)} ${S}`).includes(S), "a tag of 256: the value behind it is hidden").toBe(false);
    expect(tag(255).length - 1, "257").toBe(257);
    expect(redactSecrets(`password: ${tag(255)} ${S}`).includes(S), "a tag of 257 is not read as a tag: pinned limit").toBe(true);
    expect(redactSecrets(`password: !<${"x".repeat(5000)} ${S}`).includes(S), "an unclosed tag is an ordinary word: the value behind it is hidden").toBe(false);
  });
});
