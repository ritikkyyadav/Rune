import { expect, test } from "bun:test";
import {
  browserPreflightNote,
  browserUsable,
  NO_BROWSER_PREFLIGHT,
  probeBrowserRuntime,
  VisualVerification,
  visualChangedPaths,
} from "../../../packages/orchestrator/src/visual-verification";
import type { ToolCallOutput } from "../../../packages/tool-registry/src/types";
const output = (result = "ok", image = false): ToolCallOutput => ({
  callId: "c",
  toolName: "browser",
  success: true,
  result,
  durationMs: 1,
  ...(image
    ? {
        attachments: [{ kind: "image", label: "screen", mediaType: "image/png", data: "aGVsbG8=" }],
      }
    : {}),
});

test("only current workspace screenshots plus responsive and interaction receipts complete UI review", () => {
  const review = new VisualVerification("/workspace");
  review.changed();
  review.observe("bash", {}, output("Local: http://localhost:5173/"), true);
  review.observe("mcp_browser_browser_navigate", { url: "http://localhost:5173/" }, output(), true);
  review.observe("mcp_browser_browser_resize", { width: 1280 }, output(), true);
  review.observe("mcp_browser_browser_take_screenshot", {}, output("", true), true);
  review.observe("mcp_browser_browser_resize", { width: 390 }, output(), true);
  review.observe("mcp_browser_browser_click", {}, output(), true);
  review.observe(
    "mcp_browser_browser_snapshot",
    {},
    output("Page Snapshot:\n- button Save\n- heading Saved"),
    true,
  );
  expect(review.snapshot().status).toBe("reviewed");
  const restored = new VisualVerification("/workspace", review.snapshot());
  expect(restored.snapshot().status).toBe("reviewed");
  restored.changed();
  expect(restored.snapshot().status).toBe("pending");
  expect(restored.snapshot().captures).toHaveLength(0);
});

test("reference images, documentation, unknown localhost sites, and pre-edit screenshots do not satisfy the gate", () => {
  const review = new VisualVerification("/workspace");
  review.changed();
  expect(review.observe("read_file", { path: "reference.png" }, output("", true), true)).toBe(
    false,
  );
  review.observe(
    "mcp_browser_browser_navigate",
    { url: "https://docs.example.com" },
    output(),
    true,
  );
  expect(review.observe("mcp_browser_browser_take_screenshot", {}, output("", true), true)).toBe(
    false,
  );
  review.observe("mcp_browser_browser_navigate", { url: "http://localhost:9999" }, output(), true);
  expect(review.observe("mcp_browser_browser_take_screenshot", {}, output("", true), true)).toBe(
    false,
  );
  review.observe("bash", {}, output("http://localhost:9999"), true);
  expect(review.observe("mcp_browser_browser_take_screenshot", {}, output("", true), false)).toBe(
    false,
  );
  expect(
    review.observe("mcp_browser_browser_take_screenshot", {}, output("", true), true, true),
  ).toBe(false);
  expect(review.snapshot().captures).toHaveLength(0);
});

test("multi-file and delegated edits expose actual changed paths", () => {
  expect(
    visualChangedPaths(
      "apply_patch",
      { patch: "*** Begin Patch\n*** Update File: web/page.tsx\n*** End Patch" },
      output(),
    ),
  ).toEqual(["web/page.tsx"]);
  expect(
    visualChangedPaths("multi_edit", { edits: [{ path: "web/style.css" }] }, output()),
  ).toEqual(["web/style.css"]);
  expect(
    visualChangedPaths(
      "worker",
      { files: ["web/"] },
      { ...output(), structured: { filesChanged: ["web/page.tsx"] } },
    ),
  ).toEqual(["web/page.tsx"]);
});

