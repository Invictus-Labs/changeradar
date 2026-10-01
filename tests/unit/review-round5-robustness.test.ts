import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsSecret, redactDeep, redactIdentifier, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 5 (conditions from a sibling product's hang): the redactor terminates on ordinary input (checked in a CHILD
 * process with a hard wall clock, so a call that never returns is a failed assertion), every new scanner is linear, no
 * module-level global or sticky regex is added without a reason, ordinary text is untouched, and what is redacted is a fixed
 * point. Fake secrets are assembled at run time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const probe = resolve(root, "tests/helpers/redact-corpus-probe.ts");
const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";

function child(args: string[], wallMs: number): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", probe, ...args], { encoding: "utf8", timeout: wallMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, cwd: root });
  return { status: run.status, out: run.stdout, err: run.stderr };
}
const lastJson = (text: string): Record<string, any> => JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop() as string);

describe("R5 (termination): ordinary words that are also key names never hang the redactor", () => {
  it("the fixed corpus (key, name, value, header, ParameterKey, valueFrom, both orders, YAML) finishes and comes back unchanged", () => {
    const run = child(["fixed"], 60_000);
    expect(run.status, `still running or failed: ${run.err.slice(-300)}`).toBe(0);
    const { results } = lastJson(run.out) as { results: { text: string; unchanged: boolean }[] };
    expect(results.length).toBeGreaterThanOrEqual(19);
    // Five-character values are under the six-character floor, and the words here are not secrets: every one comes back as it was.
    expect(results.filter((r) => !r.unchanged).map((r) => r.text)).toEqual([]);
  }, 120_000);

  it.each([1, 7, 42])("100,000 ordinary strings (seed %i) finish, each call within its cap, and every result is a fixed point", (seed) => {
    const run = child(["random", String(seed)], 180_000);
    expect(run.status, `still running or failed: ${run.err.slice(-300)}`).toBe(0);
    const summary = lastJson(run.out);
    expect(summary.not_fixed_point, "strings whose redaction is not a fixed point").toBe(0);
    expect(summary.worst_ms, "the slowest single call, in milliseconds").toBeLessThan(2000);
  }, 240_000);
});

describe("R5 (linear time): 16 times the input costs at most about 16 times the time, for every new scanner", () => {
  const shapes = lastJson(child(["shapes"], 60_000).out) as unknown as string[];
  it("the child knows the shapes (control)", () => {
    expect(shapes.length).toBeGreaterThanOrEqual(15);
  });
  it.each(shapes)("%s", (shape) => {
    const run = child(["scale", shape], 300_000);
    expect(run.status, `still running or failed: ${run.err.slice(-300)}`).toBe(0);
    const { small_ms: small, large_ms: large } = lastJson(run.out);
    // 256 KiB to 4 MiB is 16 times the input; four times that ratio absorbs machine noise and the floor of tiny timings.
    expect(large, `256 KiB: ${small} ms, 4 MiB: ${large} ms`).toBeLessThan(Math.max(small, 20) * 16 * 4);
    expect(large, "4 MiB in absolute terms").toBeLessThan(30_000);
  }, 400_000);
});

