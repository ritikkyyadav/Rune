/**
 * Doctrine v2 regression guard. The agency layer is what separates "typed
 * coding agent" from "autonomous engineer" — these phrases anchor behaviors
 * that mechanical fixes can't provide, so losing one in a later edit is a
 * silent product regression. Assert the load-bearing lines survive.
 */

import { describe, test, expect } from "bun:test";
import { AGENT_DOCTRINE } from "../../../packages/orchestrator/src/prompts";

describe("AGENT_DOCTRINE — agency layer", () => {
  test("agency section leads: ownership, iterate-on-failure, no promised next steps", () => {
    expect(AGENT_DOCTRINE).toContain("# Agency — you own the task");
    // Agency must come BEFORE tone: a model reads priorities in order.
    expect(AGENT_DOCTRINE.indexOf("# Agency")).toBeLessThan(
      AGENT_DOCTRINE.indexOf("# Tone and style"),
    );
    expect(AGENT_DOCTRINE).toContain("that is YOUR bug to fix");
    expect(AGENT_DOCTRINE).toContain("Never END your reply on an unexecuted plan or a promise");
    // Stating a brief plan BEFORE acting is explicitly good practice now —
    // the ban is on stopping there, not on showing the plan.
    expect(AGENT_DOCTRINE).toContain(
      "Stating your plan briefly BEFORE executing it is good engineering",
    );
    expect(AGENT_DOCTRINE).toContain("Act on reasonable assumptions");
  });

  test("4th gear means no human mid-task", () => {
    expect(AGENT_DOCTRINE).toContain("In 4th gear (full autonomy), execution is yours alone");
    expect(AGENT_DOCTRINE).toContain("4th gear changes WHEN you ask, not whether");
  });

  test("delegation teaches parallel fan-out", () => {
    expect(AGENT_DOCTRINE).toContain("# Delegation");
    expect(AGENT_DOCTRINE).toContain("SEVERAL IN ONE RESPONSE");
    expect(AGENT_DOCTRINE).toContain("read-only scouts");
  });

  test("finish line: the user sees it running, next step offered as a statement", () => {
    expect(AGENT_DOCTRINE).toContain("the user SEEING it run");
    expect(AGENT_DOCTRINE).toContain("left it running");
    expect(AGENT_DOCTRINE).toContain("Never close with a list of questions");
  });

  test("honesty + runtime truth survive", () => {
    expect(AGENT_DOCTRINE).toContain("verified, then stopped");
    expect(AGENT_DOCTRINE).toContain('never claim "done" to escape a hard problem');
  });
});

// Doctrine v3 — the investigation layer. Added after the 2026-07-16 audit of
// rushed/shallow behavior (fake image "inspection", diagnosis-by-guess,
// missing-data cop-outs, silent egress-block workarounds). Each phrase anchors
// one observed failure mode; losing one regresses a real incident.
describe("AGENT_DOCTRINE — investigation layer", () => {
  test("investigate-before-acting section leads, right after agency", () => {
    expect(AGENT_DOCTRINE).toContain("# Investigate before you act");
    expect(AGENT_DOCTRINE.indexOf("# Investigate before you act")).toBeLessThan(
      AGENT_DOCTRINE.indexOf("# Tone and style"),
    );
    // Unknown territory → discover first, memory is not a source.
    expect(AGENT_DOCTRINE).toContain("find out FIRST");
    expect(AGENT_DOCTRINE).toContain("hypothesis to check, not a source to cite");
  });

  test("diagnosis means evidence → hypothesis → confirmation", () => {
    expect(AGENT_DOCTRINE).toContain("VERIFIED explanation, not a plausible story");
    expect(AGENT_DOCTRINE).toContain("CONFIRM it before you write the diagnosis");
  });

  test("missing data must be explained, not reported as a wall", () => {
    expect(AGENT_DOCTRINE).toContain("Missing data is a finding to explain");
    expect(AGENT_DOCTRINE).toContain("before the market closed");
  });

  test("brevity is for prose, never for the work", () => {
    expect(AGENT_DOCTRINE).toContain("Brevity applies to your PROSE, never to your work");
  });

  test("todos complete only with evidence from this session", () => {
    expect(AGENT_DOCTRINE).toContain('"Completed" is measured');
    expect(AGENT_DOCTRINE).toContain("UNPROVEN");
    expect(AGENT_DOCTRINE).toContain("A failed or blocked step is NOT done");
    // The ledger records; it never argues, and the doctrine never says it does.
    expect(AGENT_DOCTRINE).not.toMatch(/refuses a completion|re-submitted claim/);
  });

  test("communication rhythm: one sentence before an action, never the state of the plan", () => {
    expect(AGENT_DOCTRINE).toContain(
      "Before an action, one sentence saying what you are about to do and why",
    );
    expect(AGENT_DOCTRINE).toContain(
      "After a result, one sentence only if it changes the next step",
    );
    expect(AGENT_DOCTRINE).toContain("Never open a message with the state of the plan or a step");
    // The story register and its worked beats are gone: they cost 62% of a
    // weak model's sentences and taught the wrong thing to narrate.
    expect(AGENT_DOCTRINE).not.toContain("story being told");
    expect(AGENT_DOCTRINE).not.toContain("Narrate in present tense");
    expect(AGENT_DOCTRINE).not.toContain("micro-confirmations");
  });

  test("never fabricate observations; blocked calls escalate honestly", () => {
    expect(AGENT_DOCTRINE).toContain("Never fabricate an observation you could not make");
    expect(AGENT_DOCTRINE).toContain('"Egress blocked"');
    expect(AGENT_DOCTRINE).toContain("pretends the blocked data existed");
  });

  test("interruptions resume the original goal, never a downgraded deliverable", () => {
    expect(AGENT_DOCTRINE).toContain("continuing the ORIGINAL task from the last verified todo");
    expect(AGENT_DOCTRINE).toContain("Never quietly downgrade the deliverable");
  });
});
