/**
 * P7.8 — the incident → eval flywheel.
 *
 * The pipeline was built and empty: `covered.json` was `{}`,
 * `tasks-from-incidents.ts` exported `[]`, and nothing failed when a class
 * crossed the threshold, so the input side existed and never turned.
 *
 * Two things are worth testing and one is not. Worth testing: which classes the
 * gate considers its business, and that a waiver is an acknowledgement rather
 * than a way of switching the gate off. Not worth testing: that the miner reads
 * SQLite.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MIN_COUNT,
  FLYWHEEL_CLASSES,
  taskFor,
  uncoveredClasses,
  type CoveredFile,
} from "../../../tests/eval/from-incidents";
import { FROM_INCIDENTS_TASKS } from "../../../tests/eval/tasks-from-incidents";

const EVAL_DIR = join(import.meta.dir, "../../../tests/eval");

function covered(): CoveredFile {
  return JSON.parse(readFileSync(join(EVAL_DIR, "from-incidents", "covered.json"), "utf8"));
}
function snapshot(): { counts: Record<string, number> } {
  return JSON.parse(readFileSync(join(EVAL_DIR, "from-incidents", "classes.json"), "utf8"));
}

describe("the flywheel knows what is its business", () => {
  it("excludes classes that are the world working, not the harness failing", () => {
    // A rate limit is a quota. An abort is a person. A sandbox denial is the
    // sandbox. An eval that "covered" any of these would be testing something
    // that is not ours, and it would make the gate meaningless.
    for (const notOurs of [
      "provider.rate_limit",
      "provider.fallback_triggered",
      "loop.user_abort",
      "tool.sandbox_denial",
      "tool.exec_failure",
      "struggle.thrash_reads",
    ]) {
      expect(FLYWHEEL_CLASSES.has(notOurs)).toBe(false);
    }
  });

  it("includes the recovery paths that are ours", () => {
    for (const ours of [
      "provider.stream_error",
      "provider.malformed_tool_json_fatal",
      "provider.empty_completion",
      "loop.consecutive_errors",
      "crash.dirty_exit",
      "context.budget_overflow",
    ]) {
      expect(FLYWHEEL_CLASSES.has(ours)).toBe(true);
    }
  });
});

describe("uncoveredClasses", () => {
  it("flags an eval-able class over the threshold with no task", () => {
    expect(uncoveredClasses({ "provider.stream_error": 9 }, {})).toEqual([
      { class: "provider.stream_error", count: 9 },
    ]);
  });

  it("ignores a class under the threshold", () => {
    expect(uncoveredClasses({ "provider.stream_error": DEFAULT_MIN_COUNT - 1 }, {})).toEqual([]);
  });

  it("ignores a class that is not the harness's business, however loud", () => {
    expect(uncoveredClasses({ "provider.rate_limit": 4000 }, {})).toEqual([]);
  });

  it("clears when a task covers it", () => {
    expect(
      uncoveredClasses({ "provider.stream_error": 9 }, { "provider.stream_error": "t" }),
    ).toEqual([]);
  });

  it("clears on a waiver, and a waiver is not read as a task", () => {
    const file: CoveredFile = {
      waivers: { "crash.dirty_exit": { reason: "no child process to kill", at: "2026-09-02" } },
    };
    expect(uncoveredClasses({ "crash.dirty_exit": 100 }, file)).toEqual([]);
    // The distinction matters: a waiver must never be reported as coverage.
    expect(taskFor(file, "crash.dirty_exit")).toBeNull();
  });
});

describe("the committed state is consistent", () => {
  it("names a real task for every covered class", () => {
    const names = new Set(FROM_INCIDENTS_TASKS.map((t) => t.name));
    const file = covered();
    for (const key of Object.keys(file)) {
      if (key === "waivers") continue;
      const task = taskFor(file, key);
      expect(task).not.toBeNull();
      expect(names.has(task!)).toBe(true);
    }
  });

  it("gives every waiver a reason and a date", () => {
    // A silent exclusion list is how a gate stops being a gate.
    for (const [cls, w] of Object.entries(covered().waivers ?? {})) {
      expect(FLYWHEEL_CLASSES.has(cls)).toBe(true);
      expect(w.reason.length).toBeGreaterThan(60);
      expect(w.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves nothing uncovered in the committed snapshot — this IS the CI gate", () => {
    expect(uncoveredClasses(snapshot().counts, covered())).toEqual([]);
  });

  it("gives every promoted task a deterministic script", () => {
    for (const t of FROM_INCIDENTS_TASKS) {
      expect(Array.isArray(t.script)).toBe(true);
      expect(t.script!.length).toBeGreaterThan(0);
      expect(t.name.startsWith("incident_")).toBe(true);
    }
  });
});
