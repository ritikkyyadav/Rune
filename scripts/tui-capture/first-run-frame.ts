/**
 * The setup ledger at 120x40, drawn through the functions that will paint it.
 *
 * This is NOT a pty capture, and the frame it writes says so. The wizard has no
 * terminal entry point yet -- §1.7: "There is no first-run wizard" -- so there
 * is nothing for a pty to drive. What exists is `first-run.ts`, a headless state
 * machine, and lane A's `viewport.ts`, the real geometry. This file walks the
 * real machine to the middle of step 3 and composes the real regions around its
 * real output, exactly as `frame-demo.ts` does for the frames lane A could not
 * reach. Nothing is re-implemented; only the wordmark, the workspace receipts
 * and the panel's SESSION rows are invented, and they are obviously invented.
 *
 * Zero model calls and zero credentials: the provider is `custom`, the key is
 * the literal string `sk-not-a-real-key-0000-7f2a`, and `probe` is a stub that
 * returns 200 without opening a socket.
 *
 *     bun scripts/tui-capture/first-run-frame.ts OUT.txt
 */

import { FirstRun, ledgerRows, savedActiveRows } from "../../packages/orchestrator/src/first-run";
import {
  composeBand,
  regions,
  type Regions,
} from "../../packages/orchestrator/src/bin/ui/viewport";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const COLS = 120;
const ROWS = 40;
const HEADER_ROWS = 3;
const FAKE_KEY = "sk-not-a-real-key-0000-7f2a";

const width = (s: string): number => [...s].length;
const pad = (s: string, w: number): string =>
  width(s) >= w ? [...s].slice(0, w).join("") : s + " ".repeat(w - width(s));
/** flow indents by its 2-cell MARK; the right column's gutter is 1. */
const tight = (s: string): string => (s.startsWith(" ") ? s.slice(1) : s);

function header(cols: number, title: string): string[] {
  const usable = cols - 1;
  const left = `  R U N E  ${title}`;
  const right = "v0.4.1-dev+b5aef39";
  const gap = Math.max(1, usable - width(left) - width(right));
  return ["", `${left}${" ".repeat(gap)}${right}`, `  ${"━".repeat(7)}${"─".repeat(usable - 9)}`];
}

/** One workspace receipt, in the box grammar §2.8 asks for. */
function receipt(title: string, body: string[], close: string, w: number): string[] {
  const inner = w - 4;
  const edge = (label: string) => {
    const head = `  ┌ ${label} `;
    return `${head}${"─".repeat(Math.max(1, w - width(head) - 1))}┐`;
  };
  const foot = (label: string) => {
    const head = `  └ ${label} `;
    return `${head}${"─".repeat(Math.max(1, w - width(head) - 1))}┘`;
  };
  return [edge(title), ...body.map((l) => `  │ ${pad(l, inner - 1)}│`), foot(close)];
}

