import { readdir, readFile } from "node:fs/promises";
import { createLogger } from "@rune/shared";

const skillLog = createLogger("skills");
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  LoadedSkill,
  PluginCatalogEntry,
  SkillFrontmatter,
  SkillMeta,
  SkillResource,
  SkillSearchHit,
} from "./types";

// ─── Skill Loader ───
// Discovers SKILL.md files under one or more roots and exposes them via
// progressive disclosure. Mirrors the lenient loading style of the MCP and
// command loaders: a missing root or unreadable file is skipped, never thrown.
//
// Layouts understood (a root is globbed recursively for SKILL.md):
//   <root>/<plugin>/skills/<skill>/SKILL.md   → plugin = "<plugin>"   (bundled marketplace)
//   <root>/<skill>/SKILL.md                   → plugin = "user"       (flat .rune/skills)
//
// The plugin is the path segment immediately before a "skills" segment; if
// there is none, the skill is attributed to the synthetic "user" plugin.

const MAX_WALK_DEPTH = 8;
const MAX_RESOURCES = 80;
const IGNORE_DIRS = new Set([".git", "node_modules", ".turbo", "dist"]);

export interface SkillLoaderOptions {
  /** Absolute directories to scan. Earlier roots win on id collisions. */
  roots: string[];
}

export class SkillLoader {
  private roots: string[];
  private skills: Map<string, SkillMeta> = new Map();
  /** bare name → ids, for resolving un-namespaced lookups (and reporting ambiguity). */
  private byName: Map<string, string[]> = new Map();
  /** plugin → one-line description from plugin.json (lazily filled during load). */
  private pluginDescriptions: Map<string, string> = new Map();

  constructor(options: SkillLoaderOptions) {
    this.roots = options.roots.filter((r) => existsSync(r));
  }

