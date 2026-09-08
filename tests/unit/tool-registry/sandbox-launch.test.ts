/**
 * The per-call launch decision behind `/sandbox`'s three tabs: the mode, the
 * Overrides choice (fallback vs strict) and the excluded-command list, and
 * the places that must all agree with it — the Rust bridge's `--sandbox` flag
 * and path payload, the network preflight, the background shell planner, and
 * the model-facing bash description.
 */

import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canContainCommand,
  getSandboxMode,
  isSandboxAutoAllow,
  isSandboxEnabled,
  resetSandboxPolicyForTest,
  resolveSandboxLaunch,
  sandboxPathsFor,
  setSandboxMode,
  setSandboxPolicy,
} from "../../../packages/tool-registry/src/sandbox-mode";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { registerBuiltinTools } from "../../../packages/tool-registry/src/tools/builtin";
import {
  createRustToolHandler,
  sandboxDenialHint,
} from "../../../packages/tool-registry/src/tools/rust-bridge";
import { withNetworkPreflight } from "../../../packages/tool-registry/src/tools/net-preflight";
import { BackgroundShellManager } from "../../../packages/tool-registry/src/tools/background";
import type {
  ToolCallInput,
  ToolHandler,
  ToolSchema,
} from "../../../packages/tool-registry/src/types";

setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
afterEach(() => {
  resetSandboxPolicyForTest();
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

function callInput(args: Record<string, unknown>, workspaceRoot = "/tmp/ws"): ToolCallInput {
  return { toolName: "bash", callId: "c1", args, sessionId: "s1", workspaceRoot };
}

describe("resolveSandboxLaunch", () => {
  test("default: sandboxed, auto-allow, fallback allowed", () => {
    expect(getSandboxMode()).toBe("auto-allow");
    expect(isSandboxAutoAllow()).toBe(true);
    expect(resolveSandboxLaunch({ command: "ls" })).toEqual({
      sandboxed: true,
      reason: "sandboxed",
    });
  });

  test("regular keeps the walls and drops the vouching; off drops both", () => {
    setSandboxMode("regular");
    expect(isSandboxEnabled()).toBe(true);
    expect(isSandboxAutoAllow()).toBe(false);
    expect(resolveSandboxLaunch({ command: "ls" }).sandboxed).toBe(true);
    setSandboxMode("off");
    expect(resolveSandboxLaunch({ command: "ls" })).toEqual({ sandboxed: false, reason: "off" });
    // The historical spelling still works.
    setSandboxMode("on");
    expect(getSandboxMode()).toBe("auto-allow");
  });

  test("an excluded command runs on the host and names its pattern", () => {
    setSandboxPolicy({ excludedCommands: ["adb *", "docker"] });
    expect(resolveSandboxLaunch({ command: "cd app && adb install x.apk" })).toEqual({
      sandboxed: false,
      reason: "excluded",
      matched: "adb *",
    });
    expect(resolveSandboxLaunch({ command: "docker ps" }).reason).toBe("excluded");
    expect(resolveSandboxLaunch({ command: "dockerd" }).reason).toBe("sandboxed");
    expect(canContainCommand("adb devices")).toBe(false);
    expect(canContainCommand("ls")).toBe(true);
  });

  test("unsandboxed: true is a fallback under the default override and refused under strict", () => {
    expect(resolveSandboxLaunch({ command: "make", unsandboxed: true })).toEqual({
      sandboxed: false,
      reason: "fallback",
    });
    setSandboxPolicy({ allowUnsandboxedFallback: false });
    const strict = resolveSandboxLaunch({ command: "make", unsandboxed: true });
    expect(strict.sandboxed).toBe(true);
    expect(strict.refusal).toContain("strict");
    // The user's exclusion outranks the strict refusal: it is their decision.
    setSandboxPolicy({ excludedCommands: ["make"] });
    expect(resolveSandboxLaunch({ command: "make", unsandboxed: true }).reason).toBe("excluded");
    // ...and off makes the flag moot.
    setSandboxMode("off");
    expect(resolveSandboxLaunch({ command: "x", unsandboxed: true }).refusal).toBeUndefined();
  });

  test("the path lists carry the built-in control-surface denials plus the policy's", () => {
    setSandboxPolicy({
      filesystem: { denyRead: [], allowWrite: ["~/.gradle"], denyWrite: ["dist"] },
    });
    const paths = sandboxPathsFor("/ws");
    expect(paths.deny_write).toContain("/ws/.rune/hooks");
    expect(paths.deny_write).toContain("/ws/.git/hooks");
    expect(paths.deny_write).toContain("/ws/dist");
    expect(paths.allow_write[0]).toMatch(/\.gradle$/);
  });
});

describe("sandboxDenialHint", () => {
  test("only a failed sandboxed run with a permission-shaped stderr gets a hint", () => {
    expect(sandboxDenialHint("Operation not permitted", 0)).toBeNull();
    expect(sandboxDenialHint("no such file", 1)).toBeNull();
    expect(sandboxDenialHint("mkdir: /Users/me/x: Operation not permitted", 1)).toContain(
      "unsandboxed: true",
    );
    setSandboxPolicy({ allowUnsandboxedFallback: false });
    const strict = sandboxDenialHint("EACCES: permission denied", 1)!;
    expect(strict).toContain("strict");
    expect(strict).not.toContain("re-run it once with unsandboxed: true");
  });
});

// POSIX-only: the stub is a shell script and `--sandbox` names seatbelt/bwrap.
describe.skipIf(process.platform === "win32")("rust bridge follows the launch decision", () => {
  let dir = "";
  let stub = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-launch-"));
    stub = join(dir, "stub-tools");
    // Echoes argv AND the JSON it was fed, so the test can see both the flag
    // surface and the payload the binary would have acted on.
    writeFileSync(
      stub,
      `#!/bin/bash
IN=$(cat)
printf '{"success":true,"result":{"argv":"%s","stdin":%s}}\\n' "$*" "$IN"
`,
    );
    chmodSync(stub, 0o755);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: Record<string, unknown>) {
    const handler = createRustToolHandler(BASH_SCHEMA, "bash", stub);
    const out = await handler.execute(callInput(args, dir));
    return {
      out,
      parsed: out.success
        ? (JSON.parse(out.result) as { argv: string; stdin: Record<string, unknown> })
        : null,
    };
  }

  test("sandboxed: --sandbox present, trusted paths attached, unsandboxed stripped", async () => {
    const { parsed } = await run({
      command: "ls",
      unsandboxed: false,
      sandbox_paths: { deny_write: ["/model/tried/this"] },
    });
    expect(parsed!.argv).toContain("--sandbox");
    expect(parsed!.stdin.unsandboxed).toBeUndefined();
    const paths = parsed!.stdin.sandbox_paths as { deny_write: string[] };
    expect(paths.deny_write).not.toContain("/model/tried/this");
    expect(paths.deny_write.some((p) => p.endsWith("/.rune/hooks"))).toBe(true);
  });

  test("excluded and fallback runs omit --sandbox and carry no path policy", async () => {
    setSandboxPolicy({ excludedCommands: ["adb *"] });
    const excluded = await run({ command: "adb devices" });
    expect(excluded.parsed!.argv).not.toContain("--sandbox");
    expect(excluded.parsed!.stdin.sandbox_paths).toBeUndefined();
    const fallback = await run({ command: "make", unsandboxed: true });
    expect(fallback.parsed!.argv).not.toContain("--sandbox");
    expect(fallback.parsed!.stdin.unsandboxed).toBeUndefined();
  });

  test("strict refuses unsandboxed before anything is spawned", async () => {
    setSandboxPolicy({ allowUnsandboxedFallback: false });
    const { out } = await run({ command: "make", unsandboxed: true });
    expect(out.success).toBe(false);
    expect(out.error).toContain("strict");
  });
});

describe("network preflight follows the launch decision", () => {
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

  test("an excluded package install is not told it has no network", async () => {
    const wrapped = withNetworkPreflight(passthrough);
    expect((await wrapped.execute(callInput({ command: "npm install" }))).success).toBe(false);
    setSandboxPolicy({ excludedCommands: ["npm *"] });
    expect((await wrapped.execute(callInput({ command: "npm install" }))).result).toBe("ran");
  });
});

describe("background shells follow the launch decision", () => {
  test("strict refuses an unsandboxed background shell", () => {
    setSandboxPolicy({ allowUnsandboxedFallback: false });
    const manager = new BackgroundShellManager("/nonexistent/rune-tools");
    expect(() => manager.start("bun run dev", "/tmp", false, { unsandboxed: true })).toThrow(
      /strict/,
    );
    expect(manager.list()).toEqual([]);
  });
});

describe("bash description states the policy", () => {
  test("excluded patterns and the override are visible to the model", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, "/nonexistent-rune-tools");
    const schema = registry.get("bash")!.schema;
    const props = () => schema.inputSchema.properties as Record<string, { description: string }>;
    expect(props().unsandboxed.description).toContain("regular permission prompt");
    setSandboxPolicy({ excludedCommands: ["adb *"], allowUnsandboxedFallback: false });
    expect(schema.description).toContain("adb *");
    expect(props().unsandboxed.description).toContain("strict");
    setSandboxMode("off");
    expect(props().unsandboxed.description).toContain("No effect");
  });
});
