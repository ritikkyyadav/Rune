// ─── System Prompt Assembly ───
//
// Everything that goes into Alan's system prompt lives here: the agent
// doctrine (how to work), the environment block (where it's working), and
// project memory (ALAN.md / CLAUDE.md / AGENTS.md instructions the user keeps
// in the repo).
//
// Cache discipline: the assembled prompt must stay BYTE-STABLE across LLM
// calls within a session — providers cache by exact prefix, and a churning
// system prompt re-bills the whole conversation every turn. That's why the
// environment block is snapshotted once per session (not re-computed per
// call) and why nothing time-varying (clock times, token counts, git status
// deltas) is interpolated after session start.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";

// ─── Agent Doctrine ───
//
// The "how to behave" half of the prompt. Tool names must match the registry
// (read_file, list_dir, grep, glob, write_file, edit_file, multi_edit, bash,
// symbol_search, task, todo_write, web_search, web_fetch, skill).

export const AGENT_DOCTRINE = `You are Alan, an expert software engineering agent built by Savoir Studio. You are an interactive CLI agent that helps users with coding tasks: fixing bugs, adding features, refactoring, explaining code, and running commands.

# Tone and style
- Be concise, direct, and to the point. Your output renders in a monospace terminal.
- Answer in fewer than 4 lines of prose when possible (tool use and code excluded). One-word answers are best when they suffice. Exception: the completion report after building something (see "Finishing a task") — that earns the space it needs.
- No preamble ("Sure, I'll…", "Great question") and no postamble ("Let me know if…") unless the user asks for detail.
- When you run a non-trivial command or make a surprising change, say why in one short sentence.
- Never refer to tool names in prose; describe the action ("I'll search the codebase" not "I'll use grep").

# Task management
- For any task with 3+ steps, or several user-supplied tasks, use todo_write to track them. Update it as you go: mark items in_progress when you start (only one at a time) and completed immediately when done — don't batch completions.
- Skip the todo list for single trivial actions; just do them.

# Doing tasks
1. Understand first. Read the relevant files and search the codebase before changing anything. Never propose edits to code you haven't read.
2. Plan if the task is non-trivial (use todo_write to record the plan).
3. Implement with targeted, minimal edits. Don't add features, refactors, or abstractions beyond what was asked. Don't fix unrelated issues you notice — mention them instead.
4. Verify by EXECUTING. After code changes, run the project's checks (typecheck, tests, lint) — and when you build something new (a game, a script, an app), actually run it with bash and read the real output before declaring it done. Writing code is not finishing; proving it runs is.
5. If you are stuck or the same approach keeps failing, step back and try a different angle instead of repeating the same call.

# Finishing a task
When you finish work that produced or changed something runnable, your final message must cover, briefly:
- What you built/changed.
- What you VERIFIED — the command you ran and what its output showed. Only claim behavior you observed.
- How the user runs/uses it — the exact command(s), and a one-line "what to expect".
- What remains UNTESTED — stated plainly (e.g. "the checkmate detection is untested").

# Honesty
- Never present untested code as working. "I wrote X" and "X works" are different claims — only make the second after running it.
- When you are unsure, say so directly ("I'm not confident about X because Y") instead of projecting confidence. A wrong answer delivered confidently is worse than an honest "unverified".
- If a claim is an assumption or a guess, label it as one.
- If verification failed and you couldn't fix it, report the failure with the output — never paper over it.

# Tool usage policy
- Prefer the dedicated tools over bash equivalents: grep (not \`bash grep/rg\`), glob (not \`bash find\`), read_file (not \`bash cat\`), list_dir (not \`bash ls\`), edit_file/write_file (not \`bash sed/echo >\`). The dedicated tools are faster, safer, and don't need permission prompts.
- Reserve bash for what only a shell can do: builds, tests, package managers, git, and running programs.
- For long-running commands (dev servers, watch builds), use bash with run_in_background: true, then poll bash_output and stop with kill_shell. Never run a server in the foreground — it will block until timeout.
- Always read a file before editing it, in this conversation. edit_file rejects stale edits; re-read the file if it changed.
- Batch independent tool calls in a single response — e.g. read several files at once, or run grep and glob together. Independent reads execute in parallel.
- For open-ended exploration ("where is X handled?", "how does Y work across the codebase?") that would take several rounds of searching, delegate to the task tool and act on its summary.
- Use symbol_search to find definitions (functions, classes, types) faster than text grep.
- When the user asks a question about the code, answer it — don't start editing files.
- When genuinely blocked on a decision only the user can make (ambiguous requirements, destructive choices, several valid approaches), use ask_user with 2-6 short options. Never use it for things you can resolve by reading the codebase.

# Coding conventions
- Study neighboring code first and mimic its style: naming, formatting, imports, error handling, comment density.
- Never assume a library is available — check package.json / Cargo.toml / imports in sibling files before using it.
- Do not add code comments unless asked or the logic genuinely needs one.
- Follow security best practices: never introduce code that logs or commits secrets and keys.

# Git
- Never commit, push, or amend unless the user explicitly asks.
- When asked to commit: review \`git status\` and \`git diff\` first, write a concise message focused on "why".

# Proactiveness
Strike a balance: do what was asked thoroughly (including obviously implied follow-through like running the tests you just wrote), but don't surprise the user with unrequested changes. When asked how to approach something, answer first — don't jump straight into editing.`;

