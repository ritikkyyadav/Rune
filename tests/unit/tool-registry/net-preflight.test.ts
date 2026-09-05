/**
 * Sandboxed-bash network preflight: known network commands fail in ~0ms with
 * the teaching error instead of hanging to the 120s deny-net timeout (live
 * failure 2026-07-07: sandboxed `npm install` burned exactly 120,031ms).
 */

import { describe, test, expect } from "bun:test";
import {
  needsNetwork,
  withNetworkPreflight,
} from "../../../packages/tool-registry/src/tools/net-preflight";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

// The preflight only fires when deny-net is REAL — model a machine with an
// OS isolation backend, or every "blocked" expectation would be a false claim.
setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

describe("needsNetwork — pattern precision", () => {
  test("catches the well-known network commands", () => {
    expect(needsNetwork("npm install")).toBe("package install");
    expect(needsNetwork("npm i express")).toBe("package install");
    expect(needsNetwork("cd app && npm ci")).toBe("package install");
    expect(needsNetwork("bun add zod")).toBe("package install");
    expect(needsNetwork("pip install requests")).toBe("pip install");
    expect(needsNetwork("python3 -m pip install flask")).toBe("pip install");
    expect(needsNetwork("cargo install ripgrep")).toBe("cargo fetch");
    expect(needsNetwork("git push origin main")).toBe("git remote operation");
    expect(needsNetwork("git clone https://github.com/a/b")).toBe("git remote operation");
    expect(needsNetwork("curl -s https://api.example.com")).toBe("HTTP request");
    expect(needsNetwork("wget https://x.dev/f.tar.gz")).toBe("HTTP request");
    expect(needsNetwork("gh pr create --fill")).toBe("GitHub/GitLab CLI call");
    expect(needsNetwork("brew install jq")).toBe("brew install");
    expect(needsNetwork("go get golang.org/x/mod")).toBe("go get");
    expect(needsNetwork("sudo apt-get install ffmpeg")).toBe("system package install");
  });

  test("leaves offline work alone (no false positives)", () => {
    expect(needsNetwork("npm run build")).toBeNull();
    expect(needsNetwork("npm test")).toBeNull();
    expect(needsNetwork("npm run start")).toBeNull();
    expect(needsNetwork("node server.js")).toBeNull();
    expect(needsNetwork("git status && git diff")).toBeNull();
    expect(needsNetwork("git commit -m 'x'")).toBeNull();
    expect(needsNetwork("cargo build --release")).toBeNull();
    expect(needsNetwork("cargo test")).toBeNull();
    expect(needsNetwork("go build ./...")).toBeNull();
    expect(needsNetwork("grep -r install src/")).toBeNull();
    expect(needsNetwork("echo npm install")).toBeNull();
    expect(needsNetwork("gh --version")).toBeNull();
    expect(needsNetwork("npx tsc --noEmit")).toBeNull(); // npx may be local — never block
  });

  test("respects explicit offline flags", () => {
    expect(needsNetwork("npm install --offline")).toBeNull();
    expect(needsNetwork("yarn install --prefer-offline")).toBeNull();
  });
});

function fakeBash(): { handler: ToolHandler; calls: number } {
  const state = { calls: 0 };
  const handler: ToolHandler = {
    schema: {
      name: "bash",
      version: "0.1.0",
      description: "",
      inputSchema: {},
      permissionLevel: "sandbox",
      category: "execute",
    },
    validate: () => ({ valid: true }),
    execute: async (input: ToolCallInput) => {
      state.calls++;
      return {
        callId: input.callId,
        toolName: "bash",
        success: true,
        result: "ran",
        durationMs: 1,
      };
    },
  };
  return {
    handler,
    get calls() {
      return state.calls;
    },
  } as any;
}

function input(args: Record<string, unknown>): ToolCallInput {
  return { toolName: "bash", callId: "c", args, sessionId: "s", workspaceRoot: "/tmp" };
}

describe("withNetworkPreflight — wrapper behavior", () => {
  test("sandboxed npm install is blocked instantly with the teaching error", async () => {
    const fake = fakeBash();
    const wrapped = withNetworkPreflight(fake.handler);
    const out = await wrapped.execute(input({ command: "npm install" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("network: true");
    expect(out.durationMs).toBe(0);
    expect(fake.calls).toBe(0); // never reached the real handler
  });

  test("network: true passes straight through", async () => {
    const fake = fakeBash();
    const wrapped = withNetworkPreflight(fake.handler);
    const out = await wrapped.execute(input({ command: "npm install", network: true }));
    expect(out.success).toBe(true);
    expect(fake.calls).toBe(1);
  });

  test("run_in_background (unsandboxed) passes straight through", async () => {
    const fake = fakeBash();
    const wrapped = withNetworkPreflight(fake.handler);
    const out = await wrapped.execute(input({ command: "git pull", run_in_background: true }));
    expect(out.success).toBe(true);
    expect(fake.calls).toBe(1);
  });

  test("offline commands are untouched", async () => {
    const fake = fakeBash();
    const wrapped = withNetworkPreflight(fake.handler);
    const out = await wrapped.execute(input({ command: "npm run build && node server.js" }));
    expect(out.success).toBe(true);
    expect(fake.calls).toBe(1);
  });

  test("RUNE_NET_PREFLIGHT=0 disables the check", async () => {
    process.env.RUNE_NET_PREFLIGHT = "0";
    try {
      const fake = fakeBash();
      const wrapped = withNetworkPreflight(fake.handler);
      const out = await wrapped.execute(input({ command: "npm install" }));
      expect(out.success).toBe(true);
      expect(fake.calls).toBe(1);
    } finally {
      delete process.env.RUNE_NET_PREFLIGHT;
    }
  });
});
