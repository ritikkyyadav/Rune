// ─── User skills: `.rune/skills/<name>/SKILL.md` and `~/.rune/skills/<name>/SKILL.md` ───
//
// Rune already loaded skills — the bundled catalog, plugin bundles, and the
// playbook it writes for itself into `.rune/skills/playbook/SKILL.md`. What it
// did not have was a way for a PERSON to add one and find out that they had:
// no listing that said where a skill came from, no `/name` to invoke it, and no
// command to copy a directory into place.
//
// This module is that user-facing half. It deliberately shares the playbook's
// on-disk convention — a directory holding `SKILL.md` with `name` and
// `description` frontmatter — so a hand-written skill and a machine-written one
// load through the SAME path: `SkillLoader` discovers both (engine.ts adds
// `~/.rune/skills` beside `<workspace>/.rune/skills`), and the `skill` tool can
// load either. Everything here is the extra surface on top:
//
//   discoverUserSkills()  what is installed, with its description and origin
//   userSkillCommands()   `/rename-thing arg` as a slash command
//   addSkill()            copy a directory into the workspace or the user home
//
// A skill is INSTRUCTIONS, never a program. Nothing in this file executes
// anything: `add` copies files, and invoking one puts Markdown into the turn
// for the model to read. The only thing that can act on a skill is the agent,
// under the same permission ladder as any other turn.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { runeHomePath, workspaceConfigPath } from "@rune/shared";
import { splitFrontmatter, substituteArgs } from "@rune/tool-registry";
import type { SlashCommand } from "./commands";

/** Where a user skill lives. Workspace skills are committable; user skills follow the person. */
export type UserSkillOrigin = "workspace" | "user";

export interface UserSkill {
  /** Frontmatter `name`, lowercased, falling back to the directory name. */
  name: string;
  /** Frontmatter `description` (may be empty). */
  description: string;
  /** Frontmatter `argument-hint` / `argumentHint`, when present. */
  argumentHint?: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill's directory. */
  dir: string;
  origin: UserSkillOrigin;
}

/** The label shown next to a skill in `/skills`. */
export const ORIGIN_LABEL: Record<UserSkillOrigin, string> = {
  workspace: ".rune/skills",
  user: "~/.rune/skills",
};

/** A skill name is a slash command, so it is constrained like one. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** `<workspace>/.rune/skills` — the committable location. */
export function workspaceSkillsDir(workspaceRoot: string): string {
  return workspaceConfigPath(workspaceRoot, "skills");
}

/** `~/.rune/skills` — the per-person location, available in every workspace. */
export function userSkillsDir(): string {
  return runeHomePath("skills");
}

/**
 * Every user skill, workspace first. A name present in both locations resolves
 * to the workspace copy — the same precedence `SkillLoader` applies, because
 * engine.ts pushes the workspace root before the home root.
 */
export function discoverUserSkills(workspaceRoot: string): UserSkill[] {
  const seen = new Set<string>();
  const out: UserSkill[] = [];
  const roots: Array<[string, UserSkillOrigin]> = [
    [workspaceSkillsDir(workspaceRoot), "workspace"],
    [userSkillsDir(), "user"],
  ];
  for (const [root, origin] of roots) {
    for (const skill of scanSkillRoot(root, origin)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One directory level: `<root>/<dir>/SKILL.md`. Unreadable entries are skipped. */
function scanSkillRoot(root: string, origin: UserSkillOrigin): UserSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // No skills directory is the ordinary case, not an error.
    return [];
  }
  const out: UserSkill[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const dir = join(root, entry);
    const path = join(dir, "SKILL.md");
    // PENDING.md (the un-consented playbook) is deliberately not SKILL.md and
    // is therefore invisible here, exactly as it is to the loader.
    if (!existsSync(path)) continue;
    const meta = readSkillMeta(path, dir, origin);
    if (meta) out.push(meta);
  }
  return out;
}

function readSkillMeta(path: string, dir: string, origin: UserSkillOrigin): UserSkill | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { frontmatter } = splitFrontmatter(raw);
  const name = (frontmatter.name?.trim() || basename(dir)).toLowerCase();
  const skill: UserSkill = {
    name,
    description: frontmatter.description?.trim() ?? "",
    path,
    dir,
    origin,
  };
  if (frontmatter.argumentHint?.trim()) skill.argumentHint = frontmatter.argumentHint.trim();
  return skill;
}

/**
 * The text a `/name` invocation puts into the turn.
 *
 * The body is read HERE, at invocation, not at discovery — the same
 * just-in-time shape the `skill` tool uses, so editing a SKILL.md takes effect
 * on the next invocation without restarting the session, and an unused skill
 * costs nothing but its one catalog line.
 *
 * Arguments are substituted into `$ARGUMENTS` / `$1` / `{{args}}` placeholders;
 * a body with no placeholder gets them appended, so an argument is never
 * silently dropped.
 */
