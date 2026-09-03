// ─── What goes in the webview ───
//
// The extension does not reimplement the UI. It frames `gear web` — the same
// React bundle the desktop app runs, trace rail and all — and supplies the
// editor bindings around it. That is what makes this thin rather than a fourth
// client to maintain, and it is why the panel is an iframe rather than a chat
// box someone would have to keep in step with the protocol.

export interface PanelInput {
  /** `http://127.0.0.1:7788`. */
  pageUrl: string;
  token: string;
  /** A per-load nonce for the inline script. */
  nonce: string;
  /** `light` or `dark`, from the editor's theme. */
  theme: "light" | "dark";
}

/**
 * The frame URL.
 *
 * The token goes in the FRAGMENT. A fragment is never sent to the server, so
 * it cannot reach an access log, and it does not appear in any request line the
 * webview makes — the same rule `gear web --host` follows for a LAN link.
 * `?token=` would work and would put a credential for remote code execution
 * into a log for no benefit.
 */
export function frameUrl(pageUrl: string, token: string, theme: string): string {
  const base = pageUrl.replace(/\/+$/, "");
  return `${base}/#token=${encodeURIComponent(token)}&theme=${encodeURIComponent(theme)}`;
}

/**
 * The webview document.
 *
 * The CSP is the interesting part: `frame-src` is narrowed to the ONE origin we
 * are framing rather than to `http:`, so a webview that somehow navigated
 * elsewhere would be stopped rather than silently loading a different page with
 * the token in its URL.
 */
export function panelHtml(input: PanelInput): string {
  const origin = originOf(input.pageUrl);
  const src = frameUrl(input.pageUrl, input.token, input.theme);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${input.nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gear</title>
    <style>
      html, body { height: 100%; margin: 0; padding: 0; background: transparent; }
      iframe { border: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <iframe id="gear" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe>
    <script nonce="${input.nonce}">
      // The editor's own messages, forwarded into the page: a selection sent
      // from a file, a trace opened for one. The frame is same-origin with
      // nothing here, so this is postMessage and not DOM access.
      //
      // They are QUEUED until the page says it is listening. "Send selection to
      // Gear" with no panel open opens one and posts immediately, and a message
      // posted into a frame that is still loading is simply lost — which is
      // exactly what the command did before P10.6's live test caught it. The
      // page announces itself with \`gear.ready\` once its SOCKET is up — not
      // merely when its handler is attached, because a page whose transport is
      // still opening answers a selection with "still connecting" and drops it.
      //
      // The timer is the fallback for a \`gear.serverUrl\` pointing at an older
      // build whose bundle never sends \`gear.ready\`. Ten seconds, not two: it
      // must lose the race against any bundle that does send it.
      const frame = document.getElementById("gear");
      const origin = ${JSON.stringify(origin)};
      const queued = [];
      let ready = false;
      const flush = () => {
        if (ready) return;
        ready = true;
        for (const message of queued.splice(0)) frame.contentWindow?.postMessage(message, origin);
      };
      frame.addEventListener("load", () => setTimeout(flush, 10000));
      window.addEventListener("message", (event) => {
        if (!event.data || typeof event.data !== "object") return;
        if (event.origin === origin) {
          if (event.data.type === "gear.ready") flush();
          return; // the page talks to us; it is not a source of commands
        }
        if (ready) frame.contentWindow?.postMessage(event.data, origin);
        else queued.push(event.data);
      });
    </script>
  </body>
</html>`;
}

/** The page a webview shows when there is no engine to frame. */
export function unavailableHtml(reason: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <title>Gear</title>
    <style>
      body {
        font-family: var(--vscode-font-family); color: var(--vscode-foreground);
        padding: 24px; line-height: 1.5;
      }
      code { font-family: var(--vscode-editor-font-family); }
    </style>
  </head>
  <body>
    <p>${escapeText(reason)}</p>
    <p>Set <code>gear.path</code> if <code>gear</code> is not on your PATH, or point
    <code>gear.serverUrl</code> at a server you are already running.</p>
  </body>
</html>`;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "http://127.0.0.1";
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
