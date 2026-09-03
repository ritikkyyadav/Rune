/**
 * What the page accepts from the editor that framed it.
 *
 * The VS Code extension posts a composed prompt into the webview's iframe. The
 * rule that matters is the refusal: any page you have open can frame
 * `http://127.0.0.1:7788` and postMessage into it, and while it cannot read
 * anything back, a blind write is enough to make a local agent run a prompt
 * somebody else wrote. Only an editor webview origin is a host.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MAX_HOST_PROMPT, hostPrompt, isHostOrigin } from "../../../apps/web/src/lib/host";

const HOST = { name: "the editor" } as unknown as Window;
const SELF = { name: "the page" } as unknown as Window;

/** A page framed by `parent`, or standalone when parent is the window itself. */
function framedBy(parent: Window): void {
  (globalThis as { window?: unknown }).window = { parent, self: SELF };
}

beforeEach(() => framedBy(HOST));
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const compose = (over: Record<string, unknown> = {}): Parameters<typeof hostPrompt>[0] => ({
  origin: "vscode-webview://1f0e3dad",
  source: HOST,
  data: { type: "gear.compose", text: "From src/app.ts:10-12:\n\n```ts\nconst x = 1;\n```" },
  ...over,
});

describe("isHostOrigin", () => {
  test.each([
    ["vscode-webview://1f0e3dad", true],
    ["vscode-file://vscode-app", true],
    ["https://evil.example.com", false],
    ["http://127.0.0.1:7788", false],
    ["file://", false],
    ["null", false],
    ["", false],
  ])("%s → %s", (origin, allowed) => {
    expect(isHostOrigin(origin)).toBe(allowed);
  });
});

describe("hostPrompt", () => {
  test("a selection from the editor webview becomes a prompt", () => {
    expect(hostPrompt(compose())).toEqual({
      kind: "compose",
      text: "From src/app.ts:10-12:\n\n```ts\nconst x = 1;\n```",
    });
  });

  test("an open-trace message is the other binding", () => {
    const prompt = hostPrompt(
      compose({ data: { type: "gear.trace", text: "Show the trace for src/app.ts" } }),
    );
    expect(prompt?.kind).toBe("trace");
  });

  test("a page that merely framed us is refused, whatever it says", () => {
    // The reason this check exists. The message is byte-identical to a real
    // one; only the origin differs.
    expect(hostPrompt(compose({ origin: "https://evil.example.com" }))).toBeNull();
    expect(hostPrompt(compose({ origin: "http://127.0.0.1:7788" }))).toBeNull();
  });

  test("a message from anything but the framing window is refused", () => {
    expect(hostPrompt(compose({ source: SELF }))).toBeNull();
    expect(hostPrompt(compose({ source: { other: true } }))).toBeNull();
  });

  test("an unframed page has no host and accepts nothing", () => {
    // `gear web` opened directly in a browser: window.parent IS window, so
    // there is no editor and nothing may drive the page this way.
    const top: { parent?: unknown } = {};
    top.parent = top;
    (globalThis as { window?: unknown }).window = top;
    expect(hostPrompt(compose({ source: top }))).toBeNull();
  });

  test("a message type nobody defined is refused", () => {
    expect(hostPrompt(compose({ data: { type: "gear.exfiltrate", text: "hi" } }))).toBeNull();
    expect(hostPrompt(compose({ data: { text: "hi" } }))).toBeNull();
    expect(hostPrompt(compose({ data: "gear.compose" }))).toBeNull();
    expect(hostPrompt(compose({ data: null }))).toBeNull();
  });

  test("empty and oversized prompts are refused", () => {
    expect(hostPrompt(compose({ data: { type: "gear.compose", text: "   " } }))).toBeNull();
    const huge = "x".repeat(MAX_HOST_PROMPT + 1);
    expect(hostPrompt(compose({ data: { type: "gear.compose", text: huge } }))).toBeNull();
    // …and one that just fits is not.
    const fits = "x".repeat(MAX_HOST_PROMPT);
    expect(hostPrompt(compose({ data: { type: "gear.compose", text: fits } }))?.text).toBe(fits);
  });
});
