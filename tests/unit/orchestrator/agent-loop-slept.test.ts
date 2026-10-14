/**
 * A call the machine slept through is re-sent, not counted (R2.3 of
 * docs/program/rune-reliability-plan-20261014.md).
 *
 * The case, from 12 October's record: the lid closed at 01:21 and the run's
 * failures all fell inside the dark wakes that followed — seconds of running
 * with no network. Each spent the run's error budget, and the outage clock ran
 * through the sleep, so the run ended `provider_lost` at the third dark wake.
 *
 * Unless a test says otherwise, `maxConsecutiveErrors` is 1, so a failure
 * that counted would end the run at once: a run that goes on proves the
 * failure was not counted.
 */

import { describe, expect, test } from "bun:test";
import {
  AWAKE_SETTLE_MS,
  AgentLoop,
  sleptNotice,
  untilAwake,
  type AgentTurnEvent,
} from "../../../packages/orchestrator/src/agent-loop";
import type { SuspendProbe } from "../../../packages/orchestrator/src/suspend-clock";

const MIN = 60_000;

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function answer(text: string) {
  return [
    { type: "content_start", contentIndex: 0 },
    { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text } },
    { type: "content_stop", contentIndex: 0 },
    { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

/**
 * A gateway whose first `failures` calls fail — thrown, or as a retryable
 * error event — and whose later calls answer. Records when each call began.
 */
function gateway(failures: number, how: "throw" | "event" = "throw") {
  const gw = {
    calls: 0,
    startedAt: [] as number[],
    inferStream: async function* () {
      gw.calls++;
      gw.startedAt.push(Date.now());
      if (gw.calls <= failures) {
        if (how === "throw") throw new Error("Unable to connect. Is the computer online?");
        yield { type: "error", error: "socket connection was closed", retryable: true };
        return;
      }
      yield* answer("Here is the answer.");
    },
  } as any;
  return gw;
}

/**
 * A probe that reports `ms` of sleep for every call and a wake long enough ago
 * that no re-send waits; records each `since` it is asked about.
 */
function probe(
  ms: number,
  lastWakeAt: () => number | null = () => Date.now() - 5 * MIN,
): SuspendProbe & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    suspendedSince(since: number) {
      asked.push(since);
      return ms;
    },
    lastWakeAt,
  };
}

/** One sleep of `ms` that ended at `wokeAt` — the machine's real history. */
function history(ms: number, wokeAt: number): SuspendProbe {
  return {
    suspendedSince: (since) => (wokeAt > since ? ms : 0),
    lastWakeAt: () => wokeAt,
  };
}

function loop(gw: unknown, suspendClock: SuspendProbe | false, maxConsecutiveErrors = 1) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 200,
      maxConsecutiveErrors,
      systemPrompt: "s",
      suspendClock,
    } as any,
    gw as any,
    {
      toLlmTools: () => [],
      get: () => undefined,
      execute: async () => ({ success: true, result: "ok", durationMs: 1 }),
    } as any,
  );
}

const notices = (events: AgentTurnEvent[]) =>
  events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message);
const ending = (events: AgentTurnEvent[]) =>
  events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
const fatal = (events: AgentTurnEvent[]) =>
  events.find((e) => e.type === "error" && !(e as any).recoverable) as
    { error: string } | undefined;

