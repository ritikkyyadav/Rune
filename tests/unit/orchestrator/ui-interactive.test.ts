/**
 * /interactive support module: the autonomy sidecar, the directive a bare
 * /interactive submits, and the "offer a dashboard" heuristic.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInteractiveDirective,
  loadInteractiveAuto,
  saveInteractiveAuto,
  shouldOfferInteractive,
} from "../../../packages/orchestrator/src/bin/ui/interactive";
import { renderInteractiveDoctrine } from "../../../packages/orchestrator/src/prompts";

describe("interactive sidecar", () => {
  test("round-trips the toggle and tolerates absence/corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-"));
    expect(loadInteractiveAuto(dir)).toBeNull();
    saveInteractiveAuto(true, dir);
    expect(loadInteractiveAuto(dir)).toBe(true);
    saveInteractiveAuto(false, dir);
    expect(loadInteractiveAuto(dir)).toBe(false);
    // corrupt file → null, never a throw
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(dir, "interactive.json"), "{not json");
    expect(loadInteractiveAuto(dir)).toBeNull();
  });
});

describe("interactive directive", () => {
  test("bare directive targets the recent conversation and forbids invented data", () => {
    const d = buildInteractiveDirective();
    expect(d).toContain("interactive_dashboard");
    expect(d).toContain("most recent report");
    expect(d).toContain("instead of inventing data");
  });

  test("focused directive carries the user's focus", () => {
    const d = buildInteractiveDirective("test pass rates by package");
    expect(d).toContain("Focus on: test pass rates by package.");
    expect(d).toContain('action:"update"');
  });
});

describe("interactive doctrine", () => {
  test("autonomous mode instructs proactive building; manual restricts to requests", () => {
    const auto = renderInteractiveDoctrine(true);
    expect(auto).toContain("Autonomous dashboards are ON");
    expect(auto).toContain("CREATE a dashboard");
    const manual = renderInteractiveDoctrine(false);
    expect(manual).toContain("ONLY when the user asks");
    expect(manual).toContain("/interactive");
    // Both carry the full design charter: spec-first, composition acts, art
    // direction, data honesty, the governed html path, real-time, exports.
    for (const s of [auto, manual]) {
      expect(s).toContain("design charter");
      expect(s).toContain("Build through `spec` for anything analytic");
      expect(s).toContain("three acts");
      expect(s).toContain("Chart grammar");
      expect(s).toContain("accent");
      expect(s).toContain("Never invent data");
      expect(s).toContain("what slop looks like");
      expect(s).toContain("watch_file");
      expect(s).toContain('action:"export"');
    }
  });
});

describe("shouldOfferInteractive", () => {
  test("short prose answers never trigger", () => {
    expect(shouldOfferInteractive("Done — 3 files changed.")).toBe(false);
    expect(shouldOfferInteractive("")).toBe(false);
  });

  test("markdown tables trigger", () => {
    const table = [
      "Here is the comparison:",
      "",
      "| system | score | tests |",
      "|---|---|---|",
      "| gear | 94.7 | 829 |",
      "| codex | 91.2 | 700 |",
      "| opencode | 88.9 | 512 |",
      "| aider | 85.1 | 450 |",
      "and a bit of prose after it,",
      "with more lines",
      "to clear the",
      "length gate",
      "for realism.",
    ].join("\n");
    expect(shouldOfferInteractive(table)).toBe(true);
  });

  test("number-dense multi-line reports trigger; code blocks don't count", () => {
    const report = Array.from(
      { length: 14 },
      (_, i) => `Service ${i}: ${90 + i}% uptime, ${100 + i}ms p50, ${200 + i}ms p99`,
    ).join("\n");
    expect(shouldOfferInteractive(report)).toBe(true);

    const codeOnly =
      "Explanation line\n" +
      "```\n" +
      Array.from({ length: 20 }, (_, i) => `const x${i} = ${i * 37};`).join("\n") +
      "\n```\n" +
      "Short close.";
    expect(shouldOfferInteractive(codeOnly)).toBe(false);
  });
});
