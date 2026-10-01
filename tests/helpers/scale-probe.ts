/**
 * Child process probe: assess one large synthetic shape and print a one line JSON summary. Run with a small
 * V8 heap (see tests/unit/review-round1-scale.test.ts) so that unbounded output shows up as a crash instead of
 * a slow test.  Usage: scale-probe.ts <shape> <size> [all|head]
 */
import { fixedClock } from "../../src/domain/clock.js";
import { assess } from "../../src/services/assess.js";
import { buildGraph } from "../../src/services/graph.js";
import { bumped, chain, lattice, star, starWithoutFields } from "./scale-shapes.js";

const [shape, sizeArg, mode = "head"] = process.argv.slice(2);
const size = Number(sizeArg);
const clock = fixedClock("2026-09-29T00:00:00Z");

const docs =
  shape === "chain"
    ? [chain(size), bumped(chain(size), mode === "all" ? "all" : [0])]
    : shape === "star"
      ? [star(size, size), starWithoutFields(star(size, size))]
      : [lattice(size, size), bumped(lattice(size, size), "all")];

const baseline = buildGraph(docs[0]);
const proposed = buildGraph(docs[1]);
if (!baseline.ok || !proposed.ok) throw new Error("fixture rejected");
const started = Date.now();
const result = assess({ baseline: baseline.graph, proposed: proposed.graph, expected_hash: baseline.graph.hash, clock });
if (!result.ok) throw new Error("assess refused");
const a = result.assessment;
const json = JSON.stringify(a);
process.stdout.write(
  JSON.stringify({
    verdict: a.assessment,
    findings: a.findings.length,
    unknown_codes: a.unknowns.map((u) => u.code),
    bytes: json.length,
    ms: Date.now() - started,
    longest_path: Math.max(0, ...a.findings.map((x) => x.path.length)),
  }) + "\n",
);
