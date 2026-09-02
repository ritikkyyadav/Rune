// ─── The mark, generated from its geometry ───
//
// A solid eight-tooth gear with rounded tooth tips and a round centre hole.
// Written as a generator rather than a pasted path because a pasted path is
// unreviewable: nobody can tell from 900 coordinates whether the teeth are
// even, and nobody can change the tooth width without redrawing it. Here the
// mark is eight numbers, and a diff to any of them is a sentence.
//
//   outer radius   1.00   the tooth tip
//   root radius    0.80   the body between teeth
//   hole radius    0.36
//   teeth          8
//   tip width      0.30 of the pitch (45°), so 13.5° of arc at the tip
//   corner radius  0.06   on all four corners of every tooth
//
// Two subpaths, `fill-rule: evenodd`: the body-with-teeth, and the hole. The
// hole is a subpath rather than a second element so the mark is one shape that
// takes one colour, which is what lets it be dropped into a favicon, a sidebar
// and a 1024px icon without three versions of the truth.
//
// If the founder supplies the original vector it replaces `gear-mark.svg`
// byte-for-byte and keeps the file name; this file then reads as the record of
// what it replaced.
//
// Usage:  bun run scripts/generate-gear-mark.ts [outdir]

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface GearGeometry {
  teeth: number;
  outer: number;
  root: number;
  hole: number;
  /** Tooth tip width as a fraction of the pitch angle. */
  tipWidth: number;
  /** Corner radius, in the same units as the radii. */
  corner: number;
}

export const GEAR_GEOMETRY: GearGeometry = {
  teeth: 8,
  outer: 1.0,
  root: 0.8,
  hole: 0.36,
  tipWidth: 0.3,
  corner: 0.06,
};

