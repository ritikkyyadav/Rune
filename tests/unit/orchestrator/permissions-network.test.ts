/**
 * Sandbox-escape permission consistency: bash calls that leave the OS sandbox
 * (network: true, run_in_background: true) must NOT be auto-approved by
 * workspace trust ("auto" mode) — only sandbox-confined foreground commands
 * are. Autonomy III still approves everything.
 */

import { describe, test, expect } from "bun:test";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";
import type { ToolSchema } from "@gear/tool-registry";

// Auto-approval of sandbox-confined bash presumes the machine CAN isolate.
setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

const BASH: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description: "",
  inputSchema: { type: "object", properties: {} },
  permissionLevel: "sandbox",
  category: "execute",
};

function brokerInAutoMode(): PermissionBroker {
  const b = new PermissionBroker(false, { workspaceRoot: "/ws", trustWorkspace: true });
  return b;
}

describe("PermissionBroker — bash sandbox escapes", () => {
  test("auto mode: sandboxed foreground bash is auto-approved", () => {
    const d = brokerInAutoMode().check(BASH, { command: "bun test" });
    expect(d.type).toBe("allowed");
  });

  test("auto mode: network:true escalation prompts", () => {
    const d = brokerInAutoMode().check(BASH, { command: "npm install", network: true });
    expect(d.type).toBe("needs_confirmation");
  });

  test("auto mode: run_in_background:true (unsandboxed) prompts", () => {
    const d = brokerInAutoMode().check(BASH, {
      command: "bun run dev",
      run_in_background: true,
    });
    expect(d.type).toBe("needs_confirmation");
  });

  test("Autonomy III approves network bash", () => {
    const b = new PermissionBroker(true, { workspaceRoot: "/ws" });
    const d = b.check(BASH, { command: "git push", network: true });
    expect(d.type).toBe("allowed");
  });

  test("the prompt summary flags network escalation", () => {
    const d = brokerInAutoMode().check(BASH, { command: "git push origin main", network: true });
    expect(d.type).toBe("needs_confirmation");
    if (d.type === "needs_confirmation") {
      expect(d.argsSummary).toContain("[network — runs outside the sandbox]");
      expect(d.argsSummary).toContain("git push origin main");
    }
  });

  test("confirm mode still prompts for plain bash", () => {
    const b = new PermissionBroker(false, { workspaceRoot: "/ws", trustWorkspace: false });
    const d = b.check(BASH, { command: "ls" });
    expect(d.type).toBe("needs_confirmation");
  });
});
