import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DOCTRINE,
  loadProjectMemory,
  renderEnvironmentBlock,
  snapshotEnvironment,
} from "../../../packages/orchestrator/src/prompts";

describe("AGENT_DOCTRINE", () => {
  test("covers the core doctrine sections", () => {
    for (const section of [
      "# Tone and style",
      "# Plan and track",
      "# Ambiguity",
      "# Doing tasks",
      "# Tool usage policy",
      "# Coding conventions",
      "# Greenfield builds",
      "# Building interfaces",
      "# Git",
      "# Proactiveness",
    ]) {
      expect(AGENT_DOCTRINE).toContain(section);
    }
  });

  test("greenfield builds: applications are not pages, mocks are failed tasks", () => {
    expect(AGENT_DOCTRINE).toContain("applications are not pages");
    expect(AGENT_DOCTRINE).toContain("walking skeleton FIRST");
    expect(AGENT_DOCTRINE).toContain("a degraded-but-working capability beats a faked one");
    expect(AGENT_DOCTRINE).toContain("presenting a mock as the app is a failed task");
    expect(AGENT_DOCTRINE).toContain('"nothing runnable detected"');
    // The clone class is named in the Ambiguity section, and deviations from
    // the literal ask must be surfaced up front, never as a footnote.
    expect(AGENT_DOCTRINE).toContain('"Build me a clone of X"');
    expect(AGENT_DOCTRINE).toContain("never a silent decision");
    // The words of the ask decide the stack — never workspace neighbors.
    expect(AGENT_DOCTRINE).toContain("never what happens to already sit in the workspace");
  });

  test("teaches interface craft: one art direction, structure over decoration, banned slop", () => {
    expect(AGENT_DOCTRINE).toContain("ONE art direction");
    expect(AGENT_DOCTRINE).toContain("Structure does the design");
    expect(AGENT_DOCTRINE).toContain("Banned slop");
    expect(AGENT_DOCTRINE).toContain("never lorem ipsum");
  });

  test("references registry tool names, not foreign ones", () => {
    expect(AGENT_DOCTRINE).toContain("todo_write");
    expect(AGENT_DOCTRINE).toContain("edit_file");
    expect(AGENT_DOCTRINE).toContain("symbol_search");
    // No Claude Code tool names leaking in
    expect(AGENT_DOCTRINE).not.toContain("TodoWrite");
    expect(AGENT_DOCTRINE).not.toContain("str_replace");
  });

  test("forbids unsolicited commits", () => {
    expect(AGENT_DOCTRINE).toMatch(/Never commit/i);
  });
});

describe("snapshotEnvironment / renderEnvironmentBlock", () => {
  test("non-git directory renders without git sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-prompts-"));
    try {
      const env = snapshotEnvironment(dir, "test-model", "anthropic");
      expect(env.isGitRepo).toBe(false);
      const block = renderEnvironmentBlock(env);
      expect(block).toContain("# Environment");
      expect(block).toContain(`Working directory: ${dir}`);
      expect(block).toContain("Is a git repository: no");
      expect(block).not.toContain("Git branch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes model and provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-prompts-"));
    try {
      const block = renderEnvironmentBlock(snapshotEnvironment(dir, "m1", "openai"));
      expect(block).toContain("Model: m1 (via openai)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProjectMemory", () => {
  // loadProjectMemory reads the USER's global instructions (~/.gear/GEAR.md)
  // as well as the workspace's. Without redirecting the gear home, these tests
  // read the machine they run on: green on a clean CI runner, red for every
  // developer who has ever used the product — the worst way round, because the
  // failure only appears where nobody is watching for it.
  //
  // getGearHome() honors GEAR_HOME, so pointing it at an empty directory
  // isolates the global half without weakening what is being tested.
  let gearHome: string;
  let prevGearHome: string | undefined;
  let prevAlanHome: string | undefined;

  beforeEach(() => {
    gearHome = mkdtempSync(join(tmpdir(), "gear-home-"));
    prevGearHome = process.env.GEAR_HOME;
    prevAlanHome = process.env.ALAN_HOME;
    process.env.GEAR_HOME = gearHome;
    // The pre-rename fallback is consulted too; leaving it set would reopen
    // the same hole from the other side.
    delete process.env.ALAN_HOME;
  });

  afterEach(() => {
    if (prevGearHome === undefined) delete process.env.GEAR_HOME;
    else process.env.GEAR_HOME = prevGearHome;
    if (prevAlanHome === undefined) delete process.env.ALAN_HOME;
    else process.env.ALAN_HOME = prevAlanHome;
    rmSync(gearHome, { recursive: true, force: true });
  });

  test("reads the user's global instructions from the gear home", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(gearHome, "GEAR.md"), "be terse");
      const mem = loadProjectMemory(dir);
      expect(mem.block).toContain("be terse");
      expect(mem.files).toEqual([join(gearHome, "GEAR.md")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty block when no memory files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      const mem = loadProjectMemory(dir);
      expect(mem.block).toBe("");
      expect(mem.files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads GEAR.md and reports the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(dir, "GEAR.md"), "Always use tabs.");
      const mem = loadProjectMemory(dir);
      expect(mem.block).toContain("Always use tabs.");
      expect(mem.block).toContain("# Project & user instructions");
      expect(mem.files.some((f) => f.endsWith("GEAR.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GEAR.md wins while CLAUDE.md remains supported", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "claude instructions");
      let mem = loadProjectMemory(dir);
      expect(mem.block).toContain("claude instructions");

      writeFileSync(join(dir, "GEAR.md"), "gear instructions");
      mem = loadProjectMemory(dir);
      expect(mem.block).toContain("gear instructions");
      expect(mem.block).not.toContain("claude instructions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pre-rename ALAN.md still loads, below GEAR.md but above CLAUDE.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "claude instructions");
      writeFileSync(join(dir, "ALAN.md"), "alan-era instructions");
      let mem = loadProjectMemory(dir);
      // An upgraded install keeps its memory: ALAN.md beats the ecosystem files…
      expect(mem.block).toContain("alan-era instructions");
      expect(mem.block).not.toContain("claude instructions");

      writeFileSync(join(dir, "GEAR.md"), "gear instructions");
      mem = loadProjectMemory(dir);
      // …and the new name wins once the user migrates.
      expect(mem.block).toContain("gear instructions");
      expect(mem.block).not.toContain("alan-era instructions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncates oversized memory files", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(dir, "GEAR.md"), "x".repeat(60_000));
      const mem = loadProjectMemory(dir);
      expect(mem.block).toContain("… (truncated)");
      expect(mem.block.length).toBeLessThan(45_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips empty memory files", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mem-"));
    try {
      writeFileSync(join(dir, "GEAR.md"), "   \n  ");
      const mem = loadProjectMemory(dir);
      expect(mem.block).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
