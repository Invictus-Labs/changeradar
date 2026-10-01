import { describe, expect, it } from "vitest";
import { FetchError, pinnedLookup, safeFetch, safePost } from "../../src/workers/safe-fetch.js";
import {
  checkUrlAgainstAllowlist,
  classifyAddress,
  EgressDeniedError,
  parseAllowlist,
  systemResolver,
  vetDestination,
  type HostResolver,
} from "../../src/workers/ssrf.js";
import { startFixture } from "../helpers/fixture-server.js";

const resolverFor = (map: Record<string, string[]>): HostResolver => async (host) => {
  const answers = map[host];
  if (!answers) throw new Error("ENOTFOUND");
  return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

describe("classifyAddress (which destinations are reachable at all)", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["2606:4700:4700::1111", "public"],
    ["127.0.0.1", "private"],
    ["127.255.255.254", "private"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["198.18.0.1", "private"],
    ["::1", "private"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["169.254.169.254", "blocked"],
    ["169.254.0.1", "blocked"],
    ["0.0.0.0", "blocked"],
    ["0.1.2.3", "blocked"],
    ["224.0.0.1", "blocked"],
    ["255.255.255.255", "blocked"],
    ["240.0.0.1", "blocked"],
    ["192.0.0.1", "blocked"],
    ["192.0.2.10", "blocked"],
    ["198.51.100.7", "blocked"],
    ["203.0.113.9", "blocked"],
    ["::", "blocked"],
    ["fe80::1", "blocked"],
    ["ff02::1", "blocked"],
    ["::ffff:127.0.0.1", "blocked"],
    ["::ffff:8.8.8.8", "blocked"],
    ["64:ff9b::7f00:1", "blocked"],
    ["2002:7f00:1::1", "blocked"],
    ["2001:db8::1", "blocked"],
    ["fec0::1", "blocked"],
    ["feff::1", "blocked"],
    ["3fff::1", "blocked"],
    ["3fff:fff:ffff::1", "blocked"],
    ["2001:2::1", "blocked"],
    ["2001:10::1", "blocked"],
    ["2001:1f:ffff::1", "blocked"],
    ["2001:4860:4860::8888", "public"],
    ["2a00:1450:4001:80b::200e", "public"],
    ["not-an-ip", "blocked"],
    ["", "blocked"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("allowlist syntax", () => {
  it("parses hosts, ports, wildcards and IPv6 literals, dropping malformed entries", () => {
    expect(parseAllowlist(["Example.com", "api.example.com:8443", "*.internal.test", "[::1]:9000", "[::1]", " ", "bad:port:extra", "host:0", "host:70000", "host:abc", ":80"])).toEqual([
      { host: "example.com", port: null, wildcard: false },
      { host: "api.example.com", port: 8443, wildcard: false },
      { host: "internal.test", port: null, wildcard: true },
      { host: "::1", port: 9000, wildcard: false },
      { host: "::1", port: null, wildcard: false },
    ]);
  });

  it("allows exact hosts on default ports, explicit ports only where listed, and wildcard subdomains but not the apex", () => {
    const allow = ["example.com", "api.example.com:8443", "*.svc.test"];
    expect(checkUrlAgainstAllowlist("https://example.com/x", allow).hostname).toBe("example.com");
    expect(checkUrlAgainstAllowlist("http://example.com/x", allow).hostname).toBe("example.com");
    expect(checkUrlAgainstAllowlist("https://EXAMPLE.com./x", allow).hostname).toBe("example.com.");
    expect(checkUrlAgainstAllowlist("https://api.example.com:8443/x", allow).port).toBe("8443");
    expect(checkUrlAgainstAllowlist("https://a.svc.test/x", allow).hostname).toBe("a.svc.test");
    expect(checkUrlAgainstAllowlist("https://a.b.svc.test/x", allow).hostname).toBe("a.b.svc.test");
    const denied = (url: string, code: string) => {
      try {
        checkUrlAgainstAllowlist(url, allow);
        throw new Error("expected a denial");
      } catch (error) {
        expect(error).toBeInstanceOf(EgressDeniedError);
        expect((error as EgressDeniedError).code).toBe(code);
      }
    };
    denied("https://svc.test/x", "HOST_NOT_ALLOWED");
    denied("https://evil-example.com/x", "HOST_NOT_ALLOWED");
    denied("https://example.com.evil.test/x", "HOST_NOT_ALLOWED");
    denied("https://example.com:8443/x", "PORT_NOT_ALLOWED");
    denied("https://api.example.com/x", "PORT_NOT_ALLOWED");
    denied("ftp://example.com/x", "SCHEME_NOT_ALLOWED");
    denied("file:///etc/passwd", "SCHEME_NOT_ALLOWED");
    denied("https://user:pw@example.com/x", "CREDENTIALS_IN_URL");
    denied("https://user@example.com/x", "CREDENTIALS_IN_URL");
    denied("not a url", "INVALID_URL");
    denied("http://", "INVALID_URL");
  });

  it("an empty allowlist denies everything", () => {
    expect(() => checkUrlAgainstAllowlist("https://example.com/", [])).toThrow(EgressDeniedError);
  });

  it("matches IP literals only when listed exactly", () => {
    expect(checkUrlAgainstAllowlist("http://8.8.8.8/", ["8.8.8.8"]).hostname).toBe("8.8.8.8");
    expect(checkUrlAgainstAllowlist("http://[::1]:9000/", ["[::1]:9000"]).port).toBe("9000");
    expect(() => checkUrlAgainstAllowlist("http://8.8.4.4/", ["8.8.8.8"])).toThrow(/allowlist/);
  });
});

describe("vetDestination: allowlist, then DNS, every address checked, connection pinned", () => {
  const policy = { allowedHosts: ["check.example.test", "127.0.0.1", "[::1]", "10.1.2.3", "169.254.169.254"], allowPrivateNetwork: false };

  it("accepts a public resolution and returns the address to connect to", async () => {
    const vetted = await vetDestination("https://check.example.test/x", policy, resolverFor({ "check.example.test": ["93.184.216.34", "2606:2800:220:1::1"] }));
    expect(vetted.address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(vetted.hostname).toBe("check.example.test");
  });

  it("refuses a name that resolves to loopback or a private range (even though the name is allowlisted)", async () => {
    for (const answer of ["127.0.0.1", "10.0.0.1", "192.168.0.10", "::1", "fd00::1"]) {
      await expect(vetDestination("https://check.example.test/", policy, resolverFor({ "check.example.test": [answer] }))).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    }
  });

  it("refuses when ANY answer is unacceptable (a mixed public/private answer is a rebinding shape)", async () => {
    await expect(vetDestination("https://check.example.test/", policy, resolverFor({ "check.example.test": ["93.184.216.34", "127.0.0.1"] }))).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("refuses allowlisted IP literals in private and metadata space", async () => {
    await expect(vetDestination("http://127.0.0.1/", policy)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("http://[::1]/", policy)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("http://10.1.2.3/", policy)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("http://169.254.169.254/latest/meta-data", policy)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("the test-only override permits loopback and private space but never metadata, unspecified or mapped addresses", async () => {
    const test = { ...policy, allowPrivateNetwork: true };
    expect((await vetDestination("http://127.0.0.1/", test)).address.address).toBe("127.0.0.1");
    expect((await vetDestination("http://10.1.2.3/", test)).address.address).toBe("10.1.2.3");
    expect((await vetDestination("http://[::1]/", test)).address.family).toBe(6);
    await expect(vetDestination("http://169.254.169.254/", test)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("https://check.example.test/", test, resolverFor({ "check.example.test": ["::ffff:127.0.0.1"] }))).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("https://check.example.test/", test, resolverFor({ "check.example.test": ["0.0.0.0"] }))).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("resolution failures and empty answers are refusals, not passes", async () => {
    await expect(vetDestination("https://check.example.test/", policy, resolverFor({}))).rejects.toMatchObject({ code: "RESOLUTION_FAILED" });
    await expect(vetDestination("https://check.example.test/", policy, async () => [])).rejects.toMatchObject({ code: "RESOLUTION_FAILED" });
  });

  it("DNS is re-checked on every call: an answer that changes from public to private is refused the second time", async () => {
    let calls = 0;
    const rebinding: HostResolver = async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    await expect(vetDestination("https://check.example.test/", policy, rebinding)).resolves.toBeDefined();
    await expect(vetDestination("https://check.example.test/", policy, rebinding)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("the system resolver resolves localhost and that loopback answer is refused without the override", async () => {
    const answers = await systemResolver("localhost");
    expect(answers.length).toBeGreaterThan(0);
    await expect(vetDestination("http://localhost:8080/", { allowedHosts: ["localhost:8080"], allowPrivateNetwork: false })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(vetDestination("http://localhost:8080/", { allowedHosts: ["localhost:8080"], allowPrivateNetwork: true })).resolves.toBeDefined();
  });
});

describe("pinnedLookup ignores DNS and always answers with the vetted address", () => {
  it("answers both node lookup conventions", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    const single: unknown[] = [];
    lookup("evil.example", {}, ((...args: unknown[]) => single.push(...args)) as never);
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all: unknown[] = [];
    lookup("evil.example", { all: true }, ((...args: unknown[]) => all.push(...args)) as never);
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});

describe("safeFetch against a FIXTURE server (a real HTTP path)", () => {
  it("connects to the vetted address, sends the host name in the Host header, and only ever sends GET or HEAD", async () => {
    const fx = await startFixture();
    try {
      const policy = { allowedHosts: [`fixture.example.test:${fx.port}`], allowPrivateNetwork: true };
      // The name only exists in this fake resolver: reaching the fixture proves the connection is pinned to it.
      const resolver = resolverFor({ "fixture.example.test": ["127.0.0.1"] });
      const get = await safeFetch(`http://fixture.example.test:${fx.port}/ok`, { method: "GET", policy, resolver, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3 });
      expect(get.status).toBe(200);
      expect(JSON.parse(get.body.toString("utf8"))).toMatchObject({ invoice_id: "inv-1" });
      expect(get.contentType).toContain("application/json");
      const head = await safeFetch(`http://fixture.example.test:${fx.port}/ok`, { method: "HEAD", policy, resolver, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3 });
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(fx.requests.map((r) => r.method)).toEqual(["GET", "HEAD"]);
      expect(fx.requests[0]?.host).toBe(`fixture.example.test:${fx.port}`);
      expect(fx.requests.every((r) => r.authorization === undefined)).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it("follows allowlisted redirects, refuses redirects to hosts that are not allowed, and bounds redirect chains", async () => {
    const fx = await startFixture({ redirectTo: () => "http://192.0.2.1/elsewhere" });
    try {
      const base = { method: "GET" as const, policy: { allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true }, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3 };
      const followed = await safeFetch(`${fx.origin}/redirect-to-ok`, base);
      expect(followed).toMatchObject({ status: 200, redirects: 1, finalUrl: `${fx.origin}/ok` });
      await expect(safeFetch(`${fx.origin}/redirect-elsewhere`, base)).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
      await expect(safeFetch(`${fx.origin}/redirect-loop`, base)).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
      await expect(safeFetch(`${fx.origin}/redirect-no-location`, base)).rejects.toMatchObject({ code: "BAD_REDIRECT" });
      await expect(safeFetch(`${fx.origin}/redirect-bad-location`, base)).rejects.toMatchObject({ code: "BAD_REDIRECT" });
      await expect(safeFetch(`${fx.origin}/redirect-to-ok`, { ...base, maxRedirects: 0 })).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    } finally {
      await fx.close();
    }
  });

  it("a redirect to a loopback address is refused when the private override is off, even if the host is allowlisted", async () => {
    const fx = await startFixture();
    try {
      await expect(
        safeFetch(`${fx.origin}/ok`, { method: "GET", policy: { allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: false }, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3 }),
      ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
      expect(fx.requests).toEqual([]); // nothing was even sent
    } finally {
      await fx.close();
    }
  });

  it("enforces the body size limit by header and while streaming, and the per-request timeout", async () => {
    const fx = await startFixture();
    try {
      const base = { method: "GET" as const, policy: { allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true }, timeoutMs: 2000, maxBodyBytes: 1024 * 1024, maxRedirects: 3 };
      await expect(safeFetch(`${fx.origin}/huge`, base)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
      await expect(safeFetch(`${fx.origin}/huge-chunked`, base)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
      const started = Date.now();
      await expect(safeFetch(`${fx.origin}/hang`, { ...base, timeoutMs: 150 })).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await fx.close();
    }
  });

  it("an abort signal stops the request, an already aborted signal never sends one, and connection failures carry a class only", async () => {
    const fx = await startFixture();
    try {
      const base = { method: "GET" as const, policy: { allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true }, timeoutMs: 5000, maxBodyBytes: 4096, maxRedirects: 3 };
      const controller = new AbortController();
      const pending = safeFetch(`${fx.origin}/hang`, { ...base, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      const before = fx.requests.length;
      const already = new AbortController();
      already.abort();
      await expect(safeFetch(`${fx.origin}/ok`, { ...base, signal: already.signal })).rejects.toMatchObject({ code: "ABORTED" });
      expect(fx.requests.length).toBe(before);
      const dead = await startFixture();
      const port = dead.port;
      await dead.close();
      await expect(safeFetch(`http://127.0.0.1:${port}/ok`, { ...base, policy: { allowedHosts: [`127.0.0.1:${port}`], allowPrivateNetwork: true } })).rejects.toMatchObject({ code: "NETWORK", message: expect.stringMatching(/^connection failed \(ECONNREFUSED\)$/) });
    } finally {
      await fx.close();
    }
  });

  it("credentials are sent on the first hop and dropped when a redirect changes origin", async () => {
    const origin2 = await startFixture({ bearer: "s3cret-token-planted" });
    const origin1 = await startFixture({ redirectTo: () => `${origin2.origin}/auth` });
    try {
      const policy = { allowedHosts: [`127.0.0.1:${origin1.port}`, `127.0.0.1:${origin2.port}`], allowPrivateNetwork: true };
      const res = await safeFetch(`${origin1.origin}/redirect-elsewhere`, { method: "GET", policy, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3, authorization: "Bearer s3cret-token-planted" });
      expect(origin1.requests[0]?.authorization).toBe("Bearer s3cret-token-planted");
      expect(origin2.requests[0]?.authorization).toBeUndefined();
      expect(res.status).toBe(401);
      // Same-origin redirects keep the credential.
      await safeFetch(`${origin1.origin}/redirect-to-ok`, { method: "GET", policy, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3, authorization: "Bearer x" });
      expect(origin1.requests.filter((r) => r.url === "/ok").every((r) => r.authorization === "Bearer x")).toBe(true);
    } finally {
      await origin1.close();
      await origin2.close();
    }
  });

  it("safePost delivers a JSON body under the same guards and never follows redirects", async () => {
    const received: string[] = [];
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push(`${req.method} ${req.headers["content-type"]} ${Buffer.concat(chunks).toString("utf8")}`);
        if (req.url === "/redirect") {
          res.writeHead(307, { location: "/elsewhere" });
          return void res.end();
        }
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const options = { policy: { allowedHosts: [`127.0.0.1:${port}`], allowPrivateNetwork: true }, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 3 };
      const ok = await safePost(`http://127.0.0.1:${port}/sink`, Buffer.from('{"a":1}'), options);
      expect(ok.status).toBe(204);
      expect(received[0]).toBe('POST application/json {"a":1}');
      await expect(safePost(`http://127.0.0.1:${port}/redirect`, Buffer.from("{}"), options)).rejects.toBeInstanceOf(FetchError);
      await expect(safePost(`http://127.0.0.1:${port}/sink`, Buffer.from("{}"), { ...options, policy: { allowedHosts: [`127.0.0.1:${port}`], allowPrivateNetwork: false } })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });
});
