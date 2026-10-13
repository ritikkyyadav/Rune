import { readFile } from "node:fs/promises";

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import type { SkillLoader } from "./loader";
import type { LoadedSkill } from "./types";

// ─── The `skill` Tool ───
// Progressive-disclosure entry point: the model calls this to load a skill's
// full instructions (and a manifest of the skill's bundled reference files),
// to search for a relevant skill, or to list what's available. It only reads
// local skill files and returns text, so it is auto-permission / read-category
// and safe to run in parallel.

const SKILL_TOOL_DESCRIPTION =
  "Load a reusable expert skill (a step-by-step playbook) on demand. Skills cover " +
  "things like code review, debugging, architecture, data analysis, PDF handling, and more — " +
  "see the 'Available Skills' catalog in your system prompt. When a request matches a skill, " +
  "call this FIRST to load its instructions, then follow them.\n" +
  '• Load:   skill(name: "engineering:code-review")  — returns the full SKILL.md and the names of its bundled reference files.\n' +
  '• Open:   skill(name: "engineering:code-review", file: "references/checklist.md")  — returns one of those files.\n' +
  '• Search: skill(search: "review my PR")            — returns matching skills.\n' +
  "• List:   skill()                                   — returns the full catalog.\n" +
  "Optionally pass `args` (e.g. a PR URL or file path) to fill the skill's argument placeholders.";

export function createSkillTool(loader: SkillLoader): ToolHandler {
  const schema: ToolSchema = {
    name: "skill",
    version: "1.0.0",
    description: SKILL_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Skill id to load, e.g. "engineering:code-review". A bare name ("code-review") works when unambiguous.',
        },
        search: {
          type: "string",
          description: "Keywords to find a relevant skill instead of loading one.",
        },
        args: {
          type: "string",
          description:
            "Optional arguments for the skill (e.g. a PR URL, file path, or topic) substituted into its instructions.",
        },
        file: {
          type: "string",
          description:
            'With `name`: one of that skill\'s bundled reference files, by the path it was listed under (e.g. "references/checklist.md"). Returns the file instead of the instructions.',
        },
      },
    },
    permissionLevel: "auto",
    category: "read",
  };

  return {
    schema,
    validate: (args: Record<string, unknown>) => {
      for (const key of ["name", "search", "args", "file"] as const) {
        if (key in args && args[key] !== undefined && typeof args[key] !== "string") {
          return { valid: false, error: `"${key}" must be a string` };
        }
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (result: string, success = true, error?: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success,
        result,
        ...(error ? { error } : {}),
        durationMs: Math.round(performance.now() - start),
      });

      const name = typeof input.args.name === "string" ? input.args.name.trim() : "";
      const search = typeof input.args.search === "string" ? input.args.search.trim() : "";
      const args = typeof input.args.args === "string" ? input.args.args : "";
      const file = typeof input.args.file === "string" ? input.args.file.trim() : "";

      try {
        if (search) return done(renderSearch(loader, search));
        if (name && file) return done(await renderBundledFile(await loader.load(name, args), file));
        if (file)
          throw new Error(
            "`file` names a file bundled with a skill: pass that skill's `name` too.",
          );
        if (name) return done(renderLoaded(await loader.load(name, args)));
        return done(renderCatalog(loader));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return done("", false, message);
      }
    },
  };
}

function renderLoaded(skill: LoadedSkill): string {
  const { meta, body, resources, connectorsPath } = skill;
  const out: string[] = [];
  out.push(`# Skill: ${meta.id}`);
  if (meta.description) out.push(`> ${meta.description}`);
  out.push("");
  out.push("Follow these instructions to complete the task. Relative links below name files");
  out.push(`bundled with this skill, in ${meta.dir}`);
  out.push("");
  out.push("---");
  out.push("");
  out.push(body.trim());

  if (resources.length > 0) {
    out.push("");
    out.push("---");
    out.push("");
    out.push("## Bundled reference files");
    // They sit beside the skill, which is outside the workspace for every
    // project but Rune's own, and read_file opens nothing outside the
    // workspace. This used to say "Open any of these with read_file" and print
    // the absolute path: recorded 2026-10-09 on three page builds, each one
    // spent a call asking for the design skill's catalogue that way and was
    // refused with "Path escape".
    out.push(
      `Open one with skill(name: "${meta.id}", file: "<path>") when the instructions point to it ` +
        "(read_file cannot: they are outside the workspace):",
    );
    for (const r of resources) out.push(`- ${r.relPath}`);
  }
  if (connectorsPath) {
    out.push("");
    out.push(
      `Connector setup (placeholders / required tools): skill(name: "${meta.id}", file: "${CONNECTORS_FILE}")`,
    );
  }
  return out.join("\n");
}

/** The plugin-level file a skill links to as `../../CONNECTORS.md`. */
const CONNECTORS_FILE = "CONNECTORS.md";
/** A reference is prose for the model to read; past this it is cut, and says so. */
const MAX_BUNDLED_FILE_CHARS = 120_000;

/**
 * One of a loaded skill's own files.
 *
 * Only a path the loader itself collected can be named — the request is looked
 * up in that list, never joined to a directory — so this reads nothing a skill
 * did not ship: not a sibling skill, not a parent directory, not an absolute
 * path.
 */
async function renderBundledFile(skill: LoadedSkill, wanted: string): Promise<string> {
  const want = wanted.replace(/\\/g, "/").replace(/^\.\//, "");
  const found =
    skill.resources.find((r) => r.relPath === want) ??
    (skill.connectorsPath && /^(?:\.\.\/)*CONNECTORS\.md$/.test(want)
      ? { relPath: CONNECTORS_FILE, absPath: skill.connectorsPath }
      : undefined);
  if (!found) {
    const names = skill.resources.map((r) => r.relPath);
    if (skill.connectorsPath) names.push(CONNECTORS_FILE);
    throw new Error(
      `"${wanted}" is not a file bundled with ${skill.meta.id}. ` +
        (names.length > 0 ? `Its files: ${names.join(", ")}.` : "It bundles no files."),
    );
  }
  const text = await readFile(found.absPath, "utf8");
  if (text.includes("\u0000")) {
    throw new Error(`${found.relPath} is not a text file; it cannot be shown here.`);
  }
  const shown =
    text.length > MAX_BUNDLED_FILE_CHARS
      ? `${text.slice(0, MAX_BUNDLED_FILE_CHARS)}\n\n[cut at ${MAX_BUNDLED_FILE_CHARS} of ${text.length} characters]`
      : text;
  return `# ${skill.meta.id} — ${found.relPath}\n\n${shown}`;
}

function renderSearch(loader: SkillLoader, query: string): string {
  const hits = loader.search(query);
  if (hits.length === 0) {
    return `No skills matched "${query}". Call skill() with no arguments to see the full catalog.`;
  }
  const lines = [`Skills matching "${query}":`, ""];
  for (const h of hits) {
    lines.push(`- ${h.id} — ${h.description || "(no description)"}`);
  }
  lines.push("");
  lines.push('Load one with skill(name: "<id>").');
  return lines.join("\n");
}

function renderCatalog(loader: SkillLoader): string {
  const groups = loader.catalog();
  if (groups.length === 0) return "No skills are installed.";
  const lines = [`${loader.count()} skills available:`, ""];
  for (const g of groups) {
    lines.push(`## ${g.plugin}${g.description ? ` — ${g.description}` : ""}`);
    for (const s of g.skills) {
      lines.push(`- ${s.id} — ${s.description || "(no description)"}`);
    }
    lines.push("");
  }
  lines.push('Load one with skill(name: "<id>").');
  return lines.join("\n");
}
