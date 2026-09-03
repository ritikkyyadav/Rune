/**
 * The VS Code extension, minus VS Code.
 *
 * Every decision the extension makes lives in a module that imports nothing
 * from the editor, and this is why: an extension whose logic sits inside
 * `vscode` callbacks can only be tested by launching VS Code, which is why so
 * many of them are not tested at all.
 *
 * `extension.ts` is the one file that imports `vscode`, and it is wiring.
 */

import { describe, expect, test } from "bun:test";

import {
  endpointFromConfigFile,
  endpointFromSetting,
  isLoopback,
  listeningPort,
  spawnCommand,
} from "../../../apps/vscode/src/serve";
import { frameUrl, originOf, panelHtml, unavailableHtml } from "../../../apps/vscode/src/panel";
import {
  MAX_INLINE_SELECTION,
  relativePath,
  selectionMessage,
  traceMessage,
} from "../../../apps/vscode/src/editor";
import { formatCost, statusText, statusTooltip } from "../../../apps/vscode/src/status";

describe("finding an engine", () => {
  test("reads a running server out of serve.json", () => {
    expect(endpointFromConfigFile({ token: "t", port: 7788, host: "127.0.0.1" })).toEqual({
      pageUrl: "http://127.0.0.1:7788",
      token: "t",
      source: "running",
    });
  });

  test("dials loopback for a server bound to the wildcard", () => {
    // `http://0.0.0.0:7788` is not a URL anything should be handed.
    expect(endpointFromConfigFile({ token: "t", port: 7788, host: "0.0.0.0" })?.pageUrl).toBe(
      "http://127.0.0.1:7788",
    );
  });

  test("half a config file is no endpoint", () => {
    expect(endpointFromConfigFile({ port: 7788 })).toBeNull();
    expect(endpointFromConfigFile({ token: "t" })).toBeNull();
    expect(endpointFromConfigFile(null)).toBeNull();
  });

  test("a configured URL needs a token from somewhere", () => {
    const local = { pageUrl: "http://127.0.0.1:7788", token: "local", source: "running" } as const;
    // From SecretStorage.
    expect(endpointFromSetting("http://10.0.0.5:7788", "secret", null)).toEqual({
      pageUrl: "http://10.0.0.5:7788",
      token: "secret",
      source: "configured",
    });
    // Or from the local serve file, but only when the URL is this machine.
    expect(endpointFromSetting("http://127.0.0.1:7788", undefined, local)?.token).toBe("local");
    // A token minted here is not a credential for someone else's server.
    expect(endpointFromSetting("http://10.0.0.5:7788", undefined, local)).toBeNull();
    expect(endpointFromSetting(undefined, "secret", local)).toBeNull();
  });

  test("a trailing slash in the setting does not become a double slash later", () => {
    expect(endpointFromSetting("http://127.0.0.1:7788/", "t", null)?.pageUrl).toBe(
      "http://127.0.0.1:7788",
    );
  });

  test("knows loopback from a LAN address", () => {
    for (const u of ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1"]) {
      expect(isLoopback(u)).toBe(true);
    }
    expect(isLoopback("http://10.0.0.5:1")).toBe(false);
    expect(isLoopback("nonsense")).toBe(false);
  });

  test("spawns the page as well as the socket", () => {
    // `--web`, not bare `serve`: the extension hosts Gear's own client, which
    // is the only reason a thin extension beats a chat box.
    expect(spawnCommand("gear", "/w", 7788)).toEqual([
      "gear",
      "serve",
      "--web",
      "--port",
      "7788",
      "--workspace",
      "/w",
    ]);
  });

  test("reads the bound port off the banner", () => {
    // Watching stdout rather than polling: a port that accepts a connection
    // before the host pool is ready gives the webview a 500 on first load.
    expect(listeningPort("  listening  ws://127.0.0.1:7788")).toBe(7788);
    expect(listeningPort("  listening  wss://10.0.0.5:4762")).toBe(4762);
    expect(listeningPort("  workspace  /somewhere")).toBeNull();
  });
});

