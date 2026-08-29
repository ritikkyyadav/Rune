/**
 * v2 permission risk row: every fact computed from the real arguments and the
 * live rate limiter — target locality, declared network access, the timeout
 * cap, and per-minute occupancy. Absent facts stay absent.
 */

import { describe, test, expect } from "bun:test";
import { buildPermissionPreview } from "../../../packages/orchestrator/src/bin/ui/permission-preview";

const WS = "/tmp/gear-ws";

function fact(
  preview: { risk?: { label: string; value: string; tone?: string }[] },
  label: string,
) {
  return preview.risk?.find((f) => f.label === label);
}

describe("permission risk facts", () => {
  test("sandboxed bash: writes and egress blocked, default runtime cap, rate occupancy", async () => {
    const p = await buildPermissionPreview({
      toolName: "bash",
      argsSummary: "bash: bun test",
      rawArgs: { command: "bun test tests/unit/" },
      workspaceRoot: WS,
      rateLimit: { used: 3, limit: 10 },
    });
    expect(fact(p, "writes outside workspace")).toEqual({
      label: "writes outside workspace",
      value: "blocked (sandbox)",
      tone: "ok",
    });
    expect(fact(p, "network egress")?.value).toBe("blocked");
    expect(fact(p, "est. runtime")?.value).toBe("<=120s cap");
    expect(fact(p, "rate limit")).toEqual({
      label: "rate limit",
      value: "4/10 per min",
      tone: "muted",
    });
  });

  test("network bash: egress requested (warn), host writes possible, custom timeout", async () => {
    const p = await buildPermissionPreview({
      toolName: "bash",
      argsSummary: "bash: curl example.com",
      rawArgs: { command: "curl example.com", network: true, timeout_ms: 300_000 },
      workspaceRoot: WS,
    });
    expect(fact(p, "network egress")).toEqual({
      label: "network egress",
      value: "requested",
      tone: "warn",
    });
    expect(fact(p, "writes outside workspace")?.value).toBe("possible (host)");
    expect(fact(p, "est. runtime")).toEqual({
      label: "est. runtime",
      value: "<=300s cap",
      tone: "warn",
    });
    expect(fact(p, "rate limit")).toBeUndefined(); // no limiter data → no fact
  });

  test("edit inside the workspace: writes-outside is an honest 'no'", async () => {
    const p = await buildPermissionPreview({
      toolName: "edit_file",
      argsSummary: "edit_file src/a.ts",
      rawArgs: { path: "src/a.ts", old_text: "a", new_text: "b" },
      workspaceRoot: WS,
    });
    expect(fact(p, "writes outside workspace")?.value).toBe("no");
    expect(fact(p, "network egress")?.value).toBe("none");
  });

  test("write outside the workspace screams YES in accent", async () => {
    const p = await buildPermissionPreview({
      toolName: "write_file",
      argsSummary: "write_file /etc/hosts",
      rawArgs: { path: "/etc/hosts", content: "x" },
      workspaceRoot: WS,
    });
    expect(fact(p, "writes outside workspace")).toEqual({
      label: "writes outside workspace",
      value: "YES",
      tone: "accent",
    });
  });

  test("web_fetch names the exact origin as the egress fact", async () => {
    const p = await buildPermissionPreview({
      toolName: "web_fetch",
      argsSummary: "web_fetch https://api.example.com/data",
      rawArgs: { url: "https://api.example.com/data" },
      workspaceRoot: WS,
    });
    const egress = fact(p, "network egress");
    expect(egress?.tone).toBe("warn");
    expect(egress?.value).toContain("api.example.com");
  });

  test("rate limit at the ceiling warns", async () => {
    const p = await buildPermissionPreview({
      toolName: "some_tool",
      argsSummary: "some_tool {}",
      rawArgs: {},
      workspaceRoot: WS,
      rateLimit: { used: 19, limit: 20 },
    });
    expect(fact(p, "rate limit")).toEqual({
      label: "rate limit",
      value: "20/20 per min",
      tone: "warn",
    });
  });
});
