import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCommands,
  findCommand,
  type SlashCommand,
} from "../../../packages/orchestrator/src/commands";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rune-commands-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Write a `.md` file into `<workspace>/.rune/commands/`. */
async function writeCommand(fileName: string, body: string): Promise<void> {
  const dir = join(workspace, ".rune", "commands");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), body);
}

// ─── name parsing ───

describe("loadCommands · name parsing", () => {
  test("parses name from filename without .md, lowercased", async () => {
    await writeCommand("review.md", "do a review");
    await writeCommand("Fix-Tests.md", "fix the tests");

    const commands = await loadCommands(workspace);
    const names = commands.map((c) => c.name);

    expect(names).toContain("review");
    expect(names).toContain("fix-tests");
  });

  test("ignores non-.md files", async () => {
    await writeCommand("review.md", "do a review");
    await writeCommand("notes.txt", "not a command");
    await writeCommand("README", "also not a command");

    const commands = await loadCommands(workspace);
    expect(commands.map((c) => c.name)).toEqual(["review"]);
  });
});

// ─── frontmatter parsing ───

describe("loadCommands · frontmatter", () => {
  test("parses description and argument-hint from frontmatter", async () => {
    await writeCommand(
      "review.md",
      [
        "---",
        "description: Review the staged diff for bugs",
        "argument-hint: [pr-number]",
        "---",
        "Review this: $ARGUMENTS",
      ].join("\n"),
    );

    const [cmd] = await loadCommands(workspace);
    expect(cmd.name).toBe("review");
    expect(cmd.description).toBe("Review the staged diff for bugs");
    expect(cmd.argumentHint).toBe("[pr-number]");
  });

  test("accepts the camelCase argumentHint alias", async () => {
    await writeCommand(
      "deploy.md",
      ["---", "argumentHint: <env>", "---", "Deploy to $ARGUMENTS"].join("\n"),
    );

    const [cmd] = await loadCommands(workspace);
    expect(cmd.argumentHint).toBe("<env>");
  });

  test("strips surrounding quotes from frontmatter values", async () => {
    await writeCommand(
      "quoted.md",
      ["---", 'description: "Quoted summary"', "---", "body"].join("\n"),
    );

    const [cmd] = await loadCommands(workspace);
    expect(cmd.description).toBe("Quoted summary");
  });

  test("frontmatter is excluded from the rendered body", async () => {
    await writeCommand(
      "review.md",
      ["---", "description: a desc", "---", "Just the body: $ARGUMENTS"].join("\n"),
    );

    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("xyz")).toBe("Just the body: xyz");
    expect(cmd.render("xyz")).not.toContain("description");
  });
});

// ─── body-only files ───

describe("loadCommands · body-only", () => {
  test("a file with no frontmatter works (empty description)", async () => {
    await writeCommand("plain.md", "Summarize the changes: $ARGUMENTS");

    const [cmd] = await loadCommands(workspace);
    expect(cmd.name).toBe("plain");
    expect(cmd.description).toBe("");
    expect(cmd.argumentHint).toBeUndefined();
    expect(cmd.render("the diff")).toBe("Summarize the changes: the diff");
  });

  test("a leading '---' with no closing delimiter is treated as body", async () => {
    await writeCommand("loose.md", "---\nnot really frontmatter");

    const [cmd] = await loadCommands(workspace);
    // Lenient: the stray delimiter must not swallow the prompt.
    expect(cmd.render("")).toContain("not really frontmatter");
  });
});

// ─── render() substitution ───

describe("SlashCommand.render", () => {
  test("substitutes $ARGUMENTS", async () => {
    await writeCommand("echo.md", "Args were: $ARGUMENTS");
    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("hello world")).toBe("Args were: hello world");
  });

  test("substitutes the {{args}} alias (with inner whitespace)", async () => {
    await writeCommand("echo.md", "A={{args}} B={{ args }}");
    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("X")).toBe("A=X B=X");
  });

  test("replaces every occurrence of both tokens", async () => {
    await writeCommand("echo.md", "$ARGUMENTS / $ARGUMENTS / {{args}}");
    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("Z")).toBe("Z / Z / Z");
  });

  test("empty args removes the tokens", async () => {
    await writeCommand("echo.md", "before $ARGUMENTS after");
    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("")).toBe("before  after");
  });

  test("trims trailing whitespace from the rendered output", async () => {
    await writeCommand("echo.md", "line: $ARGUMENTS\n\n   ");
    const [cmd] = await loadCommands(workspace);
    expect(cmd.render("v")).toBe("line: v");
  });
});

// ─── missing directory ───

describe("loadCommands · missing dir", () => {
  test("missing .rune/commands directory returns []", async () => {
    const commands = await loadCommands(workspace);
    expect(commands).toEqual([]);
  });

  test("missing workspace path returns [] (does not throw)", async () => {
    const commands = await loadCommands(join(workspace, "does", "not", "exist"));
    expect(commands).toEqual([]);
  });
});

// ─── findCommand ───

describe("findCommand", () => {
  let commands: SlashCommand[];

  beforeEach(async () => {
    await writeCommand("review.md", "review body");
    await writeCommand("deploy.md", "deploy body");
    commands = await loadCommands(workspace);
  });

  test("finds a command by exact name", () => {
    expect(findCommand(commands, "review")?.name).toBe("review");
  });

  test("is case-insensitive", () => {
    expect(findCommand(commands, "REVIEW")?.name).toBe("review");
    expect(findCommand(commands, "Review")?.name).toBe("review");
  });

  test("tolerates a leading slash", () => {
    expect(findCommand(commands, "/deploy")?.name).toBe("deploy");
  });

  test("returns undefined for an unknown command", () => {
    expect(findCommand(commands, "nope")).toBeUndefined();
  });
});
