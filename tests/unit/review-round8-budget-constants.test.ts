import { describe, expect, it } from "vitest";
import { detectSecretKinds, redactSecrets, setWorkBudget } from "../../src/domain/redaction.js";

/**
 * Review round 8 (test adequacy P2, tests only): constants of the round-7 redactor that no test pinned on both sides. The paren group reader is bounded by 1,024 characters
 * (a longer group is read as a plain word), closers glued behind a group belong to it in any order, the work budget is 64 counted steps per character plus 65,536
 * (one hostile shape is refused whole at the default and scanned when the budget is 4096 per character or when the floor is 1,024 it is refused earlier), and every kind of
 * secret that does not need a random-looking value is still reported by the validator when the value holds no digit. Fake secrets are assembled at run time.
 */

const T = "Sunshine99Tail";
const defaultBudget = (): void => setWorkBudget(64, 65_536);

describe("R8 (test adequacy P2-a): the paren group reader is bounded by 1,024 characters", () => {
  const group = (length: number): string => `(${"a b ".repeat(Math.ceil(length / 4)).slice(0, length - 2)})`;
  it.each([10, 64, 65, 66, 1000, 1023, 1024])("a group of %i characters with blanks inside, and a word glued behind it, is hidden whole", (length) => {
    expect(group(length).length).toBe(length);
    expect(redactSecrets(`password=${group(length)}${T}`)).toBe("password=[REDACTED]");
  });
  it.each([1025, 1100, 2000])("a group of %i characters is longer than the bound: read as a plain word, the tail behind the group stays readable (pinned limit)", (length) => {
    expect(group(length).length).toBe(length);
    expect(redactSecrets(`password=${group(length)}${T}`).includes(T)).toBe(true);
  });
  it.each(["(a)])", "{a}])", "[a]})", "(a)]}", "{a}))", "[a]))", "(a)}]", "{a}]}"])("closers %s glued behind a group, in any order, belong to the value", (closers) => {
    for (const key of ["password=", "token:", "--password "]) expect(redactSecrets(`${key}${closers}${T}`).includes(T), `${key}${closers}`).toBe(false);
  });
});

describe("R8 (test adequacy P2-b): the work budget is 64 steps per character and 65,536, pinned on both sides", () => {
  const hostile = (repeats: number): string => "token:(a(b)".repeat(repeats);
  const refused = (text: string): boolean => detectSecretKinds(text)[0] === "oversize";
  it("the default budget refuses a hostile shape whole from 346 repeats and scans it below (by value: 64 per character, floor 65,536)", () => {
    try {
      // (the budget is NOT set here: this test reads the defaults of the module, so that a changed constant is seen; it is the first test of the file to touch the budget)
      expect(refused(hostile(345)), "345 repeats are scanned").toBe(false);
      expect(refused(hostile(346)), "346 repeats are refused whole").toBe(true);
      expect(redactSecrets(hostile(346)), "the whole text is replaced by the marker").toBe("[REDACTED: value too large to scan]");
      expect(redactSecrets(hostile(345)), "below it the shape is scanned (its values are hidden, not the whole text)").not.toBe("[REDACTED: value too large to scan]");
      // the same answers when the two constants are set explicitly: the defaults ARE 64 and 65,536
      setWorkBudget(64, 65_536);
      expect(refused(hostile(345))).toBe(false);
      expect(refused(hostile(346))).toBe(true);
    } finally {
      defaultBudget();
    }
  });
  it("a floor of 1,024 would refuse from 149 repeats and 4096 steps per character would scan 2,000: neither is the default", () => {
    try {
      defaultBudget();
      expect(refused(hostile(200)), "200 repeats are scanned at the default floor").toBe(false);
      expect(refused(hostile(2000)), "2,000 repeats are refused at 64 per character").toBe(true);
      setWorkBudget(64, 1024);
      expect(refused(hostile(200)), "(the smaller floor refuses them: the two constants differ)").toBe(true);
      setWorkBudget(4096, 65_536);
      expect(refused(hostile(2000)), "(a budget of 4096 per character scans them: the two constants differ)").toBe(false);
    } finally {
      defaultBudget();
    }
  });
  it("a credential-rich document of about 100 KB is scanned, not refused: every secret of it is hidden", () => {
    defaultBudget();
    const lines: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < 1400; i += 1) {
      const value = `Zx9Kq2Lm7Pw4R${String(i).padStart(4, "0")}t8Y`;
      values.push(value);
      lines.push(`service_${i}:\n  name: worker-${i}\n  password: ${value}\n  replicas: ${i % 7}\n  note: plain words for line ${i}`);
    }
    const document = lines.join("\n");
    expect(document.length, "about 100 KB").toBeGreaterThan(90_000);
    const out = redactSecrets(document);
    expect(out, "scanned, not refused whole").not.toBe("[REDACTED: value too large to scan]");
    expect(values.filter((value) => out.includes(value)), "every password is hidden").toEqual([]);
    expect(out.includes("plain words for line 1399"), "the rest of the document is kept").toBe(true);
    expect(detectSecretKinds(document)[0]).not.toBe("oversize");
  });
});

describe("R8 (test adequacy P2-c): the validator reports every kind that needs no random-looking value, with a value that holds no digit", () => {
  const cap = (n: number): string => "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2).slice(0, n);
  const low = (n: number): string => "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz".slice(0, n);
  const c = String.fromCharCode;
  const cases: [string, string][] = [
    ["an AWS access key id (AKIA and 16 capitals)", `key ${["AK", "IA"].join("")}${cap(16)} here`],
    ["a GitHub token (ghp_ and 36 letters)", `token ${["gh", "p_"].join("")}${low(36)} here`],
    ["a Slack token (xoxb-)", `token ${["xo", "xb-"].join("")}${low(30)}-${low(24)} here`],
    ["an API key (sk- and letters)", `key ${["s", "k-"].join("")}${low(40)} here`],
    ["URL credentials", `url https://alice:${low(12)}${c(64)}host.example.test/path`.replace(c(64), "@")],
    ["a private key block with an all-letter body", `${["-----BEGIN ", "PRIVATE KEY-----"].join("")}\n${low(40)}\n${low(40)}\n${["-----END ", "PRIVATE KEY-----"].join("")}`],
  ];
  it.each(cases)("%s is reported, not passed", (_label, text) => {
    const kinds = detectSecretKinds(text);
    expect(kinds.length, JSON.stringify(text)).toBeGreaterThan(0);
    expect(kinds[0]).not.toBe("oversize");
    expect(redactSecrets(text), "and redacted").not.toBe(text);
  });
  it("a low-confidence span (an assignment) still needs a random-looking value: a plain word is not a kind", () => {
    expect(detectSecretKinds("password: correcthorse")).toEqual([]);
    expect(detectSecretKinds(`password: ${low(10)}7Zq`).length).toBeGreaterThan(0);
  });
});
