/**
 * The pulse must be incapable of claiming life it cannot see.
 *
 * What this replaced was `breathAt(Date.now() - startedAt)` — a cosine-eased
 * mark that went on breathing at exactly the same rate through a wedged tool
 * call. These tests exist to make that class of bug loud: a pulse that moves
 * on a timer fails the first two cases here.
 */

import { describe, test, expect } from "bun:test";
import {
  Pulse,
  PULSE_LEVELS,
  PULSE_WEIGHT,
  QUIET_AFTER_MS,
  quietLabel,
} from "../../../packages/orchestrator/src/bin/ui/pulse";

describe("pulse", () => {
  test("a pulse fed nothing is flat, however long it runs", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    for (const dt of [0, 500, 2_600, 10_000, 240_000]) {
      const s = p.sample(t0 + dt);
      expect(s.level).toBe(0);
      expect(s.step).toBe(0);
    }
  });

  test("it rises with output and falls once output stops", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    // A second of ordinary prose streaming, in ragged bursts.
    for (let i = 0; i < 10; i++) p.feed(120, t0 + i * 100);
    const busy = p.sample(t0 + 1000);
    expect(busy.step).toBeGreaterThan(0);

    // Nothing more arrives. The level must decay on its own.
    const after2s = p.sample(t0 + 3000);
    expect(after2s.level).toBeLessThan(busy.level);
    const after10s = p.sample(t0 + 11_000);
    expect(after10s.step).toBe(0);
  });

  test("the stall is stated in words, not left to the glyph", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    p.feed(PULSE_WEIGHT.callback, t0);

    // Just inside the threshold: still working as far as anyone knows.
    const near = p.sample(t0 + QUIET_AFTER_MS - 1);
    expect(near.quiet).toBe(false);
    expect(quietLabel(near)).toBeNull();

    // Past it: the row must say so, in a word, and count.
    const gone = p.sample(t0 + 31_400);
    expect(gone.quiet).toBe(true);
    expect(quietLabel(gone)).toBe("quiet 31s");
  });

  test("feeding zero cannot fake liveness", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    p.feed(0, t0 + 100);
    p.feed(-500, t0 + 200);
    p.feed(NaN, t0 + 300);
    const s = p.sample(t0 + 30_000);
    expect(s.level).toBe(0);
    expect(s.quiet).toBe(true);
    // The quiet clock runs from construction, not from the fake feeds.
    expect(s.quietMs).toBe(30_000);
  });

  test("a faster stream reads higher than a slower one", () => {
    const t0 = 1_000_000;
    const slow = new Pulse(t0);
    const fast = new Pulse(t0);
    for (let i = 0; i < 20; i++) {
      slow.feed(40, t0 + i * 50);
      fast.feed(600, t0 + i * 50);
    }
    expect(fast.sample(t0 + 1000).step).toBeGreaterThan(slow.sample(t0 + 1000).step);
  });

  // DELETED, deliberately (2026-09-15): "the ramp is one cell wide in both
  // rungs, and the same length". It asserted that `PULSE_RAMP`,
  // `PULSE_RAMP_ASCII` and `pulseGlyph` mapped a sample onto one of eight
  // block cells. Nothing draws a ramp any more -- the working mark is fixed
  // and breathes by colour (ui/working.ts) -- so those three exports are gone
  // and the test went with them rather than being kept alive around a
  // renderer with no caller. What the ramp was FOR is still asserted, above
  // and below: the level rises with real output, falls to the floor when it
  // stops, and the `quiet` word says so. `PULSE_GLYPHS` itself survives as
  // the context meter's fill and is covered by ui-glyphs.test.ts.
  test("the level still spans the full range it quantises onto", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    p.feed(50_000, t0);
    expect(p.sample(t0).step).toBe(PULSE_LEVELS - 1);
    // …and decays all the way back to the floor, which is the half of this
    // that a timer-driven indicator could never reproduce.
    expect(p.sample(t0 + 60_000).step).toBe(0);
  });

  test("reset clears the level and restarts the quiet clock", () => {
    const t0 = 1_000_000;
    const p = new Pulse(t0);
    p.feed(5000, t0);
    p.reset(t0 + 50_000);
    const s = p.sample(t0 + 50_000);
    expect(s.level).toBe(0);
    expect(s.quiet).toBe(false);
    expect(s.quietMs).toBe(0);
  });
});
