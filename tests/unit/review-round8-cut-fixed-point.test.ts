import { describe, expect, it } from "vitest";
import { capLeaves, capText, TEXT_CAP } from "../../src/domain/derived-text.js";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 8 (logic P1, derived-text.ts:18): an export cuts a text AFTER redacting it, and redact-then-cut could end with a marker followed by the first
 * letters of the next credential-shaped word (`...access_token:[REDACTED]a`), which redacts again to `...access_token:[REDACTED]` (1,999 characters): the stored text is
 * not a fixed point of the redactor, neither reading of verification matches it, and the workspace could not export its own fresh run. A cut now leaves a
 * text that redaction leaves alone: a partial word glued to the last marker is dropped with the rest of the tail.
 */

const UNITS = [
  "access_token:abcde:apikey:abcdef",
  "client_secret:abcdef:private_key:abcdefgh",
  "password:abcdefgh:token:abcdefgh:secret:abcdefgh",
  "api_key:abcdef api_key:abcdef api_key:abcdef",
  "ct/password..abcdefghijklmnop",
  "auth:abcdef|consumes|token:abcdef",
];
const pad = (length: number): string => "unknown field x, ".repeat(Math.ceil(length / 17)).slice(0, length);

describe("R8 (derived-text.ts:18): redact, then cut, leaves a fixed point of the redactor", () => {
  it("for every cut position around the cap, over chains of credential-shaped words", () => {
    let cuts = 0;
    for (const unit of UNITS) {
      for (let padding = 1700; padding <= 2000; padding += 1) {
        const redacted = redactSecrets(`${pad(padding)}${unit} ${unit}`);
        if (redacted.length <= TEXT_CAP) continue;
        const cut = capText(redacted) as string;
        cuts += 1;
        expect(cut.length, `${unit} at ${padding}: within the cap`).toBeLessThanOrEqual(TEXT_CAP);
        expect(redactSecrets(cut), `${unit} at ${padding}: the cut text ends ${JSON.stringify(cut.slice(-40))}`).toBe(cut);
        expect(capText(cut), "cutting again changes nothing").toBe(cut);
      }
    }
    expect(cuts, "the sweep cuts long texts (control)").toBeGreaterThan(300);
  });
  it("the same at object level, as an export writes it (redact the whole value, cut every string)", () => {
    for (const unit of UNITS) {
      for (let padding = 1900; padding <= 2000; padding += 1) {
        const value = { message: `${pad(padding)}${unit} ${unit}`, list: [`${pad(padding)}${unit}`] };
        const written = capLeaves(redactDeep(value)) as typeof value;
        expect(redactDeep(written), `${unit} at ${padding}`).toEqual(written);
      }
    }
  });
  it("a tail behind the last marker that the redactor leaves alone is kept (only a tail that would be hidden again is dropped)", () => {
    const text = `${pad(100)}api_key:${"[REDACTED]"} ${"hello world ".repeat(300)}`;
    expect(redactSecrets(text)).toBe(text);
    const cut = capText(text) as string;
    expect(cut.length, "cut exactly at the cap, the plain tail kept").toBe(TEXT_CAP);
    expect(text.startsWith(cut)).toBe(true);
  });
  it("short text is byte for byte what it was (identity below the cap)", () => {
    const text = "edge auth:[REDACTED]token:[REDACTED] was never verified";
    expect(capText(text)).toBe(text);
  });
});
