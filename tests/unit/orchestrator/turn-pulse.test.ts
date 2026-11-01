/**
 * The live rung, held to its one promise: everything it shows about liveness
 * must be something that actually happened.
 *
 * The acceptance case is the third test — a tool that starts and never reports
 * anything again. Before this, the mark breathed off the wall clock and the
 * rung looked identical at four seconds and at four minutes.
 */

import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { TurnRenderer } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import type { Pulse } from "../../../packages/orchestrator/src/bin/ui/pulse";

function makeRenderer() {
  const commits: string[] = [];
  const r = new TurnRenderer({ commit: (b: string) => commits.push(b), preview: () => {} }, {});
  return {
    r,
    commits,
    /** The rung as the user reads it, with colour stripped. */
    rung: () => r.liveLines().map(stripAnsi).join("\n"),
    pulse: () => (r as unknown as { pulse: Pulse }).pulse,
    /** Pretend everything the pulse has seen happened `ms` ago, so the decay
     *  it would have done in real time has actually been done. */
    rewind: (ms: number) => {
      const p = (r as unknown as { pulse: Pulse }).pulse as unknown as {
        agedAt: number;
        lastFeedAt: number;
      };
      p.agedAt -= ms;
      p.lastFeedAt -= ms;
    },
  };
}

describe("live rung liveness", () => {
  test("streamed output raises the pulse", () => {
    const { r, pulse } = makeRenderer();
    expect(pulse().sample().level).toBe(0);
    r.onEvent({ type: "text_delta", text: "Looking at the retry ladder now." } as any);
    expect(pulse().sample().level).toBeGreaterThan(0);
  });

  test("tool traffic counts as output even though it carries no prose", () => {
    const { r, pulse } = makeRenderer();
    r.onEvent({ type: "tool_call_start", callId: "c1", toolName: "run_command" } as any);
    const started = pulse().sample().level;
    expect(started).toBeGreaterThan(0);
    r.onEvent({ type: "tool_progress", callId: "c1", note: "compiling" } as any);
    expect(pulse().sample().level).toBeGreaterThan(started);
  });

  test("a tool that starts and never reports goes flat, and the rung says so", () => {
    const { r, rung, pulse, rewind } = makeRenderer();

    // The call opened, and then nothing was heard for 47 seconds.
    r.onEvent({ type: "tool_call_start", callId: "c1", toolName: "run_command" } as any);
    expect(pulse().sample().step).toBeGreaterThan(0);
    rewind(47_000);

    const sample = pulse().sample();
    expect(sample.step).toBe(0); // flat — no invented movement
    expect(sample.quiet).toBe(true);

    // And the stall is carried by the WORD, so it survives NO_COLOR and mono.
    expect(rung()).toContain("quiet 47s");
  });

  test("a working turn never says quiet", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "text_delta", text: "still going" } as any);
    expect(rung()).not.toContain("quiet");
  });

  test("no percentage and no estimate of what remains", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "tool_call_start", callId: "c1", toolName: "run_command" } as any);
    r.onEvent({ type: "text_delta", text: "working" } as any);
    const line = rung();
    expect(line).not.toMatch(/\d+%/);
    expect(line).not.toMatch(/remaining|eta|ETA|left\b/);
  });
});

describe("retries are never silent", () => {
  // The rung gives its voice up below a 72-column measure, and the width is a
  // process global another file can leave narrow: pinned here, so what is
  // measured is the row, not the order the files ran in.
  beforeEach(() => setTermWidthOverride(100));
  afterEach(() => setTermWidthOverride(null));

  test("a retry rides the rung for as long as it lasts", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({
      type: "retry",
      provider: "anthropic",
      model: "claude-opus-5",
      attempt: 1,
      of: 3,
      status: 529,
      waitMs: 1000,
      reason: "overloaded",
    } as any);
    expect(rung()).toContain("↻ retry 1");
    // The voice says what the provider did, not that Rune is thinking.
    expect(r.workingState().voice).toBe("the provider said 529, trying again");
    expect(rung()).toContain("the provider said 529, trying again");

    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 2, of: 3 } as any);
    expect(rung()).toContain("↻ retry 2");
    // A second ladder restarts its own count; the rung's only goes up. It
    // used to read 2 of 3, 2 of 3, 1 of 3, 3 of 3 through one outage.
    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 1, of: 3 } as any);
    expect(rung()).toContain("↻ retry 3");
  });

  test("a silent model is said as waiting on it, not as thinking", () => {
    const { r, rewind } = makeRenderer();
    rewind(5_000);
    // The voice walk ("connecting the dots", "one thought at a time") ran
    // through a 45-second silence; nothing was arriving, and the row said so
    // only in the small `quiet 39s`.
    expect(r.workingState().voice).toBe("waiting on the model");
  });

  test("a running command's silence keeps the command's own voice", () => {
    const { r, rewind } = makeRenderer();
    r.onEvent({ type: "tool_call_start", callId: "b1", toolName: "bash" } as any);
    r.onEvent({
      type: "tool_call_args_delta",
      callId: "b1",
      partialJson: JSON.stringify({ command: "bun test" }),
    } as any);
    rewind(5_000);
    expect(r.workingState().voice).not.toBe("waiting on the model");
  });

  test("output arriving again ends the retry on the rung", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 1, of: 3 } as any);
    expect(rung()).toContain("↻");
    r.onEvent({ type: "text_delta", text: "Recovered and answering." } as any);
    expect(rung()).not.toContain("↻");
    expect(rung()).not.toContain("trying again");
  });

  test("switching provider ends that provider's ladder", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 2, of: 3 } as any);
    expect(rung()).toContain("↻ retry 1");
    r.onEvent({
      type: "fallback",
      from: { provider: "anthropic", model: "m" },
      to: { provider: "openrouter", model: "n" },
      status: 529,
    } as any);
    expect(rung()).not.toContain("↻");
  });

  test("a finished turn carries no stale retry", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 1, of: 3 } as any);
    r.onEvent({ type: "turn_complete", totalTurns: 1, stopReason: "end_turn" } as any);
    expect(rung()).not.toContain("↻");
  });
});