describe("R5: no module-level global or sticky regular expression is added without a reason", () => {
  /** Every one is reset immediately before its own loop and no loop body re-enters a redaction function (audited in review round 5). */
  const ALLOWED: Record<string, string> = {
    // redaction.ts
    ASSIGNMENT_KEY: "lastIndex set before scanAssignments' one loop; the body calls quotedEnd, unquotedEnd, skipGap, readValue and blockScalar, which use no regex with state",
    SCHEME_SEPARATOR: "lastIndex set before scanUrlCredentials' one loop; no re-entry",
    HEADER_LINE: "lastIndex set before scanText's one loop over it; no re-entry",
    TOKEN_PATTERNS: "each pattern's lastIndex is set before its own loop in scanText; no re-entry",
    ESCAPE_AT: "sticky: lastIndex set immediately before its one exec in percentDecode",
    // redaction-pairs.ts
    NAME_PAIR_G: "lastIndex set before scanPairs' loop 1; the body uses seek, whose sticky patterns are other objects",
    VALUE_KEY_G: "lastIndex set before scanPairs' loop 2",
    TUPLE_G: "lastIndex set before scanPairs' loop 3 and moved forward in the body",
    BARE_NAME_G: "lastIndex set before scanPairs' loop 4",
    BARE_VALUE_G: "lastIndex set before scanPairs' loop 5",
    VALUE_AFTER_NAME: "sticky: lastIndex set immediately before each exec in seek",
    NAME_AFTER_VALUE: "sticky: lastIndex set immediately before each exec in seek",
    BARE_VALUE_HEAD: "sticky: lastIndex set immediately before each exec in seekBare",
    BARE_NAME_HEAD: "sticky: lastIndex set immediately before each exec in seekBare",
    // redaction-forms.ts
    LONG_FLAG: "lastIndex set before scanCommandForms' loop; the body's readValue uses no regex with state",
    SHORT_P_EQUALS: "lastIndex set before scanCommandForms' loop",
    ENV_DECLARATION: "lastIndex set before scanCommandForms' loop",
  };

  /**
   * A regular expression literal, read with its character classes (a slash inside `[...]` does not end it), followed by flags with g
   * or y. It may follow `=`, `(`, `,`, `:`, `[`, `{` or a blank.
   */
  const STATEFUL_LITERAL = /(?:^|[=(,:[{\s])\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\n\\[])+\/([a-z]*[gy][a-z]*)(?![A-Za-z0-9_])/;
  /** A RegExp construction whose flags are a plain string literal without g and y (harmless: no state). */
  const PLAIN_CONSTRUCTION = /(?:new )?RegExp\((?:[^()]|\([^()]*\))*?,\s*(["'])[a-fh-xz]*\1\s*\)/;

  /**
   * Names of module-level statements (a `const` or `let` at the start of a line) that hold a regular expression with state (the g or
   * y flag): a literal with such flags, or a `new RegExp(` whose flags are not a plain literal without g and y (a flags argument
   * that is a variable, a template or missing-but-computed counts as state). The TypeScript compiler API is not available here (the
   * installed compiler is the native one), so the statement text is read; classes, arrays and objects of literals are handled.
   */
  function statefulSource(source: string): string[] {
    const found: string[] = [];
    const lines = source.split("\n");
    /** A literal with g or y, or a construction (with or without `new`) whose flags are not a plain literal without them. */
    const stateful = (text: string): boolean => {
      const constructs = /(?:new )?RegExp\(/.test(text);
      return STATEFUL_LITERAL.test(text) || (constructs && !PLAIN_CONSTRUCTION.test(text) && /RegExp\([\s\S]*?,/.test(text));
    };
    const namesOf = (list: string): string[] => list.split(",").map((part) => (part.split(":").pop() ?? "").replace(/^[\s.]+|[\s=].*$/g, "").trim()).filter((name) => name !== "");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      // A statement at the start of a line: a const, let or var (one name, or a destructuring list), a later assignment, a default export, or a class.
      const decl = /^(?:export )?(?:const|let|var) (?:([A-Za-z_$][\w$]*)|\[([^\]]*)\]|\{([^}]*)\})/.exec(line);
      const assign = /^([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(line);
      const isDefault = /^export default\b/.test(line);
      const cls = /^(?:export )?(?:default )?class ([A-Za-z_$][\w$]*)/.exec(line);
      if (!decl && !assign && !isDefault && !cls) continue;
      let statement = line;
      let j = i;
      const endsHere = (text: string): boolean => (cls ? /^}\s*$/.test(text) : /;\s*$/.test(text));
      while (!endsHere(lines[j] as string) && j + 1 < lines.length && j - i < 200) {
        j += 1;
        statement += `\n${lines[j]}`;
      }
      if (cls) {
        // a static field of a class is state of the module as well: `class X { static R = /abc/g; }`
        for (const field of statement.matchAll(/static\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)[^=;]*=\s*([^;]*);/g)) if (stateful(field[2] as string)) found.push(`${cls[1]}.${field[1]}`);
        continue;
      }
      if (!stateful(statement)) continue;
      if (decl) found.push(...(decl[1] ? [decl[1]] : namesOf((decl[2] ?? decl[3]) as string)));
      else if (assign) found.push(assign[1] as string);
      else found.push("default");
    }
    return found;
  }
  const stateful = (file: string): string[] => statefulSource(readFileSync(file, "utf8"));

  const files = readdirSync(join(root, "src/domain")).filter((f) => /^redaction.*\.ts$/.test(f));
  it("the redaction modules are found (control)", () => {
    expect(files).toEqual(expect.arrayContaining(["redaction.ts", "redaction-pairs.ts", "redaction-forms.ts"]));
  });

  it("every module-level regular expression with state is on the allow-list, and every allow-list entry still exists", () => {
    const seen = files.flatMap((f) => stateful(join(root, "src/domain", f)));
    expect(seen.filter((name) => !(name in ALLOWED)), "a stateful regular expression without a stated reason").toEqual([]);
    expect(Object.keys(ALLOWED).filter((name) => !seen.includes(name)), "an allow-list entry that no longer exists").toEqual([]);
  });

  it("the detector itself bites: every planted shape of a module-level regex with state is found, and the harmless ones are not", () => {
    const planted: [string, string][] = [
      ["a global literal", "const A = /abc/g;"],
      ["a sticky literal", "export const A = /abc/y;"],
      ["a literal with a slash inside a class", "const A = /[/]abc/g;"],
      ["a construction with a global flag", 'const A = new RegExp("abc", "g");'],
      ["a construction with flags that are not a literal", 'const FLAGS = "g";\nconst A = new RegExp("abc", FLAGS);'],
      ["a construction from a template with substitutions", 'const A = new RegExp(`abc${1}`, "g");'],
      ["an array of global literals", "const A = [/abc/g, /def/g];"],
      ["an object that holds a global literal", "const A = { re: /abc/g };"],
      ["a literal on the next line", "const A =\n  /abc/g;"],
      // (round 7, test review P3) shapes the first reading missed
      ["a construction without new", 'const A = RegExp("abc", "g");'],
      ["a var", "var A = /abc/g;"],
      ["a destructuring list", "const [A, B] = [/abc/g, /def/i];"],
      ["a later assignment statement", "let A;\nA = /abc/g;"],
    ];
    for (const [label, source] of planted) expect(statefulSource(source), label).toContain("A");
    expect(statefulSource("class X {\n  static R = /abc/g;\n}\n"), "a static field of a class").toContain("X.R");
    expect(statefulSource("export default /abc/g;\n"), "a default export").toContain("default");
    expect(statefulSource("export default class Y {\n  static readonly Q = new RegExp('abc', 'y');\n}\n"), "a static field of a default-exported class").toContain("Y.Q");
    expect(statefulSource("class Z {\n  static OK = /abc/i;\n}\n"), "a harmless static field").toEqual([]);
    const harmless = "const OK = /abc/i;\nconst NONE = new RegExp('abc');\nconst PLAIN = new RegExp('abc', 'i');\nfunction f() { return /y/g; }\n";
    expect(statefulSource(harmless)).toEqual([]);
  });
});

describe("R5 (precision): ordinary text is untouched", () => {
  const ordinary = [
    "Please send the report to alice@example.test by Friday.",
    "git@example.test:group/repo.git",
    "https://host.example/path?ref=a@b&x=1",
    "https://host.example/a%20b?q=x%26y&page=2",
    "service:\n  name: billing\n  value: 12\n",
    "name=report value=quarterly-2026",
    "ENV LOG_LEVEL debug",
    "ENV APP_NAME billing-service",
    "ARG VERSION 1.2.3-beta",
    "count: number = 5",
    'label: string = "hello-world"',
    "/api/sid:abcdef1",
    "svc.sid:abcdef1",
    "the dsn is documented in the runbook",
    "pin: the small wooden peg",
    "spinning and pinned and inside are ordinary words",
    "description: |\n  a plain paragraph with numbers 1 2 3\nnext: keep",
    "a > b | c && d",
    "--port 8080 --verbose --name billing-service",
    "-p 8080",
    "tool --token-file /run/secrets/t2 --key-file /etc/keys/k1.pem",
    "risk-assessment-engine-v2 and task-processing-worker-service",
  ];
  it.each(ordinary)("unchanged: %j", (text) => {
    expect(redactSecrets(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
    expect(redactIdentifier(text)).toBe(text);
  });

  it("`service.token:refresh` stays an identifier at identifier strength (log-strength free text may show it redacted, documented in docs/MANIFEST.md)", () => {
    expect(redactIdentifier("service.token:refresh")).toBe("service.token:refresh");
    expect(containsSecret("service.token:refresh")).toBe(false);
  });

  it("bare-colon names: a spaced `dsn: value` assigns, a glued or routed one stays an identifier, and the list of names is the documented one", () => {
    for (const name of ["session_id", "sid", "connection_string", "database_url", "dsn", "webhook_url", "jwt", "encryption_key", "master_key", "pw", "pswd", "pin", "otp"]) {
      expect(redactSecrets(`${name}: ${V}`), name).not.toContain(V);
      expect(redactSecrets(`${name}:${V}`), `${name} glued to its value stays an identifier`).toContain(V);
      expect(redactSecrets(`/route/${name}:${V}`), `${name} in a route`).toContain(V);
    }
    expect(redactSecrets(`connectionString: "${V}"`)).not.toContain(V);
  });
});

describe("R5 (fixed point and fail closed): new shapes redact to a fixed point, and an ambiguous or unterminated one hides to its end", () => {
  const shapes = [
    `name=DB_PASSWORD value=${V}`,
    `- name: DB_PASSWORD\n  value: ${V}\n- name: HOME\n  value: /srv/x`,
    `{"name":"DB_PASSWORD","meta":{"a":{"b":1}},"value":["${V}"]}`,
    `password: |\n  ${V}\n  ${V}\nnext: keep`,
    `password: &a !!str ${V}\nnext: keep`,
    `PASSWORD ?= ${V}`,
    `tool -p=${V} --db-password ${V}`,
    `ENV PASSWORD ${V}`,
    `password: string = "${V}"`,
    `password = b'${V}'`,
    `password%3D${V.slice(0, 10)}%26${V.slice(10)}`,
    `password: [a, ${V}]`,
    `{"password":{"a":["${V}",{"b":"${V}"}]}}`,
  ];
  it.each(shapes)("string fixed point: %j", (text) => {
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
    expect(once).not.toContain(V);
  });

  it("object fixed point over the new pair shapes", () => {
    const objects: unknown[] = [
      { name: "DB_PASSWORD", value: V },
      { header: "Authorization", value: [V] },
      { k: "api_key", meta: { a: 1 }, v: { plain: V } },
      { ParameterKey: "DbPassword", ParameterValue: V },
      [["/prod/db/password", V], ["--db-password", V]],
      { [`pass${String.fromCharCode(0x200b)}word`]: V },
    ];
    for (const object of objects) {
      const once = redactDeep(object);
      expect(redactDeep(once)).toEqual(once);
      expect(JSON.stringify(once)).not.toContain(V);
    }
  });

  it("an unterminated block scalar, flow group or quoted pair value is hidden to the end of the line or text", () => {
    expect(redactSecrets(`password: |\n  ${V}`)).not.toContain(V);
    expect(redactSecrets(`password: [${V}, more-of-the-same-list`)).not.toContain(V);
    expect(redactSecrets(`{"name":"DB_PASSWORD","value":"${V}`)).not.toContain(V);
    expect(redactSecrets(`{"name":"DB_PASSWORD","value":{"plain":"${V}`)).not.toContain(V);
    // Nested one layer deep inside JSON text: the block ends at the quote that closes the enclosing string, not at the end.
    const nested = JSON.stringify({ note: `password: |\n  ${V}\nnext: keep`, after: "still-visible" });
    const out = redactSecrets(nested);
    expect(out).not.toContain(V);
    expect(out).toContain("still-visible");
  });
});
