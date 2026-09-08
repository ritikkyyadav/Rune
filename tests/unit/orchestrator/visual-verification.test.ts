import { expect, test } from "bun:test";
import {
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
