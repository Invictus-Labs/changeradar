import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness.js";
import { e, f, manifest, n } from "../helpers/builders.js";

/**
 * Review round 5 (security P1, P2, the ruled must-fix): the shapes added in this round go through the REAL import path
 * (owner text, at most 256 characters and no line break, like every manifest string): each is refused (422
 * SECRET_VALUE_REJECTED) and never echoed, nested in JSON text 0 to 3 times, with and without percent-encoded separators.
 * Multi-line shapes (block scalars, YAML lists) cannot enter through a manifest at all (a line break is refused, SCHEMA_INVALID);
 * they are covered at text level in tests/unit/review-round5-redaction.test.ts.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const nest = (layers: number, text: string): string => {
  let s = text;
  for (let i = 0; i < layers; i += 1) s = JSON.stringify(s).slice(1, -1);
  return s;
};
const templates: [string, (s: string) => string][] = [
  ["bare pair", (s) => `name=DB_PASSWORD value=${s}`],
  ["bare pair, colon and comma", (s) => `name: password, value: ${s}`],
  ["bare pair, value first", (s) => `value=${s} name=password`],
  ["bare pair with a key in between", (s) => `name=password type=SecureString value=${s}`],
  ["array value", (s) => JSON.stringify({ name: "DB_PASSWORD", value: [s] })],
  ["object value", (s) => JSON.stringify({ name: "DB_PASSWORD", value: { plain: s } })],
  ["object between the halves", (s) => JSON.stringify({ name: "DB_PASSWORD", meta: { a: { b: 1 } }, value: s })],
  ["header/value", (s) => JSON.stringify({ header: "Authorization", value: s })],
  ["k/v", (s) => JSON.stringify({ k: "api_key", v: s })],
  ["ParameterKey", (s) => JSON.stringify({ ParameterKey: "DbPassword", ParameterValue: s })],
  ["bracketed name", (s) => JSON.stringify({ name: "password[0]", value: s })],
  ["env-style name", (s) => JSON.stringify({ name: "${DB_PASSWORD}", value: s })],
  ["long name", (s) => JSON.stringify({ name: `${"x".repeat(120)}password`, value: s })],
  ["connection string name", (s) => JSON.stringify({ name: "connection string", value: s })],
  ["yaml anchor", (s) => `password: &a ${s}`],
  ["yaml tag", (s) => `password: !!str ${s}`],
  ["flow sequence", (s) => `password: ["${s}"]`],
  ["?=", (s) => `PASSWORD ?= ${s}`],
  ["+=", (s) => `PASSWORD += ${s}`],
  ["-p=", (s) => `tool -p=${s}`],
  ["ENV", (s) => `ENV PASSWORD ${s}`],
  ["typed assignment", (s) => `password: string = "${s}"`],
  ["long flag", (s) => `--db-password ${s}`],
  ["python bytes", (s) => `password = b'${s}'`],
  ["python dict", (s) => `{'password': b'${s}'}`],
  ["session_id", (s) => `session_id=${s}`],
  ["connection_string", (s) => `connection_string=${s}`],
  ["dsn", (s) => `dsn=${s}`],
  ["pin", (s) => `pin=${s}`],
];

describe("R5 P1/P2: the import path refuses every new template x depth x encoding of a secret, and never echoes it", () => {
  it("secret shape x templates x JSON layers 0..3 x percent encoding 0..1", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Sweep5");
      const accepted: string[] = [];
      const echoed: string[] = [];
      let attempts = 0;
      let tooLong = 0;
      for (const [templateLabel, template] of templates) {
        for (let layers = 0; layers <= 3; layers += 1) {
          for (const pct of [0, 1]) {
            let text = nest(layers, template(V));
            if (pct === 1) text = text.replace(/[=:"@\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
            if (text.length > 256) {
              tooLong += 1;
              continue;
            }
            const doc = manifest([n("contract.c", "contract", { fields: [f("a")] }), n("svc.a", "service", { owner: text })], [e("svc.a", "contract.c", "consumes")]);
            const res = await h.importSnapshot(w.operator, doc, { revision: `sweep-${attempts}` });
            attempts += 1;
            const label = `${templateLabel} / layers ${layers} / percent ${pct}`;
            if (res.status !== 422) accepted.push(`${label}: ${res.status}`);
            if (res.text.includes(V)) echoed.push(label);
          }
        }
      }
      expect(attempts + tooLong).toBe(templates.length * 4 * 2);
      // Most cases fit the 256 character limit; the deepest layers of the longest templates do not (they cannot be imported).
      expect(attempts).toBeGreaterThan(templates.length * 4);
      expect(accepted).toEqual([]);
      expect(echoed).toEqual([]);
    } finally {
      await h.close();
    }
  }, 600_000);
});
