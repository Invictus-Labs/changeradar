import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OVERSIZE_REDACTED, containsSecret, detectSecretKinds, redactDeep, redactIdentifier, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 2 regression tests for the redactor (security and test-adequacy findings). Every literal that could look
 * like a credential is assembled from fragments at run time, and none is real. Each block names its finding.
 */
const join = (...parts: string[]): string => parts.join("");
const CORE = "aB3dE6gH9jK2mN5pQ8sT1vX4";
const here = dirname(fileURLToPath(import.meta.url));
const probe = resolve(here, "../helpers/redact-probe.ts");

describe("R2 P1 (redaction.ts:248): a quoted value with an ESCAPED quote is redacted through the real closing quote", () => {
  const value = "Zq8vK2mXp4Lw9RtY7nBcJd3f";
  const key = join("pass", "word");
  const forms: [string, string][] = [
    ["double quotes, escaped quote inside", `${key}="ab\\"${value}"`],
    ["single quotes, escaped quote inside", `${key}='ab\\'${value}'`],
    ["escaped pair then more", `${key}="ab\\\\\\"${value}"`],
    ["JSON text of a string holding the assignment", JSON.stringify(`${key}="ab\\"${value}"`)],
    ["escaped-quote opened (JSON inside JSON)", `{\\"${key}\\":\\"ab${value}\\"}`],
    ["escaped quote first in the value", `${key}="\\"${value}"`],
    ["no closing quote at all (fail closed to the end of the line)", `${key}="ab\\"${value}`],
    ["owner sentence, as in the review scenario", `pw: ${key}="ab\\"${value}" for the batch job`],
  ];
  for (const [name, text] of forms) {
    it(`${name}: the tail of the value never survives`, () => {
      expect(redactSecrets(text), text).not.toContain(value);
      expect(redactSecrets(text)).toContain("[REDACTED]");
    });
  }

  it("the validator refuses the escaped form when the value looks random", () => {
    expect(detectSecretKinds(`${key}="ab\\"${value}"`)).toContain("credential_assignment");
  });

  it("text after the real closing quote is kept", () => {
    expect(redactSecrets(`${key}="ab\\"${value}" and then ordinary words`)).toContain("and then ordinary words");
  });
});