describe("a call the machine slept through", () => {
  test("is re-sent without spending an error, and the run finishes", async () => {
    const gw = gateway(1);
    const events = await collect(loop(gw, probe(10 * MIN)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(2);
    expect(notices(events)).toContain(sleptNotice(10 * MIN));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(ending(events).stopReason).toBe("end_turn");
  });

  test("the same for a failure the stream reports instead of throwing", async () => {
    const gw = gateway(1, "event");
    const events = await collect(loop(gw, probe(10 * MIN)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(ending(events).stopReason).toBe("end_turn");
  });

  for (const how of ["throw", "event"] as const) {
    test(`the probe is asked from just before this call's own start (${how})`, async () => {
      const before = Date.now();
      const p = probe(10 * MIN);
      await collect(loop(gateway(1, how), p).run("hello", "s1", "/tmp"));
      expect(p.asked).toHaveLength(1);
      // Thirty seconds of grace before the call: a wake that close is the
      // sleep's doing too.
      expect(p.asked[0]! + 30_000).toBeGreaterThanOrEqual(before);
      expect(p.asked[0]! + 30_000).toBeLessThanOrEqual(Date.now());
    });
  }
});

describe("a call started just after a wake", () => {
  test("is the sleep's too: a dark wake has no network yet", async () => {
    const gw = gateway(1);
    const wokeAt = Date.now() - 15_000;
    const events = await collect(loop(gw, history(4 * MIN, wokeAt)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(2);
    expect(ending(events).stopReason).toBe("end_turn");
  });

  test("but not once the machine has been up a while", async () => {
    const gw = gateway(1);
    const wokeAt = Date.now() - 45_000;
    const events = await collect(loop(gw, history(4 * MIN, wokeAt)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(1);
    expect(fatal(events)?.error).toMatch(/Too many consecutive errors \(1\)/);
  });

  for (const how of ["throw", "event"] as const) {
    test(`the re-send waits until the machine has been awake long enough (${how})`, async () => {
      const gw = gateway(1, how);
      const wokeAt = Date.now() - (AWAKE_SETTLE_MS - 1_000);
      await collect(loop(gw, history(4 * MIN, wokeAt)).run("hello", "s1", "/tmp"));
      expect(gw.calls).toBe(2);
      expect(gw.startedAt[1]!).toBeGreaterThanOrEqual(wokeAt + AWAKE_SETTLE_MS);
    });
  }
});

describe("a call the machine did not sleep through", () => {
  test("spends an error as before", async () => {
    const gw = gateway(1);
    const events = await collect(loop(gw, probe(0)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(1);
    expect(fatal(events)?.error).toMatch(/Too many consecutive errors \(1\)/);
  });

  test("a short suspension is not what cut the call", async () => {
    const gw = gateway(1);
    await collect(loop(gw, probe(29_000)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(1);
  });

  test("thirty seconds is", async () => {
    const gw = gateway(1);
    await collect(loop(gw, probe(30_000)).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(2);
  });

  test("the check can be turned off", async () => {
    const gw = gateway(1);
    await collect(loop(gw, false).run("hello", "s1", "/tmp"));
    expect(gw.calls).toBe(1);
  });
});

describe("the re-sends are bounded", () => {
  test("three per wake; after that a failure counts again", async () => {
    // One wake, and a network that stays down after it: the fourth failure
    // is the network's, not the sleep's.
    const gw = gateway(Number.POSITIVE_INFINITY);
    const wokeAt = Date.now() - MIN;
    const events = await collect(
      loop(
        gw,
        probe(10 * MIN, () => wokeAt),
        2,
      ).run("hello", "s1", "/tmp"),
    );
    expect(gw.calls).toBe(3 + 2);
    expect(notices(events).filter((m) => m.includes("asleep"))).toHaveLength(3);
    expect(fatal(events)?.error).toMatch(/Too many consecutive errors \(2\)/);
  });

  test("each new wake gets its own three, up to fifty in a run", async () => {
    // A lid closed overnight wakes dozens of times; a clock that misreads
    // a starved event loop might report a wake every call. Either way the run
    // stops being carried at fifty.
    const gw = gateway(Number.POSITIVE_INFINITY);
    let wake = Date.now() - 10 * MIN;
    const events = await collect(
      loop(
        gw,
        probe(10 * MIN, () => (wake += 1)),
        2,
      ).run("hello", "s1", "/tmp"),
    );
    expect(gw.calls).toBe(50 + 2);
    expect(fatal(events)?.error).toMatch(/Too many consecutive errors \(2\)/);
  });
});

describe("untilAwake", () => {
  test("returns at once when no sleep was seen, or the machine is long awake", async () => {
    const t0 = Date.now();
    await untilAwake({ suspendedSince: () => 0, lastWakeAt: () => null }, undefined, 1);
    await untilAwake({ suspendedSince: () => 0, lastWakeAt: () => t0 - 60_000 }, undefined, 1);
    await untilAwake(null);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("waits through dark wakes, and goes on after a real one", async () => {
    // Each poll finds a fresh wake — the machine fell asleep and woke again —
    // until the fifth, which finds it up long enough.
    let polls = 0;
    const p: SuspendProbe = {
      suspendedSince: () => 0,
      lastWakeAt: () => (++polls < 5 ? Date.now() : Date.now() - AWAKE_SETTLE_MS),
    };
    await untilAwake(p, undefined, 1);
    expect(polls).toBe(5);
  });

  test("an abort ends the wait", async () => {
    const ac = new AbortController();
    let polls = 0;
    const p: SuspendProbe = {
      suspendedSince: () => 0,
      lastWakeAt: () => {
        if (++polls === 3) ac.abort();
        return Date.now();
      },
    };
    await untilAwake(p, ac.signal, 1);
    expect(polls).toBe(3);
  });

  test("a clock that never settles is waited on for a bounded time", async () => {
    let polls = 0;
    const p: SuspendProbe = {
      suspendedSince: () => 0,
      lastWakeAt: () => {
        polls++;
        return Date.now();
      },
    };
    await untilAwake(p, undefined, 0);
    expect(polls).toBe(600);
  });
});

describe("sleptNotice", () => {
  test("says how long, in the unit a person would", () => {
    expect(sleptNotice(45_000)).toContain("45s");
    expect(sleptNotice(10 * MIN)).toContain("10m");
    expect(sleptNotice(150 * MIN)).toContain("2h 30m");
    expect(sleptNotice(10 * MIN)).toMatch(/asleep/);
  });
});
