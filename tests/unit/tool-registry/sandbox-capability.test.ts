/**
 * Sandbox capability (what the MACHINE can do) vs sandbox mode (what the user
 * asked for). The Rust factory silently falls back to a path-guard-only
 * executor when seatbelt/bwrap is missing — these tests pin that the fallback
 * is no longer silent: auto-approval is withheld, the model-facing contract
 * tells the truth, the net preflight stops claiming a deny-net that isn't
 * there, and requireOs turns degradation into a refusal.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSandboxCapability,
  isOsIsolationAvailable,
  probeSandboxCapability,
  resetSandboxCapabilityForTest,
  setRequireOsIsolation,
  setSandboxCapability,
} from "../../../packages/tool-registry/src/sandbox-capability";
import { setSandboxMode } from "../../../packages/tool-registry/src/sandbox-mode";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { registerBuiltinTools } from "../../../packages/tool-registry/src/tools/builtin";
import { createRustToolHandler } from "../../../packages/tool-registry/src/tools/rust-bridge";
import { withNetworkPreflight } from "../../../packages/tool-registry/src/tools/net-preflight";
import type {
  ToolCallInput,
  ToolHandler,
  ToolSchema,
} from "../../../packages/tool-registry/src/types";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { renderEnvironmentBlock } from "../../../packages/orchestrator/src/prompts";

afterEach(() => {
  setSandboxMode("on");
  resetSandboxCapabilityForTest();
  // Other suites assume a healthy machine — restore it, not just "unknown".
  setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
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
  return { toolName: "bash", callId: "c1", args, sessionId: "s1", workspaceRoot: "/tmp/ws" };
}

function fakeProbeBinary(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-cap-"));
  const bin = join(dir, "fake-tools.sh");
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '${json}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// POSIX-only: `fakeProbeBinary` writes a `#!/bin/sh` script and Windows has no
// shebang dispatch, so `Bun.spawn` cannot run it. The capability being probed —
// seatbelt or bwrap — has no Windows equivalent either; the four suites below
// are pure policy and DO run there.
describe.skipIf(process.platform === "win32")("probeSandboxCapability", () => {
  test("parses the sandbox-check payload from the binary", () => {
    const bin = fakeProbeBinary(
      '{"success":true,"result":{"mechanism":"bwrap","os_isolation":true,"platform":"linux"}}',
    );
    const cap = probeSandboxCapability(bin);
    expect(cap).toEqual({ mechanism: "bwrap", osIsolation: true });
    expect(isOsIsolationAvailable()).toBe(true);
  });

  test("missing binary or garbage output degrades to unknown/false, never throws", () => {
    expect(probeSandboxCapability("/nonexistent/rune-tools")).toEqual({
      mechanism: "unknown",
      osIsolation: false,
    });
    const garbage = fakeProbeBinary("not json at all");
    expect(probeSandboxCapability(garbage).osIsolation).toBe(false);
    expect(isOsIsolationAvailable()).toBe(false);
  });

  test("unprobed state reports not isolated (fail-safe default)", () => {
    resetSandboxCapabilityForTest();
    expect(isOsIsolationAvailable()).toBe(false);
    expect(getSandboxCapability().mechanism).toBe("unknown");
  });
});

describe("auto-approval requires capability, not just intent", () => {
  function autoBroker(): PermissionBroker {
    return new PermissionBroker(false, { workspaceRoot: "/tmp/ws", trustWorkspace: true });
  }

  test("sandbox on + no OS backend → bash prompts instead of auto-running", () => {
    setSandboxMode("on");
    setSandboxCapability({ mechanism: "none", osIsolation: false });
    expect(autoBroker().check(BASH_SCHEMA, { command: "ls" }).type).toBe("needs_confirmation");

    setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
    expect(autoBroker().check(BASH_SCHEMA, { command: "ls" }).type).toBe("allowed");
  });

  test("Autonomy III still approves (its explicit contract) even when degraded", () => {
    setSandboxCapability({ mechanism: "none", osIsolation: false });
    const broker = new PermissionBroker(true, { workspaceRoot: "/tmp/ws" });
    expect(broker.check(BASH_SCHEMA, { command: "ls" }).type).toBe("allowed");
  });
});

describe("model-facing surfaces state the degraded truth", () => {
  test("bash description flips between isolated / degraded / off", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, "/nonexistent-rune-tools");
    const schema = registry.get("bash")!.schema;

    setSandboxMode("on");
    setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
    expect(schema.description).toContain("OS sandbox with NO network access");

    setSandboxCapability({ mechanism: "none", osIsolation: false });
    expect(schema.description).toContain("NO OS isolation backend");
    expect(schema.description).not.toContain("OS sandbox with NO network access");

    setSandboxMode("off");
    expect(schema.description).toContain("sandbox is DISABLED");
  });

  test("environment block renders the three-state posture", () => {
    const env = { workspaceRoot: "/tmp/ws", model: "m", provider: "p", isGitRepo: false };
    setSandboxMode("on");
    setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
    expect(renderEnvironmentBlock(env)).toContain("Sandbox: enabled — bash runs in an OS sandbox");

    setSandboxCapability({ mechanism: "none", osIsolation: false });
    expect(renderEnvironmentBlock(env)).toContain("DEGRADED");

    setSandboxMode("off");
    expect(renderEnvironmentBlock(env)).toContain("Sandbox: disabled");
  });
});

describe("network preflight only claims deny-net when it exists", () => {
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

  test("degraded machine: npm install runs (there IS network)", async () => {
    const wrapped = withNetworkPreflight(passthrough);
    setSandboxMode("on");

    setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
    const blocked = await wrapped.execute(callInput({ command: "npm install" }));
    expect(blocked.success).toBe(false);

    setSandboxCapability({ mechanism: "none", osIsolation: false });
    const ran = await wrapped.execute(callInput({ command: "npm install" }));
    expect(ran.success).toBe(true);
  });
});

describe("requireOs turns degradation into a refusal", () => {
  test("degraded + requireOs → sandbox-tier bash errors with guidance", async () => {
    const handler = createRustToolHandler(BASH_SCHEMA, "bash", "/nonexistent-rune-tools");
    setSandboxMode("on");
    setSandboxCapability({ mechanism: "none", osIsolation: false });
    setRequireOsIsolation(true);

    const out = await handler.execute(callInput({ command: "ls" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("requireOs");

    // With isolation available the same config runs normally (spawn fails on
    // the fake path, but it must get PAST the refusal gate).
    setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
    const past = await handler.execute(callInput({ command: "ls" }));
    expect(past.error ?? "").not.toContain("requireOs");
  });
});