describe("R2 P1 (redaction.ts:53): a shape is recognised whatever glues to its front", () => {
  const prefixes = ["", "0", "a", "Z", "_", "-", ".", "%20", "%0A", "\\n", "\\t", "\\r\\n", "x%20", "team a\\n"];
  const shapes: [string, string, string][] = [
    ["Bearer", `${join("Bear", "er")} ${CORE}`, CORE],
    ["Basic", `${join("Ba", "sic")} ${CORE}QUJDREVGR0g=`, CORE],
    ["Cookie header", `${join("Coo", "kie")}: sid=${CORE}`, CORE],
    ["Authorization header", `${join("Author", "ization")}: Token ${CORE}`, CORE],
    ["Proxy-Authorization header", `${join("Proxy-Author", "ization")}: Basic ${CORE}`, CORE],
    ["huggingface token", join("h", "f_", CORE, "Yz"), CORE],
    ["sendgrid key", join("S", "G.", CORE, ".", CORE, "Qq"), CORE],
    ["twilio key", join("S", "K", "0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef"],
    ["twilio account sid", join("A", "C", "fedcba9876543210fedcba9876543210"), "fedcba9876543210fedcba9876543210"],
    ["aws key", join("AK", "IA", "ZZZZ0123456789AB"), "ZZZZ0123456789AB"],
    ["github token", join("gh", "p_", CORE, "Yz"), CORE],
    ["url credentials", `${join("https", "://")}svc:${CORE}@host.example/p`, CORE],
  ];
  for (const [name, shape, core] of shapes) {
    it(`${name}: found after every prefix`, () => {
      for (const prefix of prefixes) {
        // Round 3 (security finding, short prefixes inside words): the two shortest prefixes (`hf_`, `sk-`) are not matched when a plain
        // LETTER is glued to them (`risk-...`, `task-...` are ordinary words); every other glue, including the escape
        // sequences that end in a letter, still is. Every other shape in this table keeps the letter-glue expectation.
        if (name === "huggingface token" && /^[A-Za-z]$/.test(prefix)) continue;
        const text = `${prefix}${shape}`;
        expect(redactSecrets(text), `prefix ${JSON.stringify(prefix)}`).not.toContain(core);
      }
    });
  }

  it("a header dump inside JSON text (literal \\n) is redacted line by line", () => {
    const text = `{"headers":"Host: localhost\\r\\nCookie: sid=${CORE}\\r\\nAccept: */*"}`;
    expect(redactSecrets(text)).not.toContain(CORE);
  });
});

describe("R2 P2 (redaction.ts:92): every default-ignorable character and combining mark is folded away", () => {
  const token = join("gh", "p_");
  const rest = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const gaps: [string, string][] = [
    ["U+034F", "\u034f"],
    ["U+115F", "\u115f"],
    ["U+1160", "\u1160"],
    ["U+3164", "\u3164"],
    ["U+FFA0", "\uffa0"],
    ["U+2060", "\u2060"],
    ["U+FE0F", "\ufe0f"],
    ["combining acute", "\u0301"],
    ["tag character", "\u{e0041}"],
  ];
  for (const [name, gap] of gaps) {
    it(`${name} inside a github token`, () => {
      const text = `owner ${token}${rest.slice(0, 12)}${gap}${rest.slice(12)} end`;
      const out = redactSecrets(text);
      expect(out).not.toContain(rest.slice(12));
      expect(out).toBe("owner [REDACTED] end");
    });
  }
  it("text with no secret and no ignorable character is byte for byte unchanged", () => {
    const clean = "the é and 日本語 text, v1.2.3";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("R2 P2 (redaction.ts:138): PGP blocks, Cookie keys and Cookie= are recognised", () => {
  it("a PGP private key block, complete and unterminated", () => {
    const body = "lQOYBGplantedplantedplanted0123456789";
    const head = join("-----BEGIN PGP PRIV", "ATE KEY BLOCK-----");
    const tail = join("-----END PGP PRIV", "ATE KEY BLOCK-----");
    expect(redactSecrets(`x ${head}\n${body}\n${tail} y`)).toBe("x [REDACTED] y");
    expect(redactSecrets(`x ${head}\n${body}`)).not.toContain(body);
  });
  const cookie = join("Coo", "kie");
  for (const text of [
    `{"${cookie}":"sid=${CORE}"}`,
    `{"Set-${cookie}":"sid=${CORE}"}`,
    `${cookie}=sid=${CORE}`,
    `Set-${cookie}: sid=${CORE}; HttpOnly`,
  ]) {
    it(`${text.replace(CORE, "<value>")}`, () => {
      expect(redactSecrets(text)).not.toContain(CORE);
    });
  }
});

describe("R2 P2 (redaction.ts:78): benign identifiers are accepted, and an accepted id is never rewritten", () => {
  const benign = ["auth-service:v1.2.3", "service.password-reset:v2.1.0", "job.secret-rotation:nightly2", "credential:prod2024", "svc.token:refresh-service", "cookie-banner:v3"];
  for (const id of benign) {
    it(`${id}: passes the validator and survives redactIdentifier unchanged`, () => {
      expect(detectSecretKinds(id)).toEqual([]);
      expect(redactIdentifier(id)).toBe(id);
      expect(redactDeep({ node_id: id, check_id: id, id, path: [id, id] })).toEqual({ node_id: id, check_id: id, id, path: [id, id] });
    });
  }

  it("two different ids never collapse into one in a redacted view", () => {
    const a = redactDeep({ id: "svc.token:abcdef" }) as { id: string };
    const b = redactDeep({ id: "svc.token:ghijkl" }) as { id: string };
    expect(a.id).not.toBe(b.id);
  });

  it("control: log-strength redaction is still stricter than identifier strength", () => {
    expect(redactSecrets("svc.token:refresh-service")).toContain("[REDACTED]");
    expect(redactDeep({ note: "svc.token:refresh-service" })).toEqual({ note: expect.stringContaining("[REDACTED]") });
  });

  it("an identifier that IS a secret is still redacted at identifier strength", () => {
    const token = join("gh", "p_", CORE, "Yz");
    expect(redactDeep({ node_id: token })).toEqual({ node_id: "[REDACTED]" });
  });
});

describe("R2 P2 (redaction.ts:313): there are no scan windows, so nothing straddles a boundary", () => {
  const EDGE = 262_144;
  const key = join("pass", "word");
  const cookie = join("Coo", "kie");
  const shapes: [string, string, string][] = [
    ["assignment", `${key}=${CORE}`, CORE],
    ["quoted assignment", `${key}="${CORE}"`, CORE],
    ["url credentials", `${join("https", "://")}svc:${CORE}@host.example/p`, CORE],
    ["cookie header", `${cookie}: sid=${CORE}`, CORE],
    ["github token", join("gh", "p_", CORE, "Yz"), CORE],
    ["jwt", join("ey", "J", "hbGciOiJIUzI1", ".", "eyJzdWIiOiJwbGFu", ".", "c2lnbmF0dXJl01"), "c2lnbmF0dXJl01"],
  ];
  for (const [name, shape, core] of shapes) {
    it(`${name}: redacted for every start offset from 40 characters before to 8 after a 256 K boundary`, () => {
      for (const multiple of [1, 2]) {
        for (let back = 40; back >= -8; back -= 1) {
          const at = EDGE * multiple - back;
          const text = `${"a ".repeat(Math.ceil(at / 2)).slice(0, at)}${shape} tail`;
          expect(redactSecrets(text).includes(core), `${name} at ${at}`).toBe(false);
          expect(containsSecret(text), `${name} detected at ${at}`).toBe(true);
        }
      }
    });
  }
});

describe("R2 P2 (redaction.ts:116): above the size cap the redactor REFUSES, it never passes text through", () => {
  const key = join("pass", "word");
  it("a string over 8 M characters becomes the fixed placeholder, and the validator rejects it", () => {
    const huge = `${key}=${CORE} ${"a".repeat(8 * 1024 * 1024)}`;
    expect(redactSecrets(huge)).toBe(OVERSIZE_REDACTED);
    expect(detectSecretKinds(huge)).toEqual(["oversize"]);
    expect(containsSecret(huge)).toBe(true);
    expect(redactIdentifier(huge)).toBe(OVERSIZE_REDACTED);
  });

  it("text that needs folding is capped lower (512 K): a non-ASCII string above it is refused", () => {
    const wide = `${key}=${CORE} ${"é".repeat(600_000)}`;
    expect(redactSecrets(wide)).toBe(OVERSIZE_REDACTED);
    expect(detectSecretKinds(wide)).toEqual(["oversize"]);
  });

  it("just below the caps the text is scanned normally", () => {
    const ok = `${key}=${CORE} ${"é".repeat(400_000)}`;
    const out = redactSecrets(ok);
    expect(out).not.toContain(CORE);
    expect(out).not.toBe(OVERSIZE_REDACTED);
  });

  it("redactDeep of an oversized string value never returns the original", () => {
    const out = redactDeep({ note: "a".repeat(8 * 1024 * 1024 + 1) }) as { note: string };
    expect(out.note).toBe(OVERSIZE_REDACTED);
  });

  it("the placeholder is a fixed point", () => {
    expect(redactSecrets(OVERSIZE_REDACTED)).toBe(OVERSIZE_REDACTED);
  });
});

function spawnProbe(shape: string, chars: number, heapMb: number) {
  const child = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, "--import", "tsx", probe, shape, String(chars)], { encoding: "utf8", timeout: 240_000 });
  let out: { in: number; out: number; found: boolean; ms: number } | null = null;
  try {
    out = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    out = null;
  }
  return { status: child.status, signal: child.signal, out, stderr: child.stderr.slice(0, 300) };
}

describe("R2 P2 (redaction.ts:116): the cap holds in a small V8 heap", () => {
  it("9 M characters of ASCII in a 96 MB heap: refused, no abort", () => {
    const r = spawnProbe("ascii", 9_000_000, 96);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out!.found).toBe(true);
    expect(r.out!.out).toBe(OVERSIZE_REDACTED.length);
  }, 300_000);

  it("a fullwidth string of 6 M characters in a 64 MB heap: refused, no abort", () => {
    const r = spawnProbe("fullwidth", 6_000_000, 64);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out!.out).toBe(OVERSIZE_REDACTED.length);
  }, 300_000);

  it("an expander-only string just under the fold cap (U+FDFA x 500 K) in a 96 MB heap", () => {
    const r = spawnProbe("expander", 500_000, 96);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status, r.stderr).toBe(0);
  }, 300_000);
});

