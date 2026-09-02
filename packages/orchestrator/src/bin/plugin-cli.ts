// ─── `gear plugin`: install a bundle from a path, a git URL, or npm ───
//
// Plugins existed as a directory convention with no way to get a directory
// there: `PluginDiscovery.errors` were computed and never shown, so a refused
// plugin was indistinguishable from one nobody had installed.
//
//   gear plugin add ./my-plugin          a local path
//   gear plugin add https://github.com/…  a git repository
//   gear plugin add @scope/gear-plugin-x  an npm package
//   gear plugin list                      what is installed, and what was refused
//
// Per D6, v1 plugins are DECLARATIVE: skills, commands, MCP servers, hooks.
// Nothing here installs executable tools — a manifest's `permissions` block is
// disclosure, not a sandbox, and running a stranger's code needs the latter.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { workspaceConfigPath } from "@gear/shared";
import {
  discoverPlugins,
  computeIntegrity,
  satisfiesGearVersion,
  GEAR_VERSION,
  type PluginManifest,
} from "../plugins";
import { accent, danger, dim, faint, ok, text, warn } from "./ui/theme";
import { glyph } from "./ui/glyphs";

const pad = "  ";
const say = (line = ""): void => {
  process.stdout.write(`${pad}${line}\n`);
};

function usage(): void {
  say();
  say(`${accent("gear plugin")} ${dim("— install a bundle of skills, commands, connectors and hooks")}`);
  say();
  say(`${text("Commands")}`);
  say(`  ${accent("add")} <path|git-url|npm-package> ${dim("[--name N]")}`);
  say(`  ${accent("remove")} <name>`);
  say(`  ${accent("list")}`);
  say(`  ${accent("enable")} <name> ${dim(" / ")} ${accent("disable")} <name>`);
  say();
  say(
    `  ${faint("v1 plugins are declarative: skills, commands, MCP servers, hooks. Executable")}`,
  );
  say(`  ${faint("tools stay first-party until they run under the sandbox as subprocesses.")}`);
  say();
}

function workspaceOf(values: Record<string, unknown>): string {
  return typeof values.workspace === "string" ? values.workspace : process.cwd();
}

function pluginsRoot(workspaceRoot: string): string {
  return workspaceConfigPath(workspaceRoot, "plugins");
}

function readManifest(root: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as PluginManifest;
  } catch {
    return null;
  }
}

function writeManifest(root: string, manifest: PluginManifest): void {
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// ─── Fetching a bundle ───

type Source = { kind: "path" | "git" | "npm"; spec: string };

function classifySource(spec: string): Source {
  if (/^(https?:\/\/|git@|git\+)/.test(spec) || spec.endsWith(".git")) return { kind: "git", spec };
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~") || existsSync(spec)) {
    return { kind: "path", spec };
  }
  return { kind: "npm", spec };
}

