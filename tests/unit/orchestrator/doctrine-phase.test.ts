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

/**
 * The rituals of the opening: they describe a decision, not an execution.
 *
 * "# Built-in modes on request" joined them in P3B C2 and left again when V-C
 * showed the premise was wrong: `interject()` folds a mid-run user message into
 * the SAME run, so "compact the conversation" can land on a turn > 1 request,
 * which is served the working prompt. A section that routes the USER'S WORDS
 * cannot be gated on a turn number. It is capability-gated only — see "the
 * built-in modes section follows its three tools" below.
 */
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

  /**
   * V-C's finding, as a law. C2 gated this section on the phase as well, so a
   * run that loaded a mode tool carried the routing on turn 1 and lost it from
   * turn 2 — while the message that asks for a mode can arrive at ANY turn
   * (`AgentLoop.interject` folds mid-run steering into the same run, and `turn`
   * only resets per `run()`). The tools it routes to are in the request's tool
   * list on every one of those turns; the words that say when to reach for them
   * must be too.
   */
  test("the modes routing is on every phase its tools are, not just the opening", () => {
    for (const phase of ["opening", "working"] as const) {
      expect(
        renderDoctrine({ ...ALL_ON, hasModeTools: true, phase }),
        `a mode can be asked for on a ${phase} turn`,
      ).toContain("# Built-in modes on request");
      expect(renderDoctrine({ ...ALL_ON, hasModeTools: false, phase })).not.toContain(
        "# Built-in modes on request",
      );
    }
  });

  // ─── C2 — the per-section measurement, pinned ───
  //
  // `docs/program/phase-3-auto-efficiency.md` §6 Lane C asks for the doctrine's
  // working-phase cost to be decided from bytes rather than taste. These are
  // those bytes, in UTF-8, for the jit context the default run assembles
  // (`canDelegate` and `buildsInterfaces` false — both sections are delivered
  // just in time instead). The per-section table is in
  // `.codex/audit-20260910/handoff/phase3/laneC-report.md`.
  //
  // A number that moves is not a failure; it is a doctrine edit asking to be
  // re-measured, and to be justified in the report the same way this one was.
  test("the working-phase doctrine costs what the phase split measured, to the byte", () => {
    const JIT: DoctrineContext = { ...ALL_ON, canDelegate: false, buildsInterfaces: false };
    const utf8 = (s: string) => new TextEncoder().encode(s).length;
    const opening = utf8(renderDoctrine({ ...JIT, phase: "opening" }));
    const working = utf8(renderDoctrine({ ...JIT, phase: "working" }));
    // Pinned at 730fd97: opening 24,135, working 19,099. C2 took the working
    // half to 18,358 by moving the modes section out of it; V-C showed that
    // opened a correctness hole for a mid-run mode ask, so the 741 bytes are
    // back and the working half is 19,099 again. The saving C2 claimed is
    // withdrawn — `docs/program/phase-3-auto-efficiency.md` §6 asks for bytes,
    // and these are the honest ones.
    expect(opening).toBe(24_135);
    expect(working).toBe(19_099);
    // The switch only ever drops — a working prompt that grew would cost a
    // second full cache write per run instead of a smaller prefix.
    expect(working).toBeLessThan(opening);
  });

  test("the working phase keeps every section turn 2+ reads", () => {
    const JIT: DoctrineContext = { ...ALL_ON, canDelegate: false, buildsInterfaces: false };
    const working = renderDoctrine({ ...JIT, phase: "working" });
    // Everything the working phase had at 730fd97 is still there. This is
    // the guard the design asks for: "keeping everything that turn 2+ relies
    // on" is not a claim, it is this list.
    for (const section of [
      "# Agency",
      "# Investigate before you act",
      "# Tone and style",
      "# Communication rhythm",
      "# Plan and track",
      "# Voice",
      "# Mid-task steering",
      "# Doing tasks",
      "# Finishing a task",
      "# Honesty",
      "# Tool usage policy",
      "# Built-in modes on request",
      "# Coding conventions",
      "# Git",
      "# Proactiveness",
    ]) {
      expect(working, `${section} is read on a working turn`).toContain(section);
    }
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

/**
 * The complement to the phase revert (V-C 2c): with all three mode tools
 * deferred to catalog lines, `hasModeTools` is false and the section ships in
 * NEITHER phase — so a request that asks for a mode has only one way left to
 * see the routing, and at `4c04e03` there was none. `JitDoctrineSection` did
 * not contain it and `doctrineForRequest("compact the conversation")` was `[]`.
 */
describe("doctrineForRequest routes the built-in modes", () => {
  test("the three asks the section exists to route ask for it", () => {
    for (const request of [
      "research the auth flow and give me a cited report",
      "do a deep dive on the retry ladder and research the alternatives",
      "compact the conversation",
      "compress our chat, it is getting long",
      "show this as a dashboard",
    ]) {
      expect(doctrineForRequest(request), request).toContain("modes");
    }
  });

  test("ordinary work never pays for the routing", () => {
    for (const request of [
      "rename the retry helper",
      "fix the css on the login screen",
      "compact the index file",
      "summarize this function for me",
    ]) {
      expect(doctrineForRequest(request), request).not.toContain("modes");
    }
  });
});
