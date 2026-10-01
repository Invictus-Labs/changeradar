/** Times buildGraph on the at-limit synthetic manifest (10,000 nodes, 50,000 edges). Usage: build-bench.ts */
import { buildGraph } from "../../src/services/graph.js";
import { syntheticManifest } from "./scenario.js";

const doc = syntheticManifest(10_000, 50_000);
const started = Date.now();
const result = buildGraph(doc);
process.stdout.write(JSON.stringify({ ok: result.ok, ms: Date.now() - started }) + "\n");