test("without a browser, fetching the served page is the receipt, and the missing list says how to get pixels", () => {
  const review = new VisualVerification("/workspace", undefined, { browser: false });
  review.changed();
  expect(review.snapshot().status).toBe("pending");
  expect(review.snapshot().missing.join(" ")).toMatch(/no browser is mounted/);
  review.observe(
    "bash",
    { command: "bun run dev" },
    output("Local: http://localhost:5173/"),
    false,
  );
  expect(
    review.observe(
      "bash",
      { command: "curl -s http://localhost:5173/" },
      output("<!doctype html><html><body>hi</body></html>"),
      false,
    ),
  ).toBe(true);
  const done = review.snapshot();
  expect(done.status).toBe("pending");
  expect(done.missing.join(" ")).toContain("visual review is incomplete");
  expect(done.method).toBe("fetch");
  // Fetching a page the workspace did not serve proves nothing; neither does a non-HTML reply.
  const other = new VisualVerification("/workspace", undefined, { browser: false });
  other.changed();
  expect(
    other.observe(
      "bash",
      { command: "curl http://localhost:9999/" },
      output("<html></html>"),
      false,
    ),
  ).toBe(false);
  other.observe("bash", { command: "bun run dev" }, output("http://localhost:9999/"), false);
  expect(
    other.observe(
      "bash",
      { command: "curl http://localhost:9999/api" },
      output('{"ok":true}'),
      false,
    ),
  ).toBe(false);
  expect(other.snapshot().status).toBe("pending");
});

test("with a browser mounted, a fetch never stands in for the screenshot receipts", () => {
  const review = new VisualVerification("/workspace");
  review.changed();
  review.observe("bash", { command: "bun run dev" }, output("Local: http://localhost:5173/"), true);
  review.observe(
    "bash",
    { command: "curl -s http://localhost:5173/" },
    output("<html></html>"),
    true,
  );
  const state = review.snapshot();
  expect(state.status).toBe("pending");
  expect(state.method).toBe("browser");
  expect(state.missing.join(" ")).toMatch(/screenshot/);
});

// ─── Phase 5 F2: the pre-flight, and the origin refusal ───

test("a capture naming an origin the run never served is refused", () => {
  const review = new VisualVerification("/workspace");
  review.changed();
  // The run serves its own preview on 5173 and nothing else.
  review.observe("bash", {}, output("Local: http://localhost:5173/"), true);

  // A screenshot of a REMOTE page: not this workspace's.
  expect(
    review.observe(
      "mcp_browser_browser_navigate",
      { url: "https://example.com/dashboard" },
      output("Page URL: https://example.com/dashboard", true),
      true,
    ),
  ).toBe(false);
  // A screenshot of a DIFFERENT local port nobody in this run started: a
  // localhost URL is not a licence, only a URL this workspace printed is.
  expect(
    review.observe(
      "mcp_browser_browser_navigate",
      { url: "http://localhost:9999/" },
      output("Page URL: http://localhost:9999/", true),
      true,
    ),
  ).toBe(false);
  // A file: URL outside the workspace.
  expect(
    review.observe(
      "mcp_browser_browser_take_screenshot",
      {},
      output("Page URL: file:///etc/motd", true),
      true,
    ),
  ).toBe(false);
  expect(review.snapshot().captures).toHaveLength(0);
  expect(review.snapshot().status).toBe("pending");

  // The origin the run DID serve is accepted, so the refusals above are the
  // ownership rule and not a broken observer.
  expect(
    review.observe(
      "mcp_browser_browser_take_screenshot",
      {},
      output("Page URL: http://localhost:5173/", true),
      true,
    ),
  ).toBe(true);
});

test("the pre-flight note fires only for a frontend run with no browser", () => {
  expect(browserPreflightNote(true, false)).toBe(NO_BROWSER_PREFLIGHT);
  expect(browserPreflightNote(true, true)).toBeNull();
  expect(browserPreflightNote(false, false)).toBeNull();
  expect(browserPreflightNote(false, true)).toBeNull();
  expect(NO_BROWSER_PREFLIGHT).toContain("visual review will be a fetch, not a capture");
});

test("the browser runtime probe reports what it found, and never throws", () => {
  const probe = probeBrowserRuntime({}, "/nonexistent-home");
  expect(probe.browsersDir).toBeNull();
  expect(probe.chromium).toEqual([]);
  // An env-named module (how this repo's own browser tests find one) counts.
  const named = probeBrowserRuntime(
    { RUNE_TEST_PLAYWRIGHT: import.meta.path },
    "/nonexistent-home",
  );
  expect(named.playwrightModule).toBe(import.meta.path);
  expect(
    probeBrowserRuntime({ RUNE_TEST_PLAYWRIGHT: "/no/such/module.mjs" }, "").playwrightModule,
  ).not.toBe("/no/such/module.mjs");
});

