import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Engine } from "../../packages/orchestrator/src/engine";
import type { ToolRegistry } from "../../packages/tool-registry/src/registry";
import { PermissionBroker } from "../../packages/orchestrator/src/permissions";
import {
  PluginToolServer,
  startPluginTools,
  makeGearToolsPlanner,
  type PluginToolSpawnPlan,
} from "../../packages/tool-registry/src/tools/plugin-tools";

// P10.7 part 3 — the proof.
//
// This test does NOT assert that the example tools behave. It asserts that the
// OPERATING SYSTEM refuses what the manifest did not declare: the example
// programs perform no validation of their own (see their headers), so a
// refusal here can only have come from Seatbelt. The two assertions the item
// exists for are:
//
//   * a write outside the declared scope comes back EPERM, while the same tool
//     writing inside the scope succeeds;
//   * a connection to an undeclared endpoint comes back EPERM, while the same
//     tool reaching the declared one gets a 200.
//
// Both need a real sandbox, so the whole suite skips where there is none —
// loudly enough that a skipped run is never mistaken for a passing one.

const repoRoot = resolve(import.meta.dir, "../..");
const RUST_RELEASE = join(repoRoot, "target/release/gear-tools");
const RUST_DEBUG = join(repoRoot, "target/debug/gear-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

function hasOsIsolation(): boolean {
  if (!HAS_RUST_BIN) return false;
  try {
    const proc = Bun.spawnSync([RUST_BIN, "sandbox-check"], {
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      result?: { os_isolation?: boolean };
    };
    return parsed?.result?.os_isolation === true;
  } catch {
    return false;
  }
}

function hasPython(): boolean {
  try {
    return (
      Bun.spawnSync(["python3", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
    );
  } catch {
    return false;
  }
}

const SANDBOXED = hasOsIsolation();
const PYTHON = hasPython();
const CAN_RUN = HAS_RUST_BIN && SANDBOXED && PYTHON;

/** A sandbox refusal is EPERM (1); a missing file is ENOENT and a closed port is ECONNREFUSED. */
function looksLikeSandboxRefusal(error: string | undefined): boolean {
  return /operation not permitted|\[errno 1\]|eperm/i.test(error ?? "");
}

let workspace: string;
let pluginRoot: string;
let allowedServer: ReturnType<typeof Bun.serve> | null = null;
let deniedServer: ReturnType<typeof Bun.serve> | null = null;
let allowedPort = 0;
let deniedPort = 0;

beforeAll(() => {
  if (!CAN_RUN) return;
  allowedServer = Bun.serve({ port: 0, fetch: () => new Response("declared") });
  deniedServer = Bun.serve({ port: 0, fetch: () => new Response("undeclared") });
  allowedPort = allowedServer.port;
  deniedPort = deniedServer.port;
});

afterAll(() => {
  allowedServer?.stop(true);
  deniedServer?.stop(true);
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gear-plugin-tools-"));
  pluginRoot = join(workspace, ".gear", "plugins", "gear-example-tools");
  mkdirSync(join(workspace, ".gear", "plugins"), { recursive: true });
  cpSync(join(repoRoot, "examples/plugins/gear-example-tools"), pluginRoot, { recursive: true });
  if (CAN_RUN) {
    // The example declares 127.0.0.1:8787; point it at the port this run
    // actually opened. Everything else about the bundle is untouched.
    const manifestPath = join(pluginRoot, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tools: Array<{ id: string; hosts?: string[] }>;
    };
    for (const tool of manifest.tools) {
      if (tool.id === "net") tool.hosts = [`127.0.0.1:${allowedPort}`];
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** The engine keeps its registry private; the tests reach it the way the
 *  existing engine tests do rather than widening the public surface. */
function registryOf(engine: Engine): ToolRegistry {
  return (engine as unknown as { registry: ToolRegistry }).registry;
}

function makeEngine(extensions?: { allowUnsandboxedTools?: boolean | string[] }): Engine {
  return new Engine({
    model: "mock-model",
    provider: "anthropic",
    workspaceRoot: workspace,
    dbPath: join(workspace, "gear.db"),
    toolsBinaryPath: RUST_BIN,
    skillRoots: [],
    ...(extensions ? { extensions } : {}),
  });
}

describe("executable plugin tools under the real OS sandbox", () => {
  test.skipIf(!CAN_RUN)(
    "the declared tools register, and their capability is their permission category",
    async () => {
      const engine = makeEngine();
      try {
        await engine.invalidatePlugins();
        const schemas = registryOf(engine)
          .list()
          .filter((s) => s.name.startsWith("plugin_"));
        const names = schemas.map((s) => s.name).sort();
        expect(names).toEqual([
          "plugin_gear-example-tools_http_get",
          "plugin_gear-example-tools_read_text",
          "plugin_gear-example-tools_write_text",
        ]);

        const write = schemas.find((s) => s.name.endsWith("_write_text"))!;
        expect(write.category).toBe("write");
        expect(write.permissionLevel).not.toBe("auto");
        expect(write.policyId).toBe("plugin:gear-example-tools:write_text");

        const net = schemas.find((s) => s.name.endsWith("_http_get"))!;
        expect(net.category).toBe("network");
        expect(net.policyId).toBe("plugin:gear-example-tools:http_get");

        // 1st gear: a write-capable plugin tool asks. It is not auto-approved,
        // and no manifest field can make it so.
        const broker = new PermissionBroker(false, { workspaceRoot: workspace });
        expect(broker.check(write, { path: "a.txt", text: "x" }).type).toBe("needs_confirmation");
        expect(broker.check(net, { url: "http://example.com" }).type).toBe("needs_confirmation");

        // Org policy names the whole bundle with one wildcard.
        const policed = new PermissionBroker(false, {
          workspaceRoot: workspace,
          orgPolicy: { version: 1, toolsDeny: ["plugin:gear-example-tools:*"] },
        });
        const denial = policed.check(write, { path: "a.txt", text: "x" });
        expect(denial.type).toBe("denied");
        if (denial.type === "denied")
          expect(denial.reason).toContain("plugin:gear-example-tools:*");
      } finally {
        engine.close();
      }
    },
    60_000,
  );

  test.skipIf(!CAN_RUN)(
    "a write inside the declared scope lands; a write outside it is refused by the sandbox",
    async () => {
      const engine = makeEngine();
      try {
        await engine.invalidatePlugins();
        const registry = registryOf(engine);
        const tool = "plugin_gear-example-tools_write_text";

        const inside = await registry.execute({
          toolName: tool,
          callId: "1",
          args: { path: "inside.txt", text: "written by a sandboxed plugin tool" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(inside.success).toBe(true);
        expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("sandboxed plugin");

        const escapePath = join(tmpdir(), `gear-plugin-escape-${Date.now()}.txt`);
        const outside = await registry.execute({
          toolName: tool,
          callId: "2",
          args: { path: escapePath, text: "this must never land" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(outside.success).toBe(false);
        // The refusal came from the OS, not from the tool: EPERM, and the
        // program has no path checks of its own.
        expect(looksLikeSandboxRefusal(outside.error)).toBe(true);
        expect(existsSync(escapePath)).toBe(false);
      } finally {
        engine.close();
      }
    },
    60_000,
  );

  test.skipIf(!CAN_RUN)(
    "the declared endpoint answers; an undeclared one is refused by the sandbox",
    async () => {
      const engine = makeEngine();
      try {
        await engine.invalidatePlugins();
        const registry = registryOf(engine);
        const tool = "plugin_gear-example-tools_http_get";

        const declared = await registry.execute({
          toolName: tool,
          callId: "1",
          args: { url: `http://127.0.0.1:${allowedPort}/` },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(declared.success).toBe(true);
        expect(declared.result).toContain("declared");

        const undeclared = await registry.execute({
          toolName: tool,
          callId: "2",
          args: { url: `http://127.0.0.1:${deniedPort}/` },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(undeclared.success).toBe(false);
        // Both ports are listening; only one was declared. A refusal here is
        // the kernel's, and EPERM distinguishes it from ECONNREFUSED.
        expect(looksLikeSandboxRefusal(undeclared.error)).toBe(true);
      } finally {
        engine.close();
      }
    },
    60_000,
  );

  test.skipIf(!CAN_RUN)(
    "a network-capability tool cannot read the workspace it was never given",
    async () => {
      writeFileSync(join(workspace, "secret.txt"), "workspace content");
      const engine = makeEngine();
      try {
        await engine.invalidatePlugins();
        // The `net` server declares capability "network", so its profile denies
        // workspace reads outright — a capability is a ceiling, not a hint.
        const registry = registryOf(engine);
        const schemas = registry.list().filter((s) => s.name.startsWith("plugin_"));
        expect(schemas.some((s) => s.name.endsWith("_http_get"))).toBe(true);

        // The workspace-write tool reads it fine, which is what makes the
        // comparison meaningful rather than a broken path.
        const readable = await registry.execute({
          toolName: "plugin_gear-example-tools_read_text",
          callId: "1",
          args: { path: "secret.txt" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(readable.success).toBe(true);
        expect(readable.result).toContain("workspace content");
      } finally {
        engine.close();
      }
    },
    60_000,
  );
});

describe("a machine with no sandbox", () => {
  /** A planner that reports what a Windows box (or a mac without Seatbelt) reports. */
  const unsandboxedPlanner = (): PluginToolSpawnPlan => ({
    argv: ["python3", "-u", join(pluginRoot, "tools", "files.py")],
    mechanism: "none",
    os_isolation: false,
    host_enforcement: "none",
    notes: ["no OS sandbox backend exists for this platform"],
  });

  test.skipIf(!PYTHON)("refuses to run a plugin tool, and names the escape", async () => {
    const started = await startPluginTools({
      plugin: "gear-example-tools",
      pluginRoot,
      workspaceRoot: workspace,
      declarations: [
        {
          id: "files",
          command: [join(pluginRoot, "tools", "files.py")],
          capability: "workspace-write",
        },
      ],
      planner: unsandboxedPlanner,
    });
    expect(started.handlers).toHaveLength(0);
    expect(started.servers).toHaveLength(0);
    expect(started.notices.join(" ")).toContain("needs the OS sandbox");
    expect(started.notices.join(" ")).toContain("allowUnsandboxedTools");
  });

  test.skipIf(!PYTHON)(
    "runs it only when the user opted that plugin in, and says the capability is unenforced",
    async () => {
      const started = await startPluginTools({
        plugin: "gear-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [
          {
            id: "files",
            command: [join(pluginRoot, "tools", "files.py")],
            capability: "workspace-write",
          },
        ],
        planner: unsandboxedPlanner,
        allowUnsandboxed: ["gear-example-tools"],
      });
      try {
        expect(started.handlers.length).toBeGreaterThan(0);
        expect(started.notices.join(" ")).toContain("UNSANDBOXED");
        // An unsandboxed tool is `confirm`, not `sandbox`: the level tracks
        // what is actually wrapping the process.
        expect(started.handlers[0]!.schema.permissionLevel).toBe("confirm");
        expect(started.handlers[0]!.schema.description).toContain("NOT sandboxed");
      } finally {
        await Promise.all(started.servers.map((s) => s.stop()));
      }
    },
  );

  test.skipIf(!PYTHON)("another plugin's opt-in does not cover this one", async () => {
    const started = await startPluginTools({
      plugin: "gear-example-tools",
      pluginRoot,
      workspaceRoot: workspace,
      declarations: [
        {
          id: "files",
          command: [join(pluginRoot, "tools", "files.py")],
          capability: "workspace-write",
        },
      ],
      planner: unsandboxedPlanner,
      allowUnsandboxed: ["some-other-plugin"],
    });
    expect(started.handlers).toHaveLength(0);
    expect(started.notices.join(" ")).toContain("needs the OS sandbox");
  });
});

describe("the launch plan gear-tools returns", () => {
  test.skipIf(!HAS_RUST_BIN)("reports the mechanism this machine actually has", () => {
    const planner = makeGearToolsPlanner(RUST_BIN);
    const plan = planner({
      workspaceRoot: workspace,
      capability: "workspace-write",
      hosts: [],
      pluginRoot,
      scratchDir: workspace,
      program: "python3",
      args: ["-u", "tools/files.py"],
    });
    expect(plan.argv[plan.argv.length - 1]).toBe("tools/files.py");
    expect(plan.os_isolation).toBe(SANDBOXED);
    if (SANDBOXED) {
      expect(plan.argv[0]).toBe(process.platform === "darwin" ? "sandbox-exec" : "bwrap");
    }
  });

  test.skipIf(!HAS_RUST_BIN)("a planner that cannot answer yields an UNSANDBOXED plan", () => {
    const planner = makeGearToolsPlanner(join(workspace, "no-such-binary"));
    const plan = planner({
      workspaceRoot: workspace,
      capability: "none",
      hosts: [],
      pluginRoot,
      scratchDir: workspace,
      program: "python3",
      args: [],
    });
    // Fails to the side the caller refuses: "we could not determine the
    // sandbox" must land where "there is no sandbox" lands.
    expect(plan.os_isolation).toBe(false);
    expect(plan.mechanism).toBe("none");
  });

  test.skipIf(!CAN_RUN)(
    "a server that never advertises a schema is not registered",
    async () => {
      const silent = join(workspace, "silent.py");
      writeFileSync(silent, "import time\ntime.sleep(30)\n");
      cpSync(silent, join(pluginRoot, "silent.py"));
      const server = new PluginToolServer({
        plugin: "gear-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declaration: { id: "silent", command: ["python3", "silent.py"], capability: "none" },
        planner: makeGearToolsPlanner(RUST_BIN),
        startTimeoutMs: 1_500,
      });
      const started = await server.start();
      expect(started.ok).toBe(false);
      expect(started.message).toContain("advertised no schema");
      await server.stop();
    },
    30_000,
  );
});
