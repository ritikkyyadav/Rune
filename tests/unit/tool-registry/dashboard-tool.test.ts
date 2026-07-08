/**
 * interactive_dashboard tool handler — schema contract, validation, and the
 * create/update/open/close action surface over a real DashboardManager.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DashboardManager,
  createDashboardTool,
  INTERACTIVE_DASHBOARD_SCHEMA,
} from "../../../packages/tool-registry/src/tools/dashboard";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";

process.env.BERNE_NO_OPEN = "1";

const manager = new DashboardManager({ openInBrowser: false });
const tool = createDashboardTool(manager);
const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-tool-")));

afterAll(() => manager.closeAll());

function input(args: Record<string, unknown>): ToolCallInput {
  return { toolName: "interactive_dashboard", callId: "c1", args, sessionId: "s", workspaceRoot: root };
}

describe("interactive_dashboard — schema", () => {
  test("auto-permitted (no prompt) and serialized with execute-category tools", () => {
    expect(INTERACTIVE_DASHBOARD_SCHEMA.permissionLevel).toBe("auto");
    expect(INTERACTIVE_DASHBOARD_SCHEMA.category).toBe("execute");
  });

  test("description teaches spec-first, live keys, exports, and the offline rule", () => {
    const d = INTERACTIVE_DASHBOARD_SCHEMA.description;
    expect(d).toContain("PREFER `spec`");
    expect(d).toContain("window.render(data)");
    expect(d).toContain("Chart.js");
    expect(d).toContain("no CDNs");
    expect(d).toContain("watch_file");
    expect(d).toContain("action:'export'");
  });
});

describe("interactive_dashboard — validation", () => {
  test("rejects unknown actions and missing requirements", () => {
    expect(tool.validate({ action: "destroy" }).valid).toBe(false);
    expect(tool.validate({ action: "create" }).valid).toBe(false); // no spec/html
    expect(tool.validate({ action: "create", html: "  " }).valid).toBe(false);
    expect(tool.validate({ action: "update" }).valid).toBe(false); // no id
    expect(tool.validate({ action: "close" }).valid).toBe(false); // no id
    expect(tool.validate({ action: "create", html: "<div/>" }).valid).toBe(true);
    expect(tool.validate({ action: "create", spec: { title: "t", kpis: [] } }).valid).toBe(true);
    expect(tool.validate({ action: "open" }).valid).toBe(true); // id optional
    expect(tool.validate({ action: "export" }).valid).toBe(false); // no format
    expect(tool.validate({ action: "export", format: "docx" }).valid).toBe(false);
    expect(tool.validate({ action: "export", format: "pdf" }).valid).toBe(true);
  });
});

describe("interactive_dashboard — actions", () => {
  test("create returns id + url and the page is live", async () => {
    const out = await tool.execute(
      input({ action: "create", title: "Report", html: "<div>r</div>", data: { a: 1 }, open: false }),
    );
    expect(out.success).toBe(true);
    const parsed = JSON.parse(out.result) as { id: string; url: string; note: string };
    expect(parsed.id).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.note).toContain("Tell the user the URL");
    expect((await fetch(parsed.url)).status).toBe(200);
  });

  test("data passed as a JSON string is tolerated (weak-model salvage)", async () => {
    const out = await tool.execute(
      input({ action: "create", title: "s", html: "<div/>", data: '{"rows":[1,2]}', open: false }),
    );
    expect(out.success).toBe(true);
    const { url } = JSON.parse(out.result) as { url: string };
    const page = await (await fetch(url)).text();
    expect(page).toContain('{"rows":[1,2]}'); // parsed object, not a quoted string
  });

  test("update pushes; open re-reports the url; close tears down", async () => {
    const created = JSON.parse(
      (await tool.execute(input({ action: "create", title: "u", html: "<div/>", open: false }))).result,
    ) as { id: string; url: string };

    const upd = await tool.execute(input({ action: "update", id: created.id, data: { x: 9 } }));
    expect(upd.success).toBe(true);
    expect(JSON.parse(upd.result).updated).toBe(true);

    const opened = await tool.execute(input({ action: "open", id: created.id }));
    expect(opened.success).toBe(true);
    expect(JSON.parse(opened.result).url).toBe(created.url);

    const closed = await tool.execute(input({ action: "close", id: created.id }));
    expect(closed.success).toBe(true);
    expect((await fetch(created.url)).status).toBe(404);
  });

  test("update/close on unknown ids fail with instructive errors", async () => {
    const upd = await tool.execute(input({ action: "update", id: "ffffffff", data: {} }));
    expect(upd.success).toBe(false);
    expect(upd.error).toContain("no dashboard");
    const cls = await tool.execute(input({ action: "close", id: "ffffffff" }));
    expect(cls.success).toBe(false);
  });

  test("watch_file escape comes back as a tool error, not a throw", async () => {
    const out = await tool.execute(
      input({ action: "create", html: "<div/>", watch_file: "../../etc/hosts", open: false }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toContain("inside the workspace");
  });
});

describe("interactive_dashboard — spec mode", () => {
  const spec = {
    title: "Fleet",
    kpis: [{ label: "Ships", value: 789, delta: 5.4, key: "ships" }],
    items: [
      {
        type: "chart",
        title: "Deliveries",
        key: "weekly",
        chart: { kind: "area", labels: ["Mon", "Tue"], series: [{ name: "Count", data: [4, 9] }] },
      },
      { type: "table", title: "Orders", columns: ["Id", "Status"], rows: [["#1", { chip: "Done", tone: "good" }]] },
    ],
  };

  test("create from spec (no html): page ships the design system + baked spec", async () => {
    const out = await tool.execute(input({ action: "create", title: "Fleet", spec, open: false }));
    expect(out.success).toBe(true);
    const { url, id } = JSON.parse(out.result) as { url: string; id: string };
    const page = await (await fetch(url)).text();
    expect(page).toContain("__BERNE_SPEC__");
    expect(page).toContain("berne-root");
    expect(page).toContain("--accent"); // THEME_CSS present
    expect(page).toContain("berneTheme"); // chart defaults plugin present
    expect(page).toContain('"Deliveries"');

    // spec update re-renders live (data channel), no version bump / reload
    const upd = await tool.execute(
      input({ action: "update", id, spec: { ...spec, title: "Fleet v2" } }),
    );
    expect(upd.success).toBe(true);
    const page2 = await (await fetch(url)).text();
    expect(page2).toContain('"Fleet v2"');
  });

  test("exports: standalone html, json, and csv routes + files", async () => {
    const out = await tool.execute(input({ action: "create", title: "Export Me", spec, open: false }));
    const { url, id } = JSON.parse(out.result) as { url: string; id: string };

    const html = await fetch(`${url}/export/html`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-disposition")).toContain("export-me.html");
    const doc = await html.text();
    expect(doc).toContain("__BERNE_STANDALONE__");
    expect(doc).not.toContain("EventSource"); // no live channel in the artifact
    expect(doc.length).toBeGreaterThan(200_000); // Chart.js inlined

    // print view: freezes charts, holds load, never opens a live channel
    const view = await fetch(`${url}/export/view`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-disposition")).toBeNull();
    const viewDoc = await view.text();
    expect(viewDoc).toContain("freezeCharts");
    expect(viewDoc).toContain("/export/hold");
    expect(viewDoc).not.toContain("EventSource");

    const json = await fetch(`${url}/export/json`);
    expect(json.status).toBe(200);
    expect(((await json.json()) as { title: string }).title).toBe("Fleet");

    const csv = await fetch(`${url}/export/csv`);
    expect(csv.status).toBe(200);
    const csvText = await csv.text();
    expect(csvText).toContain("Metric,Value,Delta");
    expect(csvText).toContain("Ships,789,5.4");
    expect(csvText).toContain("# Deliveries");
    expect(csvText).toContain("Mon,4");

    // export action writes real files into the workspace
    const fileOut = await tool.execute(
      input({ action: "export", id, format: "html", path: "reports/fleet.html" }),
    );
    expect(fileOut.success).toBe(true);
    const written = JSON.parse(fileOut.result) as { exported: string };
    expect(written.exported).toBe(join(root, "reports/fleet.html"));
    expect(readFileSync(written.exported, "utf8")).toContain("__BERNE_STANDALONE__");

    const escape = await tool.execute(
      input({ action: "export", id, format: "json", path: "../outside.json" }),
    );
    expect(escape.success).toBe(false);
    expect(escape.error).toContain("inside the workspace");
  });

  test("pdf export without a browser fails with guidance (not a hang)", async () => {
    const prev = process.env.BERNE_BROWSER_BIN;
    process.env.BERNE_BROWSER_BIN = "/nonexistent/browser";
    try {
      const created = await tool.execute(input({ action: "create", title: "p", spec, open: false }));
      const { id } = JSON.parse(created.result) as { id: string };
      const out = await tool.execute(input({ action: "export", id, format: "pdf" }));
      expect(out.success).toBe(false);
      expect(out.error).toContain("Export menu");
    } finally {
      if (prev === undefined) delete process.env.BERNE_BROWSER_BIN;
      else process.env.BERNE_BROWSER_BIN = prev;
    }
  });
});
