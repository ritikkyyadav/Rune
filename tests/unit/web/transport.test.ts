/**
 * The transport choice, as the bundle makes it.
 *
 * The page has exactly one way to reach the engine — a WebSocket to whatever
 * served it — and `configuredServer()` is the whole decision. Getting the
 * precedence backwards means a page served by `gear serve --web` would try to
 * drive somebody else's engine, so it is pinned here rather than trusted.
 *
 * These run without a browser: `window` is a stub with the four things the
 * function actually reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { canReloadForToken, configuredServer } from "../../../apps/web/src/lib/transport";

interface FakeWindow {
  __GEAR_SERVE__?: { url?: string; token?: string };
  location: { search: string; hash: string; host: string; protocol: string; pathname: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
  /** Every URL `history.replaceState` was called with, for the scrub check. */
  replaced: string[];
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
}

function fakeWindow(): FakeWindow {
  const store = new Map<string, string>();
  const replaced: string[] = [];
  return {
    location: {
      search: "",
      hash: "",
      host: "192.168.1.9:7788",
      protocol: "http:",
      pathname: "/",
    },
    history: {
      replaceState: (_s, _t, url) => void replaced.push(url),
    },
    replaced,
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
}

describe("the page's transport choice", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as { window?: unknown }).window;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  test("no window, no server", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(configuredServer()).toBeNull();
  });

  test("the embedded endpoint the engine injects wins", () => {
    const w = fakeWindow();
    w.__GEAR_SERVE__ = { url: "ws://127.0.0.1:7788", token: "abc" };
    w.location.search = "?server=ws://evil.example&token=zzz";
    w.localStorage.setItem("gear.serve.endpoint", JSON.stringify({ url: "ws://old", token: "o" }));
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toEqual({
      url: "ws://127.0.0.1:7788",
      token: "abc",
      source: "embedded",
    });
  });

  test("a query string endpoint is used when nothing was embedded", () => {
    const w = fakeWindow();
    w.location.search = "?server=ws%3A%2F%2F127.0.0.1%3A4762&token=tok";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toEqual({
      url: "ws://127.0.0.1:4762",
      token: "tok",
      source: "query",
    });
  });

  test("a saved server is the last resort", () => {
    const w = fakeWindow();
    w.localStorage.setItem(
      "gear.serve.endpoint",
      JSON.stringify({ url: "ws://127.0.0.1:4762", token: "saved" }),
    );
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()?.source).toBe("saved");
  });

  test("half an endpoint is no endpoint", () => {
    const w = fakeWindow();
    w.location.search = "?server=ws://127.0.0.1:4762";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toBeNull();
  });

  // ─── the fragment (P5.5) ───
  //
  // A remote link carries its token in `#token=`, not `?token=`. A fragment is
  // never sent to the server, so it cannot land in an access log, a proxy log
  // or a Referer on the way somewhere else — which is the whole point for a
  // bearer token that grants remote code execution.

  test("a fragment token names the server the page came from", () => {
    const w = fakeWindow();
    w.location.hash = "#token=lan-token";
    (globalThis as { window?: unknown }).window = w;
    // One port, one origin: the engine serves the page and the socket from the
    // same place, so the fragment only has to carry the secret.
    expect(configuredServer()).toEqual({
      url: "ws://192.168.1.9:7788",
      token: "lan-token",
      source: "fragment",
    });
  });

  test("the token is taken out of the address bar once it is read", () => {
    const w = fakeWindow();
    w.location.hash = "#token=lan-token";
    w.location.search = "?a=1";
    (globalThis as { window?: unknown }).window = w;
    configuredServer();
    expect(w.replaced).toEqual(["/?a=1"]);
  });

  test("a fragment may name a different server explicitly", () => {
    const w = fakeWindow();
    w.location.hash = "#server=ws%3A%2F%2F10.0.0.5%3A4762&token=t";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toEqual({
      url: "ws://10.0.0.5:4762",
      token: "t",
      source: "fragment",
    });
  });

  test("the embedded endpoint still wins over a fragment", () => {
    const w = fakeWindow();
    w.__GEAR_SERVE__ = { url: "ws://127.0.0.1:7788", token: "abc" };
    w.location.hash = "#token=zzz";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()?.source).toBe("embedded");
  });

  test("and the losing fragment is still taken out of the address bar", () => {
    // `gear` opens `…/#token=…` so the printed link also works pasted into a
    // second browser. On loopback the embedded token wins, and leaving the
    // fragment behind would park a live credential in this browser's history
    // for nothing.
    const w = fakeWindow();
    w.__GEAR_SERVE__ = { url: "ws://127.0.0.1:7788", token: "abc" };
    w.location.hash = "#token=zzz";
    (globalThis as { window?: unknown }).window = w;
    configuredServer();
    expect(w.replaced).toEqual(["/"]);
  });

  test("a fragment that is not a token is left alone", () => {
    const w = fakeWindow();
    w.__GEAR_SERVE__ = { url: "ws://127.0.0.1:7788", token: "abc" };
    w.location.hash = "#section-2";
    (globalThis as { window?: unknown }).window = w;
    configuredServer();
    expect(w.replaced).toEqual([]);
  });

  test("a fragment with no token is not an endpoint", () => {
    const w = fakeWindow();
    w.location.hash = "#section-2";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toBeNull();
  });
});

// ─── Recovering a restarted server ───
//
// `gear serve --web` mints a NEW token on every start, so a page holding the
// old one can retry forever against a door whose lock changed. A page the
// engine served can fix that by asking for itself again; a page whose token
// came from a pasted link cannot, because a reload loses the fragment.

describe("recovering a restarted server", () => {
  test("a page the engine served can reload for a fresh token", () => {
    expect(canReloadForToken("embedded")).toBe(true);
  });

  test("a pasted link cannot — the reload would lose the fragment", () => {
    expect(canReloadForToken("fragment")).toBe(false);
    expect(canReloadForToken("query")).toBe(false);
    expect(canReloadForToken("saved")).toBe(false);
    expect(canReloadForToken("env")).toBe(false);
    expect(canReloadForToken(null)).toBe(false);
  });
});
