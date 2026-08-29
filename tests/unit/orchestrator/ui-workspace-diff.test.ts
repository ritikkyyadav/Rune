import { describe, expect, it } from "bun:test";
import { formatWorkspaceDiff } from "../../../packages/orchestrator/src/bin/ui/workspace-diff";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/workspace-diff", () => {
  it("summarizes and renders staged plus working-tree changes without mutating Git", () => {
    const output = stripAnsi(
      formatWorkspaceDiff({
        staged: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-const oldValue = 1;",
          "+const newValue = 2;",
        ].join("\n"),
        unstaged: [
          "diff --git a/src/b.ts b/src/b.ts",
          "--- a/src/b.ts",
          "+++ b/src/b.ts",
          "@@ -2 +2 @@",
          "-export const before = true;",
          "+export const after = true;",
        ].join("\n"),
      }),
    );

    expect(output).toContain("Workspace diff");
    expect(output).toContain("2 files");
    expect(output).toContain("+2");
    expect(output).toContain("-2");
    expect(output).toContain("src/a.ts | src/b.ts");
    expect(output).toContain("Staged changes");
    expect(output).toContain("Working tree changes");
    expect(output).toContain("-const oldValue = 1;");
    expect(output).toContain("+export const after = true;");
  });

  it("has explicit clean and inspection-error states", () => {
    expect(stripAnsi(formatWorkspaceDiff({ staged: "", unstaged: "" }))).toContain(
      "Working tree clean",
    );
    expect(
      stripAnsi(formatWorkspaceDiff({ staged: "", unstaged: "", error: "not a git repository" })),
    ).toContain("not a git repository");
  });

  it("includes untracked files without pretending their contents were diffed", () => {
    const output = stripAnsi(
      formatWorkspaceDiff({
        staged: "",
        unstaged: "",
        untracked: ["src/new.ts", "docs/new.md"],
      }),
    );
    expect(output).toContain("2 files");
    expect(output).toContain("Untracked files | 2");
    expect(output).toContain("src/new.ts");
    expect(output).toContain("docs/new.md");
    expect(output).not.toContain("Working tree clean");
  });

  it("bounds every visible row while retaining full-file change counts", () => {
    const hunks = Array.from({ length: 90 }, (_, index) =>
      [`@@ -${index + 1} +${index + 1} @@`, `-before ${index}`, `+after ${index}`].join("\n"),
    ).join("\n");
    const output = stripAnsi(
      formatWorkspaceDiff({
        staged: `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n${hunks}`,
        unstaged: "",
      }),
    );
    const diffRows = output.split("\n").slice(3);

    expect(output).toContain("+90");
    expect(output).toContain("-90");
    expect(output).toContain("diff truncated at 60 lines");
    expect(diffRows.length).toBeLessThanOrEqual(61); // 60 rows + truncation notice
  });
});