async function run(cmd: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, output: `${out}${err}`.trim() };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetch a bundle into a staging directory. Returns its path, or an error. */
async function stage(source: Source): Promise<{ dir: string } | { error: string }> {
  if (source.kind === "path") {
    const abs = isAbsolute(source.spec) ? source.spec : resolve(process.cwd(), source.spec);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      return { error: `${abs} is not a directory` };
    }
    return { dir: abs };
  }

  const staging = join(tmpdir(), `gear-plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(staging, { recursive: true });

  if (source.kind === "git") {
    const url = source.spec.replace(/^git\+/, "");
    const res = await run(["git", "clone", "--depth", "1", "--quiet", url, staging]);
    if (!res.ok) {
      rmSync(staging, { recursive: true, force: true });
      return { error: `git clone failed: ${res.output.slice(0, 300)}` };
    }
    // The repository's own history is not part of the plugin.
    rmSync(join(staging, ".git"), { recursive: true, force: true });
    return { dir: staging };
  }

  // npm: pack + extract, so nothing runs an install script.
  const res = await run(["npm", "pack", source.spec, "--pack-destination", staging], staging);
  if (!res.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { error: `npm pack failed: ${res.output.slice(0, 300)}` };
  }
  const tarball = res.output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".tgz"))
    .pop();
  if (!tarball) {
    rmSync(staging, { recursive: true, force: true });
    return { error: "npm pack produced no tarball" };
  }
  const extracted = join(staging, "unpacked");
  mkdirSync(extracted, { recursive: true });
  const untar = await run(["tar", "-xzf", join(staging, tarball), "-C", extracted]);
  if (!untar.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { error: `could not unpack: ${untar.output.slice(0, 200)}` };
  }
  // npm tarballs always root at "package/".
  const inner = join(extracted, "package");
  return { dir: existsSync(inner) ? inner : extracted };
}

// ─── add ───

async function cmdAdd(args: string[], values: Record<string, unknown>): Promise<number> {
  const spec = args[0];
  if (!spec) {
    say(`  ${danger(glyph("failure"))} usage: gear plugin add <path|git-url|npm-package>`);
    return 1;
  }
  const workspaceRoot = workspaceOf(values);
  const source = classifySource(spec);

  say();
  say(`  ${dim(`fetching (${source.kind})`)} ${spec}`);
  const staged = await stage(source);
  if ("error" in staged) {
    say(`  ${danger(glyph("failure"))} ${staged.error}`);
    say();
    return 1;
  }

  const cleanup = (): void => {
    if (source.kind !== "path" && staged.dir.startsWith(tmpdir())) {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  };

  const manifest = readManifest(staged.dir);
  if (!manifest) {
    say(`  ${danger(glyph("failure"))} no readable plugin.json at the root of that bundle`);
    cleanup();
    say();
    return 1;
  }
  const name =
    (typeof values.name === "string" && values.name) || manifest.name || basename(staged.dir);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    say(`  ${danger(glyph("failure"))} plugin name "${name}" must be letters, digits, - or _`);
    cleanup();
    return 1;
  }
  if (!satisfiesGearVersion(GEAR_VERSION, manifest.gearVersion)) {
    say(
      `  ${danger(glyph("failure"))} ${accent(name)} needs Gear ${manifest.gearVersion}, this is ${GEAR_VERSION}`,
    );
    cleanup();
    say();
    return 1;
  }

  const dest = join(pluginsRoot(workspaceRoot), name);
  const replacing = existsSync(dest);
  if (replacing) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(staged.dir, dest, { recursive: true, dereference: true });
  cleanup();

  // The manifest name must equal the directory name (discovery refuses
  // otherwise), and the integrity digest is computed over what actually landed.
  const installed: PluginManifest = { ...manifest, name, source: spec };
  delete installed.integrity;
  writeManifest(dest, installed);
  installed.integrity = computeIntegrity(dest);
  writeManifest(dest, installed);

  say(`  ${ok(glyph("verified"))} ${replacing ? "reinstalled" : "installed"} ${accent(name)}${manifest.version ? dim(` v${manifest.version}`) : ""}`);
  say(`    ${faint(dest)}`);

  const contributes: string[] = [];
  if (existsSync(join(dest, "skills"))) contributes.push("skills");
  if (manifest.mcp) contributes.push("MCP servers");
  if (manifest.commands) contributes.push("commands");
  if (manifest.hooks) contributes.push("hooks");
  if (contributes.length > 0) say(`    ${dim("contributes")} ${contributes.join(", ")}`);

  // Disclosure, not enforcement — and said plainly, because that is the whole
  // value of a declaration a sandbox does not back.
  const perms = manifest.permissions;
  if (perms && (perms.hosts?.length || perms.paths?.length || perms.blockingHooks)) {
    say();
    say(`    ${warn("declares")}`);
    if (perms.hosts?.length) say(`      ${dim("network")}  ${perms.hosts.join(", ")}`);
    if (perms.paths?.length) say(`      ${dim("paths")}    ${perms.paths.join(", ")}`);
    if (perms.blockingHooks) say(`      ${dim("hooks")}    may block a tool call`);
    say(`      ${faint("declared by the plugin, not enforced — read them before you trust it")}`);
  }

  // Prove it loads, rather than asserting it will.
  const discovery = discoverPlugins(workspaceRoot);
  const loaded = discovery.plugins.find((p) => p.name === name);
  const refusal = discovery.errors.find((e) => e.includes(`"${name}"`));
  say();
  if (loaded) {
    say(`  ${ok(glyph("verified"))} loads cleanly${loaded.integrity === "verified" ? dim(" · integrity verified") : ""}`);
  } else {
    say(`  ${danger(glyph("failure"))} installed but NOT loaded: ${refusal ?? "unknown reason"}`);
    say();
    return 1;
  }
  say();
  return 0;
}

// ─── remove / enable / disable ───

function cmdRemove(args: string[], values: Record<string, unknown>): number {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: gear plugin remove <name>`);
    return 1;
  }
  const dest = join(pluginsRoot(workspaceOf(values)), name);
  if (!existsSync(dest)) {
    say(`  ${warn(glyph("retry"))} ${accent(name)} is not installed`);
    return 1;
  }
  rmSync(dest, { recursive: true, force: true });
  say(`  ${ok(glyph("verified"))} removed ${accent(name)}`);
  return 0;
}

