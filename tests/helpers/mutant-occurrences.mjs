// Prints how many times each mutant's `find` text occurs in its file (must be exactly one). Helper for maintaining
// scripts/mutation-controls.mjs. Usage: node tests/helpers/mutant-occurrences.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const source = readFileSync(resolve(root, "scripts/mutation-controls.mjs"), "utf8");
const start = source.indexOf("const MUTANTS = [");
const end = source.indexOf("\n];\n", start);
const mutants = new Function(`${source.slice(start, end + 3).replace("const MUTANTS =", "return")}`)();
let bad = 0;
for (const m of mutants) {
  const count = readFileSync(resolve(root, m.file), "utf8").split(m.find).length - 1;
  if (count !== 1) {
    bad += 1;
    console.log(`${m.id}: ${count} occurrence(s) in ${m.file}`);
  }
}
console.log(`${mutants.length} mutants checked, ${bad} with a wrong occurrence count`);
process.exit(bad === 0 ? 0 : 1);
