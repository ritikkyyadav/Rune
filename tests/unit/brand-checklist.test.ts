// ─── The brand checklist, run against the BUILT stylesheet ───
//
// The parity test pins the token module. This one pins the ARTIFACT, which is a
// different question: a shadow, a stray hue or a 14px corner can arrive through
// a component file, a dependency, or a hand-edit to `web.css` without ever
// touching the tokens. What ships is what a person sees.
//
// Six rules, and they are the six that make the surface stop reading as this
// product first:
//
//   1. A box-shadow only on something that floats. Depth is a hairline.
//   2. One chromatic hue outside the three status colours.
//   3. Every radius from {6, 8, 10}, plus circles and zero.
//   4. Geist and Geist Mono, each with a real fallback.
//   5. Every near-white in the build is one the system defines.
//   6. Not one byte of the identity this replaced.
//
// It reads `apps/web/dist/assets/*.css` and reports a MISSING build as a
// failure rather than skipping quietly, because a green test that inspected
// nothing is worse than a red one. It also refuses a STALE build: `dist/` is
// gitignored, so a directory built before the current tokens survives every
// checkout and merge, and the checklist would otherwise audit bytes nobody
// shipped. The staleness check is the accent — if the built CSS does not
// contain today's accent hex, the build predates the tokens.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GEAR_BASE_CSS, GEAR_PALETTE, GEAR_RADII } from "../../packages/shared/src/design-tokens";

const DIST = join(import.meta.dir, "../../apps/web/dist/assets");
const TOKENS = join(import.meta.dir, "../../apps/web/src/styles/tokens.css");
const BUILD_HINT = "run `bun run --cwd apps/web build` first";

function builtCss(): string | null {
  if (!existsSync(DIST)) return null;
  const files = readdirSync(DIST).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(join(DIST, f), "utf8")).join("\n");
}

const css = builtCss();
const BUILT = css !== null;
/** The build carries today's accent, so it is not a pre-rebrand directory. */
const FRESH = BUILT && css!.toLowerCase().includes(GEAR_PALETTE.accent.toLowerCase());

