// ─── Dashboard design system ───
//
// The visual floor for interactive_dashboard is guaranteed HERE, by the
// harness, not by the driving model: a dark bento-grid theme (cards, KPIs
// incl. hero/icon variants, chips, tables, progress bars, heatmaps,
// timelines, section dividers), per-view accent theming, tuned Chart.js
// defaults (muted grids, rounded bars, gradient area fills, palette
// auto-assignment), and a declarative spec renderer so a model describes
// CONTENT and the page comes out looking designed regardless of which model
// wrote it. The ceiling — composition, art direction, restraint — is taught
// by the design charter in orchestrator/src/prompts.ts; keep the two in sync.
//
// All three exports are raw strings injected into dashboard pages:
//   THEME_CSS          — design tokens + component classes (+ print styles)
//   CHART_DEFAULTS_JS  — Chart.js global defaults + runeTheme plugin + window.RUNE helpers
//   SPEC_RENDERER_JS   — renders window.__RUNE_SPEC__ into #rune-root and
//                        implements window.render(payload) (full spec re-render
//                        or key-bound live data application)
//
// Client code is plain browser JS built with string concatenation (no
// template literals) so these TS template strings stay literal-safe.

export const THEME_CSS = `
:root {
  --bg: #0b0c0f;
  --panel: #14161b;
  --panel-2: #1a1d24;
  --line: rgba(255, 255, 255, 0.07);
  --line-strong: rgba(255, 255, 255, 0.13);
  --ink: #f0f2f5;
  --muted: #969ca8;
  --faint: #686f7d;
  --accent: #c8f169;
  --accent-soft: rgba(200, 241, 105, 0.15);
  --up: #8ce99a;
  --down: #ff8896;
  --warn: #ffd66e;
  --info: #7cc7ff;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Inter", sans-serif;
  --mono: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace;
}

/* ── Art directions ──
   The dark bento grid below is one house style, and for a long time it was the
   ONLY one: every view Rune rendered came out identical except for a single
   accent hue, whether the subject was a genomics lab, a cost report, or a
   music festival. That sameness is what reads as "generated".

   These are token-level swaps, so every component class inherits them
   untouched. Selected with the spec's 'direction' field (or by setting
   data-direction on <html> from raw html). Each is a real direction, not a
   recolour: ground, type, and the structural moves that make it read as
   itself. See the frontend-design skill's art-directions.md for the full
   catalogue and how to choose one WITH the user. */

/* Editorial paper — for reports, studies, analysis meant to be READ. */
:root[data-direction="paper"] {
  --bg: #fbf8f1;
  --panel: #ffffff;
  --panel-2: #f4efe4;
  --line: rgba(43, 35, 24, 0.14);
  --line-strong: rgba(43, 35, 24, 0.28);
  --ink: #1d1913;
  --muted: #6a5f50;
  --faint: #948873;
  --accent: #9a3412;
  --accent-soft: rgba(154, 52, 18, 0.12);
  --up: #2f6b3f;
  --down: #a32b32;
  --warn: #9a6b12;
  --info: #2c5d86;
  --font: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}
:root[data-direction="paper"] .card { border-radius: 4px; box-shadow: 0 1px 2px rgba(43,35,24,.06); }
:root[data-direction="paper"] .dash-title { font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
:root[data-direction="paper"] .dash-sub { font-size: 15px; max-width: 62ch; }
:root[data-direction="paper"] .prose { font-size: 15px; line-height: 1.7; color: var(--ink); }
:root[data-direction="paper"] .kpi-label,
:root[data-direction="paper"] .sec-title { font-family: var(--mono); letter-spacing: 0.06em; }

/* Swiss / International — for scientific, institutional, archival work.
   Authority from rigour: white, a strict rule system, red as the only accent,
   and no decoration anywhere. Cards stop being cards. */
:root[data-direction="swiss"] {
  --bg: #ffffff;
  --panel: #ffffff;
  --panel-2: #f6f6f6;
  --line: rgba(0, 0, 0, 0.16);
  --line-strong: rgba(0, 0, 0, 0.85);
  --ink: #000000;
  --muted: #52525b;
  --faint: #8a8a92;
  --accent: #e1140a;
  --accent-soft: rgba(225, 20, 10, 0.10);
  --up: #1b7f3b;
  --down: #e1140a;
  --warn: #8a6d00;
  --info: #17457a;
  --font: "Helvetica Neue", Helvetica, Inter, Arial, sans-serif;
}
:root[data-direction="swiss"] .card {
  background: transparent;
  border: 0;
  border-top: 2px solid var(--line-strong);
  border-radius: 0;
  padding: 14px 0 20px;
  animation: none;
}
:root[data-direction="swiss"] .dash-title { font-size: 40px; font-weight: 700; letter-spacing: -0.03em; }
:root[data-direction="swiss"] .kpi-value { font-weight: 700; }
:root[data-direction="swiss"] .sec-rule { background: var(--line-strong); height: 2px; }
:root[data-direction="swiss"] .chip { border-radius: 0; }

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
::selection { background: rgba(200, 241, 105, 0.25); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 8px; border: 2px solid var(--bg); }
::-webkit-scrollbar-track { background: transparent; }

/* ── Shell ── */
.dash { max-width: 1360px; margin: 0 auto; padding: 28px 28px 48px; }
.dash-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 4px 2px 22px; flex-wrap: wrap; }
.dash-title { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; margin: 0; }
.dash-sub { color: var(--muted); font-size: 13px; margin: 6px 0 0; max-width: 72ch; line-height: 1.5; }
.dash-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ── Bento grid ── */
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
.span-2 { grid-column: span 2; } .span-3 { grid-column: span 3; }
.span-4 { grid-column: span 4; } .span-5 { grid-column: span 5; }
.span-6 { grid-column: span 6; } .span-7 { grid-column: span 7; }
.span-8 { grid-column: span 8; } .span-9 { grid-column: span 9; }
.span-10 { grid-column: span 10; } .span-12 { grid-column: span 12; }
@media (max-width: 1100px) {
  .span-2, .span-3, .span-4, .span-5 { grid-column: span 6; }
  .span-6, .span-7, .span-8, .span-9, .span-10 { grid-column: span 12; }
}
@media (max-width: 680px) { .grid > * { grid-column: span 12 !important; } .dash { padding: 18px 14px 40px; } }

/* ── Cards ── */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px 20px;
  min-width: 0;
  position: relative;
  overflow: hidden;
  animation: rune-in 0.45s cubic-bezier(0.2, 0.7, 0.3, 1) both;
}
.grid > .card:nth-child(2) { animation-delay: 0.04s; }
.grid > .card:nth-child(3) { animation-delay: 0.08s; }
.grid > .card:nth-child(4) { animation-delay: 0.12s; }
.grid > .card:nth-child(5) { animation-delay: 0.16s; }
.grid > .card:nth-child(n+6) { animation-delay: 0.2s; }
@keyframes rune-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.card-title { font-size: 13px; font-weight: 600; color: var(--ink); letter-spacing: 0.01em; margin: 0; }
.card-aside { font-size: 11px; color: var(--faint); }
.card-note { margin-top: 12px; font-size: 11.5px; color: var(--faint); line-height: 1.5; }

/* ── KPI ── */
.kpi-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); }
.kpi-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin-top: 10px; }
.kpi-value { font-size: 30px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1.05; }
.kpi-value .unit { font-size: 16px; font-weight: 550; color: var(--muted); margin: 0 2px; }
.kpi-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; min-height: 18px; }
.kpi-icon {
  position: absolute; top: 14px; right: 16px; width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center; font-size: 15px;
  border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line);
}
.card.has-icon .kpi-label { padding-right: 44px; }
/* Hero KPI: display-size number for single-figure stories. */
.card.kpi-hero .kpi-value { font-size: 46px; letter-spacing: -0.035em; }
.card.kpi-hero .kpi-value .unit { font-size: 22px; }
.card.kpi-hero .kpi-spark { width: 150px; height: 46px; }
/* Fixed, positioned container: Chart.js sizes the canvas to THIS box, so
   sparklines can never overflow their card. */
.kpi-spark { position: relative; width: 96px; height: 34px; flex: none; overflow: hidden; }
.kpi-spark canvas { position: absolute; inset: 0; }

/* ── Chips / badges ── */
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; line-height: 1;
  padding: 4px 9px; border-radius: 999px;
  background: var(--panel-2); color: var(--muted);
  border: 1px solid var(--line);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.chip.accent { color: #0b0c0f; background: var(--accent); border-color: transparent; }
.chip.good { color: var(--up); background: rgba(140, 233, 154, 0.12); border-color: transparent; }
.chip.bad { color: var(--down); background: rgba(255, 136, 150, 0.12); border-color: transparent; }
.chip.warn { color: var(--warn); background: rgba(255, 214, 110, 0.12); border-color: transparent; }
.chip.info { color: var(--info); background: rgba(124, 199, 255, 0.12); border-color: transparent; }

/* ── Charts ── */
.chart-wrap { position: relative; height: 260px; }

/* ── Tables ── */
.tbl-scroll { overflow-x: auto; margin: 0 -6px; }
table.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.tbl th {
  text-align: left; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--faint); padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
table.tbl td { padding: 10px; border-bottom: 1px solid var(--line); color: var(--ink); font-variant-numeric: tabular-nums; }
table.tbl tr:last-child td { border-bottom: none; }
table.tbl tbody tr { transition: background 0.12s; }
table.tbl tbody tr:hover { background: rgba(255, 255, 255, 0.025); }
table.tbl th.num, table.tbl td.num { text-align: right; }

/* ── Lists ── */
.rows { display: flex; flex-direction: column; }
.row-item { display: flex; align-items: center; gap: 12px; padding: 10px 2px; border-bottom: 1px solid var(--line); }
.row-item:last-child { border-bottom: none; }
.row-icon {
  width: 30px; height: 30px; border-radius: 9px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel-2); border: 1px solid var(--line); font-size: 14px;
}
.row-main { min-width: 0; flex: 1; }
.row-title { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sub { font-size: 11px; color: var(--faint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-value { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* ── Progress ── */
.prog { padding: 7px 0; }
.prog-top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 7px; }
.prog-label { color: var(--ink); font-weight: 550; }
.prog-value { color: var(--muted); font-variant-numeric: tabular-nums; }
.prog-track { height: 6px; border-radius: 999px; background: var(--panel-2); overflow: hidden; }
.prog-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 0.6s cubic-bezier(0.2, 0.7, 0.3, 1); }

/* ── Heatmap ── */
.hm { display: grid; gap: 4px; align-items: stretch; }
.hm-row-label { font-size: 10px; color: var(--faint); align-self: center; padding-right: 8px; white-space: nowrap; }
.hm-cell { height: 20px; border-radius: 5px; background: var(--panel-2); min-width: 0; }
.hm-col-label { font-size: 9.5px; color: var(--faint); text-align: center; padding-top: 3px; overflow: hidden; white-space: nowrap; }

/* ── Timeline ── */
.tl { display: flex; flex-direction: column; padding: 2px 0; }
.tl-item { display: flex; gap: 12px; position: relative; padding: 2px 0 16px; }
.tl-item:last-child { padding-bottom: 2px; }
.tl-rail { width: 12px; flex: none; position: relative; }
.tl-dot { position: absolute; left: 50%; top: 5px; width: 8px; height: 8px; border-radius: 50%; transform: translateX(-50%); background: rgba(255, 255, 255, 0.28); }
.tl-dot.accent { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.tl-dot.good { background: var(--up); } .tl-dot.bad { background: var(--down); }
.tl-dot.warn { background: var(--warn); } .tl-dot.info { background: var(--info); }
.tl-item:not(:last-child) .tl-rail::after {
  content: ""; position: absolute; left: 50%; top: 17px; bottom: -3px; width: 1px;
  transform: translateX(-50%); background: var(--line-strong);
}
.tl-main { flex: 1; min-width: 0; }
.tl-title { font-size: 12.5px; font-weight: 550; }
.tl-sub { font-size: 11px; color: var(--faint); margin-top: 2px; line-height: 1.45; }
.tl-time { font-size: 10.5px; color: var(--faint); font-family: var(--mono); white-space: nowrap; padding-top: 2px; }

/* ── Section dividers ── */
.sec { grid-column: span 12; display: flex; align-items: center; gap: 12px; margin: 12px 2px -2px; }
.sec-title { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); white-space: nowrap; }
.sec-rule { flex: 1; height: 1px; background: var(--line); }
.sec-aside { font-size: 11px; color: var(--faint); white-space: nowrap; }

/* ── Text blocks ── */
.prose { font-size: 13px; line-height: 1.65; color: var(--muted); }
.prose p { margin: 0 0 10px; } .prose p:last-child { margin-bottom: 0; }
.prose ul { margin: 0; padding-left: 18px; } .prose li { margin: 4px 0; }
.prose strong { color: var(--ink); }

/* ── Print / PDF export ── */
@media print {
  html, body { background: var(--bg) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .card { animation: none !important; opacity: 1 !important; break-inside: avoid; }
  .dash { max-width: none; padding: 12px; }
}
@page { margin: 10mm; }
`;

