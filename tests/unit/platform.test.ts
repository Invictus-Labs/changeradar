import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFromConfig, loadConfig } from "../../src/platform/config.js";
import { defaultSettings } from "../../src/platform/context.js";
import { decodeCursor, encodeCursor, parseLimit } from "../../src/platform/cursor.js";
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, safeEqual, SecretBox, sha256Hex, verifyPassword } from "../../src/platform/crypto.js";
import { diagnosticsFor, emitDiagnostic, silentDiagnostics } from "../../src/platform/diagnostics.js";
import { AppError, fromDomainError } from "../../src/platform/errors.js";
import { hasControlChars, isUuid } from "../../src/platform/ids.js";
import { RateLimiter } from "../../src/platform/rate-limit.js";
import { InvalidRunTransitionError, StaleBaselineError } from "../../src/domain/errors.js";
import { FAKE_AWS_KEY } from "../helpers/fake-secrets.js";
import { UUID_ZERO } from "../helpers/ids.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const baseEnv = { CHANGERADAR_DATABASE_URL: "pglite:memory", CHANGERADAR_ENCRYPTION_KEY: KEY };

describe("SecretBox (encryption at rest with an operator-managed key)", () => {
  const box = new SecretBox(Buffer.alloc(32, 1));

  it("round trips, uses a fresh nonce every time and never stores plaintext", () => {
    const a = box.encrypt("hello secret");
    const b = box.encrypt("hello secret");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain("hello");
    expect(box.decrypt(a)).toBe("hello secret");
    expect(box.decrypt(box.encrypt(""))).toBe("");
    expect(box.decrypt(box.encrypt("ünïcödé ✓"))).toBe("ünïcödé ✓");
  });

  it("refuses the wrong key, a tampered ciphertext or tag, and unknown formats", () => {
    const sealed = box.encrypt("value");
    expect(() => new SecretBox(Buffer.alloc(32, 2)).decrypt(sealed)).toThrow();
    const [v, iv, tag, ct] = sealed.split(":") as [string, string, string, string];
    expect(() => box.decrypt([v, iv, tag, Buffer.from("xxxxxxxx").toString("base64")].join(":"))).toThrow();
    expect(() => box.decrypt([v, iv, Buffer.alloc(16).toString("base64"), ct].join(":"))).toThrow();
    expect(() => box.decrypt(`v2:${iv}:${tag}:${ct}`)).toThrow(/unsupported secret format/);
    expect(() => box.decrypt("v1:only")).toThrow(/unsupported secret format/);
    expect(() => box.decrypt("")).toThrow();
  });

  it("requires exactly 32 key bytes and a configured key", () => {
    expect(() => new SecretBox(Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => new SecretBox(Buffer.alloc(33))).toThrow(/32 bytes/);
    expect(() => SecretBox.fromBase64(undefined)).toThrow(/ENCRYPTION_KEY is required/);
    expect(() => SecretBox.fromBase64("")).toThrow(/required/);
    expect(() => SecretBox.fromBase64("c2hvcnQ=")).toThrow(/32 bytes/);
    expect(SecretBox.fromBase64(KEY).encrypt("x")).toMatch(/^v1:/);
  });

  it("mac is deterministic, keyed and purpose separated", () => {
    expect(box.mac("csrf", "t")).toBe(box.mac("csrf", "t"));
    expect(box.mac("csrf", "t")).not.toBe(box.mac("other", "t"));
    expect(box.mac("csrf", "t")).not.toBe(box.mac("csrf", "u"));
    expect(new SecretBox(Buffer.alloc(32, 2)).mac("csrf", "t")).not.toBe(box.mac("csrf", "t"));
    expect(box.mac("a", "b\nc")).not.toBe(box.mac("a\nb", "c")); // purpose and value cannot be shifted into each other
  });
});

describe("password hashing and token helpers", () => {
  it("hashes with a random salt, verifies, and rejects wrong or malformed input", async () => {
    const one = await hashPassword("correct horse battery");
    const two = await hashPassword("correct horse battery");
    expect(one).not.toBe(two);
    expect(one).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", one)).toBe(true);
    expect(await verifyPassword("correct horse batterx", one)).toBe(false);
    expect(await verifyPassword("", one)).toBe(false);
    for (const bad of ["", "plain", "bcrypt$1$2$3$4$5", "scrypt$16384$8$1$AA==", "scrypt$16384$8$1$$"]) expect(await verifyPassword("x", bad)).toBe(false);
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false); // costs the same time, never matches
  });

  it("safeEqual compares in constant shape and sha256Hex/randomToken behave", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(sha256Hex("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(8)).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("loadConfig", () => {
  it("requires the database URL and the encryption key, naming what is missing", () => {
    expect(() => loadConfig({})).toThrow(/CHANGERADAR_DATABASE_URL, CHANGERADAR_ENCRYPTION_KEY/);
    expect(() => loadConfig({ CHANGERADAR_DATABASE_URL: "x" })).toThrow(/CHANGERADAR_ENCRYPTION_KEY/);
  });

  it("defaults: bind 127.0.0.1, port 8797, PRD limits, retention defaults, checks closed", () => {
    const c = loadConfig(baseEnv);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8797, logRequests: false });
    expect(c.settings).toMatchObject({
      maxManifestBytes: 25 * 1024 * 1024,
      maxNodes: 10_000,
      maxEdges: 50_000,
      idempotencyRetentionDays: 7,
      eventSinkUrl: null,
      secureCookies: true,
      retention: { evidenceDays: 90, deletionHours: 24, backupExpiryDays: 30 },
      checks: { allowedHosts: [], allowPrivateNetwork: false, maxRedirects: 3 },
    });
  });

  it("reads overrides, lower-cases the allowlist and treats http public URLs as plain-cookie deployments", () => {
    const c = loadConfig({
      ...baseEnv,
      CHANGERADAR_HOST: "0.0.0.0",
      CHANGERADAR_PORT: "9000",
      CHANGERADAR_PUBLIC_URL: "http://localhost:9000",
      CHANGERADAR_LOG: "1",
      CHANGERADAR_CHECK_ALLOWED_HOSTS: "API.Example.com, *.Svc.test:8443 ,,",
      CHANGERADAR_CHECK_ALLOW_PRIVATE_NETWORK: "true",
      CHANGERADAR_EVENT_SINK_URL: "https://sink.example.test/hook",
      CHANGERADAR_MAX_NODES: "50",
      CHANGERADAR_RATE_LIMIT_PER_MINUTE: "5",
      CHANGERADAR_RETENTION_EVIDENCE_DAYS: "30",
      CHANGERADAR_IDEMPOTENCY_RETENTION_DAYS: "14",
    });
    expect(c).toMatchObject({ host: "0.0.0.0", port: 9000, logRequests: true });
    expect(c.settings.secureCookies).toBe(false);
    expect(c.settings.checks.allowedHosts).toEqual(["api.example.com", "*.svc.test:8443"]);
    expect(c.settings.checks.allowPrivateNetwork).toBe(true);
    expect(c.settings.eventSinkUrl).toBe("https://sink.example.test/hook");
    expect(c.settings.maxNodes).toBe(50);
    expect(c.settings.rateLimit.apiPerPrincipal).toBe(5);
    expect(c.settings.retention.evidenceDays).toBe(30);
    expect(c.settings.idempotencyRetentionDays).toBe(14);
    expect(loadConfig({ ...baseEnv, CHANGERADAR_PUBLIC_URL: "https://cr.example.test" }).settings.secureCookies).toBe(true);
  });

  it("rejects invalid values with the variable name", () => {
    const bad: [string, string][] = [
      ["CHANGERADAR_PORT", "0"],
      ["CHANGERADAR_PORT", "70000"],
      ["CHANGERADAR_PORT", "abc"],
      ["CHANGERADAR_MAX_NODES", "20000"],
      ["CHANGERADAR_MAX_EDGES", "0"],
      ["CHANGERADAR_MAX_MANIFEST_BYTES", "99999999999"],
      ["CHANGERADAR_MAX_MANIFEST_BYTES", "10"],
      ["CHANGERADAR_IDEMPOTENCY_RETENTION_DAYS", "6"],
      ["CHANGERADAR_SESSION_TTL_SECONDS", "1"],
      ["CHANGERADAR_JOB_LEASE_SECONDS", "1"],
      ["CHANGERADAR_CHECK_MAX_TIMEOUT_MS", "999999"],
      ["CHANGERADAR_MAX_BUNDLE_BYTES", "5"],
      ["CHANGERADAR_RETENTION_DELETION_HOURS", "0"],
    ];
    for (const [key, value] of bad) expect(() => loadConfig({ ...baseEnv, [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    expect(() => loadConfig({ ...baseEnv, CHANGERADAR_HOST: "  " })).toThrow(/HOST must not be empty/);
    expect(() => loadConfig({ ...baseEnv, CHANGERADAR_PUBLIC_URL: "ftp://x.test" })).toThrow(/http or https/);
    expect(() => loadConfig({ ...baseEnv, CHANGERADAR_EVENT_SINK_URL: "ftp://x.test" })).toThrow(/http or https/);
    expect(() => loadConfig({ ...baseEnv, CHANGERADAR_DATABASE_PASSWORD: "p" })).toThrow(/requires PostgreSQL/);
  });

  it("merges a separately supplied database password, with delimiter encoding", () => {
    const c = loadConfig({ CHANGERADAR_DATABASE_URL: "postgres://cr@db:5432/cr", CHANGERADAR_ENCRYPTION_KEY: KEY, CHANGERADAR_DATABASE_PASSWORD: "p@ss/w:rd#1" });
    expect(new URL(c.databaseUrl).password).toBe(encodeURIComponent("p@ss/w:rd#1"));
    expect(new URL(c.databaseUrl).username).toBe("cr");
  });

  it("builds a not-yet-ready context on the embedded database", async () => {
    const ctx = await contextFromConfig(loadConfig(baseEnv));
    try {
      expect(ctx.readiness).toEqual({ ok: false, reason: "starting" });
      expect(ctx.db.kind).toBe("pglite");
      expect(ctx.settings.retention.evidenceDays).toBe(90);
    } finally {
      await ctx.db.close();
    }
    expect(defaultSettings.checks.allowPrivateNetwork).toBe(false);
  });

  it("refuses an unknown database URL scheme", async () => {
    const { openDatabase } = await import("../../src/db/index.js");
    await expect(openDatabase("mysql://x")).rejects.toThrow(/must start with postgres/);
  });
});

describe("pagination helpers", () => {
  it("encodes and decodes typed cursor tuples and treats any malformed cursor as 400", () => {
    const cursor = encodeCursor(["2026-01-01T00:00:00.000Z", "id-1", 7]);
    expect(decodeCursor(cursor, ["string", "string", "number"])).toEqual(["2026-01-01T00:00:00.000Z", "id-1", 7]);
    expect(decodeCursor(undefined, ["string"])).toBeNull();
    expect(decodeCursor("", ["string"])).toBeNull();
    const bad = [cursor, "!!", Buffer.from("{}").toString("base64url"), Buffer.from("[1]").toString("base64url"), "a".repeat(513)];
    for (const c of bad.slice(1)) expect(() => decodeCursor(c, ["string", "string", "number"]), c.slice(0, 12)).toThrow(AppError);
    expect(() => decodeCursor(cursor, ["string"])).toThrow(/cursor is not valid/);
    expect(() => decodeCursor(cursor, ["string", "string", "string"])).toThrow(/cursor is not valid/);
  });

  it("parseLimit defaults to 50, allows 1 to 100 and rejects everything else", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
    for (const bad of ["0", "101", "-3", "1.5", "abc", "", " 5", "5 ", "10000", "1e2"]) expect(() => parseLimit(bad), bad).toThrow(/limit must be an integer/);
  });
});

describe("RateLimiter", () => {
  it("allows the budget, then reports seconds to wait, then resets with the window", () => {
    const limiter = new RateLimiter(2, 10_000);
    expect(limiter.take("k", 0)).toBeNull();
    expect(limiter.take("k", 1000)).toBeNull();
    expect(limiter.take("k", 2000)).toBe(8);
    expect(limiter.take("k", 9999)).toBe(1);
    expect(limiter.take("k", 10_000)).toBeNull();
    expect(limiter.take("other", 10_000)).toBeNull();
  });

  it("at capacity never evicts a THROTTLED bucket (fails closed when all are), and recovers as buckets expire", () => {
    // Round 4: an idle bucket (not over its limit) now makes room instead of refusing every new key (see review-round4-rate-limit.test.ts);
    // a bucket that IS over its limit is never forgotten, so throttling cannot be reset by filling the table.
    const limiter = new RateLimiter(1, 1000, 2);
    expect(limiter.take("a", 0)).toBeNull();
    expect(limiter.take("a", 1)).toBe(1); // a is over its limit
    expect(limiter.take("b", 2)).toBeNull();
    expect(limiter.take("b", 3)).toBe(1); // b is over its limit
    expect(limiter.take("c", 4)).toBe(1); // table full of throttled buckets: refuse rather than forget a or b
    expect(limiter.take("a", 10)).toBe(1); // a is still limited
    expect(limiter.take("c", 1000)).toBeNull(); // expired buckets freed the room
  });
});

describe("diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits JSON lines with redaction, and filters info entries unless request logging is on", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    emitDiagnostic({ event: "x", level: "warn", code: FAKE_AWS_KEY });
    diagnosticsFor(false)({ event: "quiet", level: "info" });
    diagnosticsFor(false)({ event: "loud", level: "error" });
    diagnosticsFor(true)({ event: "verbose", level: "info" });
    silentDiagnostics({ event: "never", level: "error" });
    const parsed = writes.map((w) => JSON.parse(w));
    expect(parsed.map((p) => p.event)).toEqual(["x", "loud", "verbose"]);
    expect(parsed[0].code).toBe("[REDACTED]");
    expect(parsed[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(writes.join("")).not.toContain(FAKE_AWS_KEY);
  });
});

describe("errors and ids", () => {
  it("maps typed domain errors onto envelope errors", () => {
    const stale = fromDomainError(new StaleBaselineError("a", "b"));
    expect(stale).toMatchObject({ status: 409, code: "STALE_BASELINE" });
    expect(fromDomainError(new InvalidRunTransitionError("COMPLETE", "RUNNING"))).toMatchObject({ status: 409, code: "INVALID_RUN_TRANSITION" });
  });
  it("validates UUIDs and control characters", () => {
    expect(isUuid(UUID_ZERO)).toBe(true);
    for (const bad of ["", "x", 5, null, undefined, UUID_ZERO.slice(0, -1) + "G", UUID_ZERO + "0", UUID_ZERO + " "]) expect(isUuid(bad)).toBe(false);
    expect(hasControlChars("ok text")).toBe(false);
    expect(hasControlChars("bad\ntext")).toBe(true);
    expect(hasControlChars("nul\u0000")).toBe(true);
    expect(hasControlChars("del\u007f")).toBe(true);
  });
});
