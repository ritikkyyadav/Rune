/**
 * Plotted numbers must name a source.
 *
 * `data` is a free-form object the model authors, and it is the one tool output
 * a reader takes as fact — a chart reads as measurement whether or not anything
 * measured it. The only guard used to be a doctrine sentence ("plot the REAL
 * numbers, never invent data"), and a prose rule is precisely what does not
 * survive a model swap. These tests hold the mechanical half: the schema asks
 * the question, and the file form is checked against the filesystem.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDashboardTool,
  DashboardManager,
  validateDataSource,
  verifyDataSource,
} from "../../../packages/tool-registry/src/tools/dashboard";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";

describe("validateDataSource — shape", () => {
  test("data with no source is refused, with the three forms named", () => {
    const err = validateDataSource(undefined);
    expect(err).toBeTruthy();
    expect(err).toContain("data_source");
    expect(err).toContain("file");
    expect(err).toContain("command");
    expect(err).toContain("conversation");
  });

  test("each valid form is accepted", () => {
    expect(validateDataSource({ kind: "file", path: "results.json" })).toBeNull();
    expect(validateDataSource({ kind: "command", command: "bun test" })).toBeNull();
    expect(validateDataSource({ kind: "conversation", note: "the figures you pasted" })).toBeNull();
  });

  test("a JSON string is tolerated the same way `data` is", () => {
    expect(validateDataSource('{"kind":"file","path":"a.json"}')).toBeNull();
  });

  test("an empty payload field is refused — presence is not provenance", () => {
    expect(validateDataSource({ kind: "file", path: "   " })).toBeTruthy();
    expect(validateDataSource({ kind: "command", command: "" })).toBeTruthy();
    expect(validateDataSource({ kind: "conversation", note: "" })).toBeTruthy();
  });

  test("an unrecognized kind is refused, not waved through", () => {
    // A source field that accepts anything is decoration, not provenance.
    expect(validateDataSource({ kind: "estimate", note: "roughly" })).toBeTruthy();
    expect(validateDataSource({ kind: "model", note: "I worked it out" })).toBeTruthy();
    expect(validateDataSource(["file", "a.json"])).toBeTruthy();
  });
});

describe("verifyDataSource — the half the runtime can settle itself", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rune-dash-source-"));
    writeFileSync(join(ws, "results.json"), '{"ok":true}');
  });

  afterEach(() => {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("a file that exists in the workspace passes", () => {
    expect(verifyDataSource({ kind: "file", path: "results.json" }, ws)).toBeNull();
  });

  test("a file that does not exist is refused, and says what to do instead", () => {
    const err = verifyDataSource({ kind: "file", path: "imagined.json" }, ws);
    expect(err).toContain("does not exist");
    expect(err).toContain("watch_file");
  });

  test("a path outside the workspace is refused even if it exists", () => {
    expect(verifyDataSource({ kind: "file", path: "../../../etc/hosts" }, ws)).toContain(
      "outside the workspace",
    );
  });

  test("non-file forms are not the filesystem's business", () => {
    expect(verifyDataSource({ kind: "command", command: "bun test" }, ws)).toBeNull();
    expect(verifyDataSource({ kind: "conversation", note: "your message" }, ws)).toBeNull();
  });
});

describe("the guarantee holds on the path production actually takes", () => {
  // ToolRegistry.execute() validates before executing, so validate() is the
  // real enforcement point. This asserts that end-to-end rather than trusting
  // it — the dashboard's own tests call execute() directly and would not
  // notice if the registry ever stopped validating.
  const dashboardTool = (): ToolHandler => createDashboardTool(new DashboardManager());

  test("an unsourced data payload never reaches the tool", async () => {
    const registry = new ToolRegistry();
    registry.register(dashboardTool());

    const out = await registry.execute({
      callId: "c1",
      toolName: "interactive_dashboard",
      args: {
        action: "create",
        title: "t",
        spec: { title: "t", kpis: [] },
        data: { revenue: 4200 },
      },
      sessionId: "s",
      workspaceRoot: "/tmp",
    });

    expect(out.success).toBe(false);
    expect(out.error).toContain("data_source");
  });

  test("a sourced payload passes validation", async () => {
    const registry = new ToolRegistry();
    registry.register(dashboardTool());

    const out = await registry.execute({
      callId: "c2",
      toolName: "interactive_dashboard",
      args: {
        action: "create",
        title: "t",
        spec: { title: "t", kpis: [] },
        data: { revenue: 4200 },
        data_source: { kind: "command", command: "bun run report" },
        open: false,
      },
      sessionId: "s",
      workspaceRoot: "/tmp",
    });

    // It gets past the provenance gate. Whether the page then serves depends
    // on binding a socket, which is not what this test is about.
    expect(out.error ?? "").not.toContain("data_source");
  });

  test("a spec with no data payload is unaffected", async () => {
    const registry = new ToolRegistry();
    registry.register(dashboardTool());

    const out = await registry.execute({
      callId: "c3",
      toolName: "interactive_dashboard",
      args: { action: "create", title: "t", spec: { title: "t", kpis: [] }, open: false },
      sessionId: "s",
      workspaceRoot: "/tmp",
    });

    expect(out.error ?? "").not.toContain("data_source");
  });
});
