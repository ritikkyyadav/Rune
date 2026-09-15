/**
 * The Claude Code result envelope: which object is read, and which failures
 * are the comparator's answer rather than the comparator falling over.
 *
 * Two defects, both found by the v7 pass against a format this rig has never
 * captured live (every sample is transcribed):
 *
 *   (a) the parser walked stdout BACKWARDS and took the last line that parsed
 *       as any JSON object. Anything the CLI prints after the envelope — a
 *       hook's output, a telemetry line, a notice — became the envelope, and a
 *       completed scored run with real usage, turns and cost was recorded as
 *       `error: unexpected envelope type undefined`;
 *
 *   (b) the failed branch scored EVERY subtype once quota and auth text were
 *       absent, so `error_during_execution` — Claude Code's own crash — was
 *       graded as the comparator failing the corpus task, and the acceptance
 *       then ran over a workspace the tool never finished writing.
 */

import { describe, expect, test } from "bun:test";

import {
  SCORED_ERROR_SUBTYPES,
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

const errorEnvelope = (subtype: string) =>
  JSON.stringify({
    type: "result",
    subtype,
    is_error: true,
    result: "",
    num_turns: 3,
    usage: { input_tokens: 10, output_tokens: 2 },
  });

describe("the result envelope is found, not guessed at by position", () => {
  test("a line printed after the envelope does not become the envelope", () => {
    const parsed = parseClaudeCodeOutput(
      capture(`${SUCCESS}\n${JSON.stringify({ hook: "SessionEnd" })}`),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.resultText).toBe("Fixed parseCsv and the tests pass.");
    expect(parsed.turns).toBe(7);
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
  });

  test("no JSON at all is still an error, not an invented success", () => {
    expect(parseClaudeCodeOutput(capture("some prose\n")).outcome).toBe("error");
  });
});

describe("only a turn ceiling is the comparator failing the task", () => {
  test("the tool's own crash is unscored, so the acceptance never grades it", () => {
    const parsed = parseClaudeCodeOutput(capture(errorEnvelope("error_during_execution")));
    expect(parsed.outcome).toBe("unscored:harness_error");
    expect(parsed.unscoredReason).toBe("harness_error");
    expect(parsed.detail).toBe("error_during_execution");
    // The usage is retained: the tokens were spent whatever the outcome.
    expect(parsed.usage).not.toBeNull();
  });

  test("a subtype nobody has seen yet is unscored rather than counted against the arm", () => {
    expect(parseClaudeCodeOutput(capture(errorEnvelope("error_something_new"))).outcome).toBe(
      "unscored:harness_error",
    );
  });

  test("error_max_turns stays scored — the tool was working and ran out of turns", () => {
    expect(parseClaudeCodeOutput(capture(errorEnvelope("error_max_turns"))).outcome).toBe("scored");
    expect(SCORED_ERROR_SUBTYPES).toEqual(["error_max_turns"]);
  });

  test("a quota or auth failure still reads as the provider, not the harness", () => {
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
  });

  test("a success envelope whose prose discusses rate limits is still scored", () => {
    // Unchanged, and asserted here so the allow-list above cannot quietly
    // capture it: prose is task evidence.
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
  });
});
