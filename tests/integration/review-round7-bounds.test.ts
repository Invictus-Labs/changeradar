import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { redactSecrets } from "../../src/domain/redaction.js";
import { BundleError, buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 7 (logic P2-a, bundle-bounds.ts:45): verification accepted hash-consistent bundles that restore refused.
 * (a) A text of 1,999 characters and an astral character was cut by restore through the pair: PostgreSQL refuses a lone surrogate
 * (BUNDLE_SCHEMA_INVALID at restore). A cut now stops before a pair. (b) Two keys that differ only after the 2,000th character are
 * unique at verification and equal after restore's cut: a unique-constraint failure in the middle of the write. Verification now
 * checks uniqueness of every cut text the database keeps unique (contract check keys, run check keys).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const LIMIT = 64 * 1024 * 1024;
const CAP = 2000;
const ASTRAL = String.fromCodePoint(0x1f600);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const fresh = (): Record<string, any> => JSON.parse(ENGINE1) as Record<string, any>;
const checkRow = (key: string) => ({
  key, node_id: "contract.invoice", url: "http://localhost:9/ok", method: "GET", timeout_ms: 1000, retries: 0, expect_status: 200, required_fields: [], credential_alias: null, enabled: false,
  created_at: "2026-09-29T00:00:00.000Z", disabled_at: "2026-09-29T00:00:00.000Z",
});
const runCheck = (key: string) => ({ check_key: key, node_id: "contract.invoice", state: "UNKNOWN", definition: {}, result: null, started_at: "2026-09-29T00:00:00.000Z", finished_at: null });
const codeOf = (text: string): string => {
  try {
    verifyBundle(text, { maxBytes: LIMIT });
    return "ACCEPTED";
  } catch (error) {
    return error instanceof BundleError ? error.code : String(error);
  }
};
const restoreCode = async (text: string): Promise<string> => {
  const h = await createHarness();
  try {
    await restoreBundle(h.ctx, text);
    return "RESTORED";
  } catch (error) {
    return error instanceof BundleError ? error.code : (error as { code?: string }).code ?? String(error).slice(0, 120);
  } finally {
    await h.close();
  }
};

describe("R7 (logic P2-a, derived-text.ts): a text that a restore cuts through an astral character is cut before it, so verification and restore agree", () => {
  it("a workspace name of 1,999 characters, an astral character and one more: verified, restored, and exported again", async () => {
    const b = fresh();
    b.workspace.name = `${"a".repeat(CAP - 1)}${ASTRAL}b`;
    const text = reseal(b);
    expect(codeOf(text), "verification").toBe("ACCEPTED");
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, text).then((s) => s, (error: unknown) => ({ workspace_id: "", failure: (error as { code?: string }).code ?? String(error) }));
      expect((summary as { failure?: string }).failure, "restore").toBeUndefined();
      const again = serializeBundle((await buildBundle(h.db, { workspaceId: (summary as { workspace_id: string }).workspace_id }, h.now())) as EvidenceBundle);
      const name = (JSON.parse(again) as EvidenceBundle).workspace.name;
      expect(name.length, "the restored name is within the cap").toBeLessThanOrEqual(CAP);
      expect(name.endsWith("a"), "cut before the pair, not through it").toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R7 (test review P2-a, bundle-bounds.ts:62): an object key that redaction LENGTHENS past the cap is refused at verification and at restore", () => {
  // `pw=abcdef ` is 10 characters and becomes `pw=[REDACTED] ` (14): a key of up to 2,000 characters can grow past the cap when it is
  // redacted, and every later export refused it (`an object key is longer than 2000 characters`) although verify and restore took it in.
  const keyOf = (units: number): string => "pw=abcdef ".repeat(units);
  const lastFitting = ((): number => {
    let n = 1;
    while (redactSecrets(keyOf(n + 1)).length <= CAP) n += 1;
    return n;
  })();
  const withKey = (key: string): string => {
    const b = fresh();
    b.impact_runs[0].assessment_detail.wide = { [key]: 1 };
    return reseal(b);
  };

  it("the boundary is inside the raw cap (control: the lengthening key is a plausible one)", () => {
    expect(keyOf(lastFitting + 1).length).toBeLessThanOrEqual(CAP);
    expect(redactSecrets(keyOf(lastFitting + 1)).length).toBeGreaterThan(CAP);
  });

  it("a key whose redacted form is exactly within the cap: verified, restored, exported as a workspace and as a run bundle", async () => {
    const text = withKey(keyOf(lastFitting));
    expect(codeOf(text)).toBe("ACCEPTED");
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, text);
      const built = await buildBundle(h.db, { workspaceId: summary.workspace_id }, h.now()).then(() => "exported", (error: unknown) => `refused: ${String(error).slice(0, 120)}`);
      expect(built, "the workspace export").toBe("exported");
      const operator = await h.userIn(summary.workspace_id, "operator");
      const parsed = JSON.parse(text) as { impact_runs: { id: string }[] };
      const run = await h.api(operator, "GET", `/api/v1/impact-runs/${(parsed.impact_runs[0] as { id: string }).id}/bundle`);
      expect(run.status, run.text.slice(0, 160)).toBe(200);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("a key of the same kind whose redacted form is longer than the cap: BUNDLE_SCHEMA_INVALID at verification and at restore", async () => {
    const text = withKey(keyOf(lastFitting + 1));
    expect(codeOf(text), "verification").toBe("BUNDLE_SCHEMA_INVALID");
    expect(await restoreCode(text), "restore").toBe("BUNDLE_SCHEMA_INVALID");
    const wide = withKey(keyOf(200));
    expect(codeOf(wide), "the 2,000-character key of the report (redacted: 2,800)").toBe("BUNDLE_SCHEMA_INVALID");
  }, 120_000);

  it("control: a key that redaction does not lengthen past the cap is accepted", () => {
    expect(codeOf(withKey("token=abc12 ".repeat(166)))).toBe("ACCEPTED");
  });
});

describe("R7 (test review P2-c, bundle-bounds.ts): the edges of the surrogate ranges, in a text, in an array item and in a key", () => {
  const c = (code: number): string => String.fromCharCode(code);
  const LONE = [0xd800, 0xdbff, 0xdc00, 0xdfff];
  const withText = (edit: (detail: Record<string, any>) => void): string => {
    const b = fresh();
    edit(b.impact_runs[0].assessment_detail);
    return reseal(b);
  };
  it.each(LONE)("a lone U+%s is refused in a text, an array item and a key", (code) => {
    expect(codeOf(withText((d) => { d.note = `a${c(code)}b`; })), "text").toBe("BUNDLE_SCHEMA_INVALID");
    expect(codeOf(withText((d) => { d.list = ["ok", `a${c(code)}`]; })), "array item").toBe("BUNDLE_SCHEMA_INVALID");
    expect(codeOf(withText((d) => { d.odd = { [`k${c(code)}`]: 1 }; })), "key").toBe("BUNDLE_SCHEMA_INVALID");
  });
  it.each([[0xd800, 0xdc00], [0xdbff, 0xdfff], [0xd83d, 0xde00], [0xd800, 0xdfff], [0xdbff, 0xdc00]])("the pair U+%s U+%s is a character and is accepted, in a text and an array item", (high, low) => {
    expect(codeOf(withText((d) => { d.note = `a${c(high)}${c(low)}b`; }))).toBe("ACCEPTED");
    expect(codeOf(withText((d) => { d.list = ["ok", `${c(high)}${c(low)}`]; }))).toBe("ACCEPTED");
  });
  it("two highs in a row and a low then a high are lone halves", () => {
    expect(codeOf(withText((d) => { d.note = `${c(0xd800)}${c(0xd800)}${c(0xdc00)}${c(0xdc00)}`; }))).toBe("BUNDLE_SCHEMA_INVALID");
    expect(codeOf(withText((d) => { d.note = `${c(0xdc00)}${c(0xd800)}`; }))).toBe("BUNDLE_SCHEMA_INVALID");
  });
});

describe("R7 (test review P2-b, evidence.ts:304-318): every text of an export is cut AFTER redaction, at every site, and never through a marker", () => {
  // A text of about the cap whose redaction lengthens it: `pw=abcdef ` (10 characters) becomes `pw=[REDACTED] ` (14). The sweep of lengths
  // passes the point where a marker ends exactly at the cap and the points where a plain cut would split one.
  const MARKER = "[REDACTED]";
  const textOf = (length: number): string => `${"x".repeat(length % 10)}${"pw=abcdef ".repeat(Math.floor(length / 10))}`;
  const splitMarker = (text: string): boolean => {
    for (let n = 1; n < MARKER.length; n += 1) if (text.endsWith(MARKER.slice(0, n))) return true;
    return false;
  };
  const LENGTHS = Array.from({ length: 31 }, (_, i) => 1985 + i);
  const sites = (b: Record<string, any>, text: string): void => {
    b.snapshots[0].warnings = [{ code: "W", message: text }];
    b.impact_runs[0].error_detail = text;
    b.impact_runs[0].events[0].note = text;
    b.impact_runs[0].assessment_detail.wide = { note: text };
    b.impact_runs[0].checks = [{ check_key: "chk.sites", node_id: "contract.invoice", state: "PASSED", definition: { note: text }, result: { note: text }, started_at: "2026-09-29T00:00:00.000Z", finished_at: "2026-09-29T00:00:01.000Z" }];
    b.contract_checks = [{ ...checkRow("chk.sites"), definition: undefined }];
  };
  const read = (b: EvidenceBundle): Record<string, string> => {
    const run = b.impact_runs[0] as EvidenceBundle["impact_runs"][number] & { assessment_detail: { wide: { note: string } } };
    return {
      "snapshot warnings": ((b.snapshots[0] as { warnings: { message: string }[] }).warnings[0] as { message: string }).message,
      "error detail": run.error_detail as string,
      "event note": run.events[0]?.note as string,
      "assessment detail": run.assessment_detail.wide.note,
      "check definition": (run.checks[0]?.definition as { note: string }).note,
      "check result": (run.checks[0]?.result as { note: string }).note,
    };
  };

  it("for lengths 1,985 to 2,015 the exported text is within the cap, whole-marker, and stable through verify, restore and the next export", async () => {
    const h = await createHarness();
    let plainCutSplits = 0;
    try {
      for (const length of LENGTHS) {
        const text = textOf(length);
        if (splitMarker(redactSecrets(text).slice(0, CAP))) plainCutSplits += 1;
        const b = fresh();
        sites(b, text);
        const sealed = reseal(b);
        expect(codeOf(sealed), `length ${length}: verification`).toBe("ACCEPTED");
        const dst = await createHarness();
        try {
          const summary = await restoreBundle(dst.ctx, sealed);
          const exported = (await buildBundle(dst.db, { workspaceId: summary.workspace_id }, dst.now())) as EvidenceBundle;
          for (const [site, value] of Object.entries(read(exported))) {
            expect(value.length, `length ${length}, ${site}: within the cap`).toBeLessThanOrEqual(CAP);
            expect(splitMarker(value), `length ${length}, ${site}: a marker cut in two`).toBe(false);
          }
          const again = serializeBundle(exported);
          expect(codeOf(again), `length ${length}: the export verifies`).toBe("ACCEPTED");
        } finally {
          await dst.close();
        }
      }
    } finally {
      await h.close();
    }
    expect(plainCutSplits, "the sweep reaches lengths where a plain cut would split a marker (control)").toBeGreaterThan(0);
  }, 600_000);

  it("the split-marker check sees a cut inside every prefix of the marker (control for the check itself)", () => {
    for (let n = 1; n < MARKER.length; n += 1) expect(splitMarker(`abc${MARKER.slice(0, n)}`), `prefix of ${n} characters`).toBe(true);
    expect(splitMarker(`abc${MARKER}`)).toBe(false);
  });
});

describe("R7 (logic P2-a, bundle-bounds.ts): keys that are the same after the cut are one key, and verification says so", () => {
  const K = "k".repeat(CAP);
  it("control: two contract check keys of exactly the cap that differ inside it are accepted and restored", async () => {
    const b = fresh();
    b.contract_checks = [checkRow(`${K.slice(1)}a`), checkRow(`${K.slice(1)}b`)];
    const text = reseal(b);
    expect(codeOf(text)).toBe("ACCEPTED");
    expect(await restoreCode(text)).toBe("RESTORED");
  }, 120_000);

  it("two contract check keys that differ only after the 2,000th character: BUNDLE_SCHEMA_INVALID at verification and at restore, never a database message", async () => {
    const b = fresh();
    b.contract_checks = [checkRow(`${K}a`), checkRow(`${K}b`)];
    const text = reseal(b);
    expect(codeOf(text), "verification").toBe("BUNDLE_SCHEMA_INVALID");
    expect(await restoreCode(text), "restore").toBe("BUNDLE_SCHEMA_INVALID");
  }, 120_000);

  it("two run check keys that differ only after the 2,000th character: the same", async () => {
    const b = fresh();
    b.impact_runs[0].checks = [runCheck(`${K}a`), runCheck(`${K}b`)];
    const text = reseal(b);
    expect(codeOf(text), "verification").toBe("BUNDLE_SCHEMA_INVALID");
    expect(await restoreCode(text), "restore").toBe("BUNDLE_SCHEMA_INVALID");
  }, 120_000);
});
