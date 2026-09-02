/**
 * `gear desktop` — the launcher, and the transport choice it feeds.
 *
 * The desktop's standing defect was not a rendering bug: the app read
 * `~/.gear/desktop.json` to find the engine and nothing in the repository ever
 * wrote it. These tests hold the two halves of the fix — the pointer this
 * command writes, and the rule that decides which transport the bundle uses —
 * without needing a window or a running engine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  desktopPointerPath,
  engineRoot,
  readDesktopPointer,
  serveEndpoint,
  writeDesktopPointer,
} from "../../../packages/orchestrator/src/bin/desktop-cli";
import { configuredServer } from "../../../apps/desktop/src/lib/transport";

let home: string;
let savedHome: string | undefined;
let savedGearHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedGearHome = process.env.GEAR_HOME;
  home = mkdtempSync(join(tmpdir(), "gear-desktop-test-"));
  process.env.GEAR_HOME = join(home, ".gear");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedGearHome === undefined) delete process.env.GEAR_HOME;
  else process.env.GEAR_HOME = savedGearHome;
  delete process.env.GEAR_SERVE_URL;
  delete process.env.GEAR_SERVE_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe("gear desktop — the engine pointer", () => {
  test("writes the file lib.rs reads, with an absolute engine root", () => {
    const { pointer, written } = writeDesktopPointer();
    expect(written).toBe(true);
    const onDisk = JSON.parse(readFileSync(desktopPointerPath(), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.gearRoot).toBe(pointer.gearRoot);
    expect(String(onDisk.gearRoot).startsWith("/")).toBe(true);
    expect(onDisk.writtenBy).toBe("gear desktop");
  });

  test("carries alanRoot so a pre-rename binary still resolves", () => {
    // `lib.rs` reads `gearRoot` and falls back to `alanRoot`. An app bundle
    // built before the rename is still in someone's Applications folder.
    const { pointer } = writeDesktopPointer();
    expect(pointer.alanRoot).toBe(pointer.gearRoot);
  });

  test("names a bun and a tools binary, never an empty string", () => {
    const { pointer } = writeDesktopPointer();
    expect(pointer.bun.length).toBeGreaterThan(0);
    expect(pointer.toolsBin.length).toBeGreaterThan(0);
  });

  test("the engine root it records contains the engine host it points at", () => {
    const root = engineRoot();
    expect(
      Bun.file(join(root, "packages", "orchestrator", "src", "bin", "engine-host.ts")).size,
    ).toBeGreaterThan(0);
  });

  test("re-reads what it wrote", () => {
    const { pointer } = writeDesktopPointer();
    expect(readDesktopPointer()?.gearRoot).toBe(pointer.gearRoot);
  });

  test("a missing pointer reads as null, not a throw", () => {
    expect(readDesktopPointer()).toBeNull();
  });
});

describe("gear desktop — the serve endpoint", () => {
  test("no serve config and no environment means no endpoint", () => {
    expect(serveEndpoint()).toBeNull();
  });

  test("GEAR_SERVE_URL + token wins without touching the config file", () => {
    process.env.GEAR_SERVE_URL = "ws://127.0.0.1:9999";
    process.env.GEAR_SERVE_TOKEN = "t".repeat(43);
    expect(serveEndpoint()).toEqual({ url: "ws://127.0.0.1:9999", token: "t".repeat(43) });
  });

  test("a URL with no token is not an endpoint", () => {
    // Half a credential is not a credential: `gear serve` refuses an
    // unauthenticated connection, so offering one would only produce a 401.
    process.env.GEAR_SERVE_URL = "ws://127.0.0.1:9999";
    expect(serveEndpoint()).toBeNull();
  });
});

// ─── The transport choice, as the bundle makes it ───
//
// `configuredServer()` runs in the page. These tests stand up the three things
// it reads — the embedded object `gear web` injects, the query string, and
// localStorage — and assert the precedence, because getting it backwards means
// a page served by `gear web` would try to drive somebody else's engine.

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

  test("the embedded endpoint gear web injects wins", () => {
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
    // One port, one origin: `gear web` serves the page and the socket from the
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

  test("a fragment with no token is not an endpoint", () => {
    const w = fakeWindow();
    w.location.hash = "#section-2";
    (globalThis as { window?: unknown }).window = w;
    expect(configuredServer()).toBeNull();
  });
});
