/**
 * `gear` opens the app — the entry, and the rule that decides it.
 *
 * The routing decision is the one change in Phase 9 that can annoy every
 * existing user at once: a bare `gear` used to mean "the terminal console" and
 * now means "the app". So `wantsConsole` is pinned case by case rather than
 * trusted, and the URL, the port choice and the browser rule are pinned beside
 * it — all without opening a window, a socket to a real engine, or a browser.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WEB_PORT,
  choosePort,
  freePort,
  liveServer,
  pageUrl,
  platformOpener,
  portAnswering,
  portFree,
  processAlive,
  serveLogPath,
  shouldOpenBrowser,
  wantsConsole,
} from "../../../packages/orchestrator/src/bin/app-cli";
import { serveConfigPath } from "../../../packages/orchestrator/src/bin/serve-cli";

let home: string;
let savedGearHome: string | undefined;

beforeEach(() => {
  savedGearHome = process.env.GEAR_HOME;
  home = mkdtempSync(join(tmpdir(), "gear-entry-test-"));
  process.env.GEAR_HOME = join(home, ".gear");
  mkdirSync(process.env.GEAR_HOME, { recursive: true });
});

afterEach(() => {
  if (savedGearHome === undefined) delete process.env.GEAR_HOME;
  else process.env.GEAR_HOME = savedGearHome;
  rmSync(home, { recursive: true, force: true });
});

const TOKEN = "t".repeat(43);

/**
 * An HTTP server on `port`, so `portAnswering` has something to answer it.
 *
 * HTTP and not a bare TCP listener on purpose: the probe asks for a response,
 * not a handshake, because "a port is open" and "the engine is there" are
 * different claims and only one of them is worth printing a URL for.
 */
function standIn(port: number): { stop: () => void } {
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  return { stop: () => server.stop(true) };
}

function writeServeJson(over: Record<string, unknown> = {}): void {
  writeFileSync(
    serveConfigPath(),
    JSON.stringify({
      token: TOKEN,
      createdAt: new Date().toISOString(),
      port: 7788,
      host: "127.0.0.1",
      allowRemoteSettings: false,
      origins: [],
      pid: process.pid,
      workspace: "/tmp/ws",
      web: true,
      ...over,
    }),
  );
}

// ─── The routing rule ───

describe("what a bare `gear` means", () => {
  test("nothing at all is the app", () => {
    expect(wantsConsole({}, [])).toBe(false);
  });

  test("--console and its aliases are the console", () => {
    expect(wantsConsole({ console: true }, [])).toBe(true);
    expect(wantsConsole({ tui: true }, [])).toBe(true);
    expect(wantsConsole({ classic: true }, [])).toBe(true);
  });

  test("layout flags only a terminal has are the console", () => {
    // Someone who typed `--inline` is describing a scrollback, which a browser
    // tab does not have. Opening one would be answering a different question.
    expect(wantsConsole({ inline: true }, [])).toBe(true);
    expect(wantsConsole({ fullscreen: true }, [])).toBe(true);
    expect(wantsConsole({ pristine: true }, [])).toBe(true);
  });

  test("a headless prompt is the console, never a browser", () => {
    // `gear -P "..." --stream-json` is what CI runs. Opening a tab there would
    // be a program hijacking a machine that may not even have a desktop.
    expect(wantsConsole({ print: "do the thing" }, [])).toBe(true);
    expect(wantsConsole({ "stream-json": true }, [])).toBe(true);
  });

  test("resuming, listing or forcing a new session is the console", () => {
    expect(wantsConsole({ resume: "abc" }, [])).toBe(true);
    expect(wantsConsole({ list: true }, [])).toBe(true);
    expect(wantsConsole({ new: true }, [])).toBe(true);
  });

  test("any subcommand is the console's business, not the entry's", () => {
    expect(wantsConsole({}, ["doctor"])).toBe(true);
    expect(wantsConsole({}, ["chat"])).toBe(true);
  });

  test("a workspace or a model is still a bare gear", () => {
    // `gear -w ~/project` and `gear -m sonnet` describe the session the app is
    // about to open, not a request for a terminal.
    expect(wantsConsole({ workspace: "/tmp/x" }, [])).toBe(false);
    expect(wantsConsole({ model: "sonnet", provider: "anthropic" }, [])).toBe(false);
    expect(wantsConsole({ gear: "3" }, [])).toBe(false);
  });

  test("the flags parseArgs defaults to false do not force the console", () => {
    // Every boolean in the option table arrives as `false` rather than absent,
    // so a rule written with truthiness instead of `=== true` would send every
    // invocation to the console and the app would never open.
    expect(
      wantsConsole(
        {
          console: false,
          tui: false,
          classic: false,
          inline: false,
          fullscreen: false,
          pristine: false,
          new: false,
          list: false,
          "stream-json": false,
        },
        [],
      ),
    ).toBe(false);
  });
});

// ─── The browser rule ───