// Floating live/export cluster. Injected by the live bootstrap as its own
// <style> so it works on model-authored full-document pages that never load
// THEME_CSS. Self-contained: no var() dependencies.
export const FAB_CSS = `
.rune-fab { position: fixed; top: 14px; right: 16px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.rune-fab .rune-live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; line-height: 1;
  letter-spacing: 0.06em; padding: 6px 11px; border-radius: 999px; color: #c8f169;
  background: rgba(20, 22, 27, 0.85); border: 1px solid rgba(255, 255, 255, 0.13); backdrop-filter: blur(10px); }
.rune-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #c8f169; animation: rune-pulse 1.6s ease-in-out infinite; }
@keyframes rune-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.rune-export { position: relative; }
.rune-export > button { all: unset; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font-family: inherit; font-size: 11px; font-weight: 600; line-height: 1; padding: 6px 11px; border-radius: 999px;
  background: rgba(20, 22, 27, 0.85); color: #f0f2f5; border: 1px solid rgba(255, 255, 255, 0.13); backdrop-filter: blur(10px); }
.rune-export > button:hover { border-color: rgba(255, 255, 255, 0.3); }
.rune-export-menu { position: absolute; right: 0; top: calc(100% + 6px); min-width: 200px;
  background: #1a1d24; border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 12px; padding: 5px;
  display: none; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); }
.rune-export.open .rune-export-menu { display: block; }
.rune-export-menu a, .rune-export-menu button { all: unset; display: block; width: 100%; cursor: pointer; box-sizing: border-box;
  font-family: inherit; font-size: 12px; color: #f0f2f5; padding: 8px 10px; border-radius: 8px; text-decoration: none; }
.rune-export-menu a:hover, .rune-export-menu button:hover { background: rgba(255, 255, 255, 0.07); }
@media print { .rune-fab { display: none !important; } }
`;

