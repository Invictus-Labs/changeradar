import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REDACTED, containsSecret, detectSecretKinds, redactDeep, redactSecrets, safeReportText } from "../../src/domain/redaction.js";
import { buildGraph } from "../../src/services/graph.js";
import { ALL_FAKE_SECRETS, BENIGN_LOOKALIKES, REVIEW_ROUND1_SHAPES, SECRET_CORES } from "../helpers/fake-secrets.js";
import { billingManifest, prng } from "../helpers/builders.js";

/**
 * Review round 1 P1 (security, conformance, tests): secret shapes that were accepted at import and served
 * unredacted, plus the linear-time and low-memory requirements for the rewritten redactor.
 */

const probe = fileURLToPath(new URL("../helpers/redact-probe.ts", import.meta.url));

describe("R1 P1: shapes that used to pass both the validator and the redactor", () => {
  it.each(REVIEW_ROUND1_SHAPES.map((s) => [s[0], s[1], s[2]] as const))("redacts %s and the validator sees it", (_name, text, core) => {
    const out = redactSecrets(text);
    expect(out, "the secret core survived").not.toContain(core);
    expect(out).toContain(REDACTED);
    expect(containsSecret(text), "the validator did not flag it").toBe(true);
    expect(detectSecretKinds(text).length).toBeGreaterThan(0);
  });

  it.each(REVIEW_ROUND1_SHAPES.map((s) => [s[0], s[1], s[2]] as const))("a manifest carrying %s is rejected, in an owner and in a source_file", (_name, text) => {
    const inOwner = billingManifest((nodes) => ((nodes[0] as Record<string, unknown>).owner = `team ${text}`));
    const r1 = buildGraph(inOwner);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.code).toBe("SECRET_VALUE_REJECTED");
    const inFile = billingManifest((_nodes, edges) => ((edges[0] as Record<string, unknown>).source_file = `manifests/${text}`));
    const r2 = buildGraph(inFile);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failure.code).toBe("SECRET_VALUE_REJECTED");
  });

  it("positive control: the shapes the old detector knew are still rejected", () => {
    for (const secret of ALL_FAKE_SECRETS) {
      const built = buildGraph(billingManifest((nodes) => ((nodes[0] as Record<string, unknown>).owner = `x ${secret}`)));
      expect(built.ok, secret.slice(0, 6)).toBe(false);
    }
  });

  it.each(BENIGN_LOOKALIKES)("negative control: %j is not a secret", (text) => {
    expect(containsSecret(text)).toBe(false);
    const built = buildGraph(billingManifest((nodes) => ((nodes[0] as Record<string, unknown>).owner = text)));
    expect(built.ok).toBe(true);
  });

  it("redaction leaves surrounding text and non-secret non-ASCII text untouched", () => {
    const plain = "état: café ｆｕｌｌｗｉｄｔｈ text — ok";
    expect(redactSecrets(plain)).toBe(plain);
    const [, text] = REVIEW_ROUND1_SHAPES.find((s) => s[0] === "zero width split github token")!;
    const out = redactSecrets(text);
    expect(out.startsWith("t ")).toBe(true);
  });

  it("object keys that carry a secret are redacted as well", () => {
    const [, text, core] = REVIEW_ROUND1_SHAPES.find((s) => s[0] === "npm token")!;
    const out = JSON.stringify(redactDeep({ [text]: 1, nested: { [text]: "v" } }));
    expect(out).not.toContain(core);
  });

  it("safeReportText redacts before escaping for the new shapes", () => {
    for (const [, text, core] of REVIEW_ROUND1_SHAPES) expect(safeReportText(`<i>${text}</i>`)).not.toContain(core);
  });

  it("known planted secrets stay redacted (regression control for the old set)", () => {
    for (const secret of ALL_FAKE_SECRETS) {
      const out = redactSecrets(`a ${secret} b`);
      for (const core of SECRET_CORES) expect(out).not.toContain(core);
    }
  });
});

/* ---------- hostile input: linear time ---------- */

function build(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}
function timeOf(fn: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return best;
}