describe("when a browser is opened", () => {
  test("a terminal with no override opens one", () => {
    expect(shouldOpenBrowser({ env: {}, isTty: true })).toBe(true);
  });

  test("no tty never opens one", () => {
    // A pipe, a cron job, a CI step, a container with no desktop.
    expect(shouldOpenBrowser({ env: {}, isTty: false })).toBe(false);
  });

  test("GEAR_NO_BROWSER=1 never opens one", () => {
    expect(shouldOpenBrowser({ env: { GEAR_NO_BROWSER: "1" }, isTty: true })).toBe(false);
  });

  test("GEAR_NO_BROWSER=0 and =false are not the off switch", () => {
    // An env var set to a falsey word is a person who meant "no, don't do that
    // thing" about the OTHER thing. Treating it as on would be a trap.
    expect(shouldOpenBrowser({ env: { GEAR_NO_BROWSER: "0" }, isTty: true })).toBe(true);
    expect(shouldOpenBrowser({ env: { GEAR_NO_BROWSER: "false" }, isTty: true })).toBe(true);
  });

  test("--no-browser wins over everything", () => {
    expect(shouldOpenBrowser({ env: {}, isTty: true, noBrowser: true })).toBe(false);
  });
});

describe("the platform opener", () => {
  test("macOS uses open, Linux uses xdg-open, Windows uses start", () => {
    expect(platformOpener("darwin")).toEqual({ cmd: "open", args: [] });
    expect(platformOpener("linux")).toEqual({ cmd: "xdg-open", args: [] });
    // `start` is a cmd.exe builtin, and its first argument is a window title —
    // omitting the empty string makes Windows swallow the URL as the title and
    // open a console instead of a browser.
    expect(platformOpener("win32")).toEqual({ cmd: "cmd", args: ["/c", "start", ""] });
  });

  test("an unknown platform falls back to the freedesktop opener", () => {
    expect(platformOpener("freebsd").cmd).toBe("xdg-open");
  });
});

// ─── The URL ───

describe("the page URL", () => {
  test("carries the token in the fragment, never the query", () => {
    // A fragment is not sent to the server, so it cannot land in an access log,
    // a proxy log or a Referer. A `?token=` for the same job would.
    const url = pageUrl(7788, TOKEN);
    expect(url).toBe(`http://127.0.0.1:7788/#token=${TOKEN}`);
    expect(url).not.toContain("?");
  });

  test("names a host that can actually be dialled", () => {
    expect(pageUrl(4762, TOKEN, "192.168.1.9")).toStartWith("http://192.168.1.9:4762/");
  });
});

// ─── Finding a server ───

describe("the server this user already has", () => {
  test("no config is no server", async () => {
    expect(await liveServer()).toBeNull();
  });

  test("a config whose pid is gone is a stale file, not a server", async () => {
    // The exact case a killed process leaves behind. Trusting the file here
    // would print a URL that answers nothing.
    writeServeJson({ pid: 999_999 });
    expect(await liveServer()).toBeNull();
  });

  test("a live pid whose port answers nothing is not a server either", async () => {
    // This pid is alive (it is the test runner) and the port is closed, which
    // is the second half of the check and the half a pid-only test would miss.
    const dead = await freePort();
    writeServeJson({ port: dead });
    expect(await liveServer()).toBeNull();
  });

  test("a live pid on an answering port is the server, with its page URL", async () => {
    const port = await freePort();
    const listener = standIn(port);
    try {
      writeServeJson({ port });
      const live = await liveServer();
      expect(live?.config.port).toBe(port);
      expect(live?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(live?.page).toBe(`http://127.0.0.1:${port}/#token=${TOKEN}`);
      expect(live?.config.workspace).toBe("/tmp/ws");
    } finally {
      listener.stop();
    }
  });

  test("a 0.0.0.0 bind is dialled on loopback, because nothing can dial 0.0.0.0", async () => {
    const port = await freePort();
    const listener = standIn(port);
    try {
      writeServeJson({ port, host: "0.0.0.0" });
      expect((await liveServer())?.page).toContain("http://127.0.0.1:");
    } finally {
      listener.stop();
    }
  });
});

// ─── The port ───

describe("the port is stable per user", () => {
  test("nothing recorded means the app's default", async () => {
    const chosen = await choosePort(undefined);
    // Either the default is free and we get it, or something else has it and we
    // get a free one — never a failure.
    expect(chosen === DEFAULT_WEB_PORT || chosen > 0).toBe(true);
  });

  test("a recorded free port is reused, so yesterday's bookmark still works", async () => {
    const port = await freePort();
    expect(await choosePort(port)).toBe(port);
  });

  test("a recorded port somebody else took yields a different free one", async () => {
    const port = await freePort();
    const squatter = standIn(port);
    try {
      const chosen = await choosePort(port);
      expect(chosen).not.toBe(port);
      expect(chosen).toBeGreaterThan(0);
    } finally {
      squatter.stop();
    }
  });
});

describe("the probes the entry is built on", () => {
  test("a closed port neither answers nor is taken", async () => {
    const port = await freePort();
    expect(await portAnswering(port)).toBe(false);
    expect(await portFree(port)).toBe(true);
  });

  test("an open port answers and is not free", async () => {
    const port = await freePort();
    const listener = standIn(port);
    try {
      expect(await portAnswering(port)).toBe(true);
      expect(await portFree(port)).toBe(false);
    } finally {
      listener.stop();
    }
  });

  test("processAlive is true for this process and false for nonsense", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(999_999)).toBe(false);
  });
});

test("the spawned server's output has somewhere to go", () => {
  // A detached server with stdio to /dev/null is a start failure nobody can
  // diagnose. It writes to a file in the gear home instead, and the failure
  // message names that file.
  expect(serveLogPath()).toBe(join(process.env.GEAR_HOME!, "serve.log"));
});
