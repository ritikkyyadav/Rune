/**
 * Sandbox mode (/sandbox on|off, --no-sandbox): the single process-wide switch
 * between "commands run in the OS sandbox" and "full host access". Everything
 * that must agree — the Rust --sandbox flag, the network preflight, the
 * permission broker's confinement logic, and the model-facing bash
 * description — reads tool-registry/sandbox-mode, so flipping it may never be
 * half-applied.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSandboxMode,
  isSandboxEnabled,
  onSandboxModeChange,
  setSandboxMode,
} from "../../../packages/tool-registry/src/sandbox-mode";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { registerBuiltinTools } from "../../../packages/tool-registry/src/tools/builtin";
import { createRustToolHandler } from "../../../packages/tool-registry/src/tools/rust-bridge";
import { withNetworkPreflight } from "../../../packages/tool-registry/src/tools/net-preflight";
import type { ToolCallInput, ToolHandler, ToolSchema } from "../../../packages/tool-registry/src/types";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { renderEnvironmentBlock } from "../../../packages/orchestrator/src/prompts";
import { resolveInitialSandbox } from "../../../packages/shared/src/sandbox-store";

// Global state: every test must leave the default (on) behind, or unrelated
// suites (net-preflight, permissions-network) would inherit a flipped mode.
// Capability is process-wide too — most tests here model a healthy machine
// (seatbelt available); the degraded cases set it explicitly.
function healthyMachine() {
  setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
}
healthyMachine();
afterEach(() => {
  setSandboxMode("on");
  healthyMachine();
});

const BASH_SCHEMA: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description: "test",
  inputSchema: { type: "object", properties: {} },
  permissionLevel: "sandbox",
  category: "execute",
};

function callInput(args: Record<string, unknown>): ToolCallInput {
  return {
    toolName: "bash",
    callId: "c1",
    args,
    sessionId: "s1",
    workspaceRoot: "/tmp/ws",
  };
}

describe("sandbox-mode state", () => {
  test("defaults to on; set/get round-trips", () => {
    expect(getSandboxMode()).toBe("on");
    expect(isSandboxEnabled()).toBe(true);
    setSandboxMode("off");
    expect(getSandboxMode()).toBe("off");
    expect(isSandboxEnabled()).toBe(false);
  });

  test("listeners fire immediately on subscribe and again on change", () => {
    const seen: boolean[] = [];
    onSandboxModeChange((enabled) => seen.push(enabled));
    expect(seen).toEqual([true]); // immediate fire with current state
    setSandboxMode("off");
    expect(seen).toEqual([true, false]);
    setSandboxMode("on");
    expect(seen).toEqual([true, false, true]);
  });
});

describe("bash tool description follows the mode", () => {
  test("registered schema text swaps between sandboxed and full-access", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, "/nonexistent-alan-tools");
    const schema = registry.get("bash")!.schema;

    setSandboxMode("on");
    expect(schema.description).toContain("OS sandbox with NO network access");
    const propsOn = schema.inputSchema.properties as Record<string, { description: string }>;
    expect(propsOn.network.description).toContain("Run OUTSIDE the sandbox");

    setSandboxMode("off");
    expect(schema.description).toContain("sandbox is DISABLED");
    expect(schema.description).not.toContain("NO network access");
    const propsOff = schema.inputSchema.properties as Record<string, { description: string }>;
    expect(propsOff.network.description).toContain("No effect");
  });
});

describe("rust bridge --sandbox flag follows the mode", () => {
  // A stand-in "alan-tools" that just echoes its argv back as the result, so
  // the test asserts the exact flag surface the real binary would see.
  function fakeToolsBinary(): string {
    const dir = mkdtempSync(join(tmpdir(), "alan-sbx-"));
    const bin = join(dir, "fake-tools.sh");
    writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho "{\\"success\\":true,\\"result\\":{\\"argv\\":\\"$*\\"}}"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("on → --sandbox passed; off → omitted; network:true always omits", async () => {
    const handler = createRustToolHandler(BASH_SCHEMA, "bash", fakeToolsBinary());

    setSandboxMode("on");
    const sandboxed = await handler.execute(callInput({ command: "ls" }));
    expect(sandboxed.result).toContain("--sandbox");

    const escalated = await handler.execute(callInput({ command: "ls", network: true }));
    expect(escalated.result).not.toContain("--sandbox");

    setSandboxMode("off");
    const full = await handler.execute(callInput({ command: "ls" }));
    expect(full.result).not.toContain("--sandbox");
  });
});

describe("network preflight follows the mode", () => {
  const passthrough: ToolHandler = {
    schema: BASH_SCHEMA,
    validate: () => ({ valid: true }),
    execute: async (input) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ran",
      durationMs: 0,
    }),
  };

  test("on → npm install blocked with teaching error; off → runs", async () => {
    const wrapped = withNetworkPreflight(passthrough);

    setSandboxMode("on");
    const blocked = await wrapped.execute(callInput({ command: "npm install" }));
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("network: true");

    setSandboxMode("off");
    const ran = await wrapped.execute(callInput({ command: "npm install" }));
    expect(ran.success).toBe(true);
    expect(ran.result).toBe("ran");
  });
});

describe("permission broker confinement follows the mode", () => {
  function autoBroker(): PermissionBroker {
    return new PermissionBroker(false, { workspaceRoot: "/tmp/ws", trustWorkspace: true });
  }

  test("auto mode: bash auto-approved only while the sandbox contains it", () => {
    setSandboxMode("on");
    expect(autoBroker().check(BASH_SCHEMA, { command: "ls" }).type).toBe("allowed");

    setSandboxMode("off");
    const decision = autoBroker().check(BASH_SCHEMA, { command: "ls" });
    expect(decision.type).toBe("needs_confirmation");
    if (decision.type === "needs_confirmation") {
      expect(decision.argsSummary).toContain("sandbox off — full host access");
    }
  });

  test("Hands-Free (turing) still approves everything with the sandbox off", () => {
    setSandboxMode("off");
    const broker = new PermissionBroker(true, { workspaceRoot: "/tmp/ws" });
    expect(broker.check(BASH_SCHEMA, { command: "ls" }).type).toBe("allowed");
  });
});

describe("environment block states the posture", () => {
  const env = { workspaceRoot: "/tmp/ws", model: "m", provider: "p", isGitRepo: false };

  test("on/off render distinct, accurate lines", () => {
    setSandboxMode("on");
    expect(renderEnvironmentBlock(env)).toContain("Sandbox: enabled");
    setSandboxMode("off");
    expect(renderEnvironmentBlock(env)).toContain("Sandbox: disabled");
  });
});

describe("resolveInitialSandbox precedence", () => {
  test("flag > env > saved > configured > on", () => {
    // Flag wins over everything.
    expect(resolveInitialSandbox({ flag: false, env: "true", saved: true, configured: true })).toBe(false);
    expect(resolveInitialSandbox({ flag: true, env: "false", saved: false, configured: false })).toBe(true);
    // Env beats the sidecar and config.
    expect(resolveInitialSandbox({ env: "false", saved: true, configured: true })).toBe(false);
    expect(resolveInitialSandbox({ env: "true", saved: false, configured: false })).toBe(true);
    // Sidecar beats config.
    expect(resolveInitialSandbox({ saved: false, configured: true })).toBe(false);
    // Config is honored when nothing else speaks.
    expect(resolveInitialSandbox({ configured: false })).toBe(false);
    // Default is on.
    expect(resolveInitialSandbox({})).toBe(true);
    // Garbage env values fall through.
    expect(resolveInitialSandbox({ env: "banana", configured: false })).toBe(false);
  });
});
