// ─── Plugin bundles: one installable unit for skills + hooks + MCP + commands ───
//
// The four extension loaders (skills, hooks.json, mcp.json, commands/*.md)
// each work alone, but nothing ships as a unit. A plugin is a directory:
//
//   .gear/plugins/<name>/
//     plugin.json          ← manifest (name must equal the directory name)
//     skills/<s>/SKILL.md  ← auto-discovered; attributed to <name>
//     hooks.json           ← merged into the hook runner (manifest: "hooks")
//     mcp.json             ← servers merged into MCP discovery (manifest: "mcp")
//     commands/<c>.md      ← slash commands, tagged with the plugin (manifest: "commands")
//
// Install = drop the directory in. Uninstall = delete it. Provenance is the
// plugin name everywhere (skills catalog, command source, MCP server list).
// Conflicts refuse loudly: a manifest whose name mismatches its directory, a
// declared file that doesn't exist, or two plugins claiming the same MCP
// server name — each is an error surfaced to the caller, never a silent skip.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isPathInside, workspaceConfigPath } from "@gear/shared";

/**
 * This build's version, for `gearVersion` range checks.
 *
 * Read from the package manifest rather than imported from the UI's brand
 * module: the engine must not import a UI module, and a fifth hand-maintained
 * copy of the version string is exactly what Phase 1 is consolidating away.
 * Unreadable means "" — and an unparseable version makes every range check
 * pass, so a packaging quirk can never refuse a working plugin.
 */
export const GEAR_VERSION: string = (() => {
  for (const candidate of [
    join(import.meta.dir, "../package.json"),
    join(import.meta.dir, "../../package.json"),
  ]) {
    try {
      const v = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
      if (typeof v === "string" && v) return v;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
})();

/**
 * What a plugin may do (P4.6).
 *
 * Declared, not enforced by a sandbox — v1 plugins are DECLARATIVE (skills,
 * commands, MCP servers, hooks), so there is no plugin code to contain. The
 * value is disclosure: a user installing a plugin can see it wants to reach
 * three hosts and run blocking hooks BEFORE they enable it, and `gear plugin
 * list` can show it afterwards. Executable third-party tools stay out of v1
 * precisely because a declaration is not a sandbox.
 */
export interface PluginPermissions {
  /** Hosts the plugin's MCP servers are expected to reach. */
  hosts?: string[];
  /** Workspace-relative path scopes the plugin's hooks touch. */
  paths?: string[];
  /** Whether the plugin's hooks may BLOCK a tool call. */
  blockingHooks?: boolean;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** hooks.json path relative to the plugin root. */
  hooks?: string;
  /** mcp.json path relative to the plugin root (same shape: { mcpServers }). */
  mcp?: string;
  /** Command dir(s) of *.md slash commands, relative to the plugin root. */
  commands?: string | string[];
  /**
   * Semver range of Gear this plugin supports, e.g. ">=0.3.0" or "0.3.x".
   * A plugin that does not fit is refused with a reason rather than loaded and
   * left to fail somewhere less legible.
   */
  gearVersion?: string;
  permissions?: PluginPermissions;
  /** sha256 over the plugin tree, as written by `gear plugin add`. */
  integrity?: string;
  /** Where it came from: an npm spec, a git URL, or a local path. */
  source?: string;
  /** Set false to keep the bundle on disk and out of the session. */
  enabled?: boolean;
}

export interface LoadedPlugin {
  name: string;
  root: string;
  description?: string;
  version?: string;
  gearVersion?: string;
  permissions?: PluginPermissions;
  source?: string;
  /** Whether the manifest's integrity hash matched the tree on disk. */
  integrity?: "verified" | "mismatch" | "unset";
  /** Absolute hooks.json paths to merge into the hook runner. */
  hookFiles: string[];
  /** MCP servers declared by this plugin (raw config objects). */
  mcpServers: Record<string, unknown>;
  /** Absolute command directories, each tagged with this plugin's name. */
  commandDirs: string[];
  /** True when the plugin ships a skills/ tree (auto-discovered). */
  hasSkills: boolean;
}

export interface PluginDiscovery {
  plugins: LoadedPlugin[];
  /** Human-readable refusals; a listed plugin was NOT loaded (partially or at all). */
  errors: string[];
}

/** A path from a manifest must stay inside the plugin dir — a plugin that
 *  points at ../../ is either broken or hostile; refuse either way. */
function resolveInsidePlugin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = resolve(root, rel);
  // `isPathInside`, not `startsWith(root + "/")`: on Windows both sides are
  // backslash-separated, so the old shape refused every path in every plugin
  // and `gear plugin add` loaded nothing at all there (P10.2).
  return isPathInside(root, abs) ? abs : null;
}

// ─── Integrity ───

/** Files never hashed: caches and VCS metadata are not the plugin. */
const INTEGRITY_SKIP = new Set([".git", "node_modules", ".DS_Store", ".turbo"]);

/**
 * sha256 over the plugin tree: every file's workspace-relative path and its
 * bytes, in sorted order, so the digest is stable across machines and
 * checkouts. `integrity` in the manifest is excluded by construction — it is
 * computed BEFORE the field is written, and verification recomputes the same
 * way by blanking the field first.
 */
export function computeIntegrity(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (INTEGRITY_SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      hash.update(relative(root, abs).split("\\").join("/"));
      hash.update("\0");
      if (entry === "plugin.json") {
        // Hash the manifest WITHOUT its own integrity field, so writing the
        // digest into the file does not invalidate the digest.
        try {
          const parsed = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
          delete parsed.integrity;
          hash.update(JSON.stringify(parsed, Object.keys(parsed).sort()));
        } catch {
          hash.update(readFileSync(abs));
        }
      } else {
        try {
          hash.update(readFileSync(abs));
        } catch {
          // An unreadable file makes the digest differ, which is the point.
          hash.update("<unreadable>");
        }
      }
      hash.update("\0");
    }
  };
  walk(root);
  return `sha256-${hash.digest("hex")}`;
}

