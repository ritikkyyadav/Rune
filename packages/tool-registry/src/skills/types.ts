// ─── Skill Types ───
// A "skill" is a reusable expert playbook authored as a SKILL.md file with YAML
// frontmatter (`name`, `description`, optional `argument-hint`) and a Markdown
// body of instructions. Skills are surfaced to the model via progressive
// disclosure: a compact catalog (plugin → skill names) lives in the system
// prompt, and the full body is loaded on demand through the `skill` tool.

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Usage hint, e.g. "<PR URL, diff, or file path>". From `argument-hint`. */
  argumentHint?: string;
}

export interface SkillMeta {
  /** Namespaced, collision-free id: "<plugin>:<name>" (e.g. "engineering:code-review"). */
  id: string;
  /** Plugin folder the skill belongs to (e.g. "engineering"), or "user". */
  plugin: string;
  /** Skill name from frontmatter, falling back to the directory name. */
  name: string;
  /** One-line trigger/description from frontmatter (may be empty). */
  description: string;
  /** Optional usage hint from `argument-hint`. */
  argumentHint?: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill's directory (where bundled resources live). */
  dir: string;
}

export interface SkillResource {
  /** Path relative to the skill directory, e.g. "references/guide.md". */
  relPath: string;
  /** Absolute path — pass to read_file to open it. */
  absPath: string;
}

export interface LoadedSkill {
  meta: SkillMeta;
  /** The SKILL.md body (frontmatter stripped), with arguments substituted. */
  body: string;
  /** Bundled files the skill may reference (references/, examples/, RUNBOOK.md, …). */
  resources: SkillResource[];
  /** Absolute path to the plugin's CONNECTORS.md, when present (skills link to it). */
  connectorsPath?: string;
}

export interface SkillSearchHit {
  id: string;
  plugin: string;
  name: string;
  description: string;
  score: number;
}

export interface PluginCatalogEntry {
  /** Plugin folder name. */
  plugin: string;
  /** Plugin one-liner from .claude-plugin/plugin.json (may be empty). */
  description: string;
  /** Skills belonging to this plugin, sorted by name. */
  skills: Array<{ id: string; name: string; description: string }>;
}

export interface SkillRoot {
  /** Absolute directory scanned for SKILL.md files. */
  dir: string;
}
