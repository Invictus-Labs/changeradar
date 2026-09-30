import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPORT_STYLE } from "../../src/report/html-report.js";

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Custom properties declared in a block of CSS text. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1] as string] = (m[2] as string).toLowerCase();
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const SPA_CSS = readFileSync(join(here, "../../src/web/styles.css"), "utf8");

/** Extract the three token sets of the SPA: light (:root), system dark (media query) and forced dark (data-theme). */
function spaThemes() {
  const light = SPA_CSS.match(/:root \{([^}]*)\}/)?.[1] ?? "";
  const media = SPA_CSS.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1] ?? "";
  const forced = SPA_CSS.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1] ?? "";
  return { light: tokens(light), media: tokens(media), forced: tokens(forced) };
}

function reportThemes() {
  const light = REPORT_STYLE.match(/:root\{([^}]*)\}/)?.[1] ?? "";
  const dark = REPORT_STYLE.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)?.[1] ?? "";
  return { light: tokens(light), dark: tokens(dark) };
}

interface Pair {
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for user interface components and graphics. */
  min: number;
  what: string;
}

// Text on the surfaces it is actually drawn on (see styles.css and html-report.ts).
const TEXT_PAIRS: Pair[] = [
  { fg: "fg", bg: "bg", min: 4.5, what: "body text on page" },
  { fg: "fg", bg: "surface", min: 4.5, what: "text on cards and tables" },
  { fg: "muted", bg: "bg", min: 4.5, what: "muted text on page" },
  { fg: "muted", bg: "surface", min: 4.5, what: "muted text on cards" },
  { fg: "muted", bg: "code-bg", min: 4.5, what: "muted text in code" },
  { fg: "fg", bg: "code-bg", min: 4.5, what: "code text" },
  { fg: "bad-fg", bg: "bad-bg", min: 4.5, what: "AFFECTED verdict, failed states and badges" },
  { fg: "warn-fg", bg: "warn-bg", min: 4.5, what: "INCOMPLETE verdict (light stripe)" },
  { fg: "warn-fg", bg: "warn-bg2", min: 4.5, what: "INCOMPLETE verdict (dark stripe)" },
  { fg: "info-fg", bg: "info-bg", min: 4.5, what: "NO KNOWN IMPACT verdict and denied states" },
  { fg: "bad-fg", bg: "surface", min: 4.5, what: "failure text on cards" },
];

const SPA_ONLY_PAIRS: Pair[] = [
  { fg: "link", bg: "bg", min: 4.5, what: "links on page" },
  { fg: "link", bg: "surface", min: 4.5, what: "links on cards" },
  { fg: "accent-on", bg: "accent-bg", min: 4.5, what: "primary button label" },
  { fg: "fg", bg: "code-bg", min: 4.5, what: "code" },
  { fg: "warn-fg", bg: "bg", min: 4.5, what: "warning text on page" },
  // Non-text: control borders, focus ring and the graph strokes must reach 3:1 against what they sit on.
  { fg: "control", bg: "surface", min: 3, what: "input and button borders" },
  { fg: "control", bg: "bg", min: 3, what: "input borders on page" },
  { fg: "focus", bg: "bg", min: 3, what: "focus ring on page" },
  { fg: "focus", bg: "surface", min: 3, what: "focus ring on cards" },
  { fg: "muted", bg: "surface", min: 3, what: "graph edges and arrows" },
  { fg: "bad-fg", bg: "surface", min: 3, what: "graph origin outline" },
  { fg: "fg", bg: "bad-bg", min: 4.5, what: "graph label on a direct consumer node" },
  { fg: "fg", bg: "warn-bg", min: 4.5, what: "graph label on a transitive consumer node" },
  { fg: "muted", bg: "bad-bg", min: 4.5, what: "graph sub label on a direct consumer node" },
  { fg: "muted", bg: "warn-bg", min: 4.5, what: "graph sub label on a transitive consumer node" },
];

function check(theme: Record<string, string>, pairs: Pair[], label: string) {
  for (const p of pairs) {
    const fg = theme[p.fg];
    const bg = theme[p.bg];
    expect(fg, `${label}: --${p.fg} missing`).toBeTruthy();
    expect(bg, `${label}: --${p.bg} missing`).toBeTruthy();
    const ratio = contrast(fg as string, bg as string);
    expect(ratio, `${label}: ${p.what} (--${p.fg} ${fg} on --${p.bg} ${bg}) = ${ratio.toFixed(2)}:1, needs ${p.min}:1`).toBeGreaterThanOrEqual(p.min);
  }
}

describe("WCAG AA contrast, light and dark (SPA and static report)", () => {
  it("the math is right: black on white is 21:1 and a known failing pair fails", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  const spa = spaThemes();
  it("the SPA declares complete light, system dark and forced dark token sets, and the two dark sets are identical", () => {
    expect(Object.keys(spa.light).length).toBeGreaterThan(15);
    expect(Object.keys(spa.media).sort()).toEqual(Object.keys(spa.forced).sort());
    expect(spa.media).toEqual(spa.forced);
    for (const key of Object.keys(spa.media)) expect(spa.light[key], `--${key} missing in light`).toBeTruthy();
  });

  it("SPA light theme: every text pair reaches 4.5:1 and every control and graph stroke 3:1", () => check(spa.light, [...TEXT_PAIRS, ...SPA_ONLY_PAIRS], "SPA light"));
  it("SPA dark theme (system): every text pair reaches 4.5:1 and every control and graph stroke 3:1", () => check(spa.media, [...TEXT_PAIRS, ...SPA_ONLY_PAIRS], "SPA dark"));

  const report = reportThemes();
  it("static report light theme reaches AA for every pair it draws", () => check(report.light, TEXT_PAIRS, "report light"));
  it("static report dark theme reaches AA for every pair it draws", () => check(report.dark, TEXT_PAIRS, "report dark"));

  it("the report accent (skip link focus) is visible in both themes", () => {
    check(report.light, [{ fg: "accent", bg: "surface", min: 4.5, what: "report accent" }], "report light");
    check(report.dark, [{ fg: "accent", bg: "surface", min: 4.5, what: "report accent" }], "report dark");
  });

  it("layout guards found by the real 375px browser check: long hashes wrap and stacked tables hide their header safely", () => {
    expect(SPA_CSS).toMatch(/body \{[^}]*overflow-wrap: anywhere/);
    expect(SPA_CSS).toMatch(/\.table\.stack thead \{ display: block; position: absolute/);
    expect(SPA_CSS).toContain("content: attr(data-label)");
  });

  it("print styles switch to black on white", () => {
    expect(REPORT_STYLE).toMatch(/@media print\{[^]*body\{background:#fff;color:#000/);
  });
});
