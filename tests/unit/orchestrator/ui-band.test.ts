// ─── The selection bar ───
//
// Founder, 2026-09-26, pointing at `/sessions`: "use the proper full line
// border to highlight on which toggle we are right now ... just like this".
// One idiom for every list: the selected row is the full-width bar
// (flow.ts `band`), and only that row.
//
// Colour is resolved once, at module load, from whether stdout is a tty -- and
// a test process has none. So every case that needs to SEE the bar runs in a
// fresh process with the tty flag forced, exactly as the matte-body test in
// ui-theme.test.ts does.

import { describe, expect, it } from "bun:test";
import { join } from "path";
import { pathToFileURL } from "url";

const ROOT = join(import.meta.dir, "../../..");
const UI = join(ROOT, "packages/orchestrator/src/bin/ui");
const url = (file: string) => JSON.stringify(pathToFileURL(join(UI, file)).href);

/** Run `body` in a colour process and return what it wrote as JSON. */
function inColour(body: string, env: Record<string, string> = {}): unknown {
  const script = `
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const theme = await import(${url("theme.ts")});
    const render = await import(${url("render.ts")});
    const composer = await import(${url("composer.ts")});
    const F = await import(${url("flow.ts")});
    theme.configureAutoTheme({ background: [0, 0, 0] });
    theme.setTheme("rune-dark");
    render.setTermWidthOverride(100);
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      NO_COLOR: "",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(run.stdout.toString());
}

const BAR = /\x1b\[48;2;/;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const PALETTE = `
  const items = [
    { name: "/model", desc: "Choose model, provider, and thinking depth" },
    { name: "/config", desc: "Settings: cost, reasoning, agents, sandbox and learning" },
    { name: "/login", desc: "Connect a subscription, an API key, a local model, or web search" },
  ];
  return composer.renderSlashPalette(items, 1, 99, 8, 27);
`;

describe("the selection bar", () => {
  it("bars exactly the selected palette row, across the whole measure", () => {
    const rows = inColour(PALETTE) as string[];
    const barred = rows.filter((row) => BAR.test(row));
    expect(barred).toHaveLength(1);
    expect(plain(barred[0]!)).toContain("/config");
    expect(plain(barred[0]!)).toContain("›");
    // Full width: padded to the measure the palette was drawn at.
    const measure = plain(rows[0]!).length;
    expect(plain(barred[0]!).length).toBeGreaterThanOrEqual(measure);
  });

  it("is one colour inside: no foreground from the row survives on the bar", () => {
    const rows = inColour(PALETTE) as string[];
    const bar = rows.find((row) => BAR.test(row))!;
    // Every foreground on the bar is the bar's own ink, re-armed after resets.
    const fgs = new Set([...bar.matchAll(/\x1b\[38;2;([0-9;]+)m/g)].map((m) => m[1]));
    expect(fgs.size).toBe(1);
    // Weight survives: the command name is bold.
    expect(bar).toContain("\x1b[1m");
  });

  it("bars exactly the selected picker row", () => {
    const lines = inColour(`
      return composer.renderPicker(
        "Theme",
        [{ label: "Dark" }, { label: "Light" }, { label: "Terminal" }],
        2,
        99,
      ).lines;
    `) as string[];
    const barred = lines.filter((row) => BAR.test(row));
    expect(barred).toHaveLength(1);
    expect(plain(barred[0]!)).toContain("Terminal");
  });

  it("bars exactly the selected session", () => {
    const lines = inColour(`
      const rows = ["alpha", "beta", "gamma"].map((title, i) => ({
        id: "id-" + i, title, meta: "", current: i === 0,
        updatedAt: new Date().toISOString(), group: "Today",
      }));
      return composer.renderSessionsPanel(rows, 2, { view: "active", pendingDelete: false }, 99).lines;
    `) as string[];
    const barred = lines.filter((row) => BAR.test(row));
    expect(barred).toHaveLength(1);
    expect(plain(barred[0]!)).toContain("gamma");
  });

  it("bars the highlighted answer of a question, and only it", () => {
    const lines = inColour(`
      return F.ask({ question: "Which one?", options: ["first", "second"], selected: 0, tone: "question" });
    `) as string[];
    const barred = lines.filter((row) => BAR.test(row));
    expect(barred).toHaveLength(1);
    expect(plain(barred[0]!)).toContain("first");
  });

  it("with no colour at all, the marker alone still says which row", () => {
    const rows = inColour(PALETTE, { NO_COLOR: "1" }) as string[];
    for (const row of rows) expect(row).not.toContain("\x1b");
    const marked = rows.filter((row) => row.includes("›"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("/config");
  });

  it("on the ASCII rung the marker is `>` and nothing escapes seven bits", () => {
    const rows = inColour(PALETTE, { RUNE_ASCII: "1" }) as string[];
    for (const row of rows) expect(plain(row)).not.toMatch(/[^\x00-\x7f]/);
    expect(rows.filter((row) => plain(row).includes("> /config"))).toHaveLength(1);
  });
});
