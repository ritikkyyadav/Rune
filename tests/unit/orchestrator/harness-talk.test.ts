/**
 * The harness never hands the model a sentence it can echo.
 *
 * The transcript diagnosis of 2026-09-05 found 62% of one session's prose was
 * about the harness — "Picking up the open step", "Closing the three unproven
 * steps with the evidence I just collected" — and traced every opener to an
 * imperative the harness itself had written into the model's context: the
 * task-state block's "Act on the next open step", the ledger's "re-submit to
 * mark the step unproven", record_evidence's validation errors. The fix is
 * structural — state is data, a refusal is a fact — and this file is what
 * stops the imperatives from drifting back.
 */

import { describe, expect, test } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { AGENT_DOCTRINE } from "../../../packages/orchestrator/src/prompts";
import { HARNESS_OPENER_RE, HARNESS_TALK_RE } from "../../../packages/orchestrator/src/retro";

/** Verbs aimed at the model, in the exact forms weak models echoed. */
const ECHOABLE =
  /\b(?:act on|continue from|pick(?:ing)? up|re-?submit|re-?run|just do the work)\b/i;

function spine(): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn("audit every artifact in the vault and preserve the findings");
  s.setTodos([
    { content: "inspect the vault manifest", status: "in_progress" },
    { content: "report the findings to the user", status: "pending" },
  ]);
  return s;
}

describe("the task-state block", () => {
  test("carries state, not instructions", () => {
    const block = spine().renderBlock(5_000)!;
    expect(block).not.toMatch(ECHOABLE);
    expect(block).toContain("never open a message by naming which step you are on");
  });

  test("a resume note is stated as a fact", () => {
    const s = spine();
    s.setHandoff("max_turns");
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Resumed after: max_turns.");
    expect(block).not.toMatch(/continue from|resume from/i);
    expect(block).not.toMatch(ECHOABLE);
  });
});

describe("the ledger's verdicts", () => {
  test("an unproven close is one line of fact", () => {
    const s = spine();
    const v = s.setTodos([
      { content: "inspect the vault manifest", status: "completed" },
      { content: "report the findings to the user", status: "in_progress" },
    ]);
    expect(v.accepted).toBe(true);
    if (!v.accepted) return;
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toMatch(/^Step 1 closed unproven: [^.]+\.$/);
    expect(v.notes[0]).not.toMatch(ECHOABLE);
  });

  test("in refuse mode the refusal is one line of fact too", () => {
    const s = spine();
    s.setEvidenceGate("refuse");
    const v = s.setTodos([
      { content: "inspect the vault manifest", status: "completed" },
      { content: "report the findings to the user", status: "in_progress" },
    ]);
    expect(v.accepted).toBe(false);
    if (v.accepted) return;
    expect(v.refused[0]!.reason).toBe("nothing ran while it was open.");
    expect(v.refused[0]!.reason).not.toMatch(ECHOABLE);
  });
});

describe("the doctrine", () => {
  test("teaches the beat, not a story register", () => {
    expect(AGENT_DOCTRINE).toContain("Before an action, one sentence");
    expect(AGENT_DOCTRINE).not.toMatch(/story with direction|Narrate in present tense/);
  });
});

describe("the harness-talk pattern", () => {
  test("catches the openers the diagnosis counted", () => {
    for (const line of [
      "Picking up the open step.",
      "Continuing from the next unfinished step.",
      "Resuming the open step now.",
      "Closing the three unproven steps with the evidence I just collected.",
      "Budget is tight, so I'll be brief.",
      "Plan update: two steps left.",
      "Rewriting the plan to match what actually happened.",
    ]) {
      expect(HARNESS_TALK_RE.test(line), line).toBe(true);
    }
    for (const line of [
      "Picking up the open step.",
      "Continuing from where I left off.",
      "Resuming.",
    ]) {
      expect(HARNESS_OPENER_RE.test(line), line).toBe(true);
    }
  });

  test("leaves ordinary narration alone", () => {
    for (const line of [
      "Checking the retry loop first — that is where the 429 disappears.",
      "Found it: the timer is cleared before the await.",
      "Rebuilt the storefront around warm paper, maroon ink and brass details.",
      "The file changed under the edit, so I'm re-reading it before applying the design.",
    ]) {
      expect(HARNESS_TALK_RE.test(line), line).toBe(false);
      expect(HARNESS_OPENER_RE.test(line), line).toBe(false);
    }
  });
});
