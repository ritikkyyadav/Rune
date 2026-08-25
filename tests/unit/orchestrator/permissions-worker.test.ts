/**
 * Permission semantics for `worker`: confirm-level, but workspace-confined
 * (all owned files inside the root) → auto-approved under workspace trust;
 * any escape keeps prompting; confirm mode always prompts.
 */

import { describe, test, expect } from "bun:test";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { WORKER_TOOL_SCHEMA } from "../../../packages/orchestrator/src/worker";

const ROOT = "/tmp/ws";

describe("PermissionBroker × worker", () => {
  test("confirm mode: always prompts, summary shows ownership", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: ROOT });
    const d = broker.check(WORKER_TOOL_SCHEMA, {
      prompt: "build the auth module",
      files: ["src/auth.ts", "src/auth/"],
    });
    expect(d.type).toBe("needs_confirmation");
    if (d.type === "needs_confirmation") {
      expect(d.argsSummary).toContain("worker [owns: src/auth.ts, src/auth/]");
      expect(d.argsSummary).toContain("build the auth module");
    }
  });

  test("workspace trust: in-root ownership auto-approves; escapes still prompt", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: ROOT, trustWorkspace: true });
    expect(
      broker.check(WORKER_TOOL_SCHEMA, { prompt: "p", files: ["src/a.ts", "lib/"] }).type,
    ).toBe("allowed");
    expect(
      broker.check(WORKER_TOOL_SCHEMA, { prompt: "p", files: ["src/a.ts", "../outside.ts"] }).type,
    ).toBe("needs_confirmation");
    expect(broker.check(WORKER_TOOL_SCHEMA, { prompt: "p", files: ["/etc/hosts"] }).type).toBe(
      "needs_confirmation",
    );
    expect(broker.check(WORKER_TOOL_SCHEMA, { prompt: "p", files: [] }).type).toBe(
      "needs_confirmation",
    );
  });
});
