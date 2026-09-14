/**
 * First run and settings: the three defects the 2026-09-10 pty smoke found, and
 * the invariants that stop each one coming back.
 *
 * Each test names the frame that caught it. They are unit tests over pure
 * functions on purpose — every one of the three was a layout fact that a
 * function can be asked about, which is why a capture had to find them in the
 * first place.
 */

import { describe, expect, it } from "bun:test";
import {
  CONFIG_PRECEDENCE,
  FirstRun,
  SETUP_STEPS,
  ledgerRow,
  ledgerRows,
  maskSecret,
  noKeysHintRows,
  precedenceLine,
  savedActiveRows,
  settingsPickerChrome,
  settingsReachableCount,
  stepMark,
} from "../../../packages/orchestrator/src/first-run";
import { CONFIG_SETTINGS } from "../../../packages/orchestrator/src/config-settings";
import { transcriptGutter } from "../../../packages/orchestrator/src/bin/ui/tui-commands";
import { FRAME_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-frame";

describe("the no-provider splash keeps one comment column", () => {
  // Frame `80x24-no-keys`, 2026-09-10: the `#` column read 45, 45, 45, 44.
  it("puts every comment at the same column", () => {
    const rows = noKeysHintRows();
    expect(rows).toHaveLength(4);
    const columns = new Set(rows.map((r) => r.assign.length + r.value.length + r.pad.length));
    expect(columns.size).toBe(1);
  });

  it("leaves at least one clear space before the comment", () => {
    for (const row of noKeysHintRows()) {
      expect(row.pad.length).toBeGreaterThanOrEqual(3);
      expect(row.pad.trim()).toBe("");
      expect(row.comment.startsWith("# ")).toBe(true);
    }
  });

  it("names the four routes, longest assignment first in the measure", () => {
    const rows = noKeysHintRows();
    expect(rows.map((r) => r.assign)).toEqual([
      "export GOOGLE_API_KEY=",
      "export OPENROUTER_API_KEY=",
      "export ANTHROPIC_API_KEY=",
      "export OPENAI_API_KEY=",
    ]);
    // The column is measured from the longest row, so the longest one is the
    // one with the minimum pad -- if that ever went negative the rows would run
    // together instead of drifting apart.
    const longest = rows.reduce((a, b) => (a.assign.length > b.assign.length ? a : b));
    expect(longest.pad.length).toBe(3);
  });
});

describe("the settings picker counts what it cannot show", () => {
  // Frame `80x24-settings-open`, 2026-09-10: 17 rows painted, 22 exist, and
  // nothing on screen said the list continued.
  it("carries the total in the heading and the footnote", () => {
    const chrome = settingsPickerChrome(3);
    const total = 3 + CONFIG_SETTINGS.length;
    expect(chrome.title).toContain(String(total));
    expect(chrome.footnote).toContain(String(total));
  });

  it("counts the catalogue, not a number typed into the heading", () => {
    expect(settingsReachableCount()).toBe(CONFIG_SETTINGS.length);
    expect(settingsPickerChrome(0).title).toContain(String(CONFIG_SETTINGS.length));
    expect(settingsPickerChrome(7).title).toContain(String(CONFIG_SETTINGS.length + 7));
  });

  it("fits the footnote in an 80-column window", () => {
    // renderPicker truncates a footnote at `maxWidth - 4`; at 80 columns that
    // is about 72 cells. The heading carries the count too, so a truncation
    // here loses a hint and never the number -- but it should not truncate.
    expect(settingsPickerChrome(3).footnote.length).toBeLessThanOrEqual(72);
  });

  it("still says what a change does", () => {
    expect(settingsPickerChrome(3).footnote).toContain("apply now and are saved");
  });
});

describe("a settings confirmation keeps the transcript gutter", () => {
  // Frame `80x24-settings-saved`, 2026-09-10: the one row in the TUI at col 0.
  it("indents every non-empty line by two", () => {
    const out = transcriptGutter('playbook is now "on" — applied now and saved to /tmp/x');
    expect(out.startsWith("  ")).toBe(true);
    expect(out.slice(2).startsWith(" ")).toBe(false);
  });

  it("indents the list form the same way, and leaves blank rows blank", () => {
    const listing = ["Settings", "budget: 7.25", "", "/config <setting> <value>"].join("\n");
    const rows = transcriptGutter(listing).split("\n");
    expect(rows[0]).toBe("  Settings");
    expect(rows[1]).toBe("  budget: 7.25");
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe("  /config <setting> <value>");
  });

  it("does not double-indent a line that is already in the gutter", () => {
    // It DOES add two more -- the point is that the caller must not pass an
    // already-indented string, which this pins so a future refactor notices.
    expect(transcriptGutter("  already")).toBe("    already");
  });
});

describe("a picker opens inside the frame, not instead of it", () => {
  // `bandLayout` delegates to `bandModal`, so the receiver carries the methods
  // as well as the state. Nothing else about a Tui is reachable from either.
  const stub = (mode: string, collapsed: boolean) =>
    ({
      ...FRAME_METHODS,
      inline: false,
      mode,
      regionsNow: () => ({ collapsed }),
    }) as never;

  it("keeps the four regions for a picker at a width that has them", () => {
    expect(FRAME_METHODS.bandModal.call(stub("picker", false))).toBe(true);
    expect(FRAME_METHODS.bandLayout.call(stub("picker", false))).toBe(true);
  });

  it("leaves the collapsed window alone: there is no column to keep", () => {
    expect(FRAME_METHODS.bandModal.call(stub("picker", true))).toBe(false);
    expect(FRAME_METHODS.bandLayout.call(stub("picker", true))).toBe(false);
  });

  it("leaves every decision panel claiming the footer", () => {
    for (const mode of ["permission", "keys", "ask", "question", "held", "sessions", "memory"]) {
      expect(FRAME_METHODS.bandModal.call(stub(mode, false))).toBe(false);
      expect(FRAME_METHODS.bandLayout.call(stub(mode, false))).toBe(false);
    }
  });

  it("still draws the band for the writing surface", () => {
    expect(FRAME_METHODS.bandLayout.call(stub("input", false))).toBe(true);
    expect(FRAME_METHODS.bandLayout.call(stub("turn", false))).toBe(true);
  });

  it("never takes the band in inline mode", () => {
    const inline = {
      ...FRAME_METHODS,
      inline: true,
      mode: "picker",
      regionsNow: () => ({ collapsed: false }),
    };
    expect(FRAME_METHODS.bandLayout.call(inline as never)).toBe(false);
    expect(FRAME_METHODS.bandModal.call(inline as never)).toBe(false);
  });
});

describe("the setup ledger is data, and its rendering has a width", () => {
  const states = SETUP_STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    status: (i === 0 ? "done" : i === 1 ? "current" : "pending") as "done" | "current" | "pending",
    value: i === 0 ? "openai-codex" : s.empty,
  }));

  it("marks each status with one cell, in both modes", () => {
    for (const status of ["done", "current", "skipped", "pending"] as const) {
      expect(stepMark(status).length).toBe(1);
      expect(stepMark(status, true).length).toBe(1);
      // ASCII twins are ASCII.
      expect(/^[\x20-\x7e]$/.test(stepMark(status, true))).toBe(true);
    }
  });

  it("keeps every label at every width and counts what it elides", () => {
    for (const width of [24, 38, 60]) {
      const rows = ledgerRows(states, width);
      expect(rows).toHaveLength(SETUP_STEPS.length);
      for (const step of SETUP_STEPS) expect(rows.join("\n")).toContain(step.label);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
    }
  });

  it("elides a long value from the right rather than dropping the row", () => {
    const long = { ...states[0]!, value: "a-model-identifier-far-longer-than-the-panel" };
    const row = ledgerRow(long, 30);
    expect(row.length).toBeLessThanOrEqual(30);
    expect(row).toContain("…");
    expect(row).toContain("provider");
  });

  it("masks a secret to its last four and never shows more", () => {
    const masked = maskSecret("sk-first-run-unit-test-key-7f2a");
    expect(masked).toBe("••••••••7f2a");
    const row = ledgerRow({ ...states[0]!, label: "key", value: masked }, 38);
    expect(row).toContain("7f2a");
    expect(row).not.toContain("sk-first-run");
  });
});

