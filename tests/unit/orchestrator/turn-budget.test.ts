/**
 * The turn budget a message earns.
 *
 * The measured failure: "well why are you quite ?" — 24 characters — entered
 * the full 80-turn loop, resumed the open mission, and burned 80 completions
 * and 53 minutes. These tests pin the conservative classifier: only
 * unambiguous conversation gets the small budget, anything imperative,
 * workspace-pointing, long, or multi-line keeps the full ceiling — and the
 * real transcript's messages land where they should.
 */
import { describe, expect, test } from "bun:test";

import {
  CONVERSATIONAL_MAX_TURNS,
  turnBudgetForMessage,
} from "../../../packages/orchestrator/src/turn-budget";

const FULL = 80;

const small = (msg: string) => {
  const b = turnBudgetForMessage(msg, FULL);
  expect(b.conversational, `expected conversational: ${JSON.stringify(msg)}`).toBe(true);
  expect(b.maxTurns).toBe(CONVERSATIONAL_MAX_TURNS);
  expect(b.note).toBeString();
};

const full = (msg: string) => {
  const b = turnBudgetForMessage(msg, FULL);
  expect(b.conversational, `expected full budget: ${JSON.stringify(msg)}`).toBe(false);
  expect(b.maxTurns).toBe(FULL);
  expect(b.note).toBeUndefined();
};

describe("turnBudgetForMessage", () => {
  test("the transcript's own conversational turns get the small budget", () => {
    small("well hii");
    small("hii there");
    small("well why are you quite ?");
    small("tell me are you hallucinating ?");
    small("thanks!");
    small("ok");
  });

  test("the transcript's own work turns keep the full ceiling", () => {
    full("well i want you to ship me the end to end application !!");
    full("well the limits are normal you can proceed !!");
    full("continue");
    full("well then show me the preview of the system !!");
    full("well didnt liked it build another !!");
  });

  test("imperative questions are work, not conversation", () => {
    full("can you fix the tree view?");
    full("could you check whether the tests pass?");
    full("will you review the diff?");
  });

  test("workspace-pointing questions keep the full budget", () => {
    full("what does src/engine.ts do?");
    full("is `getFallbackProviders` correct?");
    full("does --no-verify skip the hook?");
  });

  test("long or multi-line messages are always work", () => {
    full("a".repeat(200) + "?");
    full("first line\nsecond line");
  });

  test("empty input keeps the full budget", () => {
    full("");
    full("   ");
  });

  test("the small budget never exceeds the engine ceiling", () => {
    expect(turnBudgetForMessage("well hii", 4).maxTurns).toBe(4);
  });
});
