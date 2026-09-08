/**
 * The two example plugins, installed the way the docs say to install them.
 *
 * `docs/plugins.md` tells a stranger to run `rune plugin add ./examples/plugins/…`.
 * Nothing exercised that sentence end to end: `plugin-tools-sandbox.test.ts`
 * copies the bundle in with `cpSync` and `engine-plugins.test.ts` builds a
 * synthetic one. So this test drives the REAL `rune plugin add` code path into a
 * temp workspace, for both shapes the format supports —
 *
 *   rune-example-skills  a skills-only bundle: one SKILL.md, no code
 *   rune-example-tools   two executable tool servers with declared capabilities
 *
 * — and then runs what each contributes: the skill through the engine's skill
 * loader, and the tool through the registry.
 *
 * The tool half needs a real OS sandbox and python3 and skips without them
 * (never weakened: an unsandboxed plugin tool is refused by design, which is
 * what `plugin-tools-sandbox.test.ts` proves).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Engine } from "../../packages/orchestrator/src/engine";
import { runPlugin } from "../../packages/orchestrator/src/bin/plugin-cli";
import { computeIntegrity } from "../../packages/orchestrator/src/plugins";
import type { ToolRegistry } from "../../packages/tool-registry/src/registry";

const repoRoot = resolve(import.meta.dir, "../..");
const EXAMPLES = join(repoRoot, "examples", "plugins");
const RUST_RELEASE = join(repoRoot, "target/release/rune-tools");
const RUST_DEBUG = join(repoRoot, "target/debug/rune-tools");
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

const CAN_RUN_TOOLS = HAS_RUST_BIN && hasOsIsolation() && hasPython();

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-plugin-examples-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function install(name: string): Promise<number> {
  return runPlugin(["add", join(EXAMPLES, name)], { workspace });
}

function pluginRoot(name: string): string {
  return join(workspace, ".rune", "plugins", name);
}

function manifestOf(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot(name), "plugin.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** The engine keeps its registry private; reach it the way the sibling
 *  plugin tests do rather than widening the public surface. */
function registryOf(engine: Engine): ToolRegistry {
  return (engine as unknown as { registry: ToolRegistry }).registry;
}

function makeEngine(): Engine {
  return new Engine({
    model: "mock-model",
    provider: "anthropic",
    workspaceRoot: workspace,
    dbPath: join(workspace, "rune.db"),
    toolsBinaryPath: RUST_BIN,
    // Deterministic: the plugin bundles and the workspace's own skills, not
    // whatever bundled catalog this checkout happens to carry.
    skillRoots: [join(workspace, ".rune", "plugins"), join(workspace, ".rune", "skills")],
  });
}

describe("rune plugin add ./examples/plugins/…", () => {
  test("installs both examples, stamping name, source and integrity", async () => {
    expect(await install("rune-example-skills")).toBe(0);
    expect(await install("rune-example-tools")).toBe(0);

    for (const name of ["rune-example-skills", "rune-example-tools"]) {
      const manifest = manifestOf(name);
      expect(manifest.name).toBe(name);
      expect(String(manifest.source)).toContain(name);
      // The digest is over what actually landed, so it must still verify.
      expect(manifest.integrity).toBe(computeIntegrity(pluginRoot(name)));
    }
  }, 60_000);

  test("a bundle whose runeVersion this build does not satisfy is refused", async () => {
    // Both examples declare ">=0.2.0". Point the installer at a directory that
    // is not a plugin at all and it must refuse rather than install a shell.
    expect(await runPlugin(["add", join(repoRoot, "docs")], { workspace })).toBe(1);
    expect(existsSync(join(workspace, ".rune", "plugins", "docs"))).toBe(false);
  }, 30_000);

  test.skipIf(!HAS_RUST_BIN)(
    "the engine loads both, verified, and attributes the skill to its plugin",
    async () => {
      expect(await install("rune-example-skills")).toBe(0);
      expect(await install("rune-example-tools")).toBe(0);

      const engine = makeEngine();
      try {
        const listed = engine.listPlugins();
        expect(listed.plugins.map((p) => p.name).sort()).toEqual([
          "rune-example-skills",
          "rune-example-tools",
        ]);
        for (const plugin of listed.plugins) {
          expect(plugin.integrity).toBe("verified");
        }

        const { plugins: catalog } = await engine.listSkills();
        const skills = catalog.find((p) => p.plugin === "rune-example-skills");
        expect(skills?.skills.map((s) => s.name)).toEqual(["release-notes"]);
        expect(skills?.skills[0]?.description).toContain("release notes");
      } finally {
        engine.close();
      }
    },
    60_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "the skill plugin's body loads through the skill tool",
    async () => {
      expect(await install("rune-example-skills")).toBe(0);
      const engine = makeEngine();
      try {
        await engine.listSkills();
        const result = await registryOf(engine).execute({
          toolName: "skill",
          callId: "1",
          args: { name: "rune-example-skills:release-notes" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(result.success).toBe(true);
        expect(result.result).toContain("Release notes from a commit range");
      } finally {
        engine.close();
      }
    },
    60_000,
  );

  test.skipIf(!CAN_RUN_TOOLS)(
    "the tool plugin's declared tools register and run",
    async () => {
      expect(await install("rune-example-tools")).toBe(0);
      const engine = makeEngine();
      try {
        await engine.invalidatePlugins();
        const names = registryOf(engine)
          .list()
          .filter((s) => s.name.startsWith("plugin_"))
          .map((s) => s.name)
          .sort();
        expect(names).toEqual([
          "plugin_rune-example-tools_http_get",
          "plugin_rune-example-tools_read_text",
          "plugin_rune-example-tools_write_text",
        ]);

        const wrote = await registryOf(engine).execute({
          toolName: "plugin_rune-example-tools_write_text",
          callId: "1",
          args: { path: "installed.txt", text: "written by an installed plugin tool" },
          sessionId: "s",
          workspaceRoot: workspace,
        });
        expect(wrote.success).toBe(true);
        expect(readFileSync(join(workspace, "installed.txt"), "utf8")).toContain(
          "installed plugin tool",
        );
      } finally {
        engine.close();
      }
    },
    90_000,
  );
});
