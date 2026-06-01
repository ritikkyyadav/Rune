import { describe, test, expect, afterEach } from "bun:test";
import { createWebFetchHandler } from "../../../packages/tool-registry/src/tools/web-fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(opts: { status?: number; contentType?: string; body: string }): void {
  globalThis.fetch = (async () => {
    const status = opts.status ?? 200;
    const bytes = new TextEncoder().encode(opts.body);
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: "Status",
      headers: {
        get: (h: string) =>
          h.toLowerCase() === "content-type" ? (opts.contentType ?? "text/html") : null,
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }) as typeof fetch;
}

const input = (args: Record<string, unknown>) => ({
  toolName: "web_fetch",
  callId: "c1",
  sessionId: "s1",
  workspaceRoot: "/tmp",
  args,
});

const ARTICLE_HTML = `<!doctype html><html><head><title>Doc Title</title></head>
<body><nav>navigation junk links</nav>
<article><h1>Main Heading</h1>
<p>This is the <b>main</b> content with a <a href="https://x.com">link</a>.</p>
<ul><li>one</li><li>two</li></ul></article>
<footer>footer junk text</footer></body></html>`;

describe("createWebFetchHandler", () => {
  const handler = createWebFetchHandler();

  test("schema is a confirm-level network tool", () => {
    expect(handler.schema.name).toBe("web_fetch");
    expect(handler.schema.permissionLevel).toBe("confirm");
    expect(handler.schema.category).toBe("network");
  });

  test("extracts readable markdown from HTML and drops chrome", async () => {
    mockFetch({ contentType: "text/html; charset=utf-8", body: ARTICLE_HTML });
    const out = await handler.execute(input({ url: "https://x.com/article" }));
    expect(out.success).toBe(true);
    const r = JSON.parse(out.result);
    expect(r.markdown).toContain("Main Heading");
    expect(r.markdown).toContain("main");
    expect(r.markdown).toContain("[link](https://x.com)");
    // Readability strips nav/footer chrome.
    expect(r.markdown).not.toContain("navigation junk");
    expect(r.markdown).not.toContain("footer junk");
  });

  test("returns non-HTML content as-is", async () => {
    mockFetch({ contentType: "application/json", body: `{"a":1,"b":2}` });
    const out = await handler.execute(input({ url: "https://x.com/data.json" }));
    expect(out.success).toBe(true);
    const r = JSON.parse(out.result);
    expect(r.markdown).toContain(`"a":1`);
  });

  test("HTTP error → success:false", async () => {
    mockFetch({ status: 404, body: "nope" });
    const out = await handler.execute(input({ url: "https://x.com/missing" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("404");
  });

  test("validate rejects non-http URLs", () => {
    expect(handler.validate({ url: "ftp://x" }).valid).toBe(false);
    expect(handler.validate({ url: "not a url" }).valid).toBe(false);
    expect(handler.validate({ url: "https://x.com" }).valid).toBe(true);
  });
});