describe("R2 P2 (tests): hostile input scales linearly at 1 MB and 4 MB", () => {
  const units: [string, string][] = [
    ["Bearer runs", "Bearer "],
    ["jwt starts", "eyJaaaaaaaa."],
    ["scheme separators", "a://"],
    ["private key headers", "-----BEGIN "],
    ["aws prefixes", "AKIAAKIA"],
    ["backslashes", "\\"],
    ["unterminated quoted assignments", 'password="a'],
    ["escaped quotes", 'password="\\"'],
    ["cookie headers", "Cookie: "],
    ["at signs and colons", "u:p@"],
  ];
  const make = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
  const best = (fn: () => unknown): number => {
    let min = Infinity;
    for (let i = 0; i < 3; i += 1) {
      // CPU time, not wall time (a loaded host stretches the wall clock of a test, not the work it does)
      const before = process.cpuUsage();
      fn();
      const used = process.cpuUsage(before);
      min = Math.min(min, (used.user + used.system) / 1000);
    }
    return min;
  };
  for (const [name, unit] of units) {
    it(`${name}: 4x the input costs about 4x the time`, () => {
      const one = make(unit, 1 << 20);
      const four = make(unit, 4 << 20);
      for (const fn of [redactSecrets, detectSecretKinds]) {
        // The full suite runs many files at once and a garbage collection or a busy neighbour can inflate one measurement: the
        // ratio is measured up to three times (each the best of three runs) and must hold in at least one attempt. Quadratic
        // behaviour would fail every attempt (16 times for a 4 times input), so the property itself is not weakened.
        let t1 = 0;
        let t4 = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          t1 = best(() => fn(one));
          t4 = best(() => fn(four));
          if (t4 < 6_000 && (t1 < 20 || t4 / t1 < 10)) break;
        }
        expect(t4, `${fn.name} ${name} 4 MB took ${t4.toFixed(0)} ms`).toBeLessThan(6_000);
        if (t1 >= 20) expect(t4 / t1, `${fn.name} ${name}: 1 MB ${t1.toFixed(0)} ms, 4 MB ${t4.toFixed(0)} ms`).toBeLessThan(10);
      }
    });
  }
});

