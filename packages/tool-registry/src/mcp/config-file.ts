// ─── Where connector config lives, and who wins ───
//
// Two scopes:
//
//   user       ~/.rune/mcp.json          connectors you have everywhere
//   workspace  <root>/.rune/mcp.json     connectors this project needs
//
// Workspace wins on collision, by name. The reasoning is the same as every
// other layered config in this repo: the narrower scope is the more deliberate
// one. A user-scope Notion connector pointed at a personal workspace should not
// override the one a project checked in.
//
// Both files use the same shape the workspace file already used, so nothing
// that exists today has to change:
//
//   { "mcpServers": { "<name>": { … } } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRuneHome, workspaceConfigPath } from "@rune/shared";
import type { McpServerConfig } from "./discovery";

export type McpScope = "user" | "workspace";

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/** The file backing one scope. */
export function mcpConfigPath(scope: McpScope, workspaceRoot: string): string {
  return scope === "user"
    ? join(getRuneHome(), "mcp.json")
    : workspaceConfigPath(workspaceRoot, "mcp.json");
}

/** Read one scope. A missing file is `{}`; a malformed one is reported, not thrown. */
export function readMcpConfig(path: string): { config: McpConfigFile; error?: string } {
  if (!existsSync(path)) return { config: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return { config: {}, error: `${path}: not a JSON object` };
    }
    return { config: parsed };
  } catch (err) {
    return {
      config: {},
      error: `${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Write one scope, creating the directory. Pretty-printed — people edit this. */
export function writeMcpConfig(path: string, config: McpConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export interface MergedServer {
  name: string;
  config: McpServerConfig;
  scope: McpScope;
  /** True when the same name exists in the other scope and lost. */
  shadowed: boolean;
}

/**
 * Both scopes, merged, with workspace winning. Returns entries rather than a
 * plain record so callers can SAY which file an entry came from — "why is this
 * connector here" is the question `rune mcp list` exists to answer.
 */
export function mergedServers(workspaceRoot: string): {
  servers: MergedServer[];
  errors: string[];
} {
  const errors: string[] = [];
  const out = new Map<string, MergedServer>();

  const user = readMcpConfig(mcpConfigPath("user", workspaceRoot));
  if (user.error) errors.push(user.error);
  for (const [name, config] of Object.entries(user.config.mcpServers ?? {})) {
    out.set(name, { name, config, scope: "user", shadowed: false });
  }

  const ws = readMcpConfig(mcpConfigPath("workspace", workspaceRoot));
  if (ws.error) errors.push(ws.error);
  for (const [name, config] of Object.entries(ws.config.mcpServers ?? {})) {
    out.set(name, { name, config, scope: "workspace", shadowed: out.has(name) });
  }

  return { servers: [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), errors };
}

/** The merged record, in the shape McpDiscovery consumes. */
export function mergedServerRecord(workspaceRoot: string): Record<string, McpServerConfig> {
  const record: Record<string, McpServerConfig> = {};
  for (const s of mergedServers(workspaceRoot).servers) record[s.name] = s.config;
  return record;
}

/** Add or replace one server in one scope. Returns the file it wrote. */
export function upsertServer(
  scope: McpScope,
  workspaceRoot: string,
  name: string,
  config: McpServerConfig,
): string {
  const path = mcpConfigPath(scope, workspaceRoot);
  const { config: file } = readMcpConfig(path);
  file.mcpServers = { ...(file.mcpServers ?? {}), [name]: config };
  writeMcpConfig(path, file);
  return path;
}

/** Remove one server from one scope. Returns false when it was not there. */
export function removeServer(scope: McpScope, workspaceRoot: string, name: string): boolean {
  const path = mcpConfigPath(scope, workspaceRoot);
  const { config: file } = readMcpConfig(path);
  if (!file.mcpServers || !(name in file.mcpServers)) return false;
  delete file.mcpServers[name];
  writeMcpConfig(path, file);
  return true;
}

/**
 * Flip `enabled` on one server, in whichever scope currently owns it.
 * Returns the scope it changed, or null when the name is unknown.
 */
export function setServerEnabled(
  workspaceRoot: string,
  name: string,
  enabled: boolean,
): McpScope | null {
  for (const scope of ["workspace", "user"] as const) {
    const path = mcpConfigPath(scope, workspaceRoot);
    const { config: file } = readMcpConfig(path);
    const existing = file.mcpServers?.[name];
    if (!existing) continue;
    // `enabled: true` is the default, so record it by REMOVING the flag —
    // config files should not accumulate lines that mean nothing.
    if (enabled) delete existing.enabled;
    else existing.enabled = false;
    writeMcpConfig(path, file);
    return scope;
  }
  return null;
}
