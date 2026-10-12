#!/usr/bin/env node
// Secret and content hygiene scan of the tracked files. A self-contained substitute for external scanners, so the
// local gate needs nothing that is not in this repository. Exit 0 = clean, 1 = findings (each printed with file:line).
//
// Usage: node scripts/hygiene-scan.mjs [--list]      (--list prints every rule and exception and exits 0)
// Optional: CR_SCAN_ROOT scans another directory (used by the scan's own negative-control test).
// Optional: CR_FORBID_TOKENS="word1,word2" adds case-insensitive strings that must not appear anywhere (for example
// an organization slug or a private hostname that this public repository must never mention).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.CR_SCAN_ROOT ? resolve(process.env.CR_SCAN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".sql", ".yaml", ".yml", ".sh", ".txt", ".mmd", ".svg", ".example", ""]);
const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_CONTENT = new Set(["package-lock.json", "docs/DEPENDENCY-LICENSES.md"]);

// Pieces are joined at runtime so this file does not contain a literal that a scanner would flag.
const j = (...p) => p.join("");
const RULES = [
  { id: "personal-path", re: new RegExp(j("/(Us", "ers|ho", "me)/[A-Za-z0-9._-]+/")), why: "personal filesystem path", allow: (p, m) => /^\/home\/node\//.test(m) },
  { id: "windows-path", re: new RegExp(j("[A-Za-z]:\\\\Us", "ers\\\\")), why: "personal filesystem path" },
  { id: "aws-key", re: new RegExp(j("AK", "IA[0-9A-Z]{16}")), why: "cloud access key shape" },
  { id: "github-token", re: new RegExp(j("gh[pousr]", "_[A-Za-z0-9]{36,}")), why: "source host token shape" },
  { id: "stripe-key", re: new RegExp(j("sk_", "(live|test)_[A-Za-z0-9]{16,}")), why: "payment key shape" },
  { id: "slack-token", re: new RegExp(j("xo", "x[baprs]-[A-Za-z0-9-]{10,}")), why: "chat token shape" },
  { id: "private-key", re: new RegExp(j("-----BEGIN [A-Z ]*PRIV", "ATE KEY-----")), why: "private key block" },
  { id: "jwt", re: new RegExp(j("ey", "J[A-Za-z0-9_-]{8,}\\.ey", "J[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}")), why: "signed token shape" },
  { id: "url-password", re: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/<>]+:[^\s@/<>$&{}*]{4,}@/i, why: "password embedded in a URL", allow: (p, m) => /:\/\/[^:]+:(\*+|x+|password|<[^>]*>)@/i.test(m) },
  { id: "password-literal", re: new RegExp(j("pass", "word\\s*[=:]\\s*[\"'][^\"'\\s]{8,}[\"']")), why: "password string literal outside tests (tests use obviously synthetic throwaway values; secret shapes are still scanned there)", allow: (p, m) => p.startsWith("tests/") || /[<$\{]/.test(m) },
  { id: "password-assignment", re: new RegExp(j("pass", "word=[A-Za-z0-9_\\-!@#%^&*]{8,}")), docsOnly: true, why: "password assignment in text", allow: (p, m) => /[<$\{]|generated|placeholder/.test(m) },
  { id: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, why: "email address that is not an example.* or .test address", allow: (p, m) => /@(example\.(test|invalid|com|org|net)|[A-Za-z0-9-]+\.(test|invalid|localhost)|users\.noreply\.[a-z.]+|anthropic\.com)$/i.test(m) || /^[a-z0-9._-]+@\d/.test(m) || /@[0-9]+\./.test(m) },
  {
    id: "ip-literal",
    re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/,
    why: "IPv4 literal that is not loopback, unspecified or a documentation range",
    allow: (p, m) => /^(127\.|0\.0\.0\.0|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(m) || isVersionLike(m),
  },
];
function isVersionLike(m) {
  return m.split(".").some((n) => Number(n) > 255) || /^\d+\.\d+\.\d+\.\d+$/.test(m) === false;
}

// Files that legitimately contain the shapes above: the egress guard lists reserved address ranges on purpose, and the
// tests feed those and other hostile inputs to it. Each exception is one file and one rule.
const EXCEPTIONS = [
  { file: "src/workers/ssrf.ts", rules: ["ip-literal"], why: "the SSRF deny-list names reserved address ranges" },
  { file: "tests/unit/hygiene.test.ts", rules: ["ip-literal"], why: "the scan's own negative control plants a private address on purpose" },
  { file: "tests/integration/offline.test.ts", rules: ["ip-literal"], why: "a stub resolver answer for a public documentation-style address" },
  { file: "tests/unit/clock-errors.test.ts", rules: ["ip-literal"], why: "a version string rejected by the semver parser, not an address" },
  { file: "tests/unit/redaction.test.ts", rules: ["private-key"], why: "an unterminated key block used as redaction input" },
  { file: "tests/unit/ssrf.test.ts", rules: ["ip-literal", "url-password"], why: "address classification vectors and credential-in-URL rejection" },
  { file: "tests/integration/checks.test.ts", rules: ["ip-literal", "url-password"], why: "egress policy vectors" },
  { file: "tests/integration/security.test.ts", rules: ["url-password"], why: "credential-in-URL rejection vectors" },
  { file: "tests/unit/redaction.test.ts", rules: ["url-password", "password-assignment", "password-literal", "private-key"], why: "redaction of planted URL passwords" },
  { file: "tests/fixtures/redaction-no-leak/seed-6151.json", rules: ["password-assignment"], why: "frozen redaction inputs: `password=` followed by filler words; the planted secrets are placeholders" },
  { file: "tests/fixtures/redaction-no-leak/seed-7207.json", rules: ["password-assignment"], why: "frozen redaction inputs: `password=` followed by filler words; the planted secrets are placeholders" },
  { file: "tests/fixtures/redaction-no-leak/seed-9931.json", rules: ["password-assignment"], why: "frozen redaction inputs: `password=` followed by filler words; the planted secrets are placeholders" },
  { file: "tests/fixtures/redaction-no-leak/seed-4242.json", rules: ["password-assignment"], why: "frozen redaction inputs: `password=` followed by filler words; the planted secrets are placeholders" },
  { file: "tests/unit/graph.test.ts", rules: ["url-password", "password-assignment"], why: "rejection of secret-looking manifest values" },
  { file: "docs/DOMAIN.md", rules: ["url-password", "password-assignment"], why: "documents the rejected value shapes" },
  { file: "docs/MANIFEST.md", rules: ["url-password", "password-assignment"], why: "documents the rejected value shapes" },
  { file: "docs/SECURITY.md", rules: ["url-password", "password-assignment"], why: "documents the redaction shapes" },
  { file: "SECURITY.md", rules: ["url-password", "password-assignment"], why: "documents the redaction shapes" },
];

if (process.argv.includes("--list")) {
  for (const r of RULES) console.log(`rule ${r.id}: ${r.why}`);
  for (const e of EXCEPTIONS) console.log(`exception ${e.file} [${e.rules.join(", ")}]: ${e.why}`);
  process.exit(0);
}

function trackedFiles() {
  try {
    const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
    // Tracked files, plus files not yet added (so the scan also covers work in progress).
    const files = [...new Set([...run(["ls-files", "-z"]), ...run(["ls-files", "-z", "--others", "--exclude-standard"])])];
    if (files.length > 0) return files;
  } catch {
    // not a git checkout: fall through to a directory walk
  }
  const skip = new Set(["node_modules", "dist", "coverage", ".git", ".claude", "test-results", "playwright-report"]);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [relative(root, join(dir, e.name)).split(sep).join("/")]));
  return walk(root);
}

const findings = [];
const files = trackedFiles();

// Structural rules: things that must not be tracked at all.
for (const f of files) {
  if (/^\.github\/workflows\//.test(f)) findings.push(`${f}: GitHub Actions workflows are banned (the local gate is scripts/verify-quality.sh)`);
  if (/(^|\/)\.env($|\.(?!example$))/.test(f)) findings.push(`${f}: environment file must not be tracked`);
  if (/\.(pem|key|p12|pfx)$/.test(f)) findings.push(`${f}: key material must not be tracked`);
  if (/^(node_modules|dist|coverage)\//.test(f)) findings.push(`${f}: build output must not be tracked`);
}

const forbidden = (process.env.CR_FORBID_TOKENS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

for (const f of files) {
  const abs = join(root, f);
  if (!existsSync(abs) || !statSync(abs).isFile() || !TEXT.has(extname(f)) || SKIP_CONTENT.has(f)) continue;
  if (statSync(abs).size > 2_000_000) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  const excepted = new Set(EXCEPTIONS.filter((e) => e.file === f).flatMap((e) => e.rules));
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (excepted.has(rule.id) || (rule.docsOnly && CODE.has(extname(f)))) continue;
      const match = rule.re.exec(line);
      if (match && !(rule.allow && rule.allow(f, match[0]))) findings.push(`${f}:${i + 1}: ${rule.why} (${rule.id})`);
    }
    for (const token of forbidden) if (line.toLowerCase().includes(token)) findings.push(`${f}:${i + 1}: forbidden token (CR_FORBID_TOKENS)`);
    if (f.startsWith("fixtures/") && uuid.test(line)) findings.push(`${f}:${i + 1}: fixtures use opaque ids, not UUID literals`);
  });
}

if (findings.length > 0) {
  console.error(`hygiene-scan: ${findings.length} finding(s)`);
  for (const line of findings.slice(0, 200)) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`hygiene-scan: ${files.length} tracked files scanned, 0 findings`);