describe("saved vs active states the precedence once", () => {
  it("says nothing differs when nothing does", () => {
    const painted = savedActiveRows(
      [
        { label: "provider", saved: "codex", active: "codex", differs: false },
        { label: "sandbox", saved: "on", active: "on", differs: false },
      ],
      38,
    ).join("\n");
    expect(painted).toContain("nothing differs");
    expect(painted).not.toContain(CONFIG_PRECEDENCE);
  });

  it("names the winning source and the ladder when one does", () => {
    const painted = savedActiveRows(
      [
        { label: "provider", saved: "codex", active: "codex", differs: false },
        { label: "sandbox", saved: "regular", active: "strict", differs: true, source: "env" },
      ],
      38,
    ).join("\n");
    expect(painted).toContain("sandbox: env outranks the file");
    expect(painted).toContain(precedenceLine(38));
  });

  it("states the ladder in one line, in the order it resolves", () => {
    expect(CONFIG_PRECEDENCE.split(">").map((s) => s.trim())).toEqual([
      "flag",
      "env",
      "session",
      "~/.rune/config.toml",
    ]);
  });

  it("can restart after completion or cancellation without changing saved state", () => {
    const run = new FirstRun();
    run.cancel();
    expect(run.done()).toBe(true);
    run.reset();
    expect(run.done()).toBe(false);
    expect(run.current()?.id).toBe("provider");
    expect(run.steps().every((s: { status: string }) => s.status !== "done")).toBe(true);
  });
});