function cmdToggle(args: string[], values: Record<string, unknown>, enabled: boolean): number {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: gear plugin ${enabled ? "enable" : "disable"} <name>`);
    return 1;
  }
  const dest = join(pluginsRoot(workspaceOf(values)), name);
  const manifest = readManifest(dest);
  if (!manifest) {
    say(`  ${warn(glyph("retry"))} ${accent(name)} is not installed`);
    return 1;
  }
  // `enabled: true` is the default, recorded by REMOVING the flag — and the
  // integrity digest is recomputed, since the manifest is part of the tree.
  if (enabled) delete manifest.enabled;
  else manifest.enabled = false;
  delete manifest.integrity;
  writeManifest(dest, manifest);
  manifest.integrity = computeIntegrity(dest);
  writeManifest(dest, manifest);
  say(`  ${ok(glyph("verified"))} ${accent(name)} ${enabled ? "enabled" : "disabled"}`);
  if (!enabled) say(`    ${faint("the bundle is kept — only its contributions stop")}`);
  return 0;
}

// ─── list ───

function cmdList(values: Record<string, unknown>): number {
  const workspaceRoot = workspaceOf(values);
  const { plugins, errors } = discoverPlugins(workspaceRoot);

  say();
  if (plugins.length === 0 && errors.length === 0) {
    say(`  ${dim("No plugins installed.")}`);
    say(`  ${text("Add one")}  ${accent("gear plugin add ./my-plugin")}`);
    say();
    return 0;
  }

  if (plugins.length > 0) {
    say(`  ${text("Plugins")}  ${dim(`${plugins.length} loaded`)}`);
    for (const p of plugins) {
      const contributes = [
        p.hasSkills ? "skills" : "",
        Object.keys(p.mcpServers).length > 0
          ? `${Object.keys(p.mcpServers).length} connector${Object.keys(p.mcpServers).length === 1 ? "" : "s"}`
          : "",
        p.commandDirs.length > 0 ? "commands" : "",
        p.hookFiles.length > 0 ? "hooks" : "",
      ].filter(Boolean);
      say(
        `    ${accent(p.name.padEnd(18))} ${dim(p.version ? `v${p.version}` : "")} ${contributes.join(dim(" · "))}`,
      );
      if (p.description) say(`      ${faint(p.description.slice(0, 100))}`);
      const marks: string[] = [];
      if (p.integrity === "verified") marks.push(ok("integrity verified"));
      else if (p.integrity === "unset") marks.push(dim("no integrity hash"));
      if (p.source) marks.push(faint(p.source));
      if (marks.length > 0) say(`      ${marks.join(dim("  ·  "))}`);
      const perms = p.permissions;
      if (perms?.hosts?.length) say(`      ${dim("declares network")} ${perms.hosts.join(", ")}`);
      if (perms?.blockingHooks) say(`      ${dim("declares blocking hooks")}`);
    }
  }

  // The refusals. These were computed on every discovery and shown nowhere,
  // so an installed-but-refused plugin looked exactly like one that was never
  // installed — the single most confusing state this system could be in.
  if (errors.length > 0) {
    say();
    say(`  ${danger("Refused")}  ${dim(`${errors.length}`)}`);
    for (const e of errors) say(`    ${danger(glyph("failure"))} ${e}`);
  }
  say();
  return 0;
}

// ─── dispatch ───

export async function runPlugin(
  args: string[],
  values: Record<string, unknown>,
): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "add":
    case "install":
      return cmdAdd(rest, values);
    case "remove":
    case "rm":
    case "uninstall":
      return cmdRemove(rest, values);
    case "list":
    case "ls":
      return cmdList(values);
    case "enable":
      return cmdToggle(rest, values, true);
    case "disable":
      return cmdToggle(rest, values, false);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      say(`  ${danger(glyph("failure"))} unknown subcommand ${accent(sub)}`);
      usage();
      return 1;
  }
}
