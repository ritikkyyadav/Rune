// ─── Plugin bundles: one installable unit for skills + hooks + MCP + commands ───
//
// The four extension loaders (skills, hooks.json, mcp.json, commands/*.md)
// each work alone, but nothing ships as a unit. A plugin is a directory:
//
//   .alan/plugins/<name>/
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
}

export interface LoadedPlugin {
  name: string;
  root: string;
  description?: string;
  version?: string;
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
  return abs === root || abs.startsWith(root + "/") ? abs : null;
}

export function discoverPlugins(workspaceRoot: string): PluginDiscovery {
  const pluginsRoot = join(workspaceRoot, ".alan", "plugins");
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

    const plugin: LoadedPlugin = {
      name: manifest.name,
      root,
      description: manifest.description,
      version: manifest.version,
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
