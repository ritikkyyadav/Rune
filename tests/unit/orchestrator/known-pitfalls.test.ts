/**
 * The black box read back into the run: recurring, model-actionable failures
 * become one harness note. Provider rot and rate limits are left out — they
 * are the harness's business. For a month the fingerprint table was read by
 * nothing but the CLI; this is the read path, pinned.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HARNESS_BUSINESS_RE,
  PITFALL_CLASSES,
  renderPitfallsNote,
  selectPitfalls,
} from "../../../packages/orchestrator/src/known-pitfalls";

const row = (cls: string, component: string, messageSample: string, count: number) => ({
  class: cls,
  component,
  messageSample,
  count,
});

describe("known pitfalls", () => {
  test("keeps model-actionable classes at three or more, ordered by recurrence, three lines", () => {
    const picked = selectPitfalls([
      row("tool.exec_failure", "tool:read_file", "IO error: No such file", 6),
      row(
        "tool.sandbox_denial",
        "tool:bash",
        "Blocked before running: this looks like a HTTP request, and sandboxed bash has NO network",
        21,
      ),
      row("tool.exec_failure", "tool:multi_edit", "old_text not found in file", 9),
      row("tool.exec_failure", "tool:ask_user", "each question needs 2-6 options", 2), // too rare
      row("provider.rate_limit", "gateway", "Rate limit exceeded: free-models-per-day", 798),
      row(
        "tool.exec_failure",
        "tool:web_search",
        "All search backends failed — brave: HTTP 429",
        15,
      ),
      row("tool.exec_failure", "tool:web_fetch", "HTTP 404", 10),
    ]);
    expect(picked.map((r) => r.component)).toEqual([
      "tool:bash",
      "tool:web_fetch",
      "tool:multi_edit",
    ]);
  });

  test("the harness's own business never reaches the model", () => {
    for (const m of [
      "Rate limit exceeded for read_file",
      "Codex request failed (429)",
      "You exceeded your current quota",
      "connect ECONNREFUSED 127.0.0.1:11434",
      "command timed out after 120s",
      "stream stalled — no data for 240s",
    ]) {
      expect(HARNESS_BUSINESS_RE.test(m)).toBe(true);
    }
    expect(PITFALL_CLASSES.has("provider.rate_limit")).toBe(false);
    expect(selectPitfalls([row("tool.exec_failure", "tool:bash", "timed out", 40)])).toEqual([]);
  });

  test("renders one note, or nothing", () => {
    expect(renderPitfallsNote([])).toBeNull();
    const note = renderPitfallsNote([
      row("tool.sandbox_denial", "tool:bash", "this   looks like\na HTTP request", 21),
    ]);
    expect(note).toContain("[Harness note] Recurring mistakes on this machine");
    expect(note).toContain("- bash (21×): this looks like a HTTP request");
  });

  test("the engine reads the note through these functions", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/engine.ts"),
      "utf8",
    );
    expect(src).toContain("renderPitfallsNote(selectPitfalls(store.top(");
  });
});
