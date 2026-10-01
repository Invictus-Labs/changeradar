import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_AWS_KEY, FAKE_GITHUB_TOKEN, FAKE_PRIVATE_KEY, FAKE_URL_WITH_PASSWORD } from "../helpers/fake-secrets.js";

const script = resolve(import.meta.dirname, "../../scripts/hygiene-scan.mjs");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scan(files: Record<string, string>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-hygiene-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const run = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", CR_SCAN_ROOT: dir, ...env }, encoding: "utf8" });
  return { code: run.status, out: run.stdout + run.stderr };
}

describe("scripts/hygiene-scan.mjs (secret and content hygiene of the gate)", () => {
  it("passes a clean tree", () => {
    const result = scan({ "README.md": "Open http://localhost:8797 and mail ops@example.test\n", "src/a.ts": "export const a = 1;\n" });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("0 findings");
  });

  it("SEEDED NEGATIVE CONTROL: every planted violation turns the scan red, with file and line", () => {
    const result = scan({
      "docs/a.md": `see ${"/Us"}${"ers/somebody/project"}\n`,
      "src/key.ts": `const k = "${FAKE_AWS_KEY}";\n`,
      "src/token.ts": `\nconst t = "${FAKE_GITHUB_TOKEN}";\n`,
      "src/pem.txt": `${FAKE_PRIVATE_KEY}\n`,
      "docs/mail.md": "write to " + ["real", "person"].join(".") + "@" + ["gmail", "com"].join(".") + "\n",
      "docs/ip.md": "server at 10.1.2.3\n",
      "src/db.ts": `const url = "${FAKE_URL_WITH_PASSWORD}";\n`,
      ".env": "X=1\n",
      ".github/workflows/ci.yml": "on: push\n",
      "fixtures/f.json": '{"id":"123e4567-e89b-12d3-a456-426614174000"}\n',
    });
    expect(result.code).toBe(1);
    for (const expected of ["docs/a.md:1", "src/key.ts:1", "src/token.ts:2", "src/pem.txt:1", "docs/mail.md:1", "docs/ip.md:1", "src/db.ts:1", ".env:", ".github/workflows/ci.yml:", "fixtures/f.json:1"]) {
      expect(result.out, expected).toContain(expected);
    }
  });

  it("does not flag loopback, documentation addresses or example domains, and honours CR_FORBID_TOKENS", () => {
    const files = { "a.md": "http://127.0.0.1:8797 192.0.2.7 https://example.invalid/x a@example.com\n" };
    expect(scan(files).code).toBe(0);
    const forbidden = scan(files, { CR_FORBID_TOKENS: "example.invalid" });
    expect(forbidden.code).toBe(1);
    expect(forbidden.out).toContain("forbidden token");
  });
});