// ─── Version ranges ───

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Whether `version` satisfies `range`.
 *
 * Supports the shapes a plugin author actually writes: ">=0.3.0", "^0.3.0",
 * "~0.3.1", "0.3.x", "*", and a bare exact version, plus space- or
 * comma-separated conjunctions. An UNPARSEABLE range is treated as satisfied:
 * refusing a plugin because we could not read its range would make our
 * limitation the author's problem.
 */
export function satisfiesGearVersion(version: string, range: string | undefined): boolean {
  if (!range || range.trim() === "" || range.trim() === "*") return true;
  const v = parseSemver(version);
  if (!v) return true;
  for (const clause of range.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(clause);
    if (!m) return true;
    const [, op = "=", raw] = m;
    if (/^\d+\.\d+\.x$/.test(raw) || /^\d+\.x$/.test(raw)) {
      const parts = raw.split(".");
      const lo =
        parseSemver(parts.map((p) => (p === "x" ? "0" : p)).join(".") + ".0.0".slice(0, 0)) ??
        parseSemver(`${parts[0]}.${parts[1] === "x" ? 0 : parts[1]}.0`);
      if (!lo) continue;
      const hi: [number, number, number] =
        parts[1] === "x" ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
      if (!(cmp(v, lo) >= 0 && cmp(v, hi) < 0)) return false;
      continue;
    }
    const target = parseSemver(raw);
    if (!target) continue;
    switch (op) {
      case ">=":
        if (cmp(v, target) < 0) return false;
        break;
      case ">":
        if (cmp(v, target) <= 0) return false;
        break;
      case "<=":
        if (cmp(v, target) > 0) return false;
        break;
      case "<":
        if (cmp(v, target) >= 0) return false;
        break;
      case "^": {
        // ^0.3.1 means >=0.3.1 <0.4.0 for a 0.x line, which is where Gear is.
        const hi: [number, number, number] =
          target[0] === 0 ? [0, target[1] + 1, 0] : [target[0] + 1, 0, 0];
        if (!(cmp(v, target) >= 0 && cmp(v, hi) < 0)) return false;
        break;
      }
      case "~": {
        const hi: [number, number, number] = [target[0], target[1] + 1, 0];
        if (!(cmp(v, target) >= 0 && cmp(v, hi) < 0)) return false;
        break;
      }
      default:
        if (cmp(v, target) !== 0) return false;
    }
  }
  return true;
}

