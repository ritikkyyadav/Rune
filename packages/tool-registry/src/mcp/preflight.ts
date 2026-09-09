// ─── What is wrong with a connector BEFORE we try to start it ───
//
// The founder's own `~/.rune/mcp.json` pointed the filesystem server at
// `/Users/…/Projects/Alan` — one letter off the directory that exists. What
// the session showed for that was a connector-down notice with the server's
// own stderr in it, which says the process died and nothing about why. The
// answer was on disk the whole time and nobody looked.
//
// So this runs first, on the config alone: no spawn, no network, no keychain.
// A missing command and a path that does not exist are the two mistakes people
// actually make, and both are checkable in microseconds. Each problem carries
// the line that fixes it — a corrected path, or the install that supplies the
// command.

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { McpServerConfig } from "./discovery";

export interface McpPreflightProblem {
  /** Which part of the entry is wrong. */
  kind: "command-missing" | "path-missing" | "url-invalid";
  /** One line, in the user's own terms. */
  problem: string;
  /** The corrected value, or the command that supplies what is missing. */
  fix: string;
}

/** `~` and `$HOME` as people write them in a hand-edited JSON file. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value.startsWith("$HOME/")) return join(homedir(), value.slice(6));
  return value;
}

/**
 * Does this argument look like a filesystem path the server is meant to open?
 *
 * Deliberately narrow. A flag, a package name, a URL and a bare word are all
 * things a server takes that are not paths, and reporting `-y` as a missing
 * directory would be worse than saying nothing.
 */
export function looksLikePath(arg: string): boolean {
  if (arg.length === 0 || arg.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
  return (
    arg.startsWith("~") ||
    arg.startsWith("$HOME") ||
    isAbsolute(arg) ||
    arg.startsWith("./") ||
    arg.startsWith("../")
  );
}

/** Levenshtein distance, capped — we only care about "one or two letters off". */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const row = [i];
    for (let j = 1; j < cols; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[cols - 1]!;
}

/** The tolerance that separates a typo from a different word. */
function tolerance(segment: string): number {
  return segment.length <= 4 ? 1 : segment.length <= 10 ? 2 : 3;
}

/**
 * The path the user probably meant.
 *
 * Walks the path one segment at a time from the deepest ancestor that exists,
 * and at the first segment that does not, looks for a sibling within an edit
 * distance a typo would explain. `Projects` → `Project` is distance 1 in a
 * directory that holds exactly one candidate; `Documents` → `Project` is 7 and
 * gets nothing, which is the point — a confident wrong suggestion is worse
 * than none.
 */
export function nearestExistingPath(target: string): string | null {
  const full = resolve(expandHome(target));
  if (existsSync(full)) return null;

  // The walk starts at the path's OWN root, which is `/` on POSIX and the drive
  // on Windows (`C:\`, or `\\server\share\` for a UNC path). Starting at the
  // separator instead cost Windows the whole check: `C:\Users\…` split on `\`
  // makes `C:` an ordinary segment, `\C:` does not exist, and the suggester
  // either walked the wrong volume or gave up — so a mistyped connector path on
  // Windows got "create it" where macOS got the corrected path.
  const { root } = parse(full);
  const parts = full.slice(root.length).split(sep).filter(Boolean);
  let current: string = root;
  let corrected = false;

  for (const part of parts) {
    const candidate = join(current, part);
    if (existsSync(candidate)) {
      current = candidate;
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return null;
    }
    // Case first — the mistake a case-insensitive filesystem hides until it
    // reaches a tool that does not fold case.
    const sameLetters = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    let pick = sameLetters;
    if (!pick) {
      const limit = tolerance(part);
      let best: { name: string; d: number } | null = null;
      for (const entry of entries) {
        const d = distance(entry.toLowerCase(), part.toLowerCase());
        if (d <= limit && (!best || d < best.d)) best = { name: entry, d };
      }
      pick = best?.name;
    }
    if (!pick) return null;
    corrected = true;
    current = join(current, pick);
  }

  return corrected && existsSync(current) ? current : null;
}

/**
 * The suffixes a bare command name may be wearing on disk.
 *
 * On Windows an executable IS its extension: `npx` is `npx.cmd`, `uvx` is
 * `uvx.exe`, and npm and bun write `.cmd` shims rather than shebang scripts.
 * Looking only for the literal name reported every one of them as "not on
 * PATH" — a preflight that refuses a connector that would have started fine.
 * `PATHEXT` is the list the shell itself uses, so use it, and keep the empty
 * suffix first so an extensionless file still wins where one exists.
 */
function commandSuffixes(): string[] {
  if (process.platform !== "win32") return [""];
  const ext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return [
    "",
    ...ext
      .split(";")
      .map((e) => e.trim())
      .filter(Boolean),
  ];
}

/** Is this name runnable — an executable on PATH, or a file we can execute? */
export function resolveCommand(command: string): string | null {
  const expanded = expandHome(command);
  const executable = (p: string): boolean => {
    try {
      if (!statSync(p).isFile()) return false;
      // X_OK is meaningless on Windows — every existing file answers yes — so
      // the extension check above is what actually decides there.
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // A separator of EITHER kind means the user gave a path, not a PATH lookup:
  // people write `C:/tools/server.exe` in a hand-edited JSON file as readily as
  // they write it with backslashes.
  if (expanded.includes(sep) || expanded.includes("/") || isAbsolute(expanded)) {
    const abs = resolve(expanded);
    for (const suffix of commandSuffixes()) {
      if (executable(abs + suffix)) return abs + suffix;
    }
    return null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const suffix of commandSuffixes()) {
      const candidate = join(dir, expanded + suffix);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Everything checkable about one entry without starting it.
 *
 * Returns an empty array for a healthy entry, so a caller can say "nothing
 * wrong on paper" and move on to the live check.
 */
export function preflightServer(name: string, config: McpServerConfig): McpPreflightProblem[] {
  const problems: McpPreflightProblem[] = [];

  if (config.url) {
    try {
      const parsed = new URL(config.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push({
          kind: "url-invalid",
          problem: `${name}: "${config.url}" is not an http(s) URL`,
          fix: `rune mcp add https://… --name ${name}`,
        });
      }
    } catch {
      problems.push({
        kind: "url-invalid",
        problem: `${name}: "${config.url}" is not a URL`,
        fix: `rune mcp add https://… --name ${name}`,
      });
    }
    return problems;
  }

  if (!config.command) return problems;

  if (!resolveCommand(config.command)) {
    problems.push({
      kind: "command-missing",
      problem: `${name}: "${config.command}" is not on PATH`,
      fix:
        config.command === "npx" || config.command === "node"
          ? "install Node.js — https://nodejs.org"
          : `install ${config.command}, or give the full path in mcp.json`,
    });
  }

  for (const arg of config.args ?? []) {
    if (!looksLikePath(arg)) continue;
    const full = resolve(expandHome(arg));
    if (existsSync(full)) continue;
    const near = nearestExistingPath(arg);
    problems.push({
      kind: "path-missing",
      problem: `${name}: ${arg} does not exist`,
      fix: near
        ? `did you mean ${near}`
        : `create it, or point the entry at a directory that exists`,
    });
  }

  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!looksLikePath(value)) continue;
    const full = resolve(expandHome(value));
    if (existsSync(full) || existsSync(dirname(full))) continue;
    const near = nearestExistingPath(value);
    problems.push({
      kind: "path-missing",
      problem: `${name}: ${key}=${value} does not exist`,
      fix: near ? `did you mean ${near}` : `create it, or point ${key} at a path that exists`,
    });
  }

  return problems;
}