/** Every pattern shape the redactor looks for, repeated so that each character starts a candidate. */
const HOSTILE_UNITS: [string, string][] = [
  ["dots", "a."],
  ["dashes", "a-"],
  ["sk", "sk-"],
  ["jwt starts", "-eyJ"],
  ["jwt eyJ", "eyJ"],
  ["jwt long run", "eyJ" + "a".repeat(600) + "."],
  ["jwt dots", "eyJaaaaaaaa."],
  ["bearer", "Bearer "],
  ["basic", "Basic "],
  ["assignment", "password="],
  ["assignment quote", 'password="'],
  ["assignment keys", "secret_token_"],
  ["colon", "token:"],
  ["scheme", "://"],
  ["scheme userinfo", "x://a@"],
  ["scheme long", "x://" + "a".repeat(600)],
  ["aws", "AKIA"],
  ["github", "ghp_"],
  ["github pat", "github_pat_"],
  ["sendgrid", "SG."],
  ["sendgrid segments", ["SG", ".", "aaaaaaaaaaaaaaaaaa", "."].join("")],
  ["private key", "-----BEGIN "],
  ["private key header", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
  ["private key end", "-----END "],
  ["cookie", "Cookie:"],
  ["authorization", "Authorization:"],
  ["slack webhook", "hooks.slack.com/services/"],
  ["azure", "AccountKey="],
  ["npm", "npm_"],
  ["ya29", "ya29."],
  ["zero width", "\u200b"],
  ["fullwidth", "ＡＫＩＡ"],
  ["fullwidth assignment", "ｐａｓｓｗｏｒｄ＝"],
  ["spaces", " "],
  ["newlines", "\n"],
  ["quotes", '"'],
  ["escaped quotes", '\\"'],
  ["equals", "="],
];

describe("R1 P2: the redactor scales linearly on hostile input (64, 128 and 256 KB)", () => {
  for (const [name, unit] of HOSTILE_UNITS) {
    it(`${name}: 4x the input costs about 4x the time, with a generous ceiling`, () => {
      const small = build(unit, 64 * 1024);
      const large = build(unit, 256 * 1024);
      const mid = build(unit, 128 * 1024);
      for (const fn of [redactSecrets, detectSecretKinds]) {
        fn(small); // warm up
        // Measured up to three times (each the best of three runs) so that one garbage collection or a busy neighbour in the
        // parallel full suite cannot fail the check; quadratic behaviour fails every attempt (16 times for a 4 times input).
        let t64 = 0;
        let t128 = 0;
        let t256 = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          t64 = timeOf(() => fn(small));
          t128 = timeOf(() => fn(mid));
          t256 = timeOf(() => fn(large));
          if (t256 < 1_500 && (t64 < 8 || t256 / t64 < 10)) break;
        }
        expect(t256, `${fn.name} ${name} 256KB took ${t256.toFixed(1)}ms`).toBeLessThan(1_500);
        // Quadratic behaviour would give 16x for a 4x input; allow noise but not that.
        if (t64 >= 8) expect(t256 / t64, `${fn.name} ${name}: 64KB ${t64.toFixed(1)}ms, 128KB ${t128.toFixed(1)}ms, 256KB ${t256.toFixed(1)}ms`).toBeLessThan(10);
      }
    });
  }
});

/* ---------- hostile input: low heap ---------- */

function probeChild(shape: string, chars: number, heapMb: number): { status: number | null; out: { in: number; out: number; found: boolean; ms: number } | null; stderr: string } {
  const child = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, "--import", "tsx", probe, shape, String(chars)], { encoding: "utf8", timeout: 240_000 });
  let out = null;
  try {
    out = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    out = null;
  }
  return { status: child.status, out, stderr: child.stderr.slice(0, 300) };
}

describe("R1 P2: the redactor needs no memory proportional to a huge string (small V8 heap)", () => {
  it("6 MB of non-ASCII text in a 112 MB heap", () => {
    const r = probeChild("fullwidth", 6_000_000, 112);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status).toBe(0);
    // Round 2: text that needs folding and is larger than the fold cap (512 K characters) is REFUSED (reported as
    // `oversize`, which the validator rejects), not scanned window by window. No memory grows either way.
    expect(r.out!.found).toBe(true);
  }, 300_000);

  it("6 MB of mixed zero-width text in a 112 MB heap", () => {
    const r = probeChild("mixed", 6_000_000, 112);
    expect(r.status, r.stderr).toBe(0);
  }, 300_000);

  it("8 MB of ASCII in a 96 MB heap", () => {
    const r = probeChild("ascii", 8_000_000, 96);
    expect(r.status, r.stderr).toBe(0);
  }, 300_000);

  it("a megabyte of secrets (tens of thousands of spans) is redacted in a 112 MB heap", () => {
    const r = probeChild("secrets", 1_000_000, 112);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out!.found).toBe(true);
    expect(r.out!.out).toBeLessThan(r.out!.in);
  }, 300_000);

  it("quoted assignments, 1 MB", () => {
    const r = probeChild("assignments", 1_000_000, 112);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out!.found).toBe(true);
  }, 300_000);

  it("control: the probe reports failure when the heap is impossibly small", () => {
    const r = probeChild("fullwidth", 6_000_000, 4);
    expect(r.status === 0).toBe(false);
  }, 120_000);
});

/* ---------- randomized property test ---------- */

describe("R1: randomized property test (seeded)", () => {
  const BENIGN = ["svc.billing", "contract.invoice", "team-data", "manifests/job.yaml:12", "alias cred.smtp", "état", "1.2.3", "ok", "-", "..", "a", "12345678"];
  const HOSTILE = HOSTILE_UNITS.map((u) => u[1]);
  const PLANTED = REVIEW_ROUND1_SHAPES.map((s) => [s[1], s[2]] as const);
  const SEPARATORS = [" ", "\n", ", ", "; ", " | "];

  it("no planted secret survives anywhere in random text, output is idempotent, clean text is unchanged", () => {
    const rnd = prng(20260929);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
    for (let round = 0; round < 400; round += 1) {
      const parts: string[] = [];
      const cores: string[] = [];
      const count = 3 + Math.floor(rnd() * 12);
      for (let i = 0; i < count; i += 1) {
        const roll = rnd();
        if (roll < 0.35) parts.push(pick(BENIGN));
        else if (roll < 0.6) parts.push(pick(HOSTILE).repeat(1 + Math.floor(rnd() * 30)));
        else {
          const [text, core] = pick(PLANTED);
          parts.push(text);
          cores.push(core);
        }
      }
      let text = "";
      for (const part of parts) text += part + pick(SEPARATORS);
      const out = redactSecrets(text);
      for (const core of cores) expect(out, `round ${round}: core survived`).not.toContain(core);
      expect(redactSecrets(out), `round ${round}: not idempotent`).toBe(out);
      expect(detectSecretKinds(text).length > 0 || cores.length === 0, `round ${round}: validator missed a planted secret`).toBe(true);
    }
    const clean = BENIGN.join(" ");
    expect(redactSecrets(clean)).toBe(clean);
  });
});