// ─── Colour helpers ───

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hexToHsl(hex: string): Hsl {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return toHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** Every colour literal in the stylesheet, hex and rgb() alike. */
function colorsIn(source: string): Hsl[] {
  const out: Hsl[] = [];
  for (const m of source.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) out.push(hexToHsl(m[1]!));
  for (const m of source.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    out.push(toHsl(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}

/**
 * Whether a colour carries a hue a person would name.
 *
 * Three conditions, and all three are needed. The neutral ramp is cool-tinted
 * rather than pure grey, so "saturation > 0" would call `#5B6070` chromatic:
 * 25% is above every neutral in the system (`#0B0D10`, the highest, is 18.5%)
 * and far below every hue (the accent is 79%). And hue is not perceptible at
 * the extremes of lightness — a 19%-saturated near-black is a near-black — so
 * the top and bottom of the range are excluded rather than argued about.
 */
function isChromatic(c: Hsl): boolean {
  return c.s >= 0.25 && c.l > 0.08 && c.l < 0.96;
}

/** Group hues into 30-degree buckets — the granularity of "a different colour". */
function bucket(h: Hsl): number {
  return Math.round(h.h / 30) % 12;
}

const STATUS_BUCKETS = new Set([
  bucket(hexToHsl(GEAR_PALETTE.ok)),
  bucket(hexToHsl(GEAR_PALETTE.caution)),
  bucket(hexToHsl(GEAR_PALETTE.danger)),
]);
const ACCENT_BUCKETS = new Set([
  bucket(hexToHsl(GEAR_PALETTE.accent)),
  bucket(hexToHsl(GEAR_PALETTE.accentDark)),
]);

/**
 * Split the stylesheet into `selector { declarations }` pairs.
 *
 * Crude on purpose: it does not need to parse CSS, only to answer "which
 * selector does this declaration belong to", which a split on `}` gets right
 * for a stylesheet with no nesting. At-rule preludes come through as part of
 * the selector text, which is exactly what a shadow inside a media query
 * should be judged by.
 */
function rules(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}

/** The things allowed to float, and therefore allowed one shadow. */
const FLOATS = /overlay|palette|popover|menu|dropdown|toast|tooltip|picker|dialog/i;

describe.skipIf(!BUILT)("the built stylesheet is the product's own", () => {
  test("shadows appear only on things that float", () => {
    // The most load-bearing rule in the system: structure is drawn with
    // hairlines. One shadow on a card and the whole surface reads as a
    // different, softer, more generic product.
    const offenders = rules(css ?? "")
      .filter((r) => /box-shadow\s*:/.test(r.body) && !/box-shadow\s*:\s*(none|0)/.test(r.body))
      .filter((r) => !FLOATS.test(r.selector))
      // `--shadow-overlay: …` is the token's own definition, not a use of it.
      .filter((r) => !/--shadow-overlay/.test(r.body.replace(/box-shadow[^;]*;?/g, "")))
      .map((r) => r.selector);
    expect(offenders, `content surfaces with a shadow: ${offenders.join(" | ")}`).toEqual([]);
  });

  test("has one chromatic hue outside the status colours", () => {
    const buckets = new Map<number, string[]>();
    for (const m of (css ?? "").matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hsl = hexToHsl(m[1]!);
      if (!isChromatic(hsl)) continue;
      const b = bucket(hsl);
      if (STATUS_BUCKETS.has(b)) continue;
      buckets.set(b, [...(buckets.get(b) ?? []), `#${m[1]}`]);
    }
    const found = [...buckets.entries()].map(([b, hexes]) => `${b * 30}° ${hexes.join(",")}`);
    expect(
      buckets.size,
      `hues outside status: ${found.join(" | ") || "(none)"}`,
    ).toBeLessThanOrEqual(1);
    if (buckets.size === 1) {
      // …and the one that is there is the accent, not something that merely
      // happens to be alone.
      expect(ACCENT_BUCKETS.has([...buckets.keys()][0]!)).toBe(true);
    }
  });

  test("every radius comes from {6, 8, 10}, or is a circle, or is nothing", () => {
    const allowed = new Set([...GEAR_RADII, "50%", "0", "0px", "inherit", "unset"]);
    const offenders: string[] = [];
    for (const m of (css ?? "").matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      const value = m[1]!.trim();
      // A var() resolves in tokens.css, which the parity test already pins.
      if (value.startsWith("var(")) continue;
      for (const part of value.split(/\s+/)) if (!allowed.has(part)) offenders.push(value);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("loads Geist and Geist Mono with real fallbacks", () => {
    expect(css).toContain("Geist");
    expect(css).toContain("Geist Mono");
    expect(css).toMatch(/--sans:[^;]*sans-serif/);
    expect(css).toMatch(/--mono:[^;]*monospace/);
  });

  test("every near-white in the build is one the system defines", () => {
    // Sharper than "is it warm?": the near-whites ARE the ground, and there are
    // exactly five of them. Anything else at that lightness — a cream borrowed
    // from another design system, a `#fff` hard-coded in a component, a
    // dependency's own surface — is a second ground, and two grounds is how a
    // page stops looking like one product.
    const allowed = new Set(
      [...Object.values(GEAR_BASE_CSS.light), ...Object.values(GEAR_BASE_CSS.dark)]
        .filter((v) => /^#[0-9a-fA-F]{6}$/.test(v))
        .map((v) => v.toUpperCase()),
    );
    const strays = new Set<string>();
    for (const m of (css ?? "").matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hex = `#${m[1]!.toUpperCase()}`;
      if (hexToHsl(hex).l < 0.9) continue;
      if (!allowed.has(hex)) strays.add(hex);
    }
    expect(
      [...strays],
      `near-whites the system does not define: ${[...strays].join(", ")}`,
    ).toEqual([]);
  });

  test("defines both grounds, and defines them on bare :root too", () => {
    // A colour whose only definition lives inside a media query is a colour
    // that is missing in one of the three theme states, and the state it is
    // missing in is always the one nobody tested.
    expect(css).toMatch(/:root\s*\{[^}]*--ground:/);
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toMatch(/\[data-theme=("|')?dark/);
  });
});

// ─── The rebrand, checked as an absence ───

const DITCHED = ["0E5E63", "E7E8E3", "IBM Plex", "Savoir", "graticule", "datum"];

describe("the identity this replaced leaves no trace", () => {
  test("not in the built stylesheet", () => {
    if (!BUILT) return;
    for (const needle of DITCHED) {
      expect(new RegExp(needle, "i").test(css ?? ""), `"${needle}" is still in the built CSS`).toBe(
        false,
      );
    }
  });

  test("not in the generated tokens", () => {
    const tokens = existsSync(TOKENS) ? readFileSync(TOKENS, "utf8") : "";
    expect(tokens.length, `${TOKENS} is missing — ${BUILD_HINT}`).toBeGreaterThan(0);
    for (const needle of DITCHED) {
      expect(new RegExp(needle, "i").test(tokens), `"${needle}" is still in tokens.css`).toBe(
        false,
      );
    }
  });
});

describe("the checklist inspected something real", () => {
  test("a build exists", () => {
    // Named separately so a skipped suite is visible in the output rather than
    // reported as six passes over nothing.
    expect(BUILT, `apps/web/dist/assets/*.css is missing — ${BUILD_HINT}`).toBe(true);
  });

  test("and it is not a stale one", () => {
    // `dist/` is gitignored, so a directory built before the rebrand survives
    // every checkout and merge. A checklist that audits those bytes is green on
    // a broken tree and red on a correct one, which is worse than no checklist.
    const when = BUILT ? statSync(DIST).mtime.toISOString() : "never";
    expect(
      FRESH,
      `the built CSS does not contain ${GEAR_PALETTE.accent} — dist/ was built ${when}, before the current tokens. ${BUILD_HINT}`,
    ).toBe(true);
  });
});
