/**
 * The clock that tells the loop the machine slept (R2 of
 * docs/program/rune-reliability-plan-20261014.md). Driven by hand: a clock
 * built with `start: false` only moves when ticked, against a wall clock the
 * test owns.
 */

import { describe, expect, test } from "bun:test";
import { SuspendClock } from "../../../packages/orchestrator/src/suspend-clock";

function handClock(start = 1_000_000) {
  let wall = start;
  let mono = 50_000;
  const clock = new SuspendClock({ start: false, now: () => wall, mono: () => mono });
  return {
    clock,
    /** Ticks once a second for `secs` seconds of a process that ran. */
    run(secs: number) {
      for (let i = 0; i < secs; i++) {
        wall += 1_000;
        mono += 1_000;
        clock.tick();
      }
    },
    /** The process does not run for `ms`; no tick fires. Both clocks move (macOS). */
    sleep(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** Someone sets the system time: only the wall clock moves. */
    setTime(ms: number) {
      wall += ms;
    },
    get wall() {
      return wall;
    },
  };
}

describe("SuspendClock", () => {
  test("a process that kept ticking was never suspended", () => {
    const h = handClock();
    const since = h.wall;
    h.run(120);
    expect(h.clock.suspendedSince(since)).toBe(0);
  });

  test("a sleep is measured", () => {
    const h = handClock();
    const since = h.wall;
    h.run(5);
    h.sleep(10 * 60_000);
    h.run(3);
    expect(h.clock.suspendedSince(since)).toBe(10 * 60_000);
  });

  test("a late timer is not a sleep", () => {
    const h = handClock();
    const since = h.wall;
    h.sleep(4_000); // a busy event loop, five seconds between ticks
    h.run(1);
    expect(h.clock.suspendedSince(since)).toBe(0);
  });

  test("the gap that just ended is counted, before any tick has seen it", () => {
    // The machine wakes and the first thing the process notices is the dead
    // socket — the failure is reported before the interval fires. The gap is
    // the time since the last tick, less the one period a tick was due anyway.
    const h = handClock();
    const since = h.wall;
    h.run(2);
    h.sleep(90_000);
    expect(h.clock.suspendedSince(since)).toBe(89_000);
  });

  test("a sleep before the call is not the call's", () => {
    const h = handClock();
    h.run(2);
    h.sleep(3 * 60_000);
    h.run(2);
    const since = h.wall;
    h.run(30);
    expect(h.clock.suspendedSince(since)).toBe(0);
  });

  test("a system time set forward is not a sleep", () => {
    // 1.4.4's clock read the wall alone, and a test that moved the time left
    // every later run in its process looking asleep.
    const h = handClock();
    const since = h.wall;
    h.run(2);
    h.setTime(60 * 60_000);
    h.run(3);
    expect(h.clock.suspendedSince(since)).toBe(0);
    expect(h.clock.lastWakeAt()).toBeNull();
  });

  test("a wall clock set back records nothing", () => {
    let wall = 5_000_000;
    const clock = new SuspendClock({ start: false, now: () => wall, mono: () => 0 });
    const since = wall - 1;
    wall -= 60 * 60_000;
    clock.tick();
    wall += 1_000;
    expect(clock.suspendedSince(since - 60 * 60_000)).toBe(0);
  });

  test("gaps older than a day are forgotten", () => {
    const h = handClock();
    const since = h.wall;
    h.sleep(60_000);
    h.run(1);
    h.sleep(25 * 60 * 60_000); // a long weekend
    h.run(1);
    // Only the second gap is still held; the first fell out of the window.
    expect(h.clock.suspendedSince(since)).toBe(25 * 60 * 60_000);
  });

  test("lastWakeAt: none before any sleep, then when the last one ended", () => {
    const h = handClock();
    h.run(3);
    expect(h.clock.lastWakeAt()).toBeNull();
    h.sleep(2 * 60_000);
    h.run(1);
    const first = h.wall;
    expect(h.clock.lastWakeAt()).toBe(first);
    h.run(5);
    h.sleep(60_000);
    // Asked before any tick has seen this one: the ask ticks first.
    expect(h.clock.lastWakeAt()).toBe(h.wall);
    expect(h.clock.lastWakeAt()).not.toBe(first);
  });

  test("a started clock does not keep the process alive and can be stopped", () => {
    const clock = new SuspendClock();
    clock.stop();
    clock.stop(); // twice is fine
    expect(clock.suspendedSince(Date.now() - 1_000)).toBe(0);
  });
});
