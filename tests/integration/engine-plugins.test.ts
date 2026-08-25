import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../../packages/orchestrator/src/engine";

const RUST_RELEASE = join(import.meta.dir, "../../target/release/gear-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/gear-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

// P8 end-to-end: a plugin dropped into .gear/plugins surfaces its skill in the
// engine's catalog, attributed to the plugin (provenance), and disappears on
// uninstall (fresh engine after rm).

describe("Engine plugin bundles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-engine-plugins-"));
    const pluginRoot = join(dir, ".gear", "plugins", "acme");
    mkdirSync(join(pluginRoot, "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "acme", description: "Acme release tools" }),
    );
    writeFileSync(
      join(pluginRoot, "skills", "release-check", "SKILL.md"),
      "---\nname: release-check\ndescription: Validates a release bundle\n---\n\nSteps here.\n",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(): Engine {
    return new Engine({
      model: "mock-model",
      provider: "anthropic",
      workspaceRoot: dir,
      dbPath: join(dir, "gear.db"),
      toolsBinaryPath: RUST_BIN,
      // Keep the boot light: no bundled catalog, just the workspace roots.
      skillRoots: [join(dir, ".gear", "plugins")],
    });
  }

  test.skipIf(!HAS_RUST_BIN)("plugin skill loads, attributed to the plugin", async () => {
    const engine = makeEngine();
    try {
      const { total, plugins } = await engine.listSkills();
      expect(total).toBe(1);
      const acme = plugins.find((p) => p.plugin === "acme");
      expect(acme).toBeDefined();
      expect(acme?.skills[0]?.name).toBe("release-check");
      expect(engine.listPlugins().plugins.map((p) => p.name)).toEqual(["acme"]);
    } finally {
      engine.close();
    }
  });

  test.skipIf(!HAS_RUST_BIN)("uninstall = delete the directory (fresh engine)", async () => {
    rmSync(join(dir, ".gear", "plugins", "acme"), { recursive: true, force: true });
    const engine = makeEngine();
    try {
      const { total } = await engine.listSkills();
      expect(total).toBe(0);
      expect(engine.listPlugins().plugins).toHaveLength(0);
    } finally {
      engine.close();
    }
  });
});
