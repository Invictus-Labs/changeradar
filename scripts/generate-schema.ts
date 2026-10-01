import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResponseJsonSchemas } from "../src/domain/api-responses.js";
import { buildRequestJsonSchemas } from "../src/domain/api-schemas.js";
import { buildManifestJsonSchema } from "../src/domain/manifest.js";
import { DEFAULT_LIMITS } from "../src/domain/limits.js";
import { bodySchema } from "../src/services/checks.js";
import { RequestSchema as ImpactRunRequestSchema } from "../src/services/impact.js";
import { defaultSettings } from "../src/platform/context.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const outputs: [string, string][] = [
  ["dependencies.json", JSON.stringify(buildManifestJsonSchema(DEFAULT_LIMITS), null, 2) + "\n"],
  [
    "api-requests.json",
    JSON.stringify(
      buildRequestJsonSchemas({ impactRun: ImpactRunRequestSchema, contractCheck: bodySchema(defaultSettings.checks.maxTimeoutMs), limits: DEFAULT_LIMITS }),
      null,
      2,
    ) + "\n",
  ],
  ["api-responses.json", JSON.stringify(buildResponseJsonSchemas(), null, 2) + "\n"],
];

if (process.argv.includes("--check")) {
  let drift = false;
  for (const [name, generated] of outputs) {
    let current = "";
    try {
      current = readFileSync(resolve(dir, name), "utf8");
    } catch {
      // Missing file counts as drift.
    }
    if (current !== generated) {
      console.error(`schemas/${name} is out of date; run: npm run schema:generate`);
      drift = true;
    } else {
      console.log(`schemas/${name} is up to date`);
    }
  }
  if (drift) process.exit(1);
} else {
  for (const [name, generated] of outputs) {
    writeFileSync(resolve(dir, name), generated);
    console.log(`wrote schemas/${name}`);
  }
}
