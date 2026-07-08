/**
 * Custom slash-command loader: discovers user-defined commands from Markdown
 * files and turns them into prompt templates (parity with Claude Code's custom
 * slash commands).
 *
 * This is a self-contained module. Wiring the loaded commands into the CLI /
 * Engine is intentionally left to the orchestrator — nothing here imports the
 * Engine.
 *
 * Commands live in `<workspaceRoot>/.alan/commands/*.md`. Each file becomes one
 * command whose name is the filename without its `.md` extension, lowercased:
 *
 *   .alan/commands/review.md      ->  /review
 *   .alan/commands/Fix-Tests.md   ->  /fix-tests
 *
 * A file may begin with simple YAML-ish frontmatter delimited by `---` lines:
 *
 *   ---
 *   description: Review the staged diff for bugs
 *   argument-hint: [pr-number]
 *   ---
 *   Review the following and report issues: $ARGUMENTS
 *
 * The body after the frontmatter is the prompt template. `render(args)`
 * substitutes the invocation arguments into the template, replacing every
 * `$ARGUMENTS` token (and the `{{args}}` alias) with the supplied string.
 *
 * Loading is lenient by design (mirrors hooks.ts):
 *   - Missing `.alan/commands` dir -> returns [] (never throws).
 *   - A file that can't be read    -> skipped with a console.warn (never throws).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───

export interface SlashCommand {
  /** Invocation name without the leading slash, lowercased (e.g. "review"). */
  name: string;
  /** Human-readable summary, from frontmatter `description` (may be empty). */
  description: string;
  /** Optional usage hint, from frontmatter `argument-hint` / `argumentHint`. */
  argumentHint?: string;
  /**
   * Expand the prompt template with the given argument string. Every
   * `$ARGUMENTS` occurrence (and the `{{args}}` alias) is replaced with `args`.
   * Trailing whitespace is trimmed.
   */
  render(args: string): string;
}

// ─── Loading ───

/**
 * Load custom slash commands from `<workspaceRoot>/.alan/commands/*.md`.
 *
 * - Missing `.alan/commands` directory -> returns [] (never throws).
 * - A `.md` file that cannot be read    -> skipped (logged via console.warn).
 *
 * Returned commands are sorted by name for stable, deterministic ordering.
 */
export async function loadCommands(workspaceRoot: string): Promise<SlashCommand[]> {
  const dir = join(workspaceRoot, ".alan", "commands");

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Missing directory is the common, expected case — no commands configured.
    if (isNotFound(err)) return [];
    // Any other read failure (e.g. permissions) is also non-fatal: a workspace
    // with no usable commands dir simply has no commands.
    console.warn(
      `[commands] could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const mdFiles = entries.filter((name) => name.toLowerCase().endsWith(".md")).sort();

  const commands: SlashCommand[] = [];
  for (const file of mdFiles) {
    const path = join(dir, file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      // A single unreadable file should not abort the whole load.
      console.warn(
        `[commands] skipping ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    commands.push(buildCommand(file, text));
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a command by name, case-insensitively. */
export function findCommand(commands: SlashCommand[], name: string): SlashCommand | undefined {
  // Allow callers to pass either "review" or "/review".
  const target = name.replace(/^\//, "").toLowerCase();
  return commands.find((c) => c.name === target);
}

// ─── Parsing ───

/** Build a SlashCommand from a filename and raw file contents. */
function buildCommand(fileName: string, raw: string): SlashCommand {
  const name = commandNameFromFile(fileName);
  const { frontmatter, body } = splitFrontmatter(raw);

  const description = frontmatter.description ?? "";
  // Accept both the kebab-case key and the camelCase alias.
  const argumentHint = frontmatter["argument-hint"] ?? frontmatter.argumentHint;

  // Pre-trim the body so render() output never carries trailing whitespace.
  const template = body.replace(/\s+$/, "");

  const command: SlashCommand = {
    name,
    description,
    render: (args: string) => renderTemplate(template, args ?? ""),
  };
  if (argumentHint !== undefined) command.argumentHint = argumentHint;
  return command;
}

/** Derive a command name from a filename: strip `.md`, lowercase. */
function commandNameFromFile(fileName: string): string {
  return fileName.replace(/\.md$/i, "").toLowerCase();
}

/**
 * Substitute argument tokens in a template.
 * Replaces every `$ARGUMENTS` and `{{args}}` (optional inner whitespace, e.g.
 * `{{ args }}`) with the supplied string, then trims trailing whitespace.
 */
function renderTemplate(template: string, args: string): string {
  return template
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .replace(/\s+$/, "");
}

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Split optional leading `--- ... ---` frontmatter from the body.
 *
 * Frontmatter is only recognized when the very first line is `---`. Inside it,
 * simple `key: value` lines are parsed (everything after the first colon is the
 * value, trimmed). Lines without a colon, and blank lines, are ignored. If the
 * opening `---` has no closing `---`, the whole input is treated as body (no
 * frontmatter) so a stray delimiter never swallows the prompt.
 */
function splitFrontmatter(raw: string): ParsedFrontmatter {
  // Normalize CRLF so delimiter detection works on Windows-authored files.
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: text };
  }

  // Find the closing delimiter.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closeIdx = i;
      break;
    }
  }

  // No closing delimiter -> treat as plain body (lenient).
  if (closeIdx === -1) {
    return { frontmatter: {}, body: text };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === "") continue;
    const value = stripQuotes(trimmed.slice(colon + 1).trim());
    frontmatter[key] = value;
  }

  // Body is everything after the closing delimiter. Drop a single leading
  // newline so the prompt doesn't start with a blank line.
  const body = lines
    .slice(closeIdx + 1)
    .join("\n")
    .replace(/^\n/, "");
  return { frontmatter, body };
}

/** Remove a single layer of matching surrounding quotes, if present. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ─── helpers ───

/** True when an fs error indicates a missing path (ENOENT). */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
