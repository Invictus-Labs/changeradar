import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness.js";
import { e, f, manifest, n } from "../helpers/builders.js";

/**
 * Review round 4 (security P1, a sibling review's generative method): a secret written in a template, nested in JSON text
 * 0 to 8 times, with and without percent-encoded separators, goes through the REAL import path. The manifest validator
 * refuses it (422 SECRET_VALUE_REJECTED) and never repeats it; nothing is stored. Fake secrets are assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const GH = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const nest = (layers: number, text: string): string => {
  let s = text;
  for (let i = 0; i < layers; i += 1) s = JSON.stringify(s).slice(1, -1);
  return s;
};
const templates: [string, (s: string) => string][] = [
  ["assignment", (s) => `password=${s}`],
  ["json key", (s) => JSON.stringify({ token: s })],
  ["name/value", (s) => JSON.stringify({ env: [{ name: "DB_PASSWORD", value: s }] })],
  ["value/name", (s) => JSON.stringify({ value: s, name: "api_key" })],
  ["yaml next line", (s) => `db:\n  password:\n    ${s}`],
  ["argv", (s) => JSON.stringify(["run", "--password", s])],
];

describe("R4 P1: the import path refuses every template x depth x encoding of a secret, and never echoes it", () => {
  it("secret shape x 6 templates x JSON layers 0..8 x percent encoding 0..1", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Sweep");
      const accepted: string[] = [];
      const echoed: string[] = [];
      let attempts = 0;
      for (const [secretLabel, secret] of [["random password", V], ["github token", GH]] as const) {
        for (const [templateLabel, template] of templates) {
          for (let layers = 0; layers <= 8; layers += 1) {
            for (const pct of [0, 1]) {
              let text = nest(layers, template(secret));
              if (pct === 1) text = text.replace(/[=:"@\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
              const doc = manifest([n("contract.c", "contract", { fields: [f("a")] }), n("svc.a", "service", { owner: text })], [e("svc.a", "contract.c", "consumes")]);
              const res = await h.importSnapshot(w.operator, doc, { revision: `sweep-${attempts}` });
              attempts += 1;
              const label = `${secretLabel} / ${templateLabel} / layers ${layers} / percent ${pct}`;
              if (res.status !== 422) accepted.push(`${label}: ${res.status}`);
              if (res.text.includes(secret)) echoed.push(label);
            }
          }
        }
      }
      expect(attempts).toBe(2 * 6 * 9 * 2);
      expect(accepted).toEqual([]);
      expect(echoed).toEqual([]);
    } finally {
      await h.close();
    }
  }, 300_000);
});
