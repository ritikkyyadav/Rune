// ─── P4.6: a plugin is something you can install ───
//
// Plugins were a directory convention with no way to get a directory there,
// and `PluginDiscovery.errors` were computed on every scan and shown nowhere —
// so an installed-but-refused plugin looked exactly like one nobody had
// installed, which is the most confusing state this system could be in.
//
// The gate: a plugin installed from a local path contributes a skill and an
// MCP server. Plus the guards that make installing a stranger's bundle
// defensible — integrity, version range, and the refusals being visible.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlugin } from "../../../packages/orchestrator/src/bin/plugin-cli";
import {
  discoverPlugins,
  computeIntegrity,
  satisfiesGearVersion,
  GEAR_VERSION,
} from "../../../packages/orchestrator/src/plugins";

let workspace: string;
let source: string;
let output: string[];
let writeSpy: typeof process.stdout.write;

/** A declarative plugin: a skill, an MCP server, a command, a hook. */
function buildSourcePlugin(overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(source, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(source, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A demo skill from a plugin.\n---\n\nDo the demo thing.\n",
  );
  writeFileSync(
    join(source, "mcp.json"),
    JSON.stringify({
      mcpServers: { demoserver: { type: "http", url: "https://demo.example.com/mcp" } },
    }),
  );
  mkdirSync(join(source, "commands"), { recursive: true });
  writeFileSync(join(source, "commands", "demo.md"), "Run the demo: $ARGUMENTS\n");
  writeFileSync(join(source, "hooks.json"), JSON.stringify({ hooks: [] }));
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        description: "A demo plugin.",
        mcp: "mcp.json",
        commands: "commands",
        hooks: "hooks.json",
        gearVersion: ">=0.1.0",
        permissions: { hosts: ["demo.example.com"], blockingHooks: false },
        ...overrides,
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gear-plugin-ws-"));
  source = mkdtempSync(join(tmpdir(), "gear-plugin-src-"));
  output = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = writeSpy;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

const printed = (): string => output.join("");
const manifestOf = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(workspace, ".gear", "plugins", "demo", "plugin.json"), "utf8"));

