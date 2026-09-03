// ─── Messages from the editor that framed this page ───
//
// The VS Code extension (`apps/vscode`) does not reimplement the UI. It hosts
// THIS bundle in a webview and supplies the editor bindings around it: "Send
// selection to Gear" and "Open trace for this file" turn what is on screen into
// a prompt and `postMessage` it into the frame.
//
// Until P10.6 nothing on this side listened. The extension shipped, packaged
// and unit-tested, posting into a page that had no `message` handler — the
// commands did nothing and no test anywhere would have noticed, because both
// halves were tested apart and never together. That is the whole point of the
// integration proof this file exists for.
//
// ── Why the origin check is not paranoia ──
//
// Any page you have open can frame `http://127.0.0.1:7788` and postMessage into
// it. It cannot READ anything back — the frame is cross-origin — but a blind
// write is enough to make a local agent run a prompt somebody else wrote. So
// the sender's origin must be an editor webview, which is the only host that is
// supposed to drive this page this way. `https://evil.example` framing the page
// gets nothing.

/** What an editor is allowed to ask this page to do. */
export interface HostPrompt {
  kind: "compose" | "trace";
  /** The prompt text the editor composed. */
  text: string;
}

/**
 * The schemes a webview host page is served from.
 *
 * VS Code renders webviews at `vscode-webview://<uuid>`; the desktop-Electron
 * variants use `vscode-file://`. Both are the editor itself. Everything else —
 * `http:`, `https:`, `file:` — is a page that merely found this URL.
 */
const HOST_SCHEMES = ["vscode-webview:", "vscode-file:"];

/** A prompt from a framing editor is not a place for a whole file. */
export const MAX_HOST_PROMPT = 8_000;

export function isHostOrigin(origin: string): boolean {
  // `new URL()` on "null" (a sandboxed frame's origin) throws, which is the
  // answer we want anyway.
  try {
    return HOST_SCHEMES.includes(new URL(origin).protocol);
  } catch {
    return false;
  }
}

/**
 * A `message` event, as a prompt to run — or null, which is most of them.
 *
 * Deliberately total and side-effect free so the rules are testable without a
 * browser: `tests/unit/web/host-message.test.ts` walks the refusals.
 */
export function hostPrompt(event: {
  origin?: unknown;
  source?: unknown;
  data?: unknown;
}): HostPrompt | null {
  // Only from the window that framed us. A message from a popup we opened, or
  // from this window to itself, is not an editor binding.
  const framedBy = topFrame();
  if (!framedBy || event.source !== framedBy) return null;

  if (typeof event.origin !== "string" || !isHostOrigin(event.origin)) return null;

  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const { type, text } = data as { type?: unknown; text?: unknown };
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOST_PROMPT) return null;

  if (type === "gear.compose") return { kind: "compose", text: trimmed };
  if (type === "gear.trace") return { kind: "trace", text: trimmed };
  return null;
}

/**
 * Tell the editor that framed us that this page is listening.
 *
 * "Send selection to Gear" with no panel open opens one and posts immediately,
 * into a frame that is still loading — the message is simply lost, which is
 * what the command did until P10.6. The host queues until it hears this.
 *
 * `"*"` as the target origin because the page cannot know the editor's webview
 * origin (a fresh uuid per session) and this message carries nothing: it is the
 * word "ready" and no more.
 */
export function announceReady(): void {
  const host = topFrame();
  if (!host) return;
  try {
    host.postMessage({ type: "gear.ready" }, "*");
  } catch {
    /* a sandbox that refuses postMessage: the host's timer covers it */
  }
}

/** The window that framed this one, or null when nothing did. */
function topFrame(): Window | null {
  try {
    return window.parent && window.parent !== window ? window.parent : null;
  } catch {
    // A cross-origin parent still compares by reference; only an exotic
    // sandbox reaches here, and "no host" is the safe reading of it.
    return null;
  }
}