// Palette shared with the client (kept in one place; CSS uses --accent).
export const DASH_PALETTE = [
  "#c8f169", // lime (accent)
  "#ff9f68", // orange
  "#7cc7ff", // sky
  "#b8a1ff", // violet
  "#ffd66e", // amber
  "#6fe3c2", // teal
  "#ff8fa8", // rose
  "#9fb0c8", // slate
];

export const CHART_DEFAULTS_JS = `
(function () {
  if (!window.Chart) return;
  var C = window.Chart;
  var MUTED = "#969ca8", FAINT = "#686f7d", GRID = "rgba(255,255,255,0.055)", PANEL = "#14161b";
  var PALETTE = ${JSON.stringify(DASH_PALETTE)};

  function hexToRgba(hex, a) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function areaGradient(color) {
    return function (ctx) {
      var area = ctx.chart.chartArea;
      if (!area) return hexToRgba(color, 0.12);
      var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexToRgba(color, 0.28));
      g.addColorStop(1, hexToRgba(color, 0.01));
      return g;
    };
  }
  function fmtNum(v) {
    if (typeof v !== "number" || !isFinite(v)) return String(v);
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\\.0$/, "") + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\\.0$/, "") + "M";
    if (a >= 1e5) return (v / 1e3).toFixed(0) + "K";
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  window.RUNE = { palette: PALETTE, rgba: hexToRgba, gradient: areaGradient, fmt: fmtNum };

  C.defaults.color = MUTED;
  C.defaults.font.family = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  C.defaults.font.size = 11;
  C.defaults.borderColor = GRID;
  C.defaults.responsive = true;
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation.duration = 500;
  C.defaults.elements.point.radius = 0;
  C.defaults.elements.point.hoverRadius = 4;
  C.defaults.elements.point.hitRadius = 12;
  C.defaults.elements.line.borderWidth = 2.25;
  C.defaults.elements.line.tension = 0.4;
  C.defaults.elements.line.borderCapStyle = "round";
  C.defaults.elements.bar.borderRadius = 7;
  C.defaults.elements.bar.borderSkipped = false;
  C.defaults.elements.arc.borderWidth = 3;
  C.defaults.elements.arc.borderColor = PANEL;
  if (C.defaults.datasets && C.defaults.datasets.bar) {
    C.defaults.datasets.bar.maxBarThickness = 26;
    C.defaults.datasets.bar.categoryPercentage = 0.62;
    C.defaults.datasets.bar.barPercentage = 0.78;
  }
  if (C.defaults.datasets && C.defaults.datasets.doughnut) C.defaults.datasets.doughnut.cutout = "72%";
  // Axis theming that CAN be expressed globally lives in defaults (the
  // options object charts expose at runtime is a resolver proxy — per-chart
  // "merge if unset" reads through it resolve defaults and lie).
  C.defaults.scale.grid = C.defaults.scale.grid || {};
  C.defaults.scale.grid.color = GRID;
  C.defaults.scale.grid.drawTicks = false;
  C.defaults.scale.border = C.defaults.scale.border || {};
  C.defaults.scale.border.display = false;
  C.defaults.scale.ticks = C.defaults.scale.ticks || {};
  C.defaults.scale.ticks.color = FAINT;
  C.defaults.scale.ticks.padding = 8;
  var L = C.defaults.plugins.legend;
  L.position = "top";
  L.align = "end";
  L.labels.usePointStyle = true;
  L.labels.pointStyle = "circle";
  L.labels.boxWidth = 6;
  L.labels.boxHeight = 6;
  L.labels.padding = 14;
  L.labels.color = MUTED;
  var T = C.defaults.plugins.tooltip;
  T.backgroundColor = "#1d2027";
  T.borderColor = "rgba(255,255,255,0.09)";
  T.borderWidth = 1;
  T.titleColor = "#f0f2f5";
  T.bodyColor = MUTED;
  T.padding = 12;
  T.cornerRadius = 10;
  T.usePointStyle = true;
  T.boxWidth = 7;
  T.boxHeight = 7;
  T.boxPadding = 4;
  T.titleFont = { weight: 600, size: 12 };
  if (C.defaults.plugins.colors) C.defaults.plugins.colors.enabled = false;

  // runeTheme plugin: palette auto-assignment for uncolored datasets, gradient
  // area fills, calm axes (no x grid, sparse muted y ticks). Everything is
  // "only if the author didn't set it" so explicit configs stay in control.
  C.register({
    id: "runeTheme",
    beforeInit: function (chart) {
      try {
        // Read the live palette: the spec renderer rotates window.RUNE.palette
        // when a view sets its own accent, and auto-coloring must follow.
        var PAL = (window.RUNE && window.RUNE.palette && window.RUNE.palette.length)
          ? window.RUNE.palette : PALETTE;
        var type = chart.config.type;
        var ds = (chart.config.data && chart.config.data.datasets) || [];
        for (var i = 0; i < ds.length; i++) {
          var d = ds[i];
          var dtype = d.type || type;
          var color = PAL[i % PAL.length];
          if (dtype === "doughnut" || dtype === "pie" || dtype === "polarArea") {
            if (!d.backgroundColor) {
              var n = (d.data || []).length || PAL.length;
              var arr = [];
              for (var j = 0; j < n; j++) arr.push(PAL[j % PAL.length]);
              d.backgroundColor = arr;
            }
            continue;
          }
          if (!d.borderColor) d.borderColor = color;
          if (!d.backgroundColor) {
            var base = typeof d.borderColor === "string" ? d.borderColor : color;
            if (dtype === "line" || dtype === "radar" || dtype === "scatter") {
              d.backgroundColor = d.fill ? areaGradient(base) : hexToRgba(base, 0.35);
            } else {
              d.backgroundColor = base;
            }
          }
          if (dtype === "line" && d.fill && typeof d.backgroundColor === "string") {
            d.backgroundColor = areaGradient(typeof d.borderColor === "string" ? d.borderColor : color);
          }
        }
      } catch (e) { /* theming must never break a chart */ }
    }
  });
})();
`;

