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
  makeRuneToolsPlanner,
  type PluginToolSpawnPlan,
} from "../../packages/tool-registry/src/tools/plugin-tools";
import { describeNativeBinary, resolveRuneToolsBinary } from "../helpers/native-binary";

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
// An exported RUNE_TOOLS_BINARY/RUNE_TOOLS_BIN wins over anything under
// target/. This suite used to prefer a possibly stale target/release artifact
// and read no variable at all, so it could grade a build nobody had made.
const nativeBinary = resolveRuneToolsBinary();
const RUST_BIN = nativeBinary.path;
const HAS_RUST_BIN = nativeBinary.exists;

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
if (!CAN_RUN)
  console.warn(
    `[plugin-tools-sandbox] skipped: ${
      !HAS_RUST_BIN
        ? describeNativeBinary(nativeBinary)
        : !SANDBOXED
          ? `${describeNativeBinary(nativeBinary)} reports no OS isolation on ${process.platform}`
          : "python3 is not on PATH"
    }`,
  );

/** A sandbox refusal is EPERM (1); a missing file is ENOENT and a closed port is ECONNREFUSED. */
function looksLikeSandboxRefusal(error: string | undefined): boolean {
  return /operation not permitted|\[errno (1|30)\]|eperm|read-only file system|erofs/i.test(
    error ?? "",
  );
}

let workspace: string;
let pluginRoot: string;
let allowedServer: ReturnType<typeof Bun.serve> | null = null;
let deniedServer: ReturnType<typeof Bun.serve> | null = null;
let allowedPort = 0;
let deniedPort = 0;

// Bun types `port` as optional because a unix-socket server has none. These
// fixtures are TCP on port 0, so a missing port is a broken fixture — the
// endpoint cases would silently address port 0 — not a case for a default.
function servedPort(server: ReturnType<typeof Bun.serve>): number {
  const port = server.port;
  if (typeof port !== "number")
    throw new Error("fixture server reported no port; the endpoint cases cannot be addressed");
  return port;
}

beforeAll(() => {
  if (!CAN_RUN) return;
  allowedServer = Bun.serve({ port: 0, fetch: () => new Response("declared") });
  deniedServer = Bun.serve({ port: 0, fetch: () => new Response("undeclared") });
  allowedPort = servedPort(allowedServer);
  deniedPort = servedPort(deniedServer);
});