async function build(): Promise<{ panel: string[]; workspace: string[]; composer: string[] }> {
  // The real machine, walked to the middle of step 3 with nothing written to
  // any real file: every dependency that could touch disk or the network is
  // supplied.
  const written: string[] = [];
  const saved: Record<string, unknown> = {};
  const run = new FirstRun({
    env: {},
    endpointFor: () => "https://api.example.invalid/v1/models",
    probe: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      ms: 412,
      body: "",
      url: "https://api.example.invalid/v1/models",
    }),
    storeSecret: () => "the system keychain",
    setConfig: (path, value) => {
      written.push(`${path} = ${typeof value === "string" ? `"${value}"` : value}`);
      let cur = saved as Record<string, unknown>;
      const parts = path.split(".");
      for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Record<string, unknown>;
      cur[parts[parts.length - 1]!] = value;
      return { path: "~/.rune/config.toml" };
    },
    readSaved: () => saved,
    applyLive: () => ({ ok: true }),
  });

  await run.answer("custom");
  await run.answer("gpt-5.6-sol");
  const key = await run.answer(FAKE_KEY);

  const r = frameRegions();
  const panelW = r.panelContentCols;
  const panel = [
    `  ${pad("SETUP", panelW - width(run.heading()))}${run.heading()}`,
    `  ${"─".repeat(panelW)}`,
    ...ledgerRows(run.steps(), panelW).map((l) => `  ${l}`),
    "",
    `  ${pad("SAVED vs ACTIVE", panelW)}`,
    `  ${"─".repeat(panelW)}`,
    ...savedActiveRows(run.savedVsActive(), panelW).map((l) => `  ${l}`),
    "",
    `  ${run.precedenceLine()}`,
  ].map(tight);

  const w = r.workspaceCols;
  const workspace = [
    "",
    "  ◇ Nothing here is a model call. Rune is reading and writing its own",
    "    configuration; the first call happens when you send a message.",
    "",
    ...receipt("write ~/.rune/config.toml", written, "· observed · 3 keys set", w),
    "",
    ...receipt(
      `check GET ${key.receipt.title.replace(/^check GET /, "")}`,
      key.receipt.body,
      `✓ ${key.receipt.close}`,
      w,
    ),
    "",
    "  ◇ The key went to the keychain, not to config.toml and not to the",
    "    transcript. Three steps left: search access, a spend cap and the",
    "    sandbox policy.",
  ];

  const cw = panelW;
  const composer = [
    `  ${"─".repeat(cw)}`,
    `  › ${pad("API key for custom", cw - 2)}`,
    `    ${pad(`${"•".repeat(23)}${FAKE_KEY.slice(-4)}█`, cw - 2)}`,
    `  ${"─".repeat(cw)}`,
    `  enter save · esc skip · ctrl+f steps`,
  ].map(tight);

  return { panel, workspace, composer };
}

function frameRegions(composerRows = 5): Regions {
  return regions({
    columns: COLS,
    rows: ROWS,
    headerRows: HEADER_ROWS,
    composerRows,
    strip: true,
  });
}

async function main(): Promise<void> {
  const { panel, workspace, composer } = await build();
  const r = frameRegions(composer.length);
  const left: string[] = [...workspace];
  while (left.length < r.workspaceRows) left.push("");
  const right: string[] = [...panel];
  while (right.length < r.panelRows) right.push("");

  const band = composeBand({
    regions: r,
    left: left.slice(0, r.workspaceRows),
    right: [...right.slice(0, r.panelRows), ...composer],
    divider: "│",
    width,
  });

  const status =
    "  ◆ setup · no model called yet · config ~/.rune/config.toml · keys in the system keychain";
  const rows = [...header(COLS, "~/Project/Alan"), ...band, pad(status, COLS - 1)];
  while (rows.length < ROWS) rows.splice(rows.length - 1, 0, "");

  const ruler = Array.from({ length: COLS }, (_, i) =>
    i % 10 === 0 ? String(Math.floor(i / 10) % 10) : ".",
  ).join("");
  const out = [
    "# frame: 120x40-first-run (DRAWN, not a pty capture)",
    "# source: scripts/tui-capture/first-run-frame.ts",
    "# why drawn: the wizard has no terminal entry point yet (phase-4 §1.7),",
    "#            so there is nothing for a pty to drive. The panel rows, the",
    "#            saved-vs-active block and the key receipt below are the REAL",
    "#            output of packages/orchestrator/src/first-run.ts, composed by",
    "#            the REAL viewport.regions()/composeBand(). The wordmark, the",
    "#            prose and the box frames are drawn here.",
    "# model calls: none. credentials: none (the key is a literal fake).",
    "# " + "-".repeat(60),
    "#" + ruler,
    ...rows.slice(0, ROWS).map((line, i) => `${String(i + 1).padStart(2)}|${line.trimEnd()}`),
  ].join("\n");

  const target = process.argv[2] ?? "captures-lane-e/120x40-first-run.txt";
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out + "\n");
  console.log(`  frame -> ${target}`);
}

await main();
