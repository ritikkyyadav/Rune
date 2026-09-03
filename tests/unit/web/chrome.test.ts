/**
 * The chrome the reader chose, remembered (P10.9).
 *
 * Two decisions, and they are separate: the rail is CLOSED by default, and the
 * choice someone makes is KEPT. It shipped open, so the first thing anyone saw
 * was a 760px reading column with a 380px panel of spans they had not asked for
 * beside it. Defaulting it closed and then re-closing it on every reload would
 * have replaced one annoyance with a smaller, more persistent one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadRailOpen, saveRailOpen } from "../../../apps/web/src/lib/chrome";

const KEY = "gear.rail";

function withStorage(impl: Partial<Storage>): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = impl as Storage;
}

const original = (globalThis as { localStorage?: Storage }).localStorage;
afterEach(() => {
  if (original) withStorage(original);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("the trace rail's remembered state", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    withStorage({
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });

  test("closed on a browser that has never been asked", () => {
    expect(loadRailOpen()).toBe(false);
  });

  test("the choice survives, in both directions", () => {
    saveRailOpen(true);
    expect(store[KEY]).toBe("1");
    expect(loadRailOpen()).toBe(true);
    saveRailOpen(false);
    expect(loadRailOpen()).toBe(false);
  });

  test("a value nobody wrote falls back to closed rather than to nonsense", () => {
    store[KEY] = "yes please";
    expect(loadRailOpen()).toBe(false);
  });
});

describe("storage that refuses", () => {
  test("a browser that blocks storage still gets a page", () => {
    // Private windows and blocked-site-data settings THROW on access rather
    // than returning null. A page that cannot remember a panel must still draw
    // one, and a write that cannot land must not take the page down with it.
    withStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadRailOpen()).toBe(false);
    expect(() => saveRailOpen(true)).not.toThrow();
  });
});
