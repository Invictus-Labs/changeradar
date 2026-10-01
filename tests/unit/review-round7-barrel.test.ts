import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "../../src/index.js";
import * as redaction from "../../src/domain/redaction.js";

/**
 * Review round 7: the barrel (`src/index.ts`, "public surface of the domain layer") re-exported everything of `redaction.ts` with `export *`, which
 * made the test hooks of the redactor part of it. It now names what it exports, and this test keeps it that way: a new `export` in redaction.ts
 * must be put on the barrel or on the list of hooks below on purpose, and a hook must never be on the barrel. (Type-only names such as
 * `NextMark` have no runtime value: the compiler checks those, and `export { type ... }` is not used in the named list.)
 */

const HOOKS = ["looksRandomAt", "scanStateHoldsText", "setWorkBudget"];

describe("R7 (barrel): the redaction names on the public surface are listed, the test hooks are not on it", () => {
  const exported = Object.keys(redaction).sort();
  const onBarrel = exported.filter((name) => name in barrel);

  it("no test hook of redaction.ts is on the barrel", () => {
    for (const hook of HOOKS) {
      expect(exported, `${hook} is a hook of redaction.ts (control: it exists)`).toContain(hook);
      expect(hook in barrel, `${hook} must not be exported by src/index.ts`).toBe(false);
    }
  });

  it("every other export of redaction.ts is on the barrel, and a new one is refused until it is placed", () => {
    for (const name of exported) {
      if (HOOKS.includes(name)) continue;
      expect(name in barrel, `redaction.ts exports "${name}": add it to the named list in src/index.ts or to HOOKS in this test`).toBe(true);
    }
    expect(onBarrel).toEqual(["OVERSIZE_REDACTED", "REDACTED", "containsSecret", "detectSecretKinds", "escapeHtml", "redactDeep", "redactIdentifier", "redactIdentifiers", "redactSecrets", "safeReportText"]);
  });

  it("docs/DOMAIN.md names every redaction name of the barrel", () => {
    const doc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "DOMAIN.md"), "utf8");
    const row = doc.split("\n").find((line) => line.startsWith("| `src/domain/redaction.ts` |")) as string;
    expect(row, "the row of redaction.ts in the table of the surface").toBeDefined();
    for (const name of onBarrel) expect(row, `docs/DOMAIN.md does not name "${name}"`).toContain(`\`${name}\``);
    for (const hook of HOOKS) expect(row, `${hook} is a test hook and is not documented as surface`).not.toContain(hook);
  });

  it("the barrel exposes the same function objects (a re-export, not a copy)", () => {
    expect(barrel.redactSecrets).toBe(redaction.redactSecrets);
    expect(barrel.detectSecretKinds).toBe(redaction.detectSecretKinds);
  });
});
