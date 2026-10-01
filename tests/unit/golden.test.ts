import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import { billingManifest, build, manifest } from "../helpers/builders.js";

/**
 * Golden vectors freeze the hash encoding documented in docs/DOMAIN.md section 6. If one of these
 * fails, the encoding changed and every stored snapshot hash would stop matching: that is a breaking
 * change for stage B, not a test to update casually.
 *
 * The three hashes below were also reproduced by an independent implementation of the documented
 * encoding (a short Python script using sorted-key compact JSON and hashlib.sha256), so they check the
 * specification and not just this code.
 */
describe("golden hash vectors (frozen encoding)", () => {
  it("the empty graph has a fixed graph hash", () => {
    expect(build(manifest([], [])).hash).toBe("sha256:80dffb6b2387c8f42c609e0850eeb3fb05885ae0713aa420c6df8e42188027e5");
  });

  it("the reference billing manifest has fixed graph and manifest hashes", () => {
    const graph = build(billingManifest());
    expect(graph.hash).toBe("sha256:ddcd86c69d34ba3ca79e5d1644b784801584798e242f8eb4a6efb617f09285b5");
    expect(graph.manifest_hash).toBe("sha256:f61d2cff96723281bca3acee9fecb27bd5175130b7c078a4f6b38ac8e5d2b9f9");
  });

  it("canonical JSON of a small document is byte for byte fixed", () => {
    expect(canonicalJson({ z: [1, { b: true, a: null }], a: "xé" })).toBe('{"a":"xé","z":[1,{"a":null,"b":true}]}');
  });
});