  /** Scan every root and (re)build the in-memory catalog. Returns all skills. */
  async loadAll(): Promise<SkillMeta[]> {
    this.skills.clear();
    this.byName.clear();
    this.pluginDescriptions.clear();

    for (const root of this.roots) {
      let files: string[] = [];
      try {
        files = await this.findSkillFiles(root, 0);
      } catch (err) {
        skillLog.warn(
          `[skills] could not scan ${root}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const path of files) {
        try {
          await this.ingest(root, path);
        } catch (err) {
          skillLog.warn(
            `[skills] skipping ${path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return this.list();
  }

  /** All discovered skills, sorted by id. */
  list(): SkillMeta[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  count(): number {
    return this.skills.size;
  }

  /** Skills grouped by plugin (for the `/skills` command and catalog rendering). */
  catalog(): PluginCatalogEntry[] {
    const byPlugin = new Map<string, PluginCatalogEntry>();
    for (const meta of this.list()) {
      let entry = byPlugin.get(meta.plugin);
      if (!entry) {
        entry = {
          plugin: meta.plugin,
          description: this.pluginDescriptions.get(meta.plugin) ?? "",
          skills: [],
        };
        byPlugin.set(meta.plugin, entry);
      }
      entry.skills.push({ id: meta.id, name: meta.name, description: meta.description });
    }
    return [...byPlugin.values()].sort((a, b) => a.plugin.localeCompare(b.plugin));
  }

  /**
   * Render the catalog injected into the system prompt: each skill with a
   * clipped one-line description (routing needs to know what a skill is FOR),
   * under a hard character budget — over it, the largest plugins degrade to a
   * names-only row so cost stays bounded as skills grow.
   */
  catalogPrompt(): string {
    const groups = this.catalog();
    if (groups.length === 0) return "";

    const total = this.count();
    const lines: string[] = [];
    lines.push("## Available Skills");
    lines.push("");
    lines.push(
      `You have ${total} skills (reusable expert playbooks) across ${groups.length} domains. ` +
        "When a request matches one, call the `skill` tool to load its full step-by-step " +
        'instructions BEFORE starting the task — e.g. skill(name: "engineering:code-review"). ' +
        'Use skill(search: "keywords") to find a skill, or skill() with no arguments to list them. ' +
        "Skill ids are `<plugin>:<name>`.",
    );
    lines.push("");
    // Routing needs more than bare names: "build me a website" can only reach
    // frontend-design if the catalog says what each skill is FOR. Every skill
    // gets one clipped description line, under a hard character budget (the
    // catalog rides in every system prompt — cached after turn one, but
    // unbounded growth is still unbounded). Over budget, the LARGEST plugins
    // degrade back to the old names-only row first; the result is stable for
    // a given skill set, so prompt caching is unaffected.
    const DESC_BUDGET_CHARS = 9_000;
    const namesRow = (g: (typeof groups)[number]): string => {
      const names = g.skills.map((s) => s.name).join(", ");
      const summary = g.description ? ` — ${firstSentence(g.description, 100)}` : "";
      return `- **${g.plugin}**${summary}: ${names}`;
    };
    const detailRows = (g: (typeof groups)[number]): string[] => [
      `- **${g.plugin}**${g.description ? ` — ${firstSentence(g.description, 80)}` : ""}:`,
      ...g.skills.map(
        (s) => `  - ${s.name}${s.description ? ` — ${firstSentence(s.description, 90)}` : ""}`,
      ),
    ];
    const rendered = new Map(groups.map((g) => [g.plugin, detailRows(g)] as const));
    const size = () =>
      [...rendered.values()].reduce((n, rows) => n + rows.join("\n").length + 1, 0);
    const bySize = [...groups].sort(
      (a, b) =>
        rendered.get(b.plugin)!.join("\n").length - rendered.get(a.plugin)!.join("\n").length,
    );
    for (const g of bySize) {
      if (size() <= DESC_BUDGET_CHARS) break;
      rendered.set(g.plugin, [namesRow(g)]);
    }
    for (const g of groups) lines.push(...rendered.get(g.plugin)!);
    return lines.join("\n");
  }

  /**
   * Resolve a skill id ("plugin:name") or a bare name. Returns the meta, or an
   * `ambiguous` list when a bare name maps to multiple plugins.
   */
  resolve(idOrName: string): { meta?: SkillMeta; ambiguous?: string[] } {
    const key = idOrName.trim();
    const direct = this.skills.get(key) ?? this.skills.get(key.toLowerCase());
    if (direct) return { meta: direct };

    // Accept "plugin/name" as an alias for "plugin:name".
    if (key.includes("/")) {
      const alias = key.replace("/", ":").toLowerCase();
      const viaSlash = this.skills.get(alias);
      if (viaSlash) return { meta: viaSlash };
    }

    const ids = this.byName.get(key.toLowerCase());
    if (ids && ids.length === 1) return { meta: this.skills.get(ids[0]) };
    if (ids && ids.length > 1) return { ambiguous: ids };
    return {};
  }

  /**
   * Load a skill's full instructions. `args`, when given, is substituted into
   * the body (`$ARGUMENTS`, `$1`, `$2`, … and the `{{args}}` alias).
   */
  async load(idOrName: string, args = ""): Promise<LoadedSkill> {
    const { meta, ambiguous } = this.resolve(idOrName);
    if (!meta) {
      if (ambiguous && ambiguous.length > 0) {
        throw new Error(`Ambiguous skill "${idOrName}". Specify one of: ${ambiguous.join(", ")}`);
      }
      throw new Error(`Unknown skill "${idOrName}". Use skill(search: "…") to find one.`);
    }

    const raw = await readFile(meta.path, "utf8");
    const { body } = splitFrontmatter(raw);
    const rendered = substituteArgs(body, args);

    const resources = await this.collectResources(meta.dir);
    const loaded: LoadedSkill = { meta, body: rendered, resources };

    const connectors = this.connectorsFor(meta);
    if (connectors) loaded.connectorsPath = connectors;

    return loaded;
  }

  /** Rank skills against a free-text query. Returns the top `limit` hits (score > 0). */
  search(query: string, limit = 8): SkillSearchHit[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    const hits: SkillSearchHit[] = [];
    for (const meta of this.skills.values()) {
      const name = meta.name.toLowerCase();
      const desc = meta.description.toLowerCase();
      const plugin = meta.plugin.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name === t) score += 6;
        else if (name.includes(t)) score += 3;
        if (plugin.includes(t)) score += 1;
        if (desc.includes(t)) score += 1;
      }
      if (score > 0) {
        hits.push({
          id: meta.id,
          plugin: meta.plugin,
          name: meta.name,
          description: meta.description,
          score,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  // ─── internals ───

  /** Recursively collect SKILL.md paths under `dir`, bounded in depth. */
  private async findSkillFiles(dir: string, depth: number): Promise<string[]> {
    if (depth > MAX_WALK_DEPTH) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          // Allow a literal ".rune" root to be passed directly, but don't
          // descend into dot-dirs discovered mid-walk (.git, .claude-plugin, …).
          continue;
        }
        out.push(...(await this.findSkillFiles(join(dir, entry.name), depth + 1)));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  private async ingest(root: string, path: string): Promise<void> {
    const raw = await readFile(path, "utf8");
    const { frontmatter } = splitFrontmatter(raw);

    const dir = dirname(path);
    const plugin = pluginFromPath(root, path);
    const name = (frontmatter.name?.trim() || basename(dir)).toLowerCase();
    const description = frontmatter.description?.trim() ?? "";

    let id = `${plugin}:${name}`;
    // Guard against a same-plugin name collision by disambiguating with the dir.
    if (this.skills.has(id) && this.skills.get(id)!.path !== path) {
      id = `${plugin}:${basename(dir).toLowerCase()}`;
    }
    // Earlier roots win: don't let a later root shadow an already-loaded id.
    if (this.skills.has(id)) return;

    const meta: SkillMeta = { id, plugin, name, description, path, dir };
    if (frontmatter.argumentHint) meta.argumentHint = frontmatter.argumentHint;
    this.skills.set(id, meta);

    const bare = name;
    const list = this.byName.get(bare) ?? [];
    list.push(id);
    this.byName.set(bare, list);

    if (!this.pluginDescriptions.has(plugin)) {
      this.pluginDescriptions.set(plugin, await readPluginDescription(root, plugin));
    }
  }

  /** Walk a skill's directory for bundled, model-readable resource files. */
  private async collectResources(dir: string): Promise<SkillResource[]> {
    const out: SkillResource[] = [];
    const walk = async (cur: string, depth: number): Promise<void> => {
      if (depth > MAX_WALK_DEPTH || out.length >= MAX_RESOURCES) return;
      const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= MAX_RESOURCES) return;
        if (entry.name.startsWith(".")) continue;
        const abs = join(cur, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          await walk(abs, depth + 1);
        } else if (entry.isFile() && entry.name !== "SKILL.md") {
          out.push({ relPath: relative(dir, abs).split(sep).join("/"), absPath: abs });
        }
      }
    };
    await walk(dir, 0);
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Find the plugin's CONNECTORS.md (skills reference it via ../../CONNECTORS.md). */
  private connectorsFor(meta: SkillMeta): string | undefined {
    // skill dir is <plugin>/skills/<name>; CONNECTORS.md sits at the plugin root.
    const pluginRoot = dirname(dirname(meta.dir));
    const candidate = join(pluginRoot, "CONNECTORS.md");
    return existsSync(candidate) ? candidate : undefined;
  }
}

// ─── path + frontmatter helpers ───

/** Plugin = the path segment immediately before a "skills" segment, else "user". */
function pluginFromPath(root: string, skillFile: string): string {
  const rel = relative(root, skillFile);
  const segments = rel.split(sep);
  const idx = segments.indexOf("skills");
  if (idx >= 1) return segments[idx - 1].toLowerCase();
  return "user";
}

async function readPluginDescription(root: string, plugin: string): Promise<string> {
  if (plugin === "user") return "User-defined skills";
  const candidate = join(root, plugin, ".claude-plugin", "plugin.json");
  try {
    const json = JSON.parse(await readFile(candidate, "utf8")) as { description?: string };
    return json.description?.trim() ?? "";
  } catch {
    return "";
  }
}

interface ParsedFrontmatter {
  frontmatter: SkillFrontmatter & Record<string, string>;
  body: string;
}

/**
 * Split optional leading `--- … ---` YAML-ish frontmatter from the body. Lenient
 * by design (mirrors orchestrator/commands.ts): a missing or unterminated block
 * yields empty frontmatter and the whole input as body.
 */
export function splitFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: text };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { frontmatter: {}, body: text };

  const fm: Record<string, string> = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === "") continue;
    fm[key] = stripQuotes(trimmed.slice(colon + 1).trim());
  }

  // Normalize the alias so callers read `argumentHint`.
  if (fm["argument-hint"] && !fm.argumentHint) fm.argumentHint = fm["argument-hint"];

  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n/, "");
  return { frontmatter: fm, body };
}

/**
 * Substitute invocation arguments into a skill body. `$ARGUMENTS` and `{{args}}`
 * expand to the full string; `$1`, `$2`, … expand to whitespace-split tokens.
 * When `args` is empty the placeholders are left intact so the template stays
 * legible to the model.
 */
export function substituteArgs(body: string, args: string): string {
  if (!args.trim()) return body;
  const tokens = args.trim().split(/\s+/);
  let out = body.replace(/\$ARGUMENTS/g, args).replace(/\{\{\s*args\s*\}\}/g, args);
  out = out.replace(/\$(\d+)/g, (whole, n: string) => {
    const i = Number(n) - 1;
    return i >= 0 && i < tokens.length ? tokens[i] : whole;
  });
  return out;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const a = value[0];
    const b = value[value.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return value.slice(1, -1);
  }
  return value;
}

function firstSentence(text: string, max: number): string {
  const dot = text.indexOf(". ");
  let s = dot > 0 ? text.slice(0, dot) : text;
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}
