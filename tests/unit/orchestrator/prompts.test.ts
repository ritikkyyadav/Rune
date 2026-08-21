import { describe, expect, test } from "bun:test";
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
      "# Task management",
      "# Doing tasks",
      "# Tool usage policy",
      "# Coding conventions",
      "# Building interfaces",
      "# Git",
      "# Proactiveness",
    ]) {
      expect(AGENT_DOCTRINE).toContain(section);
    }
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
    const dir = mkdtempSync(join(tmpdir(), "alan-prompts-"));
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
    const dir = mkdtempSync(join(tmpdir(), "alan-prompts-"));
    try {
      const block = renderEnvironmentBlock(snapshotEnvironment(dir, "m1", "openai"));
      expect(block).toContain("Model: m1 (via openai)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProjectMemory", () => {
  test("returns empty block when no memory files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-mem-"));
    try {
      const mem = loadProjectMemory(dir);
      expect(mem.block).toBe("");
      expect(mem.files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads GEAR.md and reports the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-mem-"));
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

  test("GEAR.md wins while legacy ALAN.md and CLAUDE.md remain supported", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-mem-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "claude instructions");
      let mem = loadProjectMemory(dir);
      expect(mem.block).toContain("claude instructions");

      writeFileSync(join(dir, "ALAN.md"), "alan instructions");
      mem = loadProjectMemory(dir);
      expect(mem.block).toContain("alan instructions");
      expect(mem.block).not.toContain("claude instructions");

      writeFileSync(join(dir, "GEAR.md"), "gear instructions");
      mem = loadProjectMemory(dir);
      expect(mem.block).toContain("gear instructions");
      expect(mem.block).not.toContain("alan instructions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncates oversized memory files", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-mem-"));
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
    const dir = mkdtempSync(join(tmpdir(), "alan-mem-"));
    try {
      writeFileSync(join(dir, "GEAR.md"), "   \n  ");
      const mem = loadProjectMemory(dir);
      expect(mem.block).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
