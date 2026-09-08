/**
 * Doctrine phases and the split design charter (P13.1).
 *
 * The 2026-09-08 live run measured 38.4 KB of doctrine on every one of twelve
 * completions. Most of it was unavoidable; three sections were not. The
 * read-back, the ambiguity round and the plan-before-you-edit rule all govern
 * the moment BEFORE the first tool call, and "Finishing a task" cannot apply
 * on a completion where nothing has been produced yet.
 *
 * What these tests hold:
 *   * the default is unchanged — a caller that names no phase gets every word;
 *   * each phase drops exactly its own sections and nothing else;
 *   * the safety-relevant and judgement-shaped guidance survives BOTH phases;
 *   * the interactive charter splits without a word changing.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_DOCTRINE,
  FULL_DOCTRINE_CONTEXT,
  INTERACTIVE_DESIGN_CHARTER,
  doctrineForRequest,
  renderDoctrine,
  renderInteractiveDoctrine,
  type DoctrineContext,
} from "../../../packages/orchestrator/src/prompts";

const ALL_ON: DoctrineContext = { ...FULL_DOCTRINE_CONTEXT };

/** The rituals of the opening: they describe a decision, not an execution. */
const OPENING_ONLY = ["# The read-back", "# Ambiguity"];
/**
 * Looked like an opening ritual and is not. Dropping "# Plan and track" after
 * the first completion was measured on 2026-09-08 (sessions 01a08036 vs
 * 01a08059, same task, same free route): malformed `todo_write` calls went
 * from one to seven — items passed as strings, an invalid status — because the
 * ledger-keeping rules (one item in_progress, mark done when done, rewrite on a
 * change of approach) govern every completion, and each fumble is a wasted
 * completion. The plan is the product's ledger; the section rides every phase.
 */
const EVERY_PHASE_BY_MEASUREMENT = ["# Plan and track"];
/** The mirror image: nothing has been produced on the first completion. */
const WORKING_ONLY = ["# Finishing a task"];

/**
 * Never phase-gated, in any combination. The safety-relevant half of this list
 * is the reason it is a test and not a comment: Tool usage policy carries the
 * sandbox and egress rules, Honesty carries "never fabricate an observation",
 * Investigate carries the evidence-before-action rule, and Mid-task steering
 * carries how to resume after an interruption.
 */
const ALWAYS = [
  "# Agency",
  "# Investigate before you act",
  "# Tone and style",
  "# Communication rhythm",
  "# Voice",
  "# Mid-task steering",
  "# Doing tasks",
  "# Honesty",
  "# Tool usage policy",
  "# Coding conventions",
  "# Git",
  "# Proactiveness",
];

describe("doctrine phases", () => {
  test("no phase named renders every section — the default is unchanged", () => {
    expect(renderDoctrine(ALL_ON)).toBe(AGENT_DOCTRINE.trimEnd());
  });

  test("the opening keeps its rituals and drops the closing one", () => {
    const opening = renderDoctrine({ ...ALL_ON, phase: "opening" });
    for (const section of OPENING_ONLY) expect(opening).toContain(section);
    for (const section of WORKING_ONLY) expect(opening).not.toContain(section);
  });

  test("working drops the opening rituals and keeps the closing one", () => {
    const working = renderDoctrine({ ...ALL_ON, phase: "working" });
    for (const section of OPENING_ONLY) {
      expect(working, `${section} governs the opening decision`).not.toContain(section);
    }
    for (const section of WORKING_ONLY) expect(working).toContain(section);
  });

  test("greenfield guidance is an opening ritual too", () => {
    expect(renderDoctrine({ ...ALL_ON, phase: "opening" })).toContain("# Greenfield builds");
    expect(renderDoctrine({ ...ALL_ON, phase: "working" })).not.toContain("# Greenfield builds");
  });

  test("safety-relevant and judgement-shaped sections survive both phases", () => {
    for (const phase of ["opening", "working"] as const) {
      const rendered = renderDoctrine({ ...ALL_ON, phase });
      for (const section of ALWAYS) {
        expect(rendered, `${section} must never be phase-gated (${phase})`).toContain(section);
      }
    }
  });

  test("the plan ledger's rules ride every completion — measured, not assumed", () => {
    for (const phase of ["opening", "working"] as const) {
      const rendered = renderDoctrine({ ...ALL_ON, phase });
      for (const section of EVERY_PHASE_BY_MEASUREMENT) {
        expect(rendered, `${section} governs the whole run (${phase})`).toContain(section);
      }
    }
  });

  test("the working phase is materially cheaper — that is the whole point", () => {
    const full = renderDoctrine(ALL_ON).length;
    const working = renderDoctrine({ ...ALL_ON, phase: "working" }).length;
    expect(full - working).toBeGreaterThan(6_000);
  });

  test("phase gating never leaves a dangling blank-line run", () => {
    for (const phase of ["opening", "working"] as const) {
      expect(renderDoctrine({ ...ALL_ON, phase })).not.toMatch(/\n{3,}/);
    }
  });

  test("the built-in modes section follows its three tools", () => {
    expect(renderDoctrine({ ...ALL_ON, hasModeTools: true })).toContain(
      "# Built-in modes on request",
    );
    expect(renderDoctrine({ ...ALL_ON, hasModeTools: false })).not.toContain(
      "# Built-in modes on request",
    );
  });
});

describe("the interactive design charter splits without a word changing", () => {
  test("charter on is byte-identical to what the block has always been", () => {
    // Every line of the head, the charter and the mechanics, in the original
    // order. If this fails the split is rewriting the doctrine, not moving it.
    for (const auto of [true, false]) {
      const whole = renderInteractiveDoctrine(auto);
      expect(whole).toContain("Composition — a view is an argument in three acts:");
      expect(whole).toContain("Art direction:");
      expect(whole).toContain("Data honesty:");
      expect(whole).toContain("Raw html views (the exception path):");
      expect(whole).toContain("Exports are built in");
    }
  });

  test("charter off keeps the heading, the tool line and the trigger", () => {
    const head = renderInteractiveDoctrine(true, false);
    expect(head).toContain("# Interactive views — design charter");
    expect(head).toContain("The interactive_dashboard tool renders a designed, live view");
    expect(head).toContain("Autonomous dashboards are ON");
    expect(head).not.toContain("Art direction:");
    expect(head.length).toBeLessThan(renderInteractiveDoctrine(true).length / 3);
  });

  test("the manual trigger survives the split too", () => {
    expect(renderInteractiveDoctrine(false, false)).toContain(
      "Build one ONLY when the user asks for an interactive view",
    );
  });

  test("every charter line lives in the just-in-time section, verbatim", () => {
    const whole = renderInteractiveDoctrine(false);
    const head = renderInteractiveDoctrine(false, false);
    for (const line of whole.split("\n")) {
      if (!line.trim()) continue;
      expect(
        head.includes(line) || INTERACTIVE_DESIGN_CHARTER.includes(line),
        `"${line.slice(0, 60)}…" was dropped by the split`,
      ).toBe(true);
    }
  });
});

describe("doctrineForRequest routes the charter", () => {
  test("a request for a view asks for the charter", () => {
    for (const request of [
      "show me a dashboard of the results",
      "visualize the benchmark",
      "build a chart of cost over time",
    ]) {
      expect(doctrineForRequest(request)).toContain("dashboards");
    }
  });

  test("ordinary front-end work does not pay for it", () => {
    expect(doctrineForRequest("fix the css on the login screen")).not.toContain("dashboards");
    expect(doctrineForRequest("rename the retry helper")).toEqual([]);
  });
});
