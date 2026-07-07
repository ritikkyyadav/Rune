/**
 * interactive_dashboard tool handler — schema contract, validation, and the
 * create/update/open/close action surface over a real DashboardManager.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
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

  test("description teaches the render contract and the offline rule", () => {
    const d = INTERACTIVE_DASHBOARD_SCHEMA.description;
    expect(d).toContain("window.render(data)");
    expect(d).toContain("Chart.js");
    expect(d).toContain("NO external URLs");
    expect(d).toContain("watch_file");
  });
});

describe("interactive_dashboard — validation", () => {
  test("rejects unknown actions and missing requirements", () => {
    expect(tool.validate({ action: "destroy" }).valid).toBe(false);
    expect(tool.validate({ action: "create" }).valid).toBe(false); // no html
    expect(tool.validate({ action: "create", html: "  " }).valid).toBe(false);
    expect(tool.validate({ action: "update" }).valid).toBe(false); // no id
    expect(tool.validate({ action: "close" }).valid).toBe(false); // no id
    expect(tool.validate({ action: "create", html: "<div/>" }).valid).toBe(true);
    expect(tool.validate({ action: "open" }).valid).toBe(true); // id optional
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