export function renderSkillInvocation(skill: UserSkill, args: string): string {
  let body: string;
  try {
    body = splitFrontmatter(readFileSync(skill.path, "utf8")).body.trim();
  } catch (err) {
    return `The skill "${skill.name}" could not be read from ${skill.path}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const trimmed = args.trim();
  const substituted = substituteArgs(body, trimmed);
  const lines = [
    `# Skill: ${skill.name}`,
    ...(skill.description ? [`> ${skill.description}`] : []),
    "",
    `Loaded from ${skill.path} (${ORIGIN_LABEL[skill.origin]}). Follow these instructions.`,
    `Relative links resolve against ${skill.dir}.`,
    "",
    "---",
    "",
    substituted,
  ];
  if (trimmed && substituted === body) {
    lines.push("", "---", "", `Arguments: ${trimmed}`);
  }
  return lines.join("\n");
}

/**
 * User skills as slash commands. `taken` holds names already claimed by a
 * `.rune/commands` file or a plugin command; those win, and the skill stays
 * reachable through `/skills`, the `skill` tool and the model's own routing.
 *
 * Built-in commands are matched BEFORE custom ones in both surfaces, so a skill
 * called `status` can never shadow `/status` either.
 */
export function userSkillCommands(
  skills: UserSkill[],
  taken: Iterable<string> = [],
): SlashCommand[] {
  const claimed = new Set([...taken].map((n) => n.toLowerCase()));
  const out: SlashCommand[] = [];
  for (const skill of skills) {
    if (!NAME_RE.test(skill.name) || claimed.has(skill.name)) continue;
    claimed.add(skill.name);
    const command: SlashCommand = {
      name: skill.name,
      description: skill.description || `Skill from ${ORIGIN_LABEL[skill.origin]}`,
      source: `skill:${skill.origin}`,
      render: (args: string) => renderSkillInvocation(skill, args ?? ""),
    };
    if (skill.argumentHint) command.argumentHint = skill.argumentHint;
    out.push(command);
  }
  return out;
}

export interface AddSkillOptions {
  workspaceRoot: string;
  /** Install into `~/.rune/skills` instead of the workspace. */
  user?: boolean;
  /** Override the installed directory name (defaults to the skill's `name`). */
  name?: string;
  /** Replace an existing skill of the same name. */
  force?: boolean;
}

export interface AddSkillResult {
  name: string;
  /** The installed skill directory. */
  dest: string;
  origin: UserSkillOrigin;
  /** True when an existing skill of the same name was replaced. */
  replaced: boolean;
}

/** Directories never worth copying into a skill. */
const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", "dist", ".DS_Store"]);

/**
 * Copy a skill directory into the workspace (default) or the user home.
 *
 * `source` may be the directory or the SKILL.md inside it. Throws with an
 * actionable message when the source is not a skill, when the name is not a
 * legal command name, or when the destination exists and `force` was not given.
 * Nothing is executed, and nothing outside the destination is written.
 */
export function addSkill(source: string, options: AddSkillOptions): AddSkillResult {
  const abs = resolve(source);
  if (!existsSync(abs)) throw new Error(`No such path: ${abs}`);
  const dir = statSync(abs).isDirectory() ? abs : resolve(abs, "..");
  const manifest = join(dir, "SKILL.md");
  if (!existsSync(manifest)) {
    throw new Error(`${dir} is not a skill: it has no SKILL.md`);
  }

  const { frontmatter } = splitFrontmatter(readFileSync(manifest, "utf8"));
  const name = (options.name?.trim() || frontmatter.name?.trim() || basename(dir)).toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `"${name}" is not a usable skill name — use lowercase letters, digits, "-" and "_" ` +
        `(set it in SKILL.md frontmatter, or pass --name).`,
    );
  }
  if (!frontmatter.description?.trim()) {
    throw new Error(
      `${manifest} has no "description" in its frontmatter — that line is what tells ` +
        `the agent when to use the skill, so it is required.`,
    );
  }

  const origin: UserSkillOrigin = options.user ? "user" : "workspace";
  const root = options.user ? userSkillsDir() : workspaceSkillsDir(options.workspaceRoot);
  const dest = join(root, name);
  if (resolve(dest) === dir) {
    throw new Error(`${dir} is already installed at that location.`);
  }
  const replaced = existsSync(dest);
  if (replaced && !options.force) {
    throw new Error(`A skill named "${name}" is already installed at ${dest} — pass --force.`);
  }

  mkdirSync(root, { recursive: true });
  cpSync(dir, dest, {
    recursive: true,
    force: true,
    filter: (src) => !SKIP_DIRS.has(basename(src)),
  });
  // `--name` renames the SKILL for real, not just its directory. Discovery
  // reads the frontmatter, so leaving the old name inside would install a
  // skill that answers to a name nobody typed — and collides with the original
  // when both are installed.
  if (name !== (frontmatter.name?.trim() || basename(dir)).toLowerCase()) {
    renameInFrontmatter(join(dest, "SKILL.md"), name);
  }
  return { name, dest, origin, replaced };
}

/** Rewrite (or insert) the frontmatter `name:` of an installed SKILL.md. */
function renameInFrontmatter(path: string, name: string): void {
  const raw = readFileSync(path, "utf8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    writeFileSync(path, `---\nname: ${name}\n---\n\n${raw}`);
    return;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      lines.splice(i, 0, `name: ${name}`);
      break;
    }
    if (/^name\s*:/.test(lines[i] ?? "")) {
      lines[i] = `name: ${name}`;
      break;
    }
  }
  writeFileSync(path, lines.join("\n"));
}
