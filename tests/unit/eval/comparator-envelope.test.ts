/**
 * The Claude Code result envelope: which object is read, and what each error
 * subtype means once the one classifier every arm shares has read it.
 *
 * Two findings shaped this file, both from the v7 pass against a format this
 * rig has never captured live (every sample is transcribed):
 *
 *   (a) the parser walked stdout BACKWARDS and took the last line that parsed
 *       as any JSON object. Anything the CLI prints after the envelope — a
 *       hook's output, a telemetry line, a notice — became the envelope, and a
 *       completed scored run with real usage, turns and cost was recorded as
 *       `error: unexpected envelope type undefined`. Still fixed; still pinned.
 *
 *   (b) the failed branch scored every subtype, so `error_during_execution` was
 *       graded as the comparator failing the task. v7 made it UNSCORED. The
 *       parity rules (tests/eval/parity/types.ts) reverse that on purpose, for
 *       every arm at once: a crash AFTER the first model call is the tool
 *       failing the task, and stays scored — because a Rune crash after an hour
 *       of work always stayed in Rune's denominator, and unscoring only the
 *       comparator's moved exactly the rows Rune would have won out of the
 *       comparison. A crash BEFORE any call is still unscored, for every arm.
 */

import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_LIMIT_SUBTYPES,
  parseClaudeCodeOutput,
} from "../../eval/comparison/arms/claude-code";
import type { ArmCapture } from "../../eval/comparison/arms/types";

const capture = (stdout: string, over: Partial<ArmCapture> = {}): ArmCapture => ({
  stdout,
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  ...over,
});

const SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Fixed parseCsv and the tests pass.",
  num_turns: 7,
  total_cost_usd: 0.42,
  usage: { input_tokens: 1000, output_tokens: 200 },
  modelUsage: { "claude-sonnet-4-5": {} },
});

const errorEnvelope = (subtype: string, turns = 3) =>
  JSON.stringify({
    type: "result",
    subtype,
    is_error: true,
    result: "",
    num_turns: turns,
    usage: { input_tokens: turns ? 10 : 0, output_tokens: turns ? 2 : 0 },
  });

describe("the result envelope is found, not guessed at by position", () => {
  test("a line printed after the envelope does not become the envelope", () => {
    const parsed = parseClaudeCodeOutput(
      capture(`${SUCCESS}\n${JSON.stringify({ hook: "SessionEnd" })}`),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.claimedSuccess).toBe(true);
    expect(parsed.resultText).toBe("Fixed parseCsv and the tests pass.");
    expect(parsed.turns).toBe(7);
    expect(parsed.calls).toBe(7);
    expect(parsed.reportedCostUsd).toBe(0.42);
    expect(parsed.usage).not.toBeNull();
    expect(parsed.models).toEqual(["claude-sonnet-4-5"]);
  });

  test("a stream of events around the envelope still yields the envelope", () => {
    const parsed = parseClaudeCodeOutput(
      capture(
        [
          JSON.stringify({ type: "system", subtype: "init" }),
          JSON.stringify({ type: "assistant", message: {} }),
          SUCCESS,
          JSON.stringify({ type: "telemetry", flushed: true }),
        ].join("\n"),
      ),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.turns).toBe(7);
  });

  test("with no result object at all, the last object is still read", () => {
    // The transcribed samples that omit `type` have to keep parsing as they
    // always did; this is the fallback that lets them.
    const parsed = parseClaudeCodeOutput(
      capture(JSON.stringify({ subtype: "success", result: "done", num_turns: 2 })),
    );
    expect(parsed.resultText).toBe("done");
    // …but an object that does not say it is the result is not a claim of success.
    expect(parsed.claimedSuccess).toBe(false);
  });

  test("no JSON at all is never an invented success", () => {
    const parsed = parseClaudeCodeOutput(capture("some prose\n"));
    expect(parsed.claimedSuccess).toBe(false);
    expect(parsed.outcome).toBe("unscored:crash_before_first_call");
  });
});

describe("what an error subtype means, under the one classifier", () => {
  test("the tool's own crash after a model call is its failure, and is scored", () => {
    const parsed = parseClaudeCodeOutput(
      capture(errorEnvelope("error_during_execution"), {
        exitCode: 1,
      }),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.failure).toBe("unfinished");
    expect(parsed.claimedSuccess).toBe(false);
    expect(parsed.detail).toBe("error_during_execution");
    // The usage is retained: the tokens were spent whatever the outcome.
    expect(parsed.usage).not.toBeNull();
  });

  test("a crash before any model call is unscored, for this arm as for every arm", () => {
    const parsed = parseClaudeCodeOutput(
      capture(errorEnvelope("error_during_execution", 0), { exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("unscored:crash_before_first_call");
  });

  test("a subtype nobody has seen yet is judged by the same facts as any other", () => {
    expect(parseClaudeCodeOutput(capture(errorEnvelope("error_something_new"))).outcome).toBe(
      "scored",
    );
    expect(parseClaudeCodeOutput(capture(errorEnvelope("error_something_new", 0))).outcome).toBe(
      "unscored:crash_before_first_call",
    );
  });

  test("the tool's own turn and dollar ceilings are scored failures, like Rune's", () => {
    const turns = parseClaudeCodeOutput(capture(errorEnvelope("error_max_turns")));
    expect(turns.outcome).toBe("scored");
    expect(turns.failure).toBe("turn_limit");
    // `error_max_budget_usd` used to be a harness error (unscored) while Rune's
    // own budget stop was a result: the same event, counted on one side only.
    const budget = parseClaudeCodeOutput(capture(errorEnvelope("error_max_budget_usd")));
    expect(budget.outcome).toBe("scored");
    expect(budget.failure).toBe("budget_limit");
    expect(CLAUDE_CODE_LIMIT_SUBTYPES).toEqual({
      error_max_turns: "turns",
      error_max_budget_usd: "budget",
    });
  });

  test("a quota or auth failure still reads as the provider, not the tool", () => {
    const parsed = parseClaudeCodeOutput(
      capture(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Your credit balance is too low to continue.",
          num_turns: 1,
        }),
      ),
    );
    expect(parsed.outcome).toBe("unscored:provider_quota");
    // Claude Code's own shape for an API error: subtype "success", is_error.
    const auth = parseClaudeCodeOutput(
      capture(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Invalid API key · Please run /login",
          num_turns: 1,
        }),
        { exitCode: 1 },
      ),
    );
    expect(auth.outcome).toBe("unscored:provider_auth");
    expect(auth.claimedSuccess).toBe(false);
  });

  test("a success envelope whose prose discusses rate limits is still scored", () => {
    // Prose is task evidence, whatever it says about quotas.
    const parsed = parseClaudeCodeOutput(
      capture(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "I added retry handling for HTTP 429 rate limit responses.",
          num_turns: 4,
        }),
      ),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.claimedSuccess).toBe(true);
  });
});