describe("the webview", () => {
  test("puts the token in the fragment, never the query", () => {
    const url = frameUrl("http://127.0.0.1:7788", "tok en", "dark");
    expect(url).toBe("http://127.0.0.1:7788/#token=tok%20en&theme=dark");
    expect(url).not.toContain("?token=");
  });

  test("narrows frame-src to the one origin it is framing", () => {
    const html = panelHtml({
      pageUrl: "http://127.0.0.1:7788",
      token: "t",
      nonce: "abc",
      theme: "dark",
    });
    expect(html).toContain("frame-src http://127.0.0.1:7788;");
    expect(html).toContain("default-src 'none'");
    // A nonce, not 'unsafe-inline': the inline script is ours and named.
    expect(html).toContain("script-src 'nonce-abc'");
    expect(html).not.toContain("script-src 'unsafe-inline'");
  });

  test("escapes what it puts in the iframe's src", () => {
    const html = panelHtml({
      pageUrl: "http://127.0.0.1:7788",
      token: '"><script>x</script>',
      nonce: "n",
      theme: "light",
    });
    expect(html).not.toContain('"><script>x');
  });

  test("holds a posted selection until the page says its socket is up", () => {
    // The defect P10.6's live test found. "Send selection to Gear" with no
    // panel open opens one and posts at once, into a frame that is still
    // loading — and a message posted into a loading frame is simply gone.
    const html = panelHtml({
      pageUrl: "http://127.0.0.1:7788",
      token: "t",
      nonce: "n",
      theme: "dark",
    });
    expect(html).toContain("const queued = []");
    expect(html).toContain('event.data.type === "gear.ready"');
    // The page's own messages are a handshake, not a source of commands: they
    // must never be forwarded back into the frame as if the editor sent them.
    expect(html).toContain("if (event.origin === origin)");
    // …and a bundle too old to send `gear.ready` still gets it eventually.
    expect(html).toContain('frame.addEventListener("load"');
  });

  test("says why when there is no engine, instead of showing a blank panel", () => {
    const html = unavailableHtml("gear serve exited with code 127", "n");
    expect(html).toContain("gear serve exited with code 127");
    expect(html).toContain("gear.path");
  });

  test("falls back to loopback rather than throwing on a broken URL", () => {
    expect(originOf("http://127.0.0.1:7788/x")).toBe("http://127.0.0.1:7788");
    expect(originOf("not a url")).toBe("http://127.0.0.1");
  });
});

describe("what a selection becomes", () => {
  const base = { path: "src/app.ts", startLine: 10, endLine: 12, languageId: "typescript" };

  test("leads with the location, then the excerpt", () => {
    const msg = selectionMessage({ ...base, text: "const x = 1;" });
    expect(msg).toStartWith("From src/app.ts:10-12:");
    expect(msg).toContain("```typescript\nconst x = 1;\n```");
  });

  test("a one-line selection is one line number", () => {
    const msg = selectionMessage({ ...base, startLine: 10, endLine: 10, text: "x" });
    expect(msg).toContain("src/app.ts:10:");
    expect(msg).not.toContain("10-10");
  });

  test("an empty selection is still a place to look", () => {
    expect(selectionMessage({ ...base, text: "   " })).toBe("Look at src/app.ts:10-12.");
  });

  test("a huge selection is a pointer, not a paste", () => {
    // A whole file in a prompt is a context bill before the agent has decided
    // it needs any of it, and it has tools for reading files.
    const msg = selectionMessage({ ...base, text: "x".repeat(MAX_INLINE_SELECTION + 1) });
    expect(msg).toContain("read it from the file");
    expect(msg).not.toContain("```");
  });

  test("a note goes in front of the location", () => {
    expect(selectionMessage({ ...base, text: "x" }, "why is this slow?")).toStartWith(
      "why is this slow?\n\nFrom src/app.ts",
    );
  });

  test("the trace message names the file", () => {
    expect(traceMessage("src/app.ts")).toContain("src/app.ts");
  });

  test("paths are workspace-relative when they can be", () => {
    expect(relativePath("/w/src/app.ts", "/w")).toBe("src/app.ts");
    expect(relativePath("/w/src/app.ts", "/w/")).toBe("src/app.ts");
    // A file outside the workspace keeps its absolute path rather than a
    // relative one that resolves somewhere else.
    expect(relativePath("/elsewhere/app.ts", "/w")).toBe("/elsewhere/app.ts");
    expect(relativePath("/w/src/app.ts", undefined)).toBe("/w/src/app.ts");
  });
});

describe("the status bar", () => {
  test("says disconnected when it is", () => {
    expect(statusText(null)).toContain("debug-disconnect");
    expect(statusText({ connected: false })).toContain("debug-disconnect");
  });

  test("shows the gear and the cost", () => {
    expect(statusText({ connected: true, gear: 3, costUsd: 1.234 })).toBe("$(gear) gear 3 · $1.23");
  });

  test("no cost data shows NOTHING, not zero", () => {
    // Rule 9: a number on screen comes from real data. `$0.00` is a claim that
    // the run was free, and a status bar is read at a glance and believed.
    expect(statusText({ connected: true, gear: "auto", costUsd: null })).toBe("$(gear) gear auto");
    expect(statusTooltip({ connected: true, gear: 3, costUsd: null })).toContain(
      "no cost recorded yet",
    );
  });

  test("sub-cent amounts get the precision that makes them a number", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(0.512)).toBe("$0.512");
    expect(formatCost(12.5)).toBe("$12.50");
  });
});
