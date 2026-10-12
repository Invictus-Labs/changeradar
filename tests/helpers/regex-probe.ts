import { detectSecretKinds, redactDeep, redactSecrets } from "../../src/domain/redaction.js";
import { buildGraph } from "../../src/services/graph.js";

/**
 * Child-process probe for tests/unit/review-round7-regex-audit.test.ts (the parent kills it after a wall-clock limit): hostile texts of the
 * shape that made a regular expression of a sibling product backtrack exponentially (a run of backslashes or percent escapes and a failing
 * tail) go through the text redactor, the object redactor, the detector of the import validator and the import validator itself.
 *   probe <n>   prints the slowest call in milliseconds and the shape that made it
 */

const n = Number(process.argv[2] ?? "24");
const shapes: [string, string][] = [
  ["backslashes then a failing tail", `password=[]x${"\\".repeat(n)}y`],
  ["percent escapes then a failing tail", `password=[]x${"%0A".repeat(n)}y`],
  ["text-written line breaks", `token: x${"\\n".repeat(n)}z`],
  ["nested text-written line breaks", `token: x${"\\\\n".repeat(n)}z`],
  ["CR LF escapes", `pw=${"%0D%0A".repeat(n)}q`],
  ["mixed backslash and percent", `secret=a${"\\%0A".repeat(n)}!`],
  ["property words", `key: ${"!a ".repeat(n)}z`],
  ["brackets", `${"[".repeat(n)}password=x`],
  ["quotes and backslashes", `"password":"${"\\\"".repeat(n)}x`],
  ["pair halves", `name=password ${"x ".repeat(n)}value=`],
  ["a key run", `${"token_".repeat(n)}: |`],
];
let slowest = 0;
let where = "";
for (const [label, text] of shapes) {
  const started = process.hrtime.bigint();
  redactSecrets(text);
  redactDeep({ a: text, b: [text], [text.slice(0, 60)]: 1 });
  detectSecretKinds(text);
  buildGraph({ schema_version: 1, nodes: [{ id: "svc.a", kind: "service", owner: text.slice(0, 4000) }], edges: [] } as never);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (ms > slowest) {
    slowest = ms;
    where = label;
  }
}
process.stdout.write(`${JSON.stringify({ n, slowest_ms: slowest, shape: where })}\n`);
