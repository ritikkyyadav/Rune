/**
 * The four-region frame, drawn with synthetic content at exact sizes.
 *
 * The pty capture (capture.py) is the honest picture of what the product does,
 * but two of the frames this phase has to show -- a turn in flight and a child
 * transcript open in the workspace split -- cannot be reached without a model
 * call or a demo hook in the product, and this lane is allowed neither. So the
 * geometry is drawn here instead, through the SAME pure functions the TUI
 * paints with: `regions`, `splitPanes`, `composeBand`, `composeFrame`. Nothing
 * is re-implemented; only the content is invented, and it is obviously
 * invented.
 *
 *     bun scripts/tui-capture/frame-demo.ts OUTDIR
 */

import {
  composeBand,
  composeFrame,
  regions,
  splitPanes,
  PANEL_COLS,
  type Regions,
} from "../../packages/orchestrator/src/bin/ui/viewport";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADER_ROWS = 3;
const RULE = "─";
const width = (s: string): number => [...s].length;
const pad = (s: string, w: number): string =>
  width(s) >= w ? [...s].slice(0, w).join("") : s + " ".repeat(w - width(s));
/** flow's 2-cell indent; the right column's gutter is 1. */
const tight = (s: string): string => (s.startsWith(" ") ? s.slice(1) : s);

function header(cols: number, title: string): string[] {
  const usable = cols - 1;
  const left = `  R U N E  ${title}`;
  const right = "v0.4.1-dev+62f02d0";
  const gap = Math.max(1, usable - width(left) - width(right));
  return ["", `${left}${" ".repeat(gap)}${right}`, `  ${"━".repeat(7)}${RULE.repeat(usable - 9)}`];
}

function panel(r: Regions, rows: string[]): string[] {
  const w = r.panelContentCols;
  const out = rows.map((l) => tight(`  ${l}`));
  while (out.length < r.panelRows) out.push("");
  void w;
  return out.slice(0, r.panelRows);
}

function composer(r: Regions, lines: string[]): string[] {
  const w = r.collapsed ? r.workspaceCols - 4 : PANEL_COLS - 2;
  const edge = tight(`  ${RULE.repeat(w)}`);
  const body = lines.map((l) => tight(`  ${pad(l, w)}`.trimEnd()));
  return [edge, ...body, edge, tight(`  enter send · ctrl+f agents · ? keys`)];
}

function frame(opts: {
  cols: number;
  rows: number;
  title: string;
  main: string[];
  panelRows: string[];
  composerRows: string[];
  child?: { header: string; lines: string[] };
  strip?: string;
  status: string;
}): string[] {
  const head = header(opts.cols, opts.title);
  const probe = regions({
    columns: opts.cols,
    rows: opts.rows,
    headerRows: HEADER_ROWS,
    strip: true,
  });
  const comp = composer(probe, opts.composerRows);
  const r = regions({
    columns: opts.cols,
    rows: opts.rows,
    headerRows: HEADER_ROWS,
    composerRows: comp.length,
    strip: true,
  });
  const panes = splitPanes(r.workspaceRows, opts.child != null);

  const left: string[] = [];
  const main = opts.main.slice(0, panes.mainRows);
  while (main.length < panes.mainRows) main.push("");
  left.push(...main.map((l) => (l ? `  ${l}` : "")));
  if (opts.child && panes.open) {
    left.push(`  ${opts.child.header}`);
    const kid = opts.child.lines.slice(0, panes.childRows);
    while (kid.length < panes.childRows) kid.push("");
    left.push(...kid.map((l) => (l ? `  ${l}` : "")));
  }

  const right: string[] = [];
  if (r.collapsed) {
    if (opts.strip) left.push(`  ${opts.strip}`);
    left.push(...comp.slice(-r.composerRows));
  } else {
    right.push(...panel(r, opts.panelRows));
    right.push(...comp.slice(-r.composerRows));
  }

  const f = composeFrame({
    rows: opts.rows,
    header: head,
    transcript: [],
    footer: [`  ${opts.status}`],
    scroll: 0,
    caretRow: 0,
    caretCol: 0,
    band: { regions: r, left, right, divider: "│", width },
  });
  return f.rows.map((l) => l.trimEnd());
}

const BOX = (w: number, title: string, body: string[], receipt: string): string[] => {
  const head = `┌ ${title} ${RULE.repeat(Math.max(1, w - width(title) - 5))}┐`;
  const foot = `└ ${receipt} ${RULE.repeat(Math.max(1, w - width(receipt) - 5))}┘`;
  return [head, ...body.map((l) => `│ ${pad(l, w - 4)} │`), foot];
};

