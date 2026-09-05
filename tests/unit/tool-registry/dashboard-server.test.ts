/**
 * DashboardManager — the loopback SSE server behind interactive_dashboard.
 * Real HTTP against 127.0.0.1: page shell, token guard, vendored Chart.js,
 * live data pushes, html reloads, watch-file streaming, workspace confinement.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardManager } from "../../../packages/tool-registry/src/tools/dashboard";

process.env.RUNE_NO_OPEN = "1";

const managers: DashboardManager[] = [];

function makeManager(opts: { watchIntervalMs?: number } = {}): DashboardManager {
  const m = new DashboardManager({ openInBrowser: false, ...opts });
  managers.push(m);
  return m;
}

afterEach(() => {
  for (const m of managers.splice(0)) m.closeAll();
});

function ws(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "dash-ws-")));
}

/**
 * Read an SSE stream until `until(buffer)` is true (or timeout). `after`
 * fires once the stream is connected — the place to trigger an update.
 */
async function readSse(
  url: string,
  until: (buf: string) => boolean,
  after?: () => void,
  timeoutMs = 4000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let buf = "";
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fired = false;
    while (!until(buf)) {
      if (!fired) {
        fired = true;
        after?.();
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return buf;
}

describe("DashboardManager — pages & token guard", () => {
  test("create serves a wrapped page with title, content, data, and live bootstrap", async () => {
    const m = makeManager();
    const info = await m.create({
      title: "GPU Overview",
      html: `<div id="root"></div><script>window.render = (d) => { document.getElementById("root").textContent = d.gpus; };</script>`,
      data: { gpus: 24 },
      workspaceRoot: ws(),
      open: false,
    });

    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}\/d\/[0-9a-f]{8}$/);

    const res = await fetch(info.url);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");

    const page = await res.text();
    expect(page).toContain("<title>GPU Overview</title>");
    expect(page).toContain('<div id="root">');
    expect(page).toContain('window.__RUNE_DATA__ = {"gpus":24}');
    expect(page).toContain("EventSource");
    expect(page).toContain("/vendor/chart.umd.js");
  });

  test("wrong token and unknown id 404", async () => {
    const m = makeManager();
    const info = await m.create({ title: "t", html: "<div/>", workspaceRoot: ws(), open: false });
    const badToken = info.url.replace(/\/t\/[0-9a-f]{32}\//, "/t/" + "0".repeat(32) + "/");
    expect((await fetch(badToken)).status).toBe(404);
    const badId = info.url.replace(/[0-9a-f]{8}$/, "deadbeef");
    expect((await fetch(badId)).status).toBe(404);
  });

  test("vendored Chart.js is served from the token path", async () => {
    const m = makeManager();
    const info = await m.create({ title: "t", html: "<div/>", workspaceRoot: ws(), open: false });
    const vendor = info.url.replace(/\/d\/[0-9a-f]{8}$/, "/vendor/chart.umd.js");
    const res = await fetch(vendor);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Chart.js v4.4.9");
    expect(body.length).toBeGreaterThan(100_000);
  });

  test("html titles are escaped; data is script-safe", async () => {
    const m = makeManager();
    const info = await m.create({
      title: `<script>alert(1)</script>`,
      html: "<div/>",
      data: { s: "</script><script>alert(2)</script>" },
      workspaceRoot: ws(),
      open: false,
    });
    const page = await (await fetch(info.url)).text();
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("</script><script>alert(2)");
    expect(page).toContain("\\u003c/script>"); // JSON-escaped, inert
  });

  test("full-document html keeps its shell but gains the live bootstrap", async () => {
    const m = makeManager();
    const info = await m.create({
      title: "t",
      html: "<!doctype html><html><head><title>Mine</title></head><body><h1>x</h1></body></html>",
      workspaceRoot: ws(),
      open: false,
    });
    const page = await (await fetch(info.url)).text();
    expect(page).toContain("<title>Mine</title>");
    expect(page).toContain("EventSource"); // injected before </body>
    expect(page.indexOf("EventSource")).toBeLessThan(page.indexOf("</body>"));
  });

  test("close stops serving; closeAll shuts the server down", async () => {
    const m = makeManager();
    const info = await m.create({ title: "t", html: "<div/>", workspaceRoot: ws(), open: false });
    expect(m.close(info.id)).toBe(true);
    expect((await fetch(info.url)).status).toBe(404);
    expect(m.close(info.id)).toBe(false);
    m.closeAll(); // idempotent, no throw
  });

  test("last() tracks the most recent dashboard", async () => {
    const m = makeManager();
    expect(m.last()).toBeNull();
    await m.create({ title: "a", html: "<div/>", workspaceRoot: ws(), open: false });
    const b = await m.create({ title: "b", html: "<div/>", workspaceRoot: ws(), open: false });
    expect(m.last()?.id).toBe(b.id);
    expect(m.list().length).toBe(2);
  });
});

describe("DashboardManager — live updates over SSE", () => {
  test("update(data) pushes an SSE data event to subscribers (no reload)", async () => {
    const m = makeManager();
    const info = await m.create({
      title: "live",
      html: "<div/>",
      data: { v: 1 },
      workspaceRoot: ws(),
      open: false,
    });

    const buf = await readSse(
      `${info.url}/events`,
      (b) => b.includes("event: data") && b.includes('{"v":2}'),
      () => m.update(info.id, { data: { v: 2 } }),
    );
    expect(buf).toContain("event: hello");
    expect(buf).toContain("event: data");
    expect(buf).toContain('data: {"v":2}');
    expect(buf).not.toContain("event: reload");
  });

  test("update(html) pushes a reload event and bumps the served page", async () => {
    const m = makeManager();
    const info = await m.create({
      title: "v",
      html: "<div>one</div>",
      workspaceRoot: ws(),
      open: false,
    });

    const buf = await readSse(
      `${info.url}/events`,
      (b) => b.includes("event: reload"),
      () => m.update(info.id, { html: "<div>two</div>" }),
    );
    expect(buf).toContain("event: reload");

    const page = await (await fetch(info.url)).text();
    expect(page).toContain("<div>two</div>");
    expect(page).not.toContain("<div>one</div>");
  });

  test("update on an unknown id throws", () => {
    const m = makeManager();
    expect(() => m.update("nope", { data: 1 })).toThrow(/no dashboard/);
  });
});

describe("DashboardManager — watch_file real-time binding", () => {
  test("bound JSON file streams into the page as it changes", async () => {
    const m = makeManager({ watchIntervalMs: 25 });
    const root = ws();
    const file = join(root, "metrics.json");
    writeFileSync(file, JSON.stringify({ step: 1 }));

    const info = await m.create({
      title: "watched",
      html: "<div/>",
      watchFile: "metrics.json",
      workspaceRoot: root,
      open: false,
    });
    expect(info.watching).toBe(file);

    // Initial data came from the file.
    const page = await (await fetch(info.url)).text();
    expect(page).toContain('{"step":1}');

    const buf = await readSse(
      `${info.url}/events`,
      (b) => b.includes('{"step":2}'),
      () => writeFileSync(file, JSON.stringify({ step: 2 })),
    );
    expect(buf).toContain("event: data");
    expect(buf).toContain('data: {"step":2}');
  });

  test("watch_file outside the workspace is rejected", async () => {
    const m = makeManager();
    const root = ws();
    const outside = mkdtempSync(join(tmpdir(), "dash-out-"));
    writeFileSync(join(outside, "x.json"), "{}");
    await expect(
      m.create({
        title: "t",
        html: "<div/>",
        watchFile: join(outside, "x.json"),
        workspaceRoot: root,
        open: false,
      }),
    ).rejects.toThrow(/inside the workspace/);
    expect(() =>
      // relative traversal too
      m["resolveWatchFile"](root, "../escape.json"),
    ).toThrow(/inside the workspace/);
  });

  test("not-yet-existing watch file binds and streams once it appears", async () => {
    const m = makeManager({ watchIntervalMs: 25 });
    const root = ws();
    const info = await m.create({
      title: "later",
      html: "<div/>",
      data: { waiting: true },
      watchFile: "out/progress.json",
      workspaceRoot: root,
      open: false,
    });
    expect(info.watching).toBe(join(root, "out", "progress.json"));

    const { mkdirSync } = await import("node:fs");
    const buf = await readSse(
      `${info.url}/events`,
      (b) => b.includes('{"pct":50}'),
      () => {
        mkdirSync(join(root, "out"), { recursive: true });
        writeFileSync(join(root, "out", "progress.json"), JSON.stringify({ pct: 50 }));
      },
    );
    expect(buf).toContain('data: {"pct":50}');
  });
});