const round = (n: number): string => {
  const r = Math.round(n * 10_000) / 10_000;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * The outline, in a 2×2 box centred on the origin, y down.
 *
 * Walked as a sequence of alternating arcs — root arc, up the tooth flank,
 * tip arc, down the flank — with a small circular fillet at each of the four
 * corners of every tooth. The fillet is what stops the mark reading as a
 * technical drawing: sharp teeth at 16px alias into noise, and rounded ones
 * stay legible down to a favicon.
 */
export function gearPath(g: GearGeometry = GEAR_GEOMETRY, cx = 0, cy = 0, scale = 1): string {
  const pitch = (Math.PI * 2) / g.teeth;
  const tipHalf = (pitch * g.tipWidth) / 2;
  const rootHalf = pitch / 2 - tipHalf;

  const at = (r: number, a: number): [number, number] => [
    cx + Math.cos(a) * r * scale,
    cy + Math.sin(a) * r * scale,
  ];

  /**
   * The angular offset a corner fillet of radius `c` occupies on a circle of
   * radius `r`. Small-angle and exact enough at these radii: the fillet is
   * 6% of the outer radius, and the error against a true tangent construction
   * is below a tenth of a pixel at 1024px.
   */
  const arcOffset = (r: number, c: number): number => Math.min(c / r, pitch / 4);
  const rootFillet = arcOffset(g.root, g.corner);
  const tipFillet = arcOffset(g.outer, g.corner);
  const radialFillet = g.corner;

  const parts: string[] = [];
  // Start at the middle of the first root arc, so the path opens on a curve
  // rather than on a corner and the first segment is not a special case.
  const start = -Math.PI / 2 - pitch / 2 + rootHalf / 2;
  const [sx, sy] = at(g.root, start - rootHalf / 2);
  parts.push(`M ${round(sx)} ${round(sy)}`);

  for (let i = 0; i < g.teeth; i++) {
    const centre = -Math.PI / 2 + i * pitch;
    const rootStart = centre - rootHalf - tipHalf;
    const toothStart = centre - tipHalf;
    const toothEnd = centre + tipHalf;
    const rootEnd = centre + tipHalf + rootHalf;

    // Along the root, stopping short of the rising flank by one fillet.
    const [ax, ay] = at(g.root, toothStart - rootFillet);
    parts.push(
      `A ${round(g.root * scale)} ${round(g.root * scale)} 0 0 1 ${round(ax)} ${round(ay)}`,
    );
    // Fillet into the flank.
    const [bx, by] = at(g.root + radialFillet, toothStart);
    parts.push(
      `Q ${round(at(g.root, toothStart)[0])} ${round(at(g.root, toothStart)[1])} ${round(bx)} ${round(by)}`,
    );
    // Up the flank, stopping short of the tip.
    const [ct, dt] = at(g.outer - radialFillet, toothStart);
    parts.push(`L ${round(ct)} ${round(dt)}`);
    // Fillet onto the tip.
    const [ex, ey] = at(g.outer, toothStart + tipFillet);
    parts.push(
      `Q ${round(at(g.outer, toothStart)[0])} ${round(at(g.outer, toothStart)[1])} ${round(ex)} ${round(ey)}`,
    );
    // Across the tip.
    const [fx, fy] = at(g.outer, toothEnd - tipFillet);
    parts.push(
      `A ${round(g.outer * scale)} ${round(g.outer * scale)} 0 0 1 ${round(fx)} ${round(fy)}`,
    );
    // Fillet off the tip.
    const [gx, gy] = at(g.outer - radialFillet, toothEnd);
    parts.push(
      `Q ${round(at(g.outer, toothEnd)[0])} ${round(at(g.outer, toothEnd)[1])} ${round(gx)} ${round(gy)}`,
    );
    // Down the flank.
    const [hx, hy] = at(g.root + radialFillet, toothEnd);
    parts.push(`L ${round(hx)} ${round(hy)}`);
    // Fillet back onto the root.
    const [ix, iy] = at(g.root, toothEnd + rootFillet);
    parts.push(
      `Q ${round(at(g.root, toothEnd)[0])} ${round(at(g.root, toothEnd)[1])} ${round(ix)} ${round(iy)}`,
    );
    // The rest of the root, up to where the next tooth's lead-in begins.
    const [jx, jy] = at(g.root, rootEnd);
    parts.push(
      `A ${round(g.root * scale)} ${round(g.root * scale)} 0 0 1 ${round(jx)} ${round(jy)}`,
    );
    void rootStart;
  }
  parts.push("Z");

  // The hole, as a second subpath. Two half-arcs because one 360° arc is
  // degenerate in SVG (the start and end points coincide and the renderer is
  // free to draw nothing).
  const h = g.hole * scale;
  parts.push(`M ${round(cx - h)} ${round(cy)}`);
  parts.push(`A ${round(h)} ${round(h)} 0 1 0 ${round(cx + h)} ${round(cy)}`);
  parts.push(`A ${round(h)} ${round(h)} 0 1 0 ${round(cx - h)} ${round(cy)}`);
  parts.push("Z");

  return parts.join(" ");
}

/** The mark at a given box size, filled with `fill`. */
export function markSvg(size = 32, fill = "currentColor", g: GearGeometry = GEAR_GEOMETRY): string {
  const c = size / 2;
  // 0.94 so the tooth tips have a hair of breathing room inside the box and the
  // mark does not read as cropped when it sits flush against an edge.
  const path = gearPath(g, c, c, c * 0.94);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="Gear">\n` +
    `  <path fill="${fill}" fill-rule="evenodd" d="${path}" />\n` +
    `</svg>\n`
  );
}

/** The app icon: the mark on its ground, with the platform's rounded square. */
export function iconSvg(size = 1024, fill = "#1B3FE4", ground = "#FAFAF8"): string {
  const c = size / 2;
  const path = gearPath(GEAR_GEOMETRY, c, c, c * 0.62);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="Gear">\n` +
    `  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="${ground}" />\n` +
    `  <path fill="${fill}" fill-rule="evenodd" d="${path}" />\n` +
    `</svg>\n`
  );
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? "apps/web/branding";
  mkdirSync(outDir, { recursive: true });

  // The mark itself takes `currentColor`, so one file serves the sidebar, the
  // empty state and anything else that already knows what colour it is.
  const mark = markSvg(32, "currentColor");
  writeFileSync(join(outDir, "gear-mark.svg"), mark);

  // The favicon cannot take `currentColor` — nothing upstream of it has a
  // colour — so it carries the accent and a `prefers-color-scheme` swap.
  const favicon = markSvg(32, "#1B3FE4").replace(
    "<path",
    `<style>@media (prefers-color-scheme: dark) { path { fill: #5B79FF } }</style>\n  <path`,
  );
  writeFileSync(join(outDir, "favicon.svg"), favicon);

  writeFileSync(join(outDir, "icon-1024.svg"), iconSvg(1024));
  writeFileSync(join(outDir, "apple-touch-icon.svg"), iconSvg(180));

  console.log(`wrote gear-mark.svg, favicon.svg, icon-1024.svg, apple-touch-icon.svg to ${outDir}`);
  console.log(
    `geometry: ${GEAR_GEOMETRY.teeth} teeth, outer ${GEAR_GEOMETRY.outer}, root ${GEAR_GEOMETRY.root}, ` +
      `hole ${GEAR_GEOMETRY.hole}, tip ${GEAR_GEOMETRY.tipWidth} of pitch, corner ${GEAR_GEOMETRY.corner}`,
  );
}
