/**
 * Child process probe for the redactor: build a large hostile string, redact and scan it, print one JSON line.
 * Run with a small V8 heap so that memory that grows with the whole input shows up as a crash.
 * Usage: redact-probe.ts <shape> <chars>
 */
import { containsSecret, redactSecrets } from "../../src/domain/redaction.js";

const [shape = "ascii", charsArg = "1000000"] = process.argv.slice(2);
const chars = Number(charsArg);
const UNITS: Record<string, string> = {
  ascii: "a.",
  fullwidth: "ＡＫＩＡ",
  // U+FDFA expands to 18 characters under NFKC: the worst case for a fold that allocates per output character.
  expander: "ﷺ",
  mixed: "a​b.é",
  // Assembled at runtime so no source line looks like a real token to the repository's hygiene scan.
  secrets: ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", " "].join(""),
  assignments: ["pass", 'word="Tr0ub4dor and 3" '].join(""),
};
const unit = UNITS[shape] ?? "a.";
const text = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
const started = Date.now();
const redacted = redactSecrets(text);
const found = containsSecret(text);
process.stdout.write(JSON.stringify({ in: text.length, out: redacted.length, found, ms: Date.now() - started }) + "\n");
