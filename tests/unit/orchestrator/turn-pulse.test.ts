/**
 * The live rung, held to its one promise: everything it shows about liveness
 * must be something that actually happened.
 *
 * The acceptance case is the third test — a tool that starts and never reports
 * anything again. Before this, the mark breathed off the wall clock and the
 * rung looked identical at four seconds and at four minutes.
 */

import { describe, test, expect } from "bun:test";
import { TurnRenderer } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
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
    expect(rung()).toContain("↻ 1 of 3");

    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 2, of: 3 } as any);
    expect(rung()).toContain("↻ 2 of 3");
  });

  test("switching provider ends that provider's ladder", () => {
    const { r, rung } = makeRenderer();
    r.onEvent({ type: "retry", provider: "anthropic", model: "m", attempt: 2, of: 3 } as any);
    expect(rung()).toContain("↻ 2 of 3");
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