const WORK_MAIN = [
  "◇ Four lanes, named: planner has the settings surface, builder the",
  "  wizard, verifier the frame captures, scribe the help copy.",
  "",
  ...BOX(
    74,
    "read  packages/orchestrator/src/bin/ui/tui-frame.ts",
    [
      "export function regions(input: RegionInput): Regions {",
      "  const usable = Math.max(1, columns - 1);",
      "… 31 lines",
    ],
    "· observed · 428 lines",
  ),
  "",
  "◇ Geometry holds at 120. Verifier is re-running the same captures",
  "  at 80 columns; I will not call it settled until that comes back.",
];

const WORK_PANEL = [
  "AGENTS                       3 running",
  RULE.repeat(38),
  "› 1  planner    ▆  2m 04s",
  "     map the settings surface",
  "     read  config-settings.ts",
  "     12.4k tok · 9 tools",
  "  2  builder    ▃  1m 12s",
  "     build the setup wizard",
  "     edit  first-run.ts",
  "     8.1k tok · 6 tools",
  "  3  verifier   ▁  48s · quiet 9s",
  "     re-run the frame captures",
  "     bun test ui-frame.test.ts",
  "     3.2k tok · 4 tools",
];

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });

const frames: Record<string, string[]> = {
  "120x40-working": frame({
    cols: 120,
    rows: 40,
    title: "~/Project/Alan",
    main: WORK_MAIN,
    panelRows: WORK_PANEL,
    composerRows: ["› and re-run the 80-column capture"],
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 34% context · sandbox on",
  }),
  "120x40-split": frame({
    cols: 120,
    rows: 40,
    title: "~/Project/Alan",
    main: WORK_MAIN,
    panelRows: WORK_PANEL,
    composerRows: ["›"],
    child: {
      header: `${RULE.repeat(2)} 3  verifier ${RULE.repeat(2)} running 48s ${RULE.repeat(2)} 3.2k tok · 4 tools ${RULE.repeat(2)} ctrl+w close ${RULE.repeat(2)}`,
      lines: [
        "◇ Capturing at 80x24 first, since that is where the right column",
        "  is supposed to collapse.",
        "",
        ...BOX(
          74,
          "run   bun test tests/unit/orchestrator/ui-frame.test.ts",
          [
            "✓ the launch frame > every painted line ends in the same column",
            "✗ full-screen behaviour > the frame still closes on both edges",
            "  expected 79, received 80",
            "16 pass  1 fail",
          ],
          "✗ exit 1 · 1 fail · 2.4s",
        ),
        "",
        "~ Suspected: the narrow fallback is padding to cols, not cols-1.",
      ],
    },
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 36% context · agent 3 open · sandbox on",
  }),
  "120x40-composer-grown": frame({
    cols: 120,
    rows: 40,
    title: "~/Project/Alan",
    main: WORK_MAIN,
    panelRows: WORK_PANEL,
    composerRows: [
      "› Rework the first-run wizard so the",
      "  provider step remembers what the",
      "  last session used, and make the",
      "  spend cap accept a monthly figure",
      "  as well as a per-session one.",
      "  [Pasted text #1 +38 lines]",
      "  The acceptance is the 80x24 capture",
      "  matching the mock exactly, including",
      "  the collapsed right column and the",
      "  one-line agent strip.█",
    ],
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 34% context · sandbox on",
  }),
  "80x24-working": frame({
    cols: 80,
    rows: 24,
    title: "~/Project/Alan",
    main: WORK_MAIN.map((l) => l.slice(0, 75)),
    panelRows: [],
    composerRows: ["› and re-run the 80-column capture"],
    strip: "◆ 3 running · 1 done · planner ▆ · builder ▃ · verifier ▁       ctrl+f open",
    status: "◆ 1st gear · gpt-5.6-sol · 34% context · sandbox on",
  }),
};

for (const [name, rows] of Object.entries(frames)) {
  const ruler = Array.from({ length: rows[1]!.length > 0 ? 0 : 0 }).join("");
  void ruler;
  const cols = name.startsWith("120") ? 120 : 80;
  const head = [
    `# frame: ${name} (synthetic content, real geometry)`,
    `# terminal: ${rows.length} rows x ${cols} cols`,
    `# ${"-".repeat(60)}`,
    `#${Array.from({ length: cols }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : ".")).join("")}`,
  ];
  const body = rows.map((l, i) => `${String(i + 1).padStart(2)}|${l}`);
  writeFileSync(join(out, `${name}.txt`), [...head, ...body].join("\n") + "\n");
  console.log(`  frame -> ${join(out, `${name}.txt`)}`);
}