describe("R2 property: redaction is a fixed point and fails closed on a seeded generator of glued, escaped and quoted shapes", () => {
  let state = 0x9e3779b9;
  const rnd = (n: number): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
  const pick = <T>(items: readonly T[]): T => items[rnd(items.length)] as T;
  const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const core = (length: number): string => Array.from({ length }, () => alnum[rnd(alnum.length)]).join("") + "7Q";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const glue = ["", "", "0", "a", "_", "-", ".", "%20", "%0A", "\\n", "\\t", "x "];
  const words = ["alpha", "beta", "the", "service", "manifest", "owner", "v1.2.3", "billing", "team"];
  const key = join("pass", "word");
  const cookie = join("Coo", "kie");
  const generators: ((c: string) => string)[] = [
    (c) => `${join("Bear", "er")} ${c}`,
    (c) => `${cookie}: sid=${c}`,
    (c) => `${join("Author", "ization")}: Basic ${c}==`,
    (c) => join("gh", "p_", c),
    (c) => join("np", "m_", c),
    (c) => ` ${join("h", "f_", c)}`, // a letter glued to `hf_` is no longer a match (round 3); a space in front keeps the shape
    (c) => join("AK", "IA", c.toUpperCase().replace(/[^A-Z0-9]/g, "Z").padEnd(16, "Z").slice(0, 16)),
    (c) => `${join("https", "://")}svc:${c}@host.example/p`,
    (c) => `${key}="${c}"`,
    (c) => `${key}='ab\\'${c}'`,
    (c) => `{"${key}":"ab\\"${c}"}`,
    (c) => `${key}=${c}`,
    (c) => `${cookie}=sid=${c}`,
  ];

  it("no planted core survives, output is idempotent, and clean text is unchanged (600 rounds)", () => {
    for (let round = 0; round < 600; round += 1) {
      const parts: string[] = [];
      const cores: string[] = [];
      for (let i = 0, n = 1 + rnd(5); i < n; i += 1) {
        parts.push(pick(words));
        const c = core(20 + rnd(20));
        // An AWS key is uppercase, so its core is the padded upper-case tail.
        const shape = pick(generators)(c);
        cores.push(shape.startsWith("AKIA") || shape.includes("AKIA") ? shape.slice(shape.indexOf("AKIA") + 4) : c);
        parts.push(pick(glue) + shape);
        if (rnd(3) === 0) parts.push(pick(["\n", ", ", "; ", " | ", "\\r\\n"]));
      }
      const text = parts.join(" ");
      const out = redactSecrets(text);
      for (const c of cores) expect(out, `round ${round}: core survived in ${JSON.stringify(text)}`).not.toContain(c);
      expect(redactSecrets(out), `round ${round}: not idempotent for ${JSON.stringify(text)}`).toBe(out);
      expect(redactIdentifier(redactIdentifier(text)), `round ${round}: identifier strength not idempotent`).toBe(redactIdentifier(text));
    }
    const clean = Array.from({ length: 200 }, () => pick(words)).join(" ");
    expect(redactSecrets(clean)).toBe(clean);
    expect(detectSecretKinds(clean)).toEqual([]);
  });
});

