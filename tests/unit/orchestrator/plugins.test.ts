import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPlugins } from "../../../packages/orchestrator/src/plugins";
import { loadHookConfig } from "../../../packages/orchestrator/src/hooks";
import { loadCommands } from "../../../packages/orchestrator/src/commands";

// P8: plugin bundles — one directory shipping skills + hooks + MCP + commands,
// merged into the four existing loaders with provenance; uninstall = rm -r;
// conflicts refuse with a clear error instead of silently shadowing.

let workspace: string;

function installPlugin(
  name: string,
  parts: {
    manifest?: Record<string, unknown>;
    hooks?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
    command?: { file: string; body: string };
    skill?: { id: string; description: string };
  } = {},
): string {
  const root = join(workspace, ".rune", "plugins", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      description: `${name} test plugin`,
      ...(parts.hooks ? { hooks: "hooks.json" } : {}),
      ...(parts.mcp ? { mcp: "mcp.json" } : {}),
      ...(parts.command ? { commands: "commands" } : {}),
      ...parts.manifest,
    }),
  );
  if (parts.hooks) writeFileSync(join(root, "hooks.json"), JSON.stringify(parts.hooks));
  if (parts.mcp) writeFileSync(join(root, "mcp.json"), JSON.stringify(parts.mcp));
  if (parts.command) {
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", parts.command.file), parts.command.body);
  }
  if (parts.skill) {
    const skillDir = join(root, "skills", parts.skill.id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${parts.skill.id}\ndescription: ${parts.skill.description}\n---\n\nDo the thing.\n`,
    );
  }
  return root;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-plugins-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("discoverPlugins", () => {
  test("a full bundle loads with every part resolved and attributed", () => {
    installPlugin("acme-tools", {
      hooks: { postToolUse: [{ command: "echo hooked" }] },
      mcp: { mcpServers: { "acme-db": { command: "acme-mcp", args: [] } } },
      command: { file: "ship.md", body: "---\ndescription: ship it\n---\nShip $ARGUMENTS" },
      skill: { id: "deploy", description: "Deploys the acme stack" },
    });

    const { plugins, errors } = discoverPlugins(workspace);
    expect(errors).toEqual([]);
    expect(plugins).toHaveLength(1);
    const p = plugins[0];
    expect(p.name).toBe("acme-tools");
    expect(p.hookFiles).toHaveLength(1);
    expect(Object.keys(p.mcpServers)).toEqual(["acme-db"]);
    expect(p.commandDirs).toHaveLength(1);
    expect(p.hasSkills).toBe(true);
  });

  test("uninstall = delete the directory", () => {
    const root = installPlugin("temp-plugin", {
      command: { file: "x.md", body: "do x" },
    });
    expect(discoverPlugins(workspace).plugins).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
    expect(discoverPlugins(workspace).plugins).toHaveLength(0);
  });

  test("manifest/dir name mismatch, missing declared files, and bad JSON all refuse", () => {
    installPlugin("wrong-name", { manifest: { name: "other-name" } });
    installPlugin("missing-hooks", { manifest: { hooks: "nope.json" } });
    const badRoot = join(workspace, ".rune", "plugins", "bad-json");
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(join(badRoot, "plugin.json"), "{not json");

    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toHaveLength(0);
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/must equal the directory name/);
    expect(errors.join("\n")).toMatch(/missing or escapes/);
    expect(errors.join("\n")).toMatch(/not valid JSON/);
  });

  test("two plugins claiming the same MCP server name: second refuses", () => {
    installPlugin("first", { mcp: { mcpServers: { shared: { command: "a" } } } });
    installPlugin("second", { mcp: { mcpServers: { shared: { command: "b" } } } });

    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins.map((p) => p.name)).toEqual(["first"]);
    expect(errors.join("\n")).toMatch(/already provided by plugin "first"/);
  });

  test("a manifest path escaping the plugin dir refuses", () => {
    installPlugin("escapee", { manifest: { hooks: "../../../hooks.json" } });
    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toHaveLength(0);
    expect(errors.join("\n")).toMatch(/escapes the plugin/);
  });
});

describe("loader merges", () => {
  test("plugin hooks concatenate AFTER workspace hooks", async () => {
    mkdirSync(join(workspace, ".rune"), { recursive: true });
    writeFileSync(
      join(workspace, ".rune", "hooks.json"),
      JSON.stringify({ postToolUse: [{ command: "echo user-hook" }] }),
    );
    installPlugin("hooky", { hooks: { postToolUse: [{ command: "echo plugin-hook" }] } });

    const { plugins } = discoverPlugins(workspace);
    const config = await loadHookConfig(workspace, plugins[0].hookFiles);
    expect(config.postToolUse?.map((h) => h.command)).toEqual([
      "echo user-hook",
      "echo plugin-hook",
    ]);
  });

  test("plugin commands are tagged; user names win; plugin conflicts refuse", async () => {
    mkdirSync(join(workspace, ".rune", "commands"), { recursive: true });
    writeFileSync(join(workspace, ".rune", "commands", "ship.md"), "user ship");
    installPlugin("shipper", {
      command: { file: "ship.md", body: "plugin ship" },
    });
    installPlugin("deployer", {
      command: { file: "deploy.md", body: "plugin deploy" },
    });

    const { plugins } = discoverPlugins(workspace);
    const dirs = plugins.flatMap((p) => p.commandDirs.map((dir) => ({ dir, source: p.name })));
    const commands = await loadCommands(workspace, dirs);

    const ship = commands.find((c) => c.name === "ship");
    expect(ship?.source).toBe("user"); // user command won the conflict
    expect(ship?.render("")).toContain("user ship");
    const deploy = commands.find((c) => c.name === "deploy");
    expect(deploy?.source).toBe("deployer");
  });
});

// P10.7 (D6 v2): a manifest may declare executable tool servers. Discovery
// validates them and refuses the WHOLE bundle on a malformed one — half a tool
// manifest is where a capability the author meant to declare is not the one
// enforced.
describe("executable tool declarations", () => {
  function withTools(name: string, tools: unknown): void {
    const root = installPlugin(name, { manifest: { tools } });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools", "run.py"), "print('hi')\n");
  }

  test("a valid declaration is loaded and its program resolved inside the plugin", () => {
    withTools("acme-exec", [
      { id: "files", command: ["python3", "-u", "tools/run.py"], capability: "workspace-write" },
    ]);
    const { plugins, errors } = discoverPlugins(workspace);
    expect(errors).toEqual([]);
    const decls = plugins[0]!.toolDeclarations;
    expect(decls).toHaveLength(1);
    expect(decls[0]!.capability).toBe("workspace-write");
    // A bare interpreter name stays a PATH lookup; a plugin cannot ship a runtime.
    expect(decls[0]!.command[0]).toBe("python3");
    expect(decls[0]!.command).toContain("tools/run.py");
  });

  test("a program path inside the plugin is resolved to an absolute path", () => {
    withTools("acme-script", [
      { id: "files", command: ["tools/run.py"], capability: "workspace-read" },
    ]);
    const { plugins, errors } = discoverPlugins(workspace);
    expect(errors).toEqual([]);
    expect(plugins[0]!.toolDeclarations[0]!.command[0]).toBe(
      join(workspace, ".rune", "plugins", "acme-script", "tools", "run.py"),
    );
  });

  test("an absolute or escaping program refuses the bundle", () => {
    withTools("acme-escape", [{ id: "evil", command: ["/bin/sh"], capability: "none" }]);
    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toHaveLength(0);
    expect(errors.join(" ")).toContain("escapes the plugin directory");

    rmSync(join(workspace, ".rune", "plugins", "acme-escape"), { recursive: true, force: true });
    withTools("acme-updir", [{ id: "evil", command: ["../../../etc/passwd"], capability: "none" }]);
    expect(discoverPlugins(workspace).plugins).toHaveLength(0);
  });

  test("a malformed declaration refuses the whole bundle, with the reason", () => {
    withTools("acme-bad", [
      { id: "files", command: ["python3", "tools/run.py"], capability: "workspace-write" },
      { id: "net", command: ["python3", "tools/run.py"], capability: "network" },
    ]);
    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toHaveLength(0);
    expect(errors.join(" ")).toContain("lists no hosts");
  });

  test("a non-array `tools` is refused rather than ignored", () => {
    installPlugin("acme-nonarray", { manifest: { tools: { id: "x" } } });
    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toHaveLength(0);
    expect(errors.join(" ")).toContain('"tools" must be an array');
  });

  test("a plugin with no `tools` key declares none, and still loads", () => {
    installPlugin("acme-plain", {});
    const { plugins, errors } = discoverPlugins(workspace);
    expect(errors).toEqual([]);
    expect(plugins[0]!.toolDeclarations).toEqual([]);
  });
});
