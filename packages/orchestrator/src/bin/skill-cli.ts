// ─── `rune skill`: add, list and remove the skills a person writes ───
//
// A skill is a directory holding SKILL.md — instructions the agent follows, not
// a program it runs. This command only moves those directories around:
//
//   rune skill add ./path/to/my-skill        into <workspace>/.rune/skills
//   rune skill add ./path/to/my-skill --user into ~/.rune/skills
//   rune skill list                          what is installed, and from where
//   rune skill remove <name>                 delete one
//
// Nothing here executes a skill. Installing one makes its description visible
// to the model and its body loadable — by the `skill` tool, or by typing
// `/<name>` — and that is the whole of the capability it confers.

import { rmSync } from "node:fs";
import { relative } from "node:path";
import {
  ORIGIN_LABEL,
  addSkill,
  discoverUserSkills,
  userSkillsDir,
  workspaceSkillsDir,
  type UserSkill,
} from "../skills-user";
import { accent, danger, dim, faint, ok, text } from "./ui/theme";
import { glyph } from "./ui/glyphs";

const pad = "  ";
const say = (line = ""): void => {
  process.stdout.write(`${pad}${line}\n`);
};

function usage(): void {
  say();
  say(`${accent("rune skill")} ${dim("— add the instructions you want Rune to follow")}`);
  say();
  say(`${text("Commands")}`);
  say(`  ${accent("add")} <path> ${dim("[--user] [--name N] [--force]")}`);
  say(`  ${accent("list")}`);
  say(`  ${accent("remove")} <name> ${dim("[--user]")}`);
  say();
  say(`  ${faint("A skill is a directory with a SKILL.md whose frontmatter carries")}`);
  say(`  ${faint("`name` and `description`. Without --user it lands in the workspace")}`);
  say(`  ${faint("at .rune/skills/<name>, which is committable; with --user it lands")}`);
  say(`  ${faint("in ~/.rune/skills/<name> and follows you between repositories.")}`);
  say();
  say(`  ${faint("Invoke one with /<name>, or let the agent choose it. See docs/skills.md.")}`);
  say();
}

function workspaceOf(values: Record<string, unknown>): string {
  return typeof values.workspace === "string" ? values.workspace : process.cwd();
}

/** A path the reader can act on: relative when it is inside the workspace. */
function displayPath(path: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function listSkills(workspaceRoot: string): number {
  const skills = discoverUserSkills(workspaceRoot);
  say();
  say(`${text("Your skills")} ${dim(`(${skills.length})`)}`);
  say();
  if (skills.length === 0) {
    say(`  ${faint("None yet.")}`);
    say(`  ${faint(`Workspace: ${workspaceSkillsDir(workspaceRoot)}`)}`);
    say(`  ${faint(`You:       ${userSkillsDir()}`)}`);
    say();
    say(`  ${faint("Add one with")} ${accent("rune skill add <path>")}${faint(".")}`);
    say();
    return 0;
  }
  for (const skill of skills) {
    say(`  ${ok(glyph("live"))} ${accent(`/${skill.name}`)} ${dim(ORIGIN_LABEL[skill.origin])}`);
    if (skill.description) say(`      ${faint(skill.description)}`);
    say(`      ${faint(displayPath(skill.path, workspaceRoot))}`);
  }
  say();
  return 0;
}

function removeSkill(name: string, workspaceRoot: string, values: Record<string, unknown>): number {
  const wanted = name.toLowerCase();
  const skills = discoverUserSkills(workspaceRoot);
  const scoped: UserSkill[] = skills.filter(
    (s) => s.name === wanted && (values.user !== true || s.origin === "user"),
  );
  const hit = scoped[0];
  if (!hit) {
    say();
    say(`${danger(glyph("failure"))} no skill named ${accent(wanted)} is installed`);
    say();
    return 1;
  }
  rmSync(hit.dir, { recursive: true, force: true });
  say();
  say(`${ok(glyph("verified"))} removed ${accent(hit.name)} ${dim(`(${hit.dir})`)}`);
  say();
  return 0;
}

export async function runSkill(args: string[], values: Record<string, unknown>): Promise<number> {
  const sub = (args[0] ?? "").toLowerCase();
  const workspaceRoot = workspaceOf(values);

  if (sub === "" || sub === "help" || values.help === true) {
    usage();
    return sub === "" || sub === "help" ? 0 : 0;
  }

  if (sub === "list" || sub === "ls") return listSkills(workspaceRoot);

  if (sub === "remove" || sub === "rm" || sub === "uninstall") {
    const name = args[1];
    if (!name) {
      say();
      say(`${danger(glyph("failure"))} ${text("rune skill remove <name>")}`);
      say();
      return 1;
    }
    return removeSkill(name, workspaceRoot, values);
  }

  if (sub === "add" || sub === "install") {
    const source = args[1];
    if (!source) {
      say();
      say(`${danger(glyph("failure"))} ${text("rune skill add <path> [--user]")}`);
      say();
      return 1;
    }
    try {
      const result = addSkill(source, {
        workspaceRoot,
        user: values.user === true,
        ...(typeof values.name === "string" ? { name: values.name } : {}),
        force: values.force === true,
      });
      say();
      say(
        `${ok(glyph("verified"))} ${result.replaced ? "replaced" : "installed"} ` +
          `${accent(result.name)} ${dim(`→ ${result.dest}`)}`,
      );
      say(`  ${faint(`Invoke it with /${result.name}, or let the agent pick it up.`)}`);
      say();
      return 0;
    } catch (err) {
      say();
      say(`${danger(glyph("failure"))} ${text(err instanceof Error ? err.message : String(err))}`);
      say();
      return 1;
    }
  }

  say();
  say(`${danger(glyph("failure"))} unknown subcommand ${accent(sub)}`);
  usage();
  return 1;
}