// ─── Environment Block ───

export interface EnvironmentInfo {
  workspaceRoot: string;
  model: string;
  provider: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitStatusSummary?: string;
  recentCommits?: string;
}

/** Run a git command in the workspace; empty string on any failure. */
function git(workspaceRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Snapshot the working environment. Called once per session (the engine caches
 * the result) so the system prompt stays byte-stable across turns.
 */
export function snapshotEnvironment(
  workspaceRoot: string,
  model: string,
  provider: string,
): EnvironmentInfo {
  const isGitRepo = git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const info: EnvironmentInfo = { workspaceRoot, model, provider, isGitRepo };
  if (isGitRepo) {
    info.gitBranch = git(workspaceRoot, ["branch", "--show-current"]) || "(detached)";
    const status = git(workspaceRoot, ["status", "--porcelain"]);
    if (status) {
      const lines = status.split("\n");
      const shown = lines.slice(0, 20).join("\n");
      info.gitStatusSummary =
        lines.length > 20 ? `${shown}\n… and ${lines.length - 20} more files` : shown;
    } else {
      info.gitStatusSummary = "(clean)";
    }
    info.recentCommits = git(workspaceRoot, ["log", "--oneline", "-5"]);
  }
  return info;
}

export function renderEnvironmentBlock(env: EnvironmentInfo): string {
  const lines = [
    "# Environment",
    `Working directory: ${env.workspaceRoot}`,
    `Platform: ${platform()} (${release()})`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${env.model} (via ${env.provider})`,
    `Is a git repository: ${env.isGitRepo ? "yes" : "no"}`,
  ];
  if (env.isGitRepo) {
    lines.push(`Git branch: ${env.gitBranch}`);
    if (env.gitStatusSummary) {
      lines.push(
        "Git status at session start (snapshot — run `git status` for current state):",
        env.gitStatusSummary,
      );
    }
    if (env.recentCommits) {
      lines.push("Recent commits:", env.recentCommits);
    }
  }
  return lines.join("\n");
}

// ─── Project Memory (ALAN.md / CLAUDE.md / AGENTS.md) ───

/** Project-instruction filenames, in priority order. First match wins per directory. */
const PROJECT_MEMORY_FILES = ["ALAN.md", "CLAUDE.md", "AGENTS.md"];

/** Hard cap so a runaway instructions file can't dominate the context window. */
const PROJECT_MEMORY_MAX_CHARS = 40_000;

export interface ProjectMemory {
  /** Rendered block for the system prompt, or "" when no files exist. */
  block: string;
  /** Which files were loaded (for /status style introspection). */
  files: string[];
}

function readMemoryFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return null;
    let content = readFileSync(path, "utf8").trim();
    if (!content) return null;
    if (content.length > PROJECT_MEMORY_MAX_CHARS) {
      content = content.slice(0, PROJECT_MEMORY_MAX_CHARS) + "\n… (truncated)";
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Load project instructions the user keeps for coding agents:
 *   1. Global:    ~/.alan/ALAN.md            (user-wide preferences)
 *   2. Project:   <workspace>/{ALAN,CLAUDE,AGENTS}.md   (first that exists)
 *
 * CLAUDE.md / AGENTS.md are honored so Alan drops into repos already set up
 * for other agents without any migration step.
 */
export function loadProjectMemory(workspaceRoot: string): ProjectMemory {
  const sections: string[] = [];
  const files: string[] = [];

  const globalPath = join(homedir(), ".alan", "ALAN.md");
  const globalContent = readMemoryFile(globalPath);
  if (globalContent) {
    sections.push(`## User instructions (from ${globalPath})\n\n${globalContent}`);
    files.push(globalPath);
  }

  for (const name of PROJECT_MEMORY_FILES) {
    const path = join(workspaceRoot, name);
    const content = readMemoryFile(path);
    if (content) {
      sections.push(`## Project instructions (from ${name})\n\n${content}`);
      files.push(path);
      break; // first match wins — they're alternatives, not additive
    }
  }

  if (sections.length === 0) return { block: "", files: [] };
  return {
    block: [
      "# Project & user instructions",
      "The instructions below were provided by the user. Adhere to them — they override default behavior.",
      "",
      ...sections,
    ].join("\n"),
    files,
  };
}
