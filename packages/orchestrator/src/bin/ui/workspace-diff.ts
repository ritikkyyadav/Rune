// --- Workspace diff surface (`/diff`) ---
// Read-only inspection of staged + unstaged changes, rendered with the same
// semantic palette and bounded unified-diff component used by edit receipts.

import { renderUnifiedDiff } from "../diff-render";
import { bold, danger, text, muted, faint, info, ok, panel } from "./theme";
import { glyph } from "./glyphs";

export interface WorkspaceDiffSnapshot {
  staged: string;
  unstaged: string;
  untracked?: string[];
  error?: string;
}

function changedFiles(raw: string): string[] {
  const files = new Set<string>();
  for (const line of raw.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files];
}

export function formatWorkspaceDiff(snapshot: WorkspaceDiffSnapshot): string {
  const untracked = snapshot.untracked ?? [];
  if (!snapshot.staged.trim() && !snapshot.unstaged.trim() && untracked.length === 0) {
    if (snapshot.error) {
      return `  ${danger(glyph("failure"))} ${muted("Could not inspect this workspace:")} ${faint(snapshot.error)}`;
    }
    return `  ${ok(glyph("verified"))} ${muted("Working tree clean -- no staged or unstaged changes.")}`;
  }

  const files = new Set(changedFiles(`${snapshot.staged}\n${snapshot.unstaged}`));
  for (const file of untracked) files.add(file);
  const sections: string[] = [];
  let added = 0;
  let removed = 0;

  const renderSection = (label: string, raw: string): void => {
    if (!raw.trim()) return;
    const rendered = renderUnifiedDiff(raw, "    ");
    added += rendered.added;
    removed += rendered.removed;
    sections.push(`  ${bold(text(label))}`, rendered.text);
  };

  renderSection("Staged changes", snapshot.staged);
  renderSection("Working tree changes", snapshot.unstaged);
  if (untracked.length > 0) {
    const shown = untracked.slice(0, 20);
    sections.push(
      `  ${bold(text("Untracked files"))} ${faint(`| ${untracked.length}`)}`,
      ...shown.map((file) => `    ${info(file)}`),
    );
    if (untracked.length > shown.length) {
      sections.push(`    ${faint(`${glyph("elision")} ${untracked.length - shown.length} more`)}`);
    }
  }

  const summary = panel(
    `  ${bold(text("Workspace diff"))} ${faint(glyph("observed"))} ${muted(
      `${files.size} ${files.size === 1 ? "file" : "files"}`,
    )} ${ok(`+${added}`)} ${danger(`-${removed}`)}`,
  );
  const fileList = [...files];
  const fileLine = fileList.length
    ? `  ${info(fileList.slice(0, 4).join(" | "))}${
        fileList.length > 4 ? faint(` | ${fileList.length - 4} more`) : ""
      }`
    : "";
  return [summary, fileLine, ...sections].filter(Boolean).join("\n");
}

function gitDiff(workspaceRoot: string, args: string[]): { output: string; error?: string } {
  try {
    const result = Bun.spawnSync(["git", "-C", workspaceRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString();
    if (result.exitCode === 0) return { output };
    return {
      output: "",
      error: result.stderr.toString().trim() || `git exited ${result.exitCode}`,
    };
  } catch (error) {
    return { output: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Render both index and working-tree changes without mutating Git state. */
export function renderWorkspaceDiff(workspaceRoot: string): string {
  const staged = gitDiff(workspaceRoot, ["diff", "--cached", "--no-ext-diff", "--no-color"]);
  const unstaged = gitDiff(workspaceRoot, ["diff", "--no-ext-diff", "--no-color"]);
  const untracked = gitDiff(workspaceRoot, ["ls-files", "--others", "--exclude-standard"]);
  return formatWorkspaceDiff({
    staged: staged.output,
    unstaged: unstaged.output,
    untracked: untracked.output.split("\n").filter(Boolean),
    error: staged.error ?? unstaged.error ?? untracked.error,
  });
}