// ─── A mounted browser that cannot launch (v7, lane F) ───
//
// The pre-flight had two states where the world has three. `@playwright/mcp`
// registers its tool list on handshake and only fails at LAUNCH time, so a
// machine with no downloaded Chromium mounts the tools and then fails every
// call. That run was told nothing, kept `method: "browser"`, and was asked at
// the finish gate for four receipts nothing in it could produce — the exact
// expensive discovery F2 was written to abolish, on the branch where the
// browser is nominally on.

const failed = (result: string): ToolCallOutput => ({
  callId: "c",
  toolName: "browser",
  success: false,
  result,
  durationMs: 1,
});

const LAUNCH_FAILED =
  "Error: browserType.launch: Executable doesn't exist at ~/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium";

test("a browser that mounted with nothing to launch is not a browser this run has", () => {
  const noChromium = { mcpModule: "x", playwrightModule: null, browsersDir: null, chromium: [] };
  expect(browserUsable(true, noChromium)).toMatchObject({ mounted: true, usable: false });
  expect(browserUsable(true, noChromium).reason).toContain("no Chromium");

  // Mounted with a Chromium, or with a Playwright this machine named itself
  // (the repo's own fixtures, and the frontend eval): taken at its word.
  expect(browserUsable(true, { ...noChromium, chromium: ["chromium-1243"] })).toMatchObject({
    usable: true,
  });
  expect(browserUsable(true, { ...noChromium, playwrightModule: "/p" })).toMatchObject({
    usable: true,
  });
  // Not mounted at all is still the plain case, with no reason to append.
  expect(browserUsable(false, noChromium)).toEqual({ mounted: false, usable: false });
});

test("the pre-flight says WHICH of the two it is, and stays silent when the browser works", () => {
  const broken = browserUsable(true, {
    mcpModule: "x",
    playwrightModule: null,
    browsersDir: null,
    chromium: [],
  });
  const note = browserPreflightNote(true, broken.usable, broken.reason);
  expect(note).toContain(NO_BROWSER_PREFLIGHT);
  expect(note).toContain("no Chromium");
  // The same sentence a run with no browser at all gets, unchanged.
  expect(browserPreflightNote(true, false)).toBe(NO_BROWSER_PREFLIGHT);
  // …and a backend run pays nothing for either.
  expect(browserPreflightNote(false, broken.usable, broken.reason)).toBeNull();
  expect(browserPreflightNote(true, true, undefined)).toBeNull();
});

test("a launch failure demotes the bar to the fetch this environment can do", () => {
  const visual = new VisualVerification("/tmp/ws", undefined, { browser: true });
  visual.changed();
  visual.observe(
    "mcp_browser_navigate",
    { url: "http://localhost:3000/" },
    failed(LAUNCH_FAILED),
    true,
  );
  const snapshot = visual.snapshot();

  expect(snapshot.method).toBe("fetch");
  expect(snapshot.missing.some((line) => /fetch the served page/.test(line))).toBe(true);
  expect(snapshot.missing.some((line) => /inspect a narrow viewport/.test(line))).toBe(false);
  expect(snapshot.missing.some((line) => /cannot launch/.test(line))).toBe(true);
  expect(snapshot.browserBroken).toContain("no Chromium to launch");
});

test("a failure about the PAGE is not a failure of the browser", () => {
  const visual = new VisualVerification("/tmp/ws", undefined, { browser: true });
  visual.changed();
  // A dev server that is not up yet, and a selector that matched nothing.
  visual.observe("mcp_browser_navigate", {}, failed("Error: net::ERR_CONNECTION_REFUSED"), true);
  visual.observe("mcp_browser_click", {}, failed('No element matches selector "#save"'), true);
  const snapshot = visual.snapshot();

  expect(snapshot.browserBroken).toBeUndefined();
  expect(snapshot.method).toBe("browser");
  expect(snapshot.missing.some((line) => /inspect a narrow viewport/.test(line))).toBe(true);
});

test("a real capture still outranks a later launch failure", () => {
  // Pixels are pixels: a run that already photographed the page is not demoted
  // because a later call could not start a second browser.
  const visual = new VisualVerification("/workspace", undefined, { browser: true });
  visual.changed();
  visual.observe("bash", { command: "npm run dev" }, output("http://localhost:5173/"), true);
  visual.observe(
    "mcp_browser_browser_take_screenshot",
    {},
    output("Page URL: http://localhost:5173/", true),
    true,
  );
  visual.observe("mcp_browser_navigate", {}, failed(LAUNCH_FAILED), true);
  expect(visual.snapshot().method).toBe("browser");
});