describe("R2 idempotence (found by the round-1 seeded property test): a long AWS-shaped run is consumed whole", () => {
  const aws = join("AK", "IA");
  it("an uppercase run of any length after the prefix leaves no residue and is a fixed point", () => {
    for (const tail of [16, 17, 20, 36, 40, 64, 200]) {
      const run = aws + "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0".repeat(6).slice(0, tail);
      for (const text of [run, `x ${run} y`, `key_${run}`, `${run}=`]) {
        const once = redactSecrets(text);
        expect(once.replaceAll("[REDACTED]", ""), JSON.stringify(text)).not.toMatch(/[0-9A-Z]{8}/);
        expect(redactSecrets(once), JSON.stringify(text)).toBe(once);
      }
    }
  });

  it("the fullwidth form from the failing seed (repeated fullwidth AKIA groups) is a fixed point", () => {
    const group = "ＡＫＩＡ";
    const text = `1.2.3; ${group.repeat(10)} sid`;
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
    expect(once).not.toContain(group);
  });
});

describe("R2 P1 (redaction.ts:248): singly, doubly and triply escaped quotes (JSON.stringify layers) are redacted through the real closing quote", () => {
  const value = "Zq8vK2mXp4Lw9RtY7nBcJd3f";
  const key = join("pass", "word");
  const layer0 = `${key}="ab\\"${value}" and more`;
  const layers = [layer0, JSON.stringify(layer0), JSON.stringify(JSON.stringify(layer0)), JSON.stringify(JSON.stringify(JSON.stringify(layer0)))];
  for (const [depth, text] of layers.entries()) {
    it(`${depth} layer(s) of JSON escaping`, () => {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(value);
      expect(redactSecrets(out)).toBe(out);
    });
  }

  it("a backslash run before the closing quote: an even run closes the value, an odd run does not", () => {
    // password="abc\\" then text: the two backslashes are one escaped backslash, the quote closes the value
    const even = `${key}="${value}\\\\" then visible`;
    expect(redactSecrets(even)).toContain("then visible");
    expect(redactSecrets(even)).not.toContain(value);
    // password="abc\" then text: the quote is escaped, so the value runs on (fail closed to the end of the line)
    const odd = `${key}="${value}\\" tail${value}`;
    expect(redactSecrets(odd).includes(value)).toBe(false);
  });

  it("a long run of backslashes is linear (256 KB and 4 MB)", () => {
    const build = (n: number) => `${key}="` + "\\".repeat(n) + '"tail';
    const best = (text: string): number => {
      let min = Infinity;
      for (let i = 0; i < 3; i += 1) {
        // CPU time, not wall time, and the ratio is measured up to three times (each the best of three): quadratic behaviour fails every attempt
        const before = process.cpuUsage();
        redactSecrets(text);
        detectSecretKinds(text);
        const used = process.cpuUsage(before);
        min = Math.min(min, (used.user + used.system) / 1000);
      }
      return min;
    };
    let small = 0;
    let large = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      small = best(build(256 * 1024));
      large = best(build(4 * 1024 * 1024));
      if (large < 8_000 && (small < 5 || large / small < 40)) break;
    }
    expect(large, `4 MB took ${large.toFixed(0)} CPU ms`).toBeLessThan(8_000);
    if (small >= 5) expect(large / small, `256 KB ${small.toFixed(1)} ms, 4 MB ${large.toFixed(1)} ms`).toBeLessThan(40);
  });
});