export function discoverPlugins(workspaceRoot: string): PluginDiscovery {
  const pluginsRoot = workspaceConfigPath(workspaceRoot, "plugins");
  const out: PluginDiscovery = { plugins: [], errors: [] };
  if (!existsSync(pluginsRoot)) return out;

  let entries: string[] = [];
  try {
    entries = readdirSync(pluginsRoot).filter((e) => {
      try {
        return statSync(join(pluginsRoot, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return out;
  }

  const mcpNameOwners = new Map<string, string>();

  for (const dirName of entries.sort()) {
    const root = join(pluginsRoot, dirName);
    const manifestPath = join(root, "plugin.json");
    if (!existsSync(manifestPath)) {
      out.errors.push(`plugin "${dirName}": missing plugin.json — not loaded`);
      continue;
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    } catch (err) {
      out.errors.push(
        `plugin "${dirName}": plugin.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — not loaded`,
      );
      continue;
    }
    if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
      out.errors.push(`plugin "${dirName}": manifest has no name — not loaded`);
      continue;
    }
    if (manifest.name !== dirName) {
      out.errors.push(
        `plugin "${dirName}": manifest name "${manifest.name}" must equal the directory name — not loaded`,
      );
      continue;
    }
    if (manifest.enabled === false) continue; // disabled, not broken: say nothing
    if (!satisfiesGearVersion(GEAR_VERSION, manifest.gearVersion)) {
      out.errors.push(
        `plugin "${dirName}": needs Gear ${manifest.gearVersion}, this is ${GEAR_VERSION} — not loaded`,
      );
      continue;
    }

    // Integrity: a declared digest that does not match the tree means the
    // bundle changed since it was installed. Refuse it — a plugin contributes
    // hooks that run shell commands, and "probably fine" is not a standard to
    // run someone else's commands under.
    let integrity: LoadedPlugin["integrity"] = "unset";
    if (typeof manifest.integrity === "string" && manifest.integrity) {
      integrity = computeIntegrity(root) === manifest.integrity ? "verified" : "mismatch";
      if (integrity === "mismatch") {
        out.errors.push(
          `plugin "${dirName}": integrity check failed — the files changed since it was installed; ` +
            `reinstall it or remove the "integrity" field if you edited it deliberately — not loaded`,
        );
        continue;
      }
    }

    const plugin: LoadedPlugin = {
      name: manifest.name,
      root,
      description: manifest.description,
      version: manifest.version,
      gearVersion: manifest.gearVersion,
      permissions: manifest.permissions,
      source: manifest.source,
      integrity,
      hookFiles: [],
      mcpServers: {},
      commandDirs: [],
      hasSkills: existsSync(join(root, "skills")),
    };
    let refused = false;

    if (manifest.hooks) {
      const abs = resolveInsidePlugin(root, manifest.hooks);
      if (!abs || !existsSync(abs)) {
        out.errors.push(
          `plugin "${dirName}": declared hooks file "${manifest.hooks}" is missing or escapes the plugin — not loaded`,
        );
        refused = true;
      } else {
        plugin.hookFiles.push(abs);
      }
    }

    if (manifest.mcp && !refused) {
      const abs = resolveInsidePlugin(root, manifest.mcp);
      if (!abs || !existsSync(abs)) {
        out.errors.push(
          `plugin "${dirName}": declared mcp file "${manifest.mcp}" is missing or escapes the plugin — not loaded`,
        );
        refused = true;
      } else {
        try {
          const parsed = JSON.parse(readFileSync(abs, "utf8")) as {
            mcpServers?: Record<string, unknown>;
          };
          for (const [serverName, spec] of Object.entries(parsed.mcpServers ?? {})) {
            const owner = mcpNameOwners.get(serverName);
            if (owner) {
              out.errors.push(
                `plugin "${dirName}": MCP server "${serverName}" already provided by plugin "${owner}" — not loaded`,
              );
              refused = true;
              break;
            }
            plugin.mcpServers[serverName] = spec;
          }
          if (!refused) {
            for (const serverName of Object.keys(plugin.mcpServers)) {
              mcpNameOwners.set(serverName, dirName);
            }
          }
        } catch (err) {
          out.errors.push(
            `plugin "${dirName}": mcp file is not valid JSON (${err instanceof Error ? err.message : String(err)}) — not loaded`,
          );
          refused = true;
        }
      }
    }

    if (manifest.commands && !refused) {
      const dirs = Array.isArray(manifest.commands) ? manifest.commands : [manifest.commands];
      for (const rel of dirs) {
        const abs = resolveInsidePlugin(root, rel);
        if (!abs || !existsSync(abs)) {
          out.errors.push(
            `plugin "${dirName}": declared commands dir "${rel}" is missing or escapes the plugin — not loaded`,
          );
          refused = true;
          break;
        }
        plugin.commandDirs.push(abs);
      }
    }

    if (!refused) out.plugins.push(plugin);
  }

  return out;
}