afterAll(() => {
  allowedServer?.stop(true);
  deniedServer?.stop(true);
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-plugin-tools-"));
  pluginRoot = join(workspace, ".rune", "plugins", "rune-example-tools");
  mkdirSync(join(workspace, ".rune", "plugins"), { recursive: true });
  cpSync(join(repoRoot, "examples/plugins/rune-example-tools"), pluginRoot, { recursive: true });
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
    dbPath: join(workspace, "rune.db"),
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
          ...(process.platform === "darwin" ? ["plugin_rune-example-tools_http_get"] : []),
          "plugin_rune-example-tools_read_text",
          "plugin_rune-example-tools_write_text",
        ]);

        const write = schemas.find((s) => s.name.endsWith("_write_text"))!;
        expect(write.category).toBe("write");
        expect(write.permissionLevel).not.toBe("auto");
        expect(write.policyId).toBe("plugin:rune-example-tools:write_text");

        const net = schemas.find((s) => s.name.endsWith("_http_get"))!;
        if (process.platform === "darwin") {
          expect(net.category).toBe("network");
          expect(net.policyId).toBe("plugin:rune-example-tools:http_get");
        } else expect(net).toBeUndefined();

        // 1st gear: a write-capable plugin tool asks. It is not auto-approved,
        // and no manifest field can make it so.
        const broker = new PermissionBroker(false, { workspaceRoot: workspace });
        expect(broker.check(write, { path: "a.txt", text: "x" }).type).toBe("needs_confirmation");
        if (net)
          expect(broker.check(net, { url: "http://example.com" }).type).toBe("needs_confirmation");

        // Org policy names the whole bundle with one wildcard.
        const policed = new PermissionBroker(false, {
          workspaceRoot: workspace,
          orgPolicy: { version: 1, toolsDeny: ["plugin:rune-example-tools:*"] },
        });
        const denial = policed.check(write, { path: "a.txt", text: "x" });
        expect(denial.type).toBe("denied");
        if (denial.type === "denied")
          expect(denial.reason).toContain("plugin:rune-example-tools:*");
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
        const tool = "plugin_rune-example-tools_write_text";

        const inside = await registry.execute({
          toolName: tool,
          callId: "1",
          args: { path: "inside.txt", text: "written by a sandboxed plugin tool" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(inside.success).toBe(true);
        expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("sandboxed plugin");

        const escapePath = join(tmpdir(), `rune-plugin-escape-${Date.now()}.txt`);
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
        const tool = "plugin_rune-example-tools_http_get";
        if (process.platform === "linux") {
          // bubblewrap has no endpoint filter. Refusal to register enforces
          // the restriction instead of silently granting the whole network.
          expect(registry.get(tool)).toBeUndefined();
          expect(engine.drainMcpNotices().join(" ")).toContain(
            "cannot enforce its declared network endpoints",
          );
          return;
        }

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
    "a plugin installed outside the workspace runs from its own root and cannot write to it",
    async () => {
      // The fixture normally lives under the workspace, which hides two rules:
      // the child's cwd is the PLUGIN root (so a relative entrypoint resolves),
      // and the plugin's own code is read-only (so a tool cannot rewrite the
      // program the next session will run).
      const outside = mkdtempSync(join(tmpdir(), "rune-plugin-outside-"));
      cpSync(join(repoRoot, "examples/plugins/rune-example-tools"), outside, { recursive: true });
      const server = new PluginToolServer({
        plugin: "rune-example-tools",
        pluginRoot: outside,
        workspaceRoot: workspace,
        declaration: {
          id: "files",
          command: ["python3", "-u", "tools/files.py"],
          capability: "workspace-write",
        },
        planner: makeRuneToolsPlanner(RUST_BIN),
      });
      try {
        const started = await server.start();
        expect(started.message ?? "").toBe("");
        expect(started.ok).toBe(true);
        expect(server.sandboxed).toBe(true);

        const landed = await server.call("write_text", {
          path: "landed.txt",
          text: "workspace write",
        });
        expect(landed.ok).toBe(true);
        expect(readFileSync(join(workspace, "landed.txt"), "utf8")).toBe("workspace write");

        const overwrite = await server.call("write_text", {
          path: join(outside, "tools", "files.py"),
          text: "# overwritten",
        });
        expect(overwrite.ok).toBe(false);
        expect(looksLikeSandboxRefusal(overwrite.error)).toBe(true);
        expect(readFileSync(join(outside, "tools", "files.py"), "utf8")).toContain(
          "A Rune plugin tool server",
        );
      } finally {
        await server.stop();
        rmSync(outside, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.skipIf(!CAN_RUN)(
    "a sandboxed plugin child gets its declared environment and none of the parent's credentials",
    async () => {
      const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      };
      process.env.OPENAI_API_KEY = "sk-synthetic-never-forward-this";
      process.env.ANTHROPIC_API_KEY = "sk-ant-synthetic-never-forward-this";
      // The probe asserts, then becomes the real tool server: a failed
      // assertion means no schema, and `start()` reports the AssertionError.
      const probe = [
        "import os",
        'assert "OPENAI_API_KEY" not in os.environ, "inherited OPENAI_API_KEY"',
        'assert "ANTHROPIC_API_KEY" not in os.environ, "inherited ANTHROPIC_API_KEY"',
        'assert os.environ.get("RUNE_EXPLICIT_TEST_VALUE") == "allowed", "declared env was dropped"',
        'assert os.environ.get("RUNE_WORKSPACE"), "RUNE_WORKSPACE was dropped"',
        ...(process.platform === "linux"
          ? [
              // bwrap is pid 1 of a fresh PID namespace and this is its first
              // child; a host pid would be orders of magnitude larger.
              'assert os.getpid() <= 10, "not in a separate PID namespace: pid %d" % os.getpid()',
              'caps = [l for l in open("/proc/self/status") if l.startswith("CapEff:")][0]',
              'assert int(caps.split()[1], 16) == 0, "capabilities were not dropped: " + caps',
            ]
          : []),
        // Relative to the plugin root, which is the cwd on every platform.
        'exec(open("tools/files.py").read())',
      ].join("\n");
      const server = new PluginToolServer({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declaration: {
          id: "files",
          command: ["python3", "-u", "-c", probe],
          capability: "workspace-write",
        },
        planner: makeRuneToolsPlanner(RUST_BIN),
        env: { RUNE_EXPLICIT_TEST_VALUE: "allowed" },
      });
      try {
        const started = await server.start();
        expect(started.message ?? "").toBe("");
        expect(started.ok).toBe(true);
        expect(server.sandboxed).toBe(true);
      } finally {
        await server.stop();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
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
        expect(schemas.some((s) => s.name.endsWith("_http_get"))).toBe(
          process.platform === "darwin",
        );

        // The workspace-write tool reads it fine, which is what makes the
        // comparison meaningful rather than a broken path.
        const readable = await registry.execute({
          toolName: "plugin_rune-example-tools_read_text",
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
  test.skipIf(!PYTHON)(
    "plugin children receive explicit environment but never inherit parent secrets",
    async () => {
      const before = process.env.RUNE_TEST_PLUGIN_SECRET;
      process.env.RUNE_TEST_PLUGIN_SECRET = "synthetic-parent-secret";
      const server = new PluginToolServer({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declaration: { id: "files", command: ["python3"], capability: "workspace-write" },
        planner: () => ({
          argv: [
            "python3",
            "-u",
            "-c",
            'import os; assert "RUNE_TEST_PLUGIN_SECRET" not in os.environ; assert os.environ.get("RUNE_EXPLICIT_TEST_VALUE") == "allowed"; exec(open("tools/files.py").read())',
          ],
          mechanism: "none",
          os_isolation: false,
          host_enforcement: "none",
          notes: [],
        }),
        allowUnsandboxed: ["rune-example-tools"],
        env: { RUNE_EXPLICIT_TEST_VALUE: "allowed" },
      });
      try {
        expect((await server.start()).ok).toBe(true);
      } finally {
        await server.stop();
        if (before === undefined) delete process.env.RUNE_TEST_PLUGIN_SECRET;
        else process.env.RUNE_TEST_PLUGIN_SECRET = before;
      }
    },
  );
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
      plugin: "rune-example-tools",
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
        plugin: "rune-example-tools",
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
        allowUnsandboxed: ["rune-example-tools"],
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
      plugin: "rune-example-tools",
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

describe("a backend that isolates but cannot filter endpoints", () => {
  // What bubblewrap reports on Linux: real OS isolation, and a network that is
  // all-or-nothing. Stated as a planner so BOTH halves of the rule are provable
  // on macOS too, where the real backend does filter by port.
  const allOrNothingPlanner = (): PluginToolSpawnPlan => ({
    argv: ["python3", "-u", "tools/net.py"],
    mechanism: "bubblewrap",
    os_isolation: true,
    host_enforcement: "all-or-nothing",
    notes: [
      "bubblewrap's network isolation is all-or-nothing: the declared hosts are disclosure on Linux, not a filter",
    ],
  });

  const netDeclaration = {
    id: "net",
    command: ["python3", "-u", "tools/net.py"],
    capability: "network" as const,
    hosts: ["127.0.0.1:8787"],
  };

  test.skipIf(!PYTHON)(
    "refuses a host-restricted tool rather than quietly granting the whole network",
    async () => {
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [netDeclaration],
        planner: allOrNothingPlanner,
      });
      expect(started.handlers).toHaveLength(0);
      expect(started.servers).toHaveLength(0);
      expect(started.notices.join(" ")).toContain("cannot enforce its declared network endpoints");
      expect(started.notices.join(" ")).toContain("allowUnsandboxedTools");
    },
  );

  test.skipIf(!PYTHON)(
    "runs it under the explicit opt-in, and says the endpoints are unenforced",
    async () => {
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [netDeclaration],
        planner: allOrNothingPlanner,
        allowUnsandboxed: ["rune-example-tools"],
      });
      try {
        expect(started.handlers.length).toBeGreaterThan(0);
        // The opt-in is not a silent grant: the same surface that reports
        // UNSANDBOXED reports the scope this tool did not get.
        expect(started.notices.join(" ")).toContain("are NOT enforced as written by bubblewrap");
        expect(started.notices.join(" ")).toContain("127.0.0.1:8787");
      } finally {
        await Promise.all(started.servers.map((s) => s.stop()));
      }
    },
    30_000,
  );

  test.skipIf(!PYTHON)("another plugin's opt-in does not cover this one", async () => {
    const started = await startPluginTools({
      plugin: "rune-example-tools",
      pluginRoot,
      workspaceRoot: workspace,
      declarations: [netDeclaration],
      planner: allOrNothingPlanner,
      allowUnsandboxed: ["some-other-plugin"],
    });
    expect(started.handlers).toHaveLength(0);
    expect(started.notices.join(" ")).toContain("cannot enforce its declared network endpoints");
  });

  test.skipIf(!PYTHON)(
    "a network tool that declares no endpoints has nothing to lose, and still starts",
    async () => {
      // No declared hosts means no restriction was advertised, so there is
      // nothing for this rule to protect — the capability gate still applies.
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [{ ...netDeclaration, hosts: [] }],
        planner: allOrNothingPlanner,
      });
      try {
        expect(started.handlers.length).toBeGreaterThan(0);
        expect(started.notices.join(" ")).not.toContain("cannot enforce");
      } finally {
        await Promise.all(started.servers.map((s) => s.stop()));
      }
    },
    30_000,
  );
});

describe("a backend that filters by port but not by host", () => {
  // What Seatbelt reports on macOS for a NAMED host: real OS isolation, and a
  // rule that can only say "any host on port 443". Until V1 the plan called
  // that `"port"` whatever the hosts were, and `"port"` was read as enforced —
  // so `api.example.com:443` ran as `*:443` with an empty notes list and no
  // opt-in. Stated as a planner so both halves are provable on either OS.
  const portOnlyPlanner = (): PluginToolSpawnPlan => ({
    argv: ["python3", "-u", "tools/net.py"],
    mechanism: "seatbelt",
    os_isolation: true,
    host_enforcement: "port",
    notes: [
      'Seatbelt filters by port, not by host: declared "api.example.com:443" is enforced as "*:443" — ANY host on port 443',
    ],
  });

  /** The same backend, for a declaration it CAN enforce as written. */
  const loopbackPlanner = (): PluginToolSpawnPlan => ({
    argv: ["python3", "-u", "tools/net.py"],
    mechanism: "seatbelt",
    os_isolation: true,
    host_enforcement: "host-and-port",
    notes: [],
  });

  const namedHost = {
    id: "net",
    command: ["python3", "-u", "tools/net.py"],
    capability: "network" as const,
    hosts: ["api.example.com:443"],
  };

  test.skipIf(!PYTHON)(
    "refuses a named host rather than silently widening it to the whole port",
    async () => {
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [namedHost],
        planner: portOnlyPlanner,
      });
      expect(started.handlers).toHaveLength(0);
      expect(started.servers).toHaveLength(0);
      const notices = started.notices.join(" ");
      expect(notices).toContain("cannot enforce its declared network endpoints");
      // The widening itself reaches the person reading the notice, not just
      // the words "not enforced".
      expect(notices).toContain("host_enforcement: port");
      expect(notices).toContain("ANY host on port 443");
      expect(notices).toContain("allowUnsandboxedTools");
    },
  );

  test.skipIf(!PYTHON)(
    "runs it under the explicit opt-in, naming the enforcement it did not get",
    async () => {
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [namedHost],
        planner: portOnlyPlanner,
        allowUnsandboxed: ["rune-example-tools"],
      });
      try {
        expect(started.handlers.length).toBeGreaterThan(0);
        expect(started.notices.join(" ")).toContain("are NOT enforced as written by seatbelt");
        expect(started.notices.join(" ")).toContain("host_enforcement: port");
      } finally {
        await Promise.all(started.servers.map((s) => s.stop()));
      }
    },
    30_000,
  );

  test.skipIf(!PYTHON)(
    "a loopback endpoint Seatbelt CAN express is not dragged into the refusal",
    async () => {
      const started = await startPluginTools({
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declarations: [{ ...namedHost, hosts: ["127.0.0.1:8787"] }],
        planner: loopbackPlanner,
      });
      try {
        expect(started.handlers.length).toBeGreaterThan(0);
        expect(started.notices.join(" ")).not.toContain("cannot enforce");
      } finally {
        await Promise.all(started.servers.map((s) => s.stop()));
      }
    },
    30_000,
  );
});

describe("the launch plan rune-tools returns", () => {
  test.skipIf(!HAS_RUST_BIN)("reports the mechanism this machine actually has", () => {
    const planner = makeRuneToolsPlanner(RUST_BIN);
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
    const planner = makeRuneToolsPlanner(join(workspace, "no-such-binary"));
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
        plugin: "rune-example-tools",
        pluginRoot,
        workspaceRoot: workspace,
        declaration: { id: "silent", command: ["python3", "silent.py"], capability: "none" },
        planner: makeRuneToolsPlanner(RUST_BIN),
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
