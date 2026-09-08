/**
 * User skills — the half of the skills system a person owns.
 *
 * The machine-written playbook already used `.rune/skills/<name>/SKILL.md`.
 * What is tested here is that a HAND-written one loads through the same path,
 * carries its origin, becomes `/<name>`, and reads its body at invocation
 * rather than at discovery.
 *
 * Every test that touches the user location runs against a TEMPORARY
 * RUNE_HOME. Nothing here may read or write the founder's `~/.rune`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_LABEL,
  addSkill,
  discoverUserSkills,
  renderSkillInvocation,
  userSkillCommands,
  userSkillsDir,
  workspaceSkillsDir,
} from "../../../packages/orchestrator/src/skills-user";
import { resetRuneHomeCache } from "../../../packages/shared/src/paths";

let workspace: string;
let home: string;
let prevRuneHome: string | undefined;
let prevGearHome: string | undefined;

function writeSkill(root: string, name: string, body: string, frontmatter = ""): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\n${frontmatter}---\n\n${body}\n`);
  return dir;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-user-skills-ws-"));
  home = mkdtempSync(join(tmpdir(), "rune-user-skills-home-"));
  prevRuneHome = process.env.RUNE_HOME;
  prevGearHome = process.env.GEAR_HOME;
  process.env.RUNE_HOME = home;
  delete process.env.GEAR_HOME;
  resetRuneHomeCache();
});

afterEach(() => {
  if (prevRuneHome === undefined) delete process.env.RUNE_HOME;
  else process.env.RUNE_HOME = prevRuneHome;
  if (prevGearHome === undefined) delete process.env.GEAR_HOME;
  else process.env.GEAR_HOME = prevGearHome;
  resetRuneHomeCache();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("discovery", () => {
  test("finds nothing when neither location exists", () => {
    expect(discoverUserSkills(workspace)).toEqual([]);
  });

  test("reads name, description and origin from both locations", () => {
    writeSkill(workspaceSkillsDir(workspace), "ship", "Ship it.", "description: Ship the thing\n");
    writeSkill(userSkillsDir(), "triage", "Triage it.", "description: Triage a bug\n");

    const skills = discoverUserSkills(workspace);
    expect(skills.map((s) => s.name)).toEqual(["ship", "triage"]);
    expect(skills[0]!.origin).toBe("workspace");
    expect(skills[0]!.description).toBe("Ship the thing");
    expect(skills[1]!.origin).toBe("user");
    expect(ORIGIN_LABEL[skills[1]!.origin]).toBe("~/.rune/skills");
  });

  test("the workspace copy wins when both locations hold the same name", () => {
    writeSkill(workspaceSkillsDir(workspace), "ship", "workspace body");
    writeSkill(userSkillsDir(), "ship", "home body");

    const skills = discoverUserSkills(workspace);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.origin).toBe("workspace");
  });

  test("a directory without SKILL.md is not a skill (the pending playbook stays inert)", () => {
    const dir = join(workspaceSkillsDir(workspace), "playbook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PENDING.md"), "---\nname: playbook\n---\n\nnot enabled\n");
    expect(discoverUserSkills(workspace)).toEqual([]);
  });

  test("an argument hint is carried through", () => {
    writeSkill(
      workspaceSkillsDir(workspace),
      "review",
      "Review $ARGUMENTS.",
      "description: Review a PR\nargument-hint: <pr-url>\n",
    );
    expect(discoverUserSkills(workspace)[0]!.argumentHint).toBe("<pr-url>");
  });
});

describe("invocation", () => {
  test("substitutes arguments into the body", () => {
    writeSkill(workspaceSkillsDir(workspace), "review", "Review $ARGUMENTS carefully.");
    const skill = discoverUserSkills(workspace)[0]!;
    const rendered = renderSkillInvocation(skill, "PR 42");
    expect(rendered).toContain("Review PR 42 carefully.");
    expect(rendered).toContain("# Skill: review");
    // Appended only when the body had no placeholder to take them.
    expect(rendered).not.toContain("Arguments: PR 42");
  });

  test("appends arguments a body has no placeholder for", () => {
    writeSkill(workspaceSkillsDir(workspace), "triage", "Triage the newest bug.");
    const rendered = renderSkillInvocation(discoverUserSkills(workspace)[0]!, "issue 9");
    expect(rendered).toContain("Arguments: issue 9");
  });

  test("the body is read at invocation, not at discovery", () => {
    const dir = writeSkill(workspaceSkillsDir(workspace), "ship", "first body");
    const skill = discoverUserSkills(workspace)[0]!;
    writeFileSync(join(dir, "SKILL.md"), "---\nname: ship\n---\n\nsecond body\n");
    expect(renderSkillInvocation(skill, "")).toContain("second body");
  });

  test("a deleted skill reports the read failure instead of throwing", () => {
    writeSkill(workspaceSkillsDir(workspace), "ship", "body");
    const skill = discoverUserSkills(workspace)[0]!;
    rmSync(skill.dir, { recursive: true, force: true });
    expect(renderSkillInvocation(skill, "")).toContain("could not be read");
  });
});

describe("slash commands", () => {
  test("each skill becomes /<name> with its description", () => {
    writeSkill(workspaceSkillsDir(workspace), "ship", "Ship $ARGUMENTS.", "description: Ship it\n");
    const [command] = userSkillCommands(discoverUserSkills(workspace));
    expect(command!.name).toBe("ship");
    expect(command!.description).toBe("Ship it");
    expect(command!.source).toBe("skill:workspace");
    expect(command!.render("now")).toContain("Ship now.");
  });

  test("a name already claimed by a custom command is not offered", () => {
    writeSkill(workspaceSkillsDir(workspace), "review", "body");
    expect(userSkillCommands(discoverUserSkills(workspace), ["review"])).toEqual([]);
  });

  test("a name that is not a legal command name is skipped", () => {
    const dir = join(workspaceSkillsDir(workspace), "odd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: Not A Name\n---\n\nbody\n");
    expect(userSkillCommands(discoverUserSkills(workspace))).toEqual([]);
  });
});

describe("rune skill add", () => {
  let source: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "rune-skill-src-"));
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the service\n---\n\nSteps.\n",
    );
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "references", "runbook.md"), "detail\n");
  });

  afterEach(() => rmSync(source, { recursive: true, force: true }));

  test("installs into the workspace by default, resources included", () => {
    const result = addSkill(source, { workspaceRoot: workspace });
    expect(result.name).toBe("deploy");
    expect(result.origin).toBe("workspace");
    expect(result.dest).toBe(join(workspaceSkillsDir(workspace), "deploy"));
    expect(existsSync(join(result.dest, "references", "runbook.md"))).toBe(true);
    expect(discoverUserSkills(workspace).map((s) => s.name)).toEqual(["deploy"]);
  });

  test("--user installs into the rune home", () => {
    const result = addSkill(source, { workspaceRoot: workspace, user: true });
    expect(result.origin).toBe("user");
    expect(result.dest).toBe(join(userSkillsDir(), "deploy"));
    expect(discoverUserSkills(workspace)[0]!.origin).toBe("user");
  });

  test("accepts the SKILL.md path as well as its directory", () => {
    const result = addSkill(join(source, "SKILL.md"), { workspaceRoot: workspace });
    expect(result.name).toBe("deploy");
  });

  test("--name renames the skill itself, not just its directory", () => {
    const result = addSkill(source, { workspaceRoot: workspace, name: "ship-it" });
    expect(result.name).toBe("ship-it");
    expect(readFileSync(join(result.dest, "SKILL.md"), "utf8")).toContain("name: ship-it");
    expect(discoverUserSkills(workspace).map((s) => s.name)).toEqual(["ship-it"]);
  });

  test("refuses to overwrite without --force, and replaces with it", () => {
    addSkill(source, { workspaceRoot: workspace });
    expect(() => addSkill(source, { workspaceRoot: workspace })).toThrow(/already installed/);
    const again = addSkill(source, { workspaceRoot: workspace, force: true });
    expect(again.replaced).toBe(true);
  });

  test("refuses a directory with no SKILL.md", () => {
    const empty = mkdtempSync(join(tmpdir(), "rune-skill-empty-"));
    try {
      expect(() => addSkill(empty, { workspaceRoot: workspace })).toThrow(/no SKILL\.md/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("refuses a skill with no description — that line is what routes it", () => {
    writeFileSync(join(source, "SKILL.md"), "---\nname: deploy\n---\n\nSteps.\n");
    expect(() => addSkill(source, { workspaceRoot: workspace })).toThrow(/description/);
  });

  test("refuses a name that could not be typed as a command", () => {
    expect(() => addSkill(source, { workspaceRoot: workspace, name: "Not A Name" })).toThrow(
      /not a usable skill name/,
    );
  });

  test("does not copy a .git directory into the workspace", () => {
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = addSkill(source, { workspaceRoot: workspace });
    expect(existsSync(join(result.dest, ".git"))).toBe(false);
  });
});