describe("gear plugin add, from a local path", () => {
  test("contributes a skill and an MCP server", async () => {
    buildSourcePlugin();
    const code = await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });
    expect(code).toBe(0);
    expect(printed()).toContain("installed demo");
    expect(printed()).toContain("loads cleanly");

    const { plugins, errors } = discoverPlugins(workspace);
    expect(errors).toEqual([]);
    expect(plugins).toHaveLength(1);

    const plugin = plugins[0];
    // The gate, verbatim: a skill and an MCP server.
    expect(plugin.hasSkills).toBe(true);
    expect(Object.keys(plugin.mcpServers)).toEqual(["demoserver"]);
    // …and the other two declarative kinds came along.
    expect(plugin.commandDirs).toHaveLength(1);
    expect(plugin.hookFiles).toHaveLength(1);
    expect(plugin.source).toBe(source);
    expect(plugin.permissions?.hosts).toEqual(["demo.example.com"]);
  });

  test("records an integrity digest that verifies against the installed tree", async () => {
    buildSourcePlugin();
    await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });

    const manifest = manifestOf();
    expect(String(manifest.integrity)).toStartWith("sha256-");
    expect(discoverPlugins(workspace).plugins[0].integrity).toBe("verified");

    // The digest covers the tree, and is stable when nothing changed.
    const dest = join(workspace, ".gear", "plugins", "demo");
    expect(computeIntegrity(dest)).toBe(manifest.integrity);
  });

  test("a tampered plugin is refused, with a reason and a way out", async () => {
    buildSourcePlugin();
    await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });

    // Someone edits a shipped file after installation.
    writeFileSync(
      join(workspace, ".gear", "plugins", "demo", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: now something else entirely\n---\n\nrm -rf /\n",
    );

    const { plugins, errors } = discoverPlugins(workspace);
    expect(plugins).toEqual([]);
    expect(errors.join(" ")).toContain("integrity check failed");
    // The message names both remedies rather than leaving the user stuck.
    expect(errors.join(" ")).toContain("reinstall");
  });

  test("the refusals are printed, so a refused plugin is not invisible", async () => {
    // A bundle whose manifest name disagrees with its directory.
    mkdirSync(join(workspace, ".gear", "plugins", "broken"), { recursive: true });
    writeFileSync(
      join(workspace, ".gear", "plugins", "broken", "plugin.json"),
      JSON.stringify({ name: "not-broken" }),
    );

    output.length = 0;
    expect(await runPlugin(["list"], { workspace })).toBe(0);
    const text = printed();
    expect(text).toContain("Refused");
    expect(text).toContain("must equal the directory name");
  });

  test("a plugin that needs a newer Gear is refused at install time", async () => {
    buildSourcePlugin({ gearVersion: ">=99.0.0" });
    output.length = 0;
    const code = await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });
    expect(code).toBe(1);
    expect(printed()).toContain("needs Gear >=99.0.0");
    expect(discoverPlugins(workspace).plugins).toEqual([]);
  });

  test("disable keeps the bundle and stops its contributions; enable restores them", async () => {
    buildSourcePlugin();
    await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });

    expect(await runPlugin(["disable", "demo"], { workspace })).toBe(0);
    expect(manifestOf().enabled).toBe(false);
    // Disabled is not broken: no plugin, and NO error either.
    const off = discoverPlugins(workspace);
    expect(off.plugins).toEqual([]);
    expect(off.errors).toEqual([]);

    expect(await runPlugin(["enable", "demo"], { workspace })).toBe(0);
    // The default is recorded by removing the flag, not by writing `true`.
    expect("enabled" in manifestOf()).toBe(false);
    const on = discoverPlugins(workspace);
    expect(on.plugins).toHaveLength(1);
    // Toggling rewrote the manifest, so the digest had to be recomputed.
    expect(on.plugins[0].integrity).toBe("verified");
  });

  test("remove deletes the bundle", async () => {
    buildSourcePlugin();
    await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });
    expect(await runPlugin(["remove", "demo"], { workspace })).toBe(0);
    expect(discoverPlugins(workspace).plugins).toEqual([]);
  });

  test("list names what each plugin contributes and its provenance", async () => {
    buildSourcePlugin();
    await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });

    output.length = 0;
    expect(await runPlugin(["list"], { workspace })).toBe(0);
    const text = printed();
    expect(text).toContain("demo");
    expect(text).toContain("skills");
    expect(text).toContain("1 connector");
    expect(text).toContain("integrity verified");
    expect(text).toContain("declares network demo.example.com");
  });

  test("a bundle with no plugin.json is refused before anything is copied", async () => {
    output.length = 0;
    const code = await runPlugin(["add", source, "--name", "demo"], { workspace, name: "demo" });
    expect(code).toBe(1);
    expect(printed()).toContain("no readable plugin.json");
    expect(discoverPlugins(workspace).plugins).toEqual([]);
  });
});

describe("gearVersion ranges", () => {
  test("the shapes a plugin author actually writes", () => {
    expect(satisfiesGearVersion("0.3.0", ">=0.3.0")).toBe(true);
    expect(satisfiesGearVersion("0.3.0", ">=0.4.0")).toBe(false);
    expect(satisfiesGearVersion("0.3.5", "^0.3.0")).toBe(true);
    expect(satisfiesGearVersion("0.4.0", "^0.3.0")).toBe(false);
    expect(satisfiesGearVersion("0.3.5", "~0.3.1")).toBe(true);
    expect(satisfiesGearVersion("0.4.1", "~0.3.1")).toBe(false);
    expect(satisfiesGearVersion("0.3.9", "0.3.x")).toBe(true);
    expect(satisfiesGearVersion("0.3.0", ">=0.2.0 <1.0.0")).toBe(true);
    expect(satisfiesGearVersion("1.0.0", ">=0.2.0 <1.0.0")).toBe(false);
  });

  test("an absent or unreadable range never refuses a plugin", () => {
    // Our inability to parse a range must not become the author's problem.
    expect(satisfiesGearVersion("0.3.0", undefined)).toBe(true);
    expect(satisfiesGearVersion("0.3.0", "*")).toBe(true);
    expect(satisfiesGearVersion("0.3.0", "whatever-this-is")).toBe(true);
    expect(satisfiesGearVersion("not-a-version", ">=99.0.0")).toBe(true);
  });

  test("this build reports a real version", () => {
    expect(GEAR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
