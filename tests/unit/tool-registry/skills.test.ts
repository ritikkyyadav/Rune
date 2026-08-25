import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillLoader,
  createSkillTool,
  splitFrontmatter,
  substituteArgs,
} from "../../../packages/tool-registry/src/skills/index";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "gear-skills-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Write a SKILL.md in marketplace layout: <root>/<plugin>/skills/<skill>/SKILL.md. */
async function writeSkill(
  root: string,
  plugin: string,
  skill: string,
  frontmatter: Record<string, string>,
  body: string,
): Promise<string> {
  const dir = join(root, plugin, "skills", skill);
  await mkdir(dir, { recursive: true });
  const fm = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", ""];
  await writeFile(join(dir, "SKILL.md"), fm.join("\n") + body);
  return dir;
}

async function writePluginJson(root: string, plugin: string, description: string): Promise<void> {
  const dir = join(root, plugin, ".claude-plugin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: plugin, description }));
}

function callInput(args: Record<string, unknown>): ToolCallInput {
  return { toolName: "skill", callId: "c1", args, sessionId: "s1", workspaceRoot: workspace };
}

// ─── pure helpers ───

describe("splitFrontmatter", () => {
  test("parses name/description/argument-hint and strips block from body", () => {
    const { frontmatter, body } = splitFrontmatter(
      [
        "---",
        "name: code-review",
        "description: Review a diff: find bugs",
        'argument-hint: "<PR URL>"',
        "---",
        "",
        "# Body here",
      ].join("\n"),
    );
    expect(frontmatter.name).toBe("code-review");
    expect(frontmatter.description).toBe("Review a diff: find bugs"); // colon in value preserved
    expect(frontmatter.argumentHint).toBe("<PR URL>"); // quotes stripped, alias normalized
    expect(body.trim()).toBe("# Body here");
  });

  test("no frontmatter → whole input is body", () => {
    const { frontmatter, body } = splitFrontmatter("just a body\nline two");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a body\nline two");
  });

  test("unterminated frontmatter is treated as body (lenient)", () => {
    const { frontmatter, body } = splitFrontmatter("---\nname: x\nno close");
    expect(frontmatter).toEqual({});
    expect(body).toContain("no close");
  });
});

describe("substituteArgs", () => {
  test("substitutes $ARGUMENTS, {{args}} and positional $1/$2", () => {
    const out = substituteArgs("Review @$1 vs $2 — full: $ARGUMENTS / {{args}}", "PR-12 main");
    expect(out).toBe("Review @PR-12 vs main — full: PR-12 main / PR-12 main");
  });

  test("empty args leaves placeholders intact", () => {
    const out = substituteArgs("Review @$1", "");
    expect(out).toBe("Review @$1");
  });

  test("unmatched positional placeholder is left as-is", () => {
    expect(substituteArgs("$1 $2 $3", "only-one")).toBe("only-one $2 $3");
  });
});

// ─── discovery & namespacing ───

describe("SkillLoader · discovery", () => {
  test("discovers skills, namespaces by plugin, reads plugin description", async () => {
    await writePluginJson(workspace, "engineering", "Engineering workflows");
    await writeSkill(
      workspace,
      "engineering",
      "code-review",
      { name: "code-review", description: "Review code" },
      "body",
    );
    await writeSkill(
      workspace,
      "engineering",
      "debug",
      { name: "debug", description: "Debug things" },
      "body",
    );

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();

    expect(loader.count()).toBe(2);
    const ids = loader.list().map((s) => s.id);
    expect(ids).toEqual(["engineering:code-review", "engineering:debug"]);

    const catalog = loader.catalog();
    expect(catalog[0].plugin).toBe("engineering");
    expect(catalog[0].description).toBe("Engineering workflows");
  });

  test("flat .gear/skills layout is attributed to the 'user' plugin", async () => {
    const dir = join(workspace, "mine");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: mine\ndescription: my skill\n---\nbody");

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();
    expect(loader.resolve("user:mine").meta?.id).toBe("user:mine");
  });

  test("missing root → empty, never throws", async () => {
    const loader = new SkillLoader({ roots: [join(workspace, "does-not-exist")] });
    await expect(loader.loadAll()).resolves.toEqual([]);
    expect(loader.count()).toBe(0);
  });
});

// ─── collisions & resolution ───

describe("SkillLoader · collisions", () => {
  test("same bare name across plugins stays distinct; bare lookup is ambiguous", async () => {
    await writeSkill(
      workspace,
      "sales",
      "start",
      { name: "start", description: "sales start" },
      "b",
    );
    await writeSkill(workspace, "zoom", "start", { name: "start", description: "zoom start" }, "b");

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();

    expect(loader.resolve("sales:start").meta?.description).toBe("sales start");
    expect(loader.resolve("zoom:start").meta?.description).toBe("zoom start");

    const bare = loader.resolve("start");
    expect(bare.meta).toBeUndefined();
    expect(bare.ambiguous?.sort()).toEqual(["sales:start", "zoom:start"]);
  });

  test("unambiguous bare name resolves; 'plugin/name' alias works", async () => {
    await writeSkill(workspace, "engineering", "debug", { name: "debug", description: "d" }, "b");
    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();
    expect(loader.resolve("debug").meta?.id).toBe("engineering:debug");
    expect(loader.resolve("engineering/debug").meta?.id).toBe("engineering:debug");
  });

  test("earlier root wins on id collision", async () => {
    const rootA = join(workspace, "a");
    const rootB = join(workspace, "b");
    await writeSkill(rootA, "engineering", "debug", { name: "debug", description: "from A" }, "b");
    await writeSkill(rootB, "engineering", "debug", { name: "debug", description: "from B" }, "b");

    const loader = new SkillLoader({ roots: [rootA, rootB] });
    await loader.loadAll();
    expect(loader.count()).toBe(1);
    expect(loader.resolve("engineering:debug").meta?.description).toBe("from A");
  });
});

// ─── load() ───

describe("SkillLoader · load", () => {
  test("returns body, bundled resource manifest, and CONNECTORS path", async () => {
    const skillDir = await writeSkill(
      workspace,
      "engineering",
      "code-review",
      { name: "code-review", description: "Review code" },
      "Review @$1 now.",
    );
    await writeFile(join(skillDir, "references", "guide.md"), "ref").catch(async () => {
      await mkdir(join(skillDir, "references"), { recursive: true });
      await writeFile(join(skillDir, "references", "guide.md"), "ref");
    });
    // CONNECTORS.md lives at the plugin root (engineering/CONNECTORS.md).
    await writeFile(join(workspace, "engineering", "CONNECTORS.md"), "connectors");

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();

    const loaded = await loader.load("engineering:code-review", "PR-9");
    expect(loaded.body).toBe("Review @PR-9 now."); // args substituted
    expect(loaded.resources.map((r) => r.relPath)).toContain("references/guide.md");
    expect(loaded.resources[0].absPath).toContain(skillDir);
    expect(loaded.connectorsPath).toContain("CONNECTORS.md");
  });

  test("unknown skill throws a helpful error", async () => {
    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();
    await expect(loader.load("nope:nope")).rejects.toThrow(/Unknown skill/);
  });
});

// ─── search & catalog prompt ───

describe("SkillLoader · search / catalogPrompt", () => {
  test("search ranks name matches above description matches", async () => {
    await writeSkill(
      workspace,
      "engineering",
      "code-review",
      { name: "code-review", description: "inspect a diff" },
      "b",
    );
    await writeSkill(
      workspace,
      "data",
      "analyze",
      { name: "analyze", description: "review datasets" },
      "b",
    );

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();

    const hits = loader.search("review");
    expect(hits.length).toBe(2);
    // "code-review" matches on name (higher) than "analyze" which matches in description.
    expect(hits[0].id).toBe("engineering:code-review");
  });

  test("catalogPrompt lists each skill WITH its description (routing needs it)", async () => {
    await writePluginJson(
      workspace,
      "engineering",
      "Engineering workflows. Extra ignored sentence.",
    );
    await writeSkill(
      workspace,
      "engineering",
      "code-review",
      { name: "code-review", description: "Review a diff for correctness bugs" },
      "b",
    );
    await writeSkill(
      workspace,
      "engineering",
      "debug",
      { name: "debug", description: "Root-cause a failing behavior" },
      "b",
    );

    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();

    const prompt = loader.catalogPrompt();
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("**engineering**");
    // Names-only was the old format — "build me a website" could never route
    // to a skill whose purpose the catalog never stated.
    expect(prompt).toContain("code-review — Review a diff for correctness bugs");
    expect(prompt).toContain("debug — Root-cause a failing behavior");
    expect(prompt).toContain("Engineering workflows"); // first sentence only
    expect(prompt).not.toContain("Extra ignored sentence");
  });

  test("catalogPrompt degrades the largest plugins to names-only over budget", async () => {
    // One small plugin and one enormous one: the big one must fall back to a
    // names row while the small one keeps its descriptions.
    await writePluginJson(workspace, "tiny", "Small plugin.");
    await writeSkill(
      workspace,
      "tiny",
      "one-skill",
      { name: "one-skill", description: "Does one thing" },
      "b",
    );
    await writePluginJson(workspace, "huge", "Big plugin.");
    for (let i = 0; i < 120; i++) {
      await writeSkill(
        workspace,
        "huge",
        `skill-${i}`,
        { name: `skill-${i}`, description: "A long description ".repeat(6) + i },
        "b",
      );
    }
    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();
    const prompt = loader.catalogPrompt();
    expect(prompt).toContain("one-skill — Does one thing");
    expect(prompt).toContain("skill-0,"); // names row
    expect(prompt.length).toBeLessThan(16_000);
  });

  test("catalogPrompt is empty when no skills", async () => {
    const loader = new SkillLoader({ roots: [join(workspace, "missing")] });
    await loader.loadAll();
    expect(loader.catalogPrompt()).toBe("");
  });
});

// ─── the `skill` tool ───

describe("createSkillTool", () => {
  async function toolWith(): Promise<ReturnType<typeof createSkillTool>> {
    await writeSkill(
      workspace,
      "engineering",
      "code-review",
      { name: "code-review", description: "Review code" },
      "Do the review.",
    );
    const loader = new SkillLoader({ roots: [workspace] });
    await loader.loadAll();
    return createSkillTool(loader);
  }

  test("load returns the skill body and is read/auto", async () => {
    const tool = await toolWith();
    expect(tool.schema.permissionLevel).toBe("auto");
    expect(tool.schema.category).toBe("read");
    const out = await tool.execute(callInput({ name: "engineering:code-review" }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("Skill: engineering:code-review");
    expect(out.result).toContain("Do the review.");
  });

  test("search returns matches; list returns catalog; bad name errors", async () => {
    const tool = await toolWith();

    const search = await tool.execute(callInput({ search: "review" }));
    expect(search.result).toContain("engineering:code-review");

    const list = await tool.execute(callInput({}));
    expect(list.result).toContain("1 skills available");

    const bad = await tool.execute(callInput({ name: "ghost:ghost" }));
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/Unknown skill/);
  });

  test("rejects non-string args in validate", async () => {
    const tool = await toolWith();
    expect(tool.validate({ name: 123 }).valid).toBe(false);
    expect(tool.validate({ name: "ok" }).valid).toBe(true);
  });
});

// ─── the real vendored catalog ───

describe("bundled skills/ catalog", () => {
  const bundled = join(import.meta.dir, "../../../skills");

  test.skipIf(!existsSync(bundled))(
    "loads the vendored marketplace and keeps the system-prompt catalog bounded",
    async () => {
      const loader = new SkillLoader({ roots: [bundled] });
      await loader.loadAll();

      // 181 skills were vendored from the knowledge-work marketplace.
      expect(loader.count()).toBeGreaterThanOrEqual(180);

      // The injected catalog must stay small (names, not full descriptions).
      const prompt = loader.catalogPrompt();
      expect(prompt.length).toBeLessThan(16000); // ~<4k tokens
      expect(prompt).toContain("**engineering**");

      // A known skill loads with its bundled references and connector pointer.
      const loaded = await loader.load("engineering:code-review");
      expect(loaded.body.length).toBeGreaterThan(0);
      expect(loaded.connectorsPath).toBeTruthy();
    },
  );
});
