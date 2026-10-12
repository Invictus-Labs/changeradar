// Child process of the bounded-verification tests: verifies the bundle file named by argv[2] and prints the outcome and the time taken.
import { readFileSync } from "node:fs";
import { BundleError, verifyBundle } from "../../src/services/evidence.js";

const text = readFileSync(process.argv[2] as string, "utf8");
const started = process.hrtime.bigint();
let outcome = "ACCEPTED";
try {
  verifyBundle(text, { maxBytes: 64 * 1024 * 1024 });
} catch (error) {
  outcome = error instanceof BundleError ? error.code : `ERROR ${String(error).slice(0, 80)}`;
}
const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
process.stdout.write(`${JSON.stringify({ outcome, ms })}\n`);
