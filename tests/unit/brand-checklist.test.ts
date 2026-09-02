// ─── The brand checklist, run against the BUILT stylesheet ───
//
// The parity test pins the token module. This one pins the artifact, which is a
// different question: a shadow, a stray hue or a 12px corner can arrive through
// a component file, a dependency, or a hand-edit to `desktop.css` without ever
// touching the tokens. What ships is what a person sees.
//
// Three rules, and they are the three that make something stop reading as
// Savoir first:
//
//   1. Zero box-shadows. Depth is a 1px hairline, always.
//   2. One chromatic hue outside the status colours. One accent, rationed.
//   3. Every radius is 3px, except a pill and the icon tile.
//
// It reads `apps/desktop/dist/assets/*.css` and skips with a named reason when
// the app has not been built, rather than passing on an empty file — a green
// test that inspected nothing is worse than a red one.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SAVOIR } from "../../packages/shared/src/design-tokens";

const DIST = join(import.meta.dir, "../../apps/desktop/dist/assets");

function builtCss(): string | null {
  if (!existsSync(DIST)) return null;
  const files = readdirSync(DIST).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(join(DIST, f), "utf8")).join("\n");
}

const css = builtCss();
const BUILT = css !== null;

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
  for (const m of source.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    out.push(hexToHsl(m[1]!));
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    out.push(toHsl(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}

/**
 * Whether a colour carries a hue a person would name.
 *
 * The neutral ramp is cool-tinted rather than pure grey (that is the point of
 * "cool"), so a naive "saturation > 0" test would call `#4A4F55` chromatic.
 * 18% is above the whole ramp and below every hue in the system.
 */
const CHROMATIC = 0.18;

/** Group hues into 30-degree buckets — the granularity of "a different colour". */
function bucket(h: Hsl): number {
  return Math.round(h.h / 30) % 12;
}

const STATUS_BUCKETS = new Set([
  bucket(hexToHsl(SAVOIR.caution)),
  bucket(hexToHsl(SAVOIR.negative)),
]);
const ACCENT_BUCKETS = new Set([bucket(hexToHsl(SAVOIR.datum)), bucket(hexToHsl(SAVOIR.signal))]);

describe.skipIf(!BUILT)("the built stylesheet is Savoir", () => {
  test("has zero box-shadows", () => {
    // The single most load-bearing rule in the system: structure is drawn with
    // hairlines. One shadow and the whole surface reads as a different product.
    const shadows = (css ?? "").match(/box-shadow\s*:/g) ?? [];
    expect(shadows.length, `found ${shadows.length} box-shadow declarations`).toBe(0);
  });

  test("has one chromatic hue outside the status colours", () => {
    const buckets = new Map<number, string[]>();
    for (const m of (css ?? "").matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hsl = hexToHsl(m[1]!);
      if (hsl.s < CHROMATIC) continue;
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
      // …and the one that is there is the datum, not something that merely
      // happens to be alone.
      expect(ACCENT_BUCKETS.has([...buckets.keys()][0]!)).toBe(true);
    }
  });

  test("every radius is 3px, except pills and the icon tile", () => {
    const allowed = new Set(["3px", "50%", "0", "0px", "999px", "20px", "6px", "inherit"]);
    const offenders: string[] = [];
    for (const m of (css ?? "").matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      const value = m[1]!.trim();
      // A var() resolves in tokens.css, which the parity test already pins.
      if (value.startsWith("var(")) continue;
      for (const part of value.split(/\s+/)) {
        if (!allowed.has(part)) offenders.push(value);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("the ground is paper or ink, never cream", () => {
    // The one mistake this brand is most likely to drift into: `#faf9f5` and
    // its neighbours are warm, and warm is the other design system.
    for (const c of colorsIn(css ?? "")) {
      if (c.l < 0.85 || c.s < 0.05) continue;
      const warm = c.h < 70 || c.h > 320;
      expect(warm, `a warm near-white at ${Math.round(c.h)}° crept into the ground`).toBe(false);
    }
  });

  test("loads Inter and IBM Plex Mono with real fallbacks", () => {
    expect(css).toContain("Inter");
    expect(css).toContain("IBM Plex Mono");
    expect(css).toMatch(/--sans:[^;]*sans-serif/);
    expect(css).toMatch(/--mono:[^;]*monospace/);
  });

  test("draws the 28px graticule", () => {
    expect(css).toContain("--graticule: 28px");
    expect(css).toMatch(/radial-gradient\(circle,\s*var\(--graticule-ink\)/);
  });
});

test("the checklist ran against a real build", () => {
  // Named separately so a skipped suite is visible in the output rather than
  // reported as six passes over nothing.
  expect(
    BUILT,
    "apps/desktop/dist/assets/*.css is missing — run `bun run --cwd apps/desktop build` first",
  ).toBe(true);
});
