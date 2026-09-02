// ─── The connector catalog: name → URL → auth mode ───
//
// `gear mcp add notion` has to resolve a bare word into a server spec. Two
// sources, in this order:
//
//   1. The 20 vendored `skills/*/.mcp.json` files already in the repo. They
//      carry ~60 distinct connectors — Notion, Slack, Linear, Atlassian,
//      GitHub, Figma, HubSpot, PagerDuty, Datadog, Gmail, Google Calendar and
//      the rest — with the URLs each vendor actually publishes. This is a real
//      seed catalog that was sitting unused.
//   2. The public MCP registry, when it answers. Purely additive, and every
//      failure is soft: no network, a slow endpoint, a shape we do not
//      recognize — all of them mean "the vendored catalog is what you get",
//      never an error the user has to work around.
//
// An entry with an empty URL (Snowflake, Databricks, Benchling in the vendored
// files) is a placeholder the vendor has not published; it is listed as
// unresolvable rather than silently added as a broken server.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogEntry {
  /** The name `gear mcp add <name>` matches. */
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  type?: "stdio" | "http";
  oauth?: { clientId?: string; callbackPort?: number };
  /** Where this entry came from, shown in `gear mcp add` output. */
  source: "vendored" | "registry";
  /** Skills that reference this connector — useful context when listing. */
  usedBy?: string[];
  description?: string;
}

/** Candidate locations of the bundled skills catalog, most specific first. */
export function skillCatalogRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.GEAR_SKILLS_DIR,
    // packages/tool-registry/src/mcp → repo root
    join(import.meta.dir, "../../../../skills"),
    join(process.cwd(), "skills"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
}

interface VendoredFile {
  mcpServers?: Record<
    string,
    {
      type?: "stdio" | "http";
      url?: string;
      command?: string;
      args?: string[];
      headers?: Record<string, string>;
      oauth?: { clientId?: string; callbackPort?: number };
    }
  >;
}

/**
 * Index every `skills/<skill>/.mcp.json`. When two skills name the same
 * connector (Notion appears in nine of them), the first non-empty URL wins and
 * the rest are recorded as additional `usedBy` entries — the URLs agree in
 * every current case, and disagreement should surface as a choice rather than
 * a silent last-write-wins.
 */
export function loadVendoredCatalog(env: NodeJS.ProcessEnv = process.env): CatalogEntry[] {
  const root = skillCatalogRoots(env).find((r) => existsSync(r));
  if (!root) return [];

  const byName = new Map<string, CatalogEntry>();
  let skills: string[] = [];
  try {
    skills = readdirSync(root);
  } catch {
    return [];
  }

  for (const skill of skills.sort()) {
    const file = join(root, skill, ".mcp.json");
    if (!existsSync(file)) continue;
    let parsed: VendoredFile;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as VendoredFile;
    } catch {
      continue; // A malformed vendored file is not the user's problem.
    }
    for (const [name, spec] of Object.entries(parsed.mcpServers ?? {})) {
      const existing = byName.get(name);
      if (existing) {
        if (!existing.usedBy?.includes(skill)) existing.usedBy?.push(skill);
        // Fill in a URL a previous (placeholder) entry lacked.
        if (!existing.url && spec.url) existing.url = spec.url;
        continue;
      }
      byName.set(name, {
        name,
        type: spec.type,
        url: spec.url || undefined,
        command: spec.command,
        args: spec.args,
        headers: spec.headers,
        oauth: spec.oauth,
        source: "vendored",
        usedBy: [skill],
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The public MCP registry. Overridable so a test never reaches the network. */
export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

interface RegistryServer {
  name?: string;
  description?: string;
  remotes?: Array<{ type?: string; url?: string }>;
  packages?: Array<{ registry_name?: string; name?: string; runtime_arguments?: string[] }>;
}

/**
 * Ask the public registry, if it answers within the budget.
 *
 * Every failure path returns an empty list. A user who is offline, behind a
 * proxy, or on a plane must still get `gear mcp add notion` from the vendored
 * catalog — this source is a bonus, never a dependency.
 */
export async function fetchRegistryCatalog(
  opts: { url?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CatalogEntry[]> {
  const env = opts.env ?? process.env;
  if (env.GEAR_MCP_REGISTRY === "off") return [];
  const url = opts.url ?? env.GEAR_MCP_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { servers?: RegistryServer[] } | RegistryServer[];
    const servers = Array.isArray(body) ? body : (body.servers ?? []);
    const out: CatalogEntry[] = [];
    for (const s of servers) {
      if (!s.name) continue;
      // Registry names are namespaced ("io.github.org/server"); the last
      // segment is what a person types.
      const short = s.name.split("/").pop() ?? s.name;
      const remote = s.remotes?.find((r) => typeof r.url === "string" && r.url);
      if (!remote?.url) continue;
      out.push({
        name: short,
        url: remote.url,
        type: "http",
        source: "registry",
        description: s.description,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a name against both sources. The vendored catalog wins: it is the
 * one this repo has actually looked at, and a registry entry that shadows
 * "notion" with something else would be a supply-chain surprise.
 */
export async function resolveConnector(
  name: string,
  opts: { includeRegistry?: boolean; registryUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CatalogEntry | null> {
  const key = name.trim().toLowerCase();
  const vendored = loadVendoredCatalog(opts.env);
  const hit = vendored.find((e) => e.name.toLowerCase() === key);
  if (hit) return hit;
  if (opts.includeRegistry === false) return null;
  const registry = await fetchRegistryCatalog({ url: opts.registryUrl, env: opts.env });
  return registry.find((e) => e.name.toLowerCase() === key) ?? null;
}

/** Names close enough to what was typed to be worth suggesting. */
export function nearestNames(name: string, entries: CatalogEntry[], limit = 5): string[] {
  const key = name.trim().toLowerCase();
  return entries
    .map((e) => e.name)
    .filter((n) => {
      const lower = n.toLowerCase();
      return lower.includes(key) || key.includes(lower) || lower.startsWith(key.slice(0, 3));
    })
    .slice(0, limit);
}