// Renders window.__RUNE_SPEC__ into #rune-root and exposes window.render.
export const SPEC_RENDERER_JS = `
(function () {
  var charts = [];
  var keyed = {}; // key -> { kind, el, chart, item }
  var firstRender = true;
  var ACCENT = "#c8f169";
  var BASE_PALETTE = null; // window.RUNE.palette before any accent rotation

  // Per-view art direction: a spec-level accent recolors the CSS tokens and
  // rotates the chart palette so the accent leads series/slice assignment.
  // Absent or invalid accents restore the defaults (updates can de-theme).
  function applyDirection(direction) {
    var allowed = { console: 1, paper: 1, swiss: 1 };
    var el = document.documentElement;
    if (direction && allowed[direction] && direction !== "console") {
      el.setAttribute("data-direction", direction);
    } else {
      el.removeAttribute("data-direction");
    }
  }
  function applyAccent(accent) {
    var doc = document.documentElement;
    if (window.RUNE && !BASE_PALETTE) BASE_PALETTE = window.RUNE.palette.slice();
    var ok = typeof accent === "string" && /^#[0-9a-fA-F]{6}$/.test(accent);
    ACCENT = ok ? accent : "#c8f169";
    if (ok) {
      doc.style.setProperty("--accent", accent);
      if (window.RUNE) {
        doc.style.setProperty("--accent-soft", window.RUNE.rgba(accent, 0.16));
        var rest = [];
        for (var i = 0; i < (BASE_PALETTE || []).length; i++) {
          if (BASE_PALETTE[i].toLowerCase() !== accent.toLowerCase()) rest.push(BASE_PALETTE[i]);
        }
        window.RUNE.palette = [accent].concat(rest);
      }
    } else {
      doc.style.removeProperty("--accent");
      doc.style.removeProperty("--accent-soft");
      if (window.RUNE && BASE_PALETTE) window.RUNE.palette = BASE_PALETTE.slice();
    }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function fmt(v) { return window.RUNE ? window.RUNE.fmt(v) : String(v); }
  function toneClass(t) {
    return t === "good" || t === "bad" || t === "warn" || t === "info" || t === "accent" ? t : "";
  }
  function chip(text, tone) {
    var c = el("span", "chip " + toneClass(tone), text);
    return c;
  }
  function deltaChip(delta) {
    if (delta === undefined || delta === null || delta === "") return null;
    var s = String(delta);
    var neg = s.charAt(0) === "-";
    var pos = !neg && (s.charAt(0) === "+" || (typeof delta === "number" && delta > 0));
    if (typeof delta === "number") s = (delta > 0 ? "+" : "") + fmt(delta) + "%";
    return chip((pos ? "\\u2197 " : neg ? "\\u2198 " : "") + s, neg ? "bad" : pos ? "good" : "");
  }
  function isSpec(p) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    var okItems = Array.isArray(p.items) && p.items.every(function (o) { return o && typeof o === "object" && !Array.isArray(o); });
    var okKpis = Array.isArray(p.kpis) && p.kpis.every(function (o) { return o && typeof o === "object" && !Array.isArray(o); });
    return okItems || okKpis;
  }

  // ── charts from the simple shape ──
  function seriesColor(s, i) {
    return s.color || (window.RUNE ? window.RUNE.palette[i % window.RUNE.palette.length] : undefined);
  }
  function chartConfig(c) {
    if (c.raw) return c.raw; // full Chart.js config escape hatch
    var kind = c.kind || "line";
    var series = c.series || [];
    var stacked = kind === "stacked-bar" || !!c.stacked;
    var horizontal = kind === "hbar";
    var type = kind === "area" ? "line" : kind === "stacked-bar" || kind === "hbar" ? "bar" : kind;
    var datasets = [];
    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      var d = { label: s.name || "Series " + (i + 1), data: s.data || [] };
      var col = seriesColor(s, i);
      if (col) { d.borderColor = col; if (type !== "line") d.backgroundColor = col; }
      if (kind === "area" || s.fill) { d.fill = true; }
      if (s.dashed) d.borderDash = [5, 5];
      datasets.push(d);
    }
    var config = {
      type: type,
      data: { labels: c.labels || [], datasets: datasets },
      options: {
        animation: firstRender ? undefined : false,
        plugins: { legend: { display: series.length > 1 } }
      }
    };
    if (type === "doughnut" || type === "pie" || type === "polarArea" || type === "radar") {
      if (type === "doughnut" || type === "pie") {
        config.data.datasets = [{ data: (series[0] && series[0].data) || c.data || [] }];
        config.options.plugins.legend = { display: true, position: "right", align: "center" };
      }
    } else {
      // Explicit axes: calm index axis (no grid), sparse formatted value axis.
      // Built here because runtime chart.options is a resolver proxy — this
      // plain config is the one place per-axis intent reliably lands.
      var indexScale = { grid: { display: false } };
      var valueScale = {
        grid: { color: "rgba(255,255,255,0.055)" },
        ticks: { maxTicksLimit: 6, callback: function (v) { return fmt(v); } }
      };
      var scales = horizontal
        ? { x: valueScale, y: indexScale }
        : { x: indexScale, y: valueScale };
      if (stacked) {
        config.options.indexAxis = horizontal ? "y" : undefined;
        scales.x.stacked = true;
        scales.y.stacked = true;
      }
      if (horizontal) config.options.indexAxis = "y";
      if (c.max !== undefined) valueScale.max = c.max;
      config.options.scales = scales;
    }
    return config;
  }
  function centerTextPlugin(center) {
    return {
      id: "runeCenter",
      afterDraw: function (chart) {
        var area = chart.chartArea;
        if (!area) return;
        var ctx = chart.ctx;
        var cx = (area.left + area.right) / 2, cy = (area.top + area.bottom) / 2;
        ctx.save();
        ctx.textAlign = "center";
        ctx.fillStyle = "#f0f2f5";
        ctx.font = "650 22px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(String(center.value !== undefined ? center.value : ""), cx, cy - (center.label ? 4 : -7));
        if (center.label) {
          ctx.fillStyle = "#686f7d";
          ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(String(center.label).toUpperCase(), cx, cy + 14);
        }
        ctx.restore();
      }
    };
  }
  function makeChart(canvas, c) {
    var cfg = chartConfig(c);
    var plugins = [];
    if (c.center && (cfg.type === "doughnut" || cfg.type === "pie")) plugins.push(centerTextPlugin(c.center));
    if (plugins.length) cfg.plugins = (cfg.plugins || []).concat(plugins);
    var chart = new window.Chart(canvas.getContext("2d"), cfg);
    charts.push(chart);
    return chart;
  }
  function sparkline(canvas, data, color) {
    var chart = new window.Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: data.map(function (_, i) { return i; }), datasets: [{ data: data, borderColor: color, borderWidth: 1.75, fill: true, backgroundColor: window.RUNE ? window.RUNE.gradient(color) : undefined }] },
      options: {
        animation: firstRender ? { duration: 400 } : false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
        elements: { point: { radius: 0 } }
      }
    });
    charts.push(chart);
    return chart;
  }

  // ── blocks ──
  function renderKpi(k, i) {
    var cls = "card span-" + (k.span || (k.hero ? 4 : 3));
    if (k.hero) cls += " kpi-hero";
    if (k.icon) cls += " has-icon";
    var card = el("div", cls);
    if (k.icon) card.appendChild(el("div", "kpi-icon", k.icon));
    card.appendChild(el("div", "kpi-label", k.label || "Metric"));
    var row = el("div", "kpi-row");
    var val = el("div", "kpi-value");
    setKpiValue(val, k);
    row.appendChild(val);
    if (Array.isArray(k.spark) && k.spark.length > 1) {
      var wrap = el("div", "kpi-spark");
      var sc = el("canvas");
      wrap.appendChild(sc);
      row.appendChild(wrap);
      // Sparks follow the view accent (charter: one accent per view), not the
      // rotating series palette — KPI rows must read as one instrument.
      var color = k.color || ACCENT;
      requestAnimationFrame(function () { var ch = sparkline(sc, k.spark, color); if (k.key) keyed[k.key].spark = ch; });
    }
    card.appendChild(row);
    var foot = el("div", "kpi-foot");
    var d = deltaChip(k.delta);
    if (d) foot.appendChild(d);
    if (k.note) foot.appendChild(el("span", "card-aside", k.note));
    card.appendChild(foot);
    if (k.key) keyed[k.key] = { kind: "kpi", el: val, foot: foot, item: k };
    return card;
  }
  function setKpiValue(valEl, k) {
    valEl.textContent = "";
    if (k.prefix) valEl.appendChild(el("span", "unit", k.prefix));
    valEl.appendChild(document.createTextNode(typeof k.value === "number" ? fmt(k.value) : String(k.value !== undefined ? k.value : "\\u2014")));
    if (k.suffix) valEl.appendChild(el("span", "unit", k.suffix));
  }

  function cardShell(item, defSpan) {
    var card = el("div", "card span-" + (item.span || defSpan));
    if (item.title || item.aside) {
      var head = el("div", "card-head");
      head.appendChild(el("h3", "card-title", item.title || ""));
      if (item.aside) head.appendChild(el("span", "card-aside", item.aside));
      card.appendChild(head);
    }
    return card;
  }
  function renderChart(item) {
    var card = cardShell(item, 6);
    var wrap = el("div", "chart-wrap");
    if (item.height) wrap.style.height = item.height + "px";
    var canvas = el("canvas");
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    if (item.note) card.appendChild(el("div", "card-note", item.note));
    requestAnimationFrame(function () {
      var ch = makeChart(canvas, item.chart || {});
      if (item.key) keyed[item.key] = { kind: "chart", chart: ch, item: item };
    });
    return card;
  }
  function tdFor(cell) {
    var td = el("td");
    if (cell !== null && typeof cell === "object") {
      td.appendChild(chip(cell.chip !== undefined ? cell.chip : cell.text, cell.tone));
    } else if (typeof cell === "number") {
      td.className = "num";
      td.textContent = fmt(cell);
    } else {
      td.textContent = cell === undefined || cell === null ? "" : String(cell);
    }
    return td;
  }
  function fillTable(tbody, rows, columns) {
    tbody.textContent = "";
    (rows || []).forEach(function (r) {
      var tr = el("tr");
      (r || []).forEach(function (cell) { tr.appendChild(tdFor(cell)); });
      tbody.appendChild(tr);
    });
  }
  function renderTable(item) {
    var card = cardShell(item, 6);
    var scroll = el("div", "tbl-scroll");
    var table = el("table", "tbl");
    var thead = el("thead");
    var trh = el("tr");
    var numeric = [];
    var rows = item.rows || [];
    (item.columns || []).forEach(function (c, ci) {
      var isNum = rows.length > 0 && rows.every(function (r) { return typeof (r || [])[ci] === "number" || (r || [])[ci] === undefined; });
      numeric.push(isNum);
      var th = el("th", isNum ? "num" : "", c);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = el("tbody");
    fillTable(tbody, rows, item.columns);
    // apply numeric alignment detected from data
    Array.prototype.forEach.call(tbody.children, function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, ci) {
        if (numeric[ci] && !td.className) td.className = "num";
      });
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    if (item.note) card.appendChild(el("div", "card-note", item.note));
    if (item.key) keyed[item.key] = { kind: "table", tbody: tbody, item: item };
    return card;
  }
  function renderList(item) {
    var card = cardShell(item, 4);
    var box = el("div", "rows");
    (item.items || []).forEach(function (it) {
      var row = el("div", "row-item");
      if (it.icon) row.appendChild(el("div", "row-icon", it.icon));
      var main = el("div", "row-main");
      main.appendChild(el("div", "row-title", it.title));
      if (it.sub) main.appendChild(el("div", "row-sub", it.sub));
      row.appendChild(main);
      if (it.chip !== undefined) row.appendChild(chip(it.chip, it.tone));
      else if (it.value !== undefined) row.appendChild(el("div", "row-value", typeof it.value === "number" ? fmt(it.value) : it.value));
      box.appendChild(row);
    });
    card.appendChild(box);
    if (item.note) card.appendChild(el("div", "card-note", item.note));
    return card;
  }
  function renderProgress(item) {
    var card = cardShell(item, 4);
    var box = el("div");
    var fills = [];
    (item.items || []).forEach(function (it, i) {
      var p = el("div", "prog");
      var top = el("div", "prog-top");
      top.appendChild(el("span", "prog-label", it.label));
      var v = Math.max(0, Math.min(100, Number(it.value) || 0));
      top.appendChild(el("span", "prog-value", it.display !== undefined ? it.display : v + "%"));
      p.appendChild(top);
      var track = el("div", "prog-track");
      var fill = el("div", "prog-fill");
      fill.style.width = v + "%";
      if (it.color) fill.style.background = it.color;
      else if (window.RUNE && item.multicolor) fill.style.background = window.RUNE.palette[i % window.RUNE.palette.length];
      track.appendChild(fill);
      p.appendChild(track);
      fills.push({ fill: fill, top: top });
      box.appendChild(p);
    });
    card.appendChild(box);
    if (item.key) keyed[item.key] = { kind: "progress", box: box, item: item };
    return card;
  }
  function renderHeatmap(item) {
    var card = cardShell(item, 6);
    var rows = item.rows || [];
    var cols = item.cols || [];
    var values = item.values || [];
    var max = typeof item.max === "number" && item.max > 0 ? item.max : 0;
    if (!max) {
      for (var r = 0; r < values.length; r++) {
        var vr = values[r] || [];
        for (var c = 0; c < vr.length; c++) {
          if (typeof vr[c] === "number" && isFinite(vr[c]) && vr[c] > max) max = vr[c];
        }
      }
    }
    var grid = el("div", "hm");
    grid.style.gridTemplateColumns = "auto repeat(" + Math.max(cols.length, 1) + ", 1fr)";
    for (var ri = 0; ri < rows.length; ri++) {
      grid.appendChild(el("div", "hm-row-label", rows[ri]));
      for (var ci = 0; ci < cols.length; ci++) {
        var v = (values[ri] || [])[ci];
        var cell = el("div", "hm-cell");
        if (typeof v === "number" && isFinite(v) && v > 0 && max > 0) {
          var t = Math.max(0, Math.min(1, v / max));
          if (window.RUNE) cell.style.background = window.RUNE.rgba(ACCENT, 0.07 + 0.88 * t);
        }
        cell.title = rows[ri] + " \\u00b7 " + cols[ci] + ": " + (v === undefined || v === null ? "\\u2014" : fmt(v));
        grid.appendChild(cell);
      }
    }
    if (cols.length) {
      grid.appendChild(el("div"));
      var step = Math.max(1, Math.ceil(cols.length / 12));
      for (var li = 0; li < cols.length; li++) {
        grid.appendChild(el("div", "hm-col-label", li % step === 0 ? cols[li] : ""));
      }
    }
    card.appendChild(grid);
    if (item.note) card.appendChild(el("div", "card-note", item.note));
    return card;
  }
  function renderTimeline(item) {
    var card = cardShell(item, 4);
    var box = el("div", "tl");
    (item.items || []).forEach(function (it) {
      var row = el("div", "tl-item");
      var rail = el("div", "tl-rail");
      rail.appendChild(el("span", "tl-dot " + toneClass(it.tone)));
      row.appendChild(rail);
      var main = el("div", "tl-main");
      main.appendChild(el("div", "tl-title", it.title));
      if (it.sub) main.appendChild(el("div", "tl-sub", it.sub));
      row.appendChild(main);
      if (it.time !== undefined && it.time !== null) row.appendChild(el("div", "tl-time", it.time));
      box.appendChild(row);
    });
    card.appendChild(box);
    if (item.note) card.appendChild(el("div", "card-note", item.note));
    return card;
  }
  function renderSection(item) {
    var sec = el("div", "sec");
    sec.appendChild(el("div", "sec-title", item.title || ""));
    sec.appendChild(el("div", "sec-rule"));
    if (item.aside) sec.appendChild(el("div", "sec-aside", item.aside));
    return sec;
  }
  function renderText(item) {
    var card = cardShell(item, 6);
    var prose = el("div", "prose");
    var lines = String(item.body || "").split("\\n");
    var ul = null;
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) { ul = null; return; }
      if (t.indexOf("- ") === 0) {
        if (!ul) { ul = el("ul"); prose.appendChild(ul); }
        ul.appendChild(el("li", "", t.slice(2)));
      } else {
        ul = null;
        prose.appendChild(el("p", "", t));
      }
    });
    card.appendChild(prose);
    return card;
  }

  function renderSpec(spec) {
    charts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    charts = [];
    keyed = {};
    applyDirection(spec.direction); // ground + type first: the accent sits ON it
    applyAccent(spec.accent); // before any chart exists: palette must lead
    var root = document.getElementById("rune-root");
    if (!root) return;
    root.textContent = "";
    var dash = el("div", "dash");

    var header = el("div", "dash-header");
    var left = el("div");
    left.appendChild(el("h1", "dash-title", spec.title || "Dashboard"));
    if (spec.subtitle) left.appendChild(el("p", "dash-sub", spec.subtitle));
    header.appendChild(left);
    var meta = el("div", "dash-meta");
    (spec.badges || []).forEach(function (b) {
      if (typeof b === "string") meta.appendChild(chip(b));
      else meta.appendChild(chip(b.text, b.tone));
    });
    var updated = el("span", "chip");
    updated.id = "rune-updated";
    updated.style.display = "none";
    meta.appendChild(updated);
    header.appendChild(meta);
    dash.appendChild(header);

    var grid = el("div", "grid");
    (spec.kpis || []).forEach(function (k, i) { grid.appendChild(renderKpi(k, i)); });
    (spec.items || []).forEach(function (item) {
      var t = item.type || (item.chart ? "chart" : item.columns ? "table" : item.values ? "heatmap" : "text");
      if (t === "chart") grid.appendChild(renderChart(item));
      else if (t === "table") grid.appendChild(renderTable(item));
      else if (t === "list") grid.appendChild(renderList(item));
      else if (t === "progress") grid.appendChild(renderProgress(item));
      else if (t === "heatmap") grid.appendChild(renderHeatmap(item));
      else if (t === "timeline") grid.appendChild(renderTimeline(item));
      else if (t === "section") grid.appendChild(renderSection(item));
      else if (t === "kpi") grid.appendChild(renderKpi(item, 0));
      else grid.appendChild(renderText(item));
    });
    dash.appendChild(grid);
    if (spec.footer) {
      var foot = el("div", "card-note", spec.footer);
      foot.style.margin = "18px 4px 0";
      dash.appendChild(foot);
    }
    root.appendChild(dash);
    firstRender = false;
  }

  function stampUpdated() {
    var s = document.getElementById("rune-updated");
    if (!s) return;
    s.style.display = "";
    s.textContent = "updated " + new Date().toLocaleTimeString();
  }

  // Key-bound live updates: payload { key: value } applied to declared items.
  function applyData(payload) {
    if (!payload || typeof payload !== "object") return;
    Object.keys(payload).forEach(function (key) {
      var slot = keyed[key];
      if (!slot) return;
      var v = payload[key];
      try {
        if (slot.kind === "kpi") {
          var k = slot.item;
          if (v !== null && typeof v === "object") {
            if (v.value !== undefined) k.value = v.value;
            if (v.delta !== undefined) k.delta = v.delta;
            if (v.spark && slot.spark) {
              slot.spark.data.labels = v.spark.map(function (_, i) { return i; });
              slot.spark.data.datasets[0].data = v.spark;
              slot.spark.update("none");
            }
          } else k.value = v;
          setKpiValue(slot.el, k);
          slot.foot.textContent = "";
          var d = deltaChip(k.delta);
          if (d) slot.foot.appendChild(d);
          if (k.note) slot.foot.appendChild(el("span", "card-aside", k.note));
        } else if (slot.kind === "chart" && slot.chart) {
          if (v && typeof v === "object") {
            if (Array.isArray(v.labels)) slot.chart.data.labels = v.labels;
            var series = v.series || v.datasets;
            if (Array.isArray(series)) {
              series.forEach(function (s, i) {
                if (!slot.chart.data.datasets[i]) return;
                slot.chart.data.datasets[i].data = Array.isArray(s) ? s : s.data || slot.chart.data.datasets[i].data;
              });
            }
            slot.chart.update("none");
          }
        } else if (slot.kind === "table") {
          var rows = Array.isArray(v) ? v : v && v.rows;
          if (Array.isArray(rows)) fillTable(slot.tbody, rows, slot.item.columns);
        } else if (slot.kind === "progress") {
          var items = Array.isArray(v) ? v : v && v.items;
          if (Array.isArray(items)) {
            slot.item.items = items.map(function (it, i) {
              return typeof it === "number" ? Object.assign({}, slot.item.items[i], { value: it }) : it;
            });
            var fresh = renderProgress(slot.item);
            var old = slot.box.parentElement;
            old.replaceWith(fresh);
          }
        }
      } catch (e) { /* one bad key must not kill the update */ }
    });
    stampUpdated();
  }

  window.render = function (payload) {
    if (isSpec(payload)) {
      var wasFirst = firstRender;
      window.__RUNE_SPEC__ = payload;
      renderSpec(payload);
      if (!wasFirst) stampUpdated();
      return;
    }
    if (window.__RUNE_SPEC__) {
      var root = document.getElementById("rune-root");
      if (root && !root.firstChild) renderSpec(window.__RUNE_SPEC__);
      applyData(payload);
    }
  };
})();
`;

/** Body fragment for spec-driven dashboards: root node + renderer. */
export function specShellHtml(specJson: string): string {
  return `<div id="rune-root"></div>
<script>window.__RUNE_SPEC__ = ${specJson};</script>
<script>${SPEC_RENDERER_JS}</script>`;
}
