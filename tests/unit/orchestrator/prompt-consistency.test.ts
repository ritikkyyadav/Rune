/**
 * P1 — the doctrine and the tool descriptions say the same thing.
 *
 * The doctrine was already right: a clear local fix is one unit of work, a
 * todo list is for three or more deliverables, a read-back is for work whose
 * scope needs agreement. But a model reads each TOOL's description on every
 * request too, and four of those still said the opposite — "use it for
 * anything that will change a file", "call this as you go", "any task with 3+
 * steps" — and so did one line of the doctrine itself. An instruction that
 * disagrees with itself is settled by whichever half the model weighs more,
 * which for a tool is usually the description sitting next to its schema.
 *
 * Each case below is one of those disagreements, held closed. And the fix did
 * not buy its consistency with fixed overhead: the five descriptions together
 * may not grow past what they measured here.
 */

import { describe, expect, test } from "bun:test";

import { READ_BACK_SCHEMA, RECORD_EVIDENCE_SCHEMA } from "../../../packages/orchestrator/src/brief";
import {
  NOTE_HYPOTHESIS_SCHEMA,
  RECORD_DECISION_SCHEMA,
} from "../../../packages/orchestrator/src/narrative-tools";
import { AGENT_DOCTRINE } from "../../../packages/orchestrator/src/prompts";
import { TODO_WRITE_SCHEMA } from "../../../packages/tool-registry/src/tools/todo-write";

describe("planning is for work with several deliverables — said the same way in every place", () => {
  test("the doctrine's own steps do not tell every non-trivial task to write a list", () => {
    expect(AGENT_DOCTRINE).not.toContain("Plan if the task is non-trivial");
    expect(AGENT_DOCTRINE).toContain("only when the work has several deliverables");
    // The rule it defers to is still there, word for word.
    expect(AGENT_DOCTRINE).toContain("For tasks with 3+ independent deliverables");
    expect(AGENT_DOCTRINE).toContain("A clear local repair or small feature is one work unit");
  });

  test("todo_write counts deliverables, not steps — reading, editing and testing one fix is one", () => {
    const text = TODO_WRITE_SCHEMA.description;
    expect(text).not.toMatch(/3\+ steps/);
    expect(text).toMatch(/3\+\s+deliverables or milestones/);
    expect(text).toContain("Skip it for one local change");
    // What a list still has to be, for the work that needs one.
    expect(text).toContain("BEFORE your first file edit");
    expect(text).toContain("exactly one item in_progress");
    expect(text).toContain("unproven");
  });
});

describe("a read-back is for work whose scope needs agreement", () => {
  test("its description no longer asks for one before every file change", () => {
    const text = READ_BACK_SCHEMA.description;
    expect(text).not.toContain("anything that will change a file");
    expect(text).not.toContain("any non-trivial task");
    expect(text).toContain("well-specified local change");
    // The same exemption the doctrine states.
    expect(AGENT_DOCTRINE).toContain(
      "Skip it for a question, lookup or well-specified local change",
    );
    // And what a read-back is, when one is written, is unchanged.
    expect(text).toContain("`leave` is the most important field");
    expect(text).toContain("You cannot mark them met; only evidence can");
  });
});

describe("evidence, hypotheses and decisions are not narration", () => {
  test("record_evidence does not invite a call 'as you go' — it says how to make one cost no turn", () => {
    const text = RECORD_EVIDENCE_SCHEMA.description;
    expect(text).not.toMatch(/as you go/i);
    expect(text).toContain("SAME response as the check");
    expect(text).toContain("costs no extra turn");
    // The contract it enforces is untouched.
    expect(text).toContain("FAILS there and passes now");
  });

  test("a hypothesis is for an investigation with competing explanations", () => {
    expect(NOTE_HYPOTHESIS_SCHEMA.description).toContain(
      "In an investigation with competing explanations",
    );
    expect(AGENT_DOCTRINE).toContain("A direct local repair does not need separate hypothesis");
  });

  test("a decision record is for a consequential decision, not for every commit to an approach", () => {
    expect(RECORD_DECISION_SCHEMA.description).toContain("consequential decision");
    expect(RECORD_DECISION_SCHEMA.description).not.toContain("not at the end");
  });
});

describe("a rule the request states is carried in the person's words", () => {
  // 2026-10-05: twice, on one serious task, a run restated "must not make the
  // writer delete the lines that follow it" as not swallowing a following
  // section — and built, tested and reported the smaller promise. The tool and
  // the doctrine asked for a restatement and nothing else.
  test("the doctrine and the tool say the same thing, where the criteria are written", () => {
    const line = AGENT_DOCTRINE.split("\n").find((l) =>
      l.startsWith("- 'done_when' are the terms"),
    );
    expect(line).toEndWith(
      "Quote any rule they stated (must, must not, never, keep): a paraphrase promises less.",
    );
    const doneWhen = (
      READ_BACK_SCHEMA.inputSchema.properties as Record<string, { description?: string }>
    ).done_when!;
    expect(doneWhen.description).toEndWith(
      "Quote any rule the request states (must, must not, never, keep) — do not restate it.",
    );
  });

  test("restating is still asked for where it belongs: the symptom", () => {
    expect(AGENT_DOCTRINE).toContain(
      "Restate the SYMPTOM they described, not the command they typed.",
    );
    expect(READ_BACK_SCHEMA.description).toContain("Restate the SYMPTOM");
  });
});

describe("consistency was not bought with fixed overhead", () => {
  test("the five bookkeeping descriptions stay under what they measured", () => {
    const bytes = [
      READ_BACK_SCHEMA,
      RECORD_EVIDENCE_SCHEMA,
      TODO_WRITE_SCHEMA,
      NOTE_HYPOTHESIS_SCHEMA,
      RECORD_DECISION_SCHEMA,
    ].reduce((n, schema) => n + Buffer.byteLength(schema.description), 0);
    // 3,313 before the P1 edits; 3,320 after them. A ratchet, like the
    // doctrine's: lower it when these are trimmed, argue for it when they grow.
    expect(bytes).toBeLessThanOrEqual(3_330);
  });
});