describe("R2 P2 (validator strength): identifier fields shown in hops and coverage keep accepted ids and still redact a secret-shaped id", () => {
  const accepted = "contract.token:abcdef";
  const secretId = join("gh", "p_", CORE, "Yz");
  it("hops from/to, origin_node_ids and changed_node_ids keep an accepted id verbatim", () => {
    const view = { hops: [{ from: accepted, to: "svc.token:refresh-service", source_id: "svc.token:refresh-service", target_id: accepted }], coverage: { origin_node_ids: [accepted], changed_node_ids: [accepted] } };
    expect(redactDeep(view)).toEqual(view);
  });
  it("a secret-shaped id in those fields is still redacted", () => {
    const view = { hops: [{ from: secretId, to: accepted }], coverage: { origin_node_ids: [secretId, accepted], changed_node_ids: [secretId] } };
    const out = redactDeep(view) as { hops: { from: string; to: string }[]; coverage: { origin_node_ids: string[]; changed_node_ids: string[] } };
    expect(JSON.stringify(out)).not.toContain(CORE);
    expect(out.hops[0]!.from).toBe("[REDACTED]");
    expect(out.hops[0]!.to).toBe(accepted);
    expect(out.coverage.origin_node_ids).toEqual(["[REDACTED]", accepted]);
    expect(out.coverage.changed_node_ids).toEqual(["[REDACTED]"]);
  });
});

describe("R2: redactDeep is idempotent on hostile keys and values", () => {
  it("redactDeep(redactDeep(x)) equals redactDeep(x)", () => {
    const value = {
      [`${join("pass", "word")}=${CORE}`]: { node_id: "svc.token:refresh-service", note: `${join("Bear", "er")} ${CORE}`, list: [`${join("gh", "p_")}${CORE}Yz`, "plain"] },
      path: ["a.b:c", "svc.token:refresh-service"],
    };
    const once = redactDeep(value);
    expect(redactDeep(once)).toEqual(once);
  });
});
