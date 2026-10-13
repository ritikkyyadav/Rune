/**
 * A check the run already watched pass, on the tree exactly as it stands, is
 * not run a second time.
 *
 * Recorded on seven hard tasks (2026-10-07 and 10-08,
 * `~/rune-evidence/b2-s4-serious-20261007`, `b2-s5…`, `b2-s6…`): in every one
 * the agent ran tests after its last edit, and the end-of-turn verification
 * then ran the project's checks again from nothing. On one of them the agent
 * had run the whole suite itself — "4987 pass, 0 fail … [51.97s]", exit 0, no
 * file changed afterwards — and 68 seconds later the verifier started the same
 * suite, was killed at its 120-second limit, and reported that nothing was
 * measured. The waits after the last model call were 85 to 125 seconds on runs
 * of 240 to 570.
 *
 * Three questions have to be answered with no model in the loop, and each has
 * a function here:
 *
 *   faithfullyReports   which commands does a shell line's exit status speak
 *                       for? `bun test | tail` speaks for `tail`.
 *   workTreeFingerprint is the tree, byte for byte, what it was then?
 *   equivalentCommands  is `bun test tests/unit/` the project's `bun run test`?
 *
 * Only a PASS is ever reused. A failure is run again, because the next reader
 * needs what it printed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { isHarnessOwnedPath } from "./lifecycle";
import { isVerificationCommand, normalizeCommand } from "./verification-command";

// ─── Which commands a shell line's exit status speaks for ───

type Separator = "&&" | "||" | "|" | ";";
interface Part {
  text: string;
  /** The operator that follows this part, or null for the last one. */
  then: Separator | null;
}

/**
 * A shell line cut at its top-level operators, or null when it holds anything
 * this does not account for: a substitution, a subshell or a group, a
 * background job, a comment, a redirection other than `2>&1`, an unclosed
 * quote. Null is the common answer and the safe one — nothing is claimed for a
 * line that was not fully read.
 */
function topLevelParts(line: string): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  let quote: '"' | "'" | null = null;
  const push = (then: Separator | null): boolean => {
    const trimmed = text.trim();
    text = "";
    if (!trimmed) return false;
    parts.push({ text: trimmed, then });
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (quote === "'") {
      text += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) return null;
    if (ch === "\\") {
      if (next === undefined) return null;
      // A continued line is one line.
      if (next === "\n" && !quote) {
        text += " ";
        i++;
        continue;
      }
      text += ch + next;
      i++;
      continue;
    }
    if (quote === '"') {
      text += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      text += ch;
      continue;
    }
    // `${NAME[0]}` is a parameter, read whole; any other brace is a group.
    if (ch === "$" && next === "{") {
      const end = line.indexOf("}", i);
      if (end < 0) return null;
      text += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "#") return null;
    if (ch === "2" && line.startsWith("2>&1", i) && /(?:^|\s)$/.test(text)) {
      // The one redirection that changes nothing about what ran or how it ended.
      i += 3;
      continue;
    }
    if (ch === ">" || ch === "<") return null;
    if (ch === "&") {
      if (next !== "&") return null;
      if (!push("&&")) return null;
      i++;
      continue;
    }
    if (ch === "|") {
      if (next === "&") return null;
      if (!push(next === "|" ? "||" : "|")) return null;
      if (next === "|") i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      // An empty list between two separators is nothing; a leading one is not a line.
      if (!push(";") && parts.length === 0) return null;
      continue;
    }
    text += ch;
  }
  if (quote) return null;
  if (text.trim()) parts.push({ text: text.trim(), then: null });
  else if (parts.length > 0) parts[parts.length - 1]!.then = null;
  return parts.length > 0 ? parts : null;
}

/** `set -o pipefail`, alone or with the other strictness letters. Nothing else. */
const SET_PIPEFAIL_RE = /^set\s+-[eux]*o\s+pipefail$/;
/** A stage that only shortens what the stage before it printed. */
const TRIMMER_RE = /^(?:tail|head)(?:\s+-n\s*\d+|\s+-\d+)?$/;
/**
 * The first stage's own exit status, asked for by name straight after the pipe.
 *
 * Two spellings, both of which FAIL when the name expands to nothing: a shell
 * that has no `PIPESTATUS` must not be able to read "" as zero. `exit
 * ${PIPESTATUS[0]}` and `[[ … ]]` are left out for that reason — the first
 * exits with the pipeline's own status when the name is empty, and the second
 * evaluates an empty string as 0.
 */
const FIRST_STAGE_STATUS_RE =
  /^(?:test\s+\$\{PIPESTATUS\[0\]\}\s+-eq\s+0|\[\s+\$\{PIPESTATUS\[0\]\}\s+-eq\s+0\s+\])$/;

/**
 * Whether the shell that runs the agent's commands is one whose pipe idioms
 * mean what they say.
 *
 * The shell tool runs `/bin/sh -c` unless `RUNE_SHELL` names another program
 * (rune-sandbox, shell.rs). Every `/bin/sh` either honours both idioms below
 * (bash) or stops the whole line on them (dash and busybox reject
 * `${PIPESTATUS[0]}`; a dash too old for `set -o pipefail` exits on it), and a
 * line that stopped did not exit 0. A shell someone chose is another matter:
 * fish prints an error for `set -o pipefail` and carries on to a pipeline
 * whose status is its last stage's. So an override is trusted only when it is
 * bash by name, and Windows — where the shell may be `cmd.exe` — never.
 */
export function shellHonoursPipeIdioms(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  const chosen = (env.RUNE_SHELL ?? "").trim();
  if (!chosen) return true;
  const name = chosen.split(/[\\/]/).pop() ?? "";
  return name === "bash" || name === "sh";
}

/**
 * The commands whose result this line's exit status faithfully reports — the
 * ones for which "the line exited 0" means "this command exited 0".
 *
 * Four shapes, and nothing that merely resembles them:
 *
 *   A && B && C                              each of them
 *   set -o pipefail; A | tail -n 8           A — the option makes a failing
 *                                            first stage the pipeline's status
 *   A | tail -n 8; test ${PIPESTATUS[0]} -eq 0
 *                                            A — its status asked for by name
 *   cd dir && A                              `cd dir && A`, which is a
 *                                            different check from A
 *
 * The two with a pipe are read only where the shell is known to mean them
 * (`shellHonoursPipeIdioms`).
 *
 * A pipe with neither guard reports the LAST stage, so `bun test | tail`
 * speaks only for `tail` and yields nothing. So does anything after `||`,
 * which is a fallback, and any list before the last, whose failure the shell
 * discards. `set -o pipefail` counts only as its own unconditional list:
 * `rm -rf dist && set -o pipefail; A | tail` does not set it when `rm` fails.
 */
export function faithfullyReports(line: string, opts: { pipeIdioms?: boolean } = {}): string[] {
  const pipeIdioms = opts.pipeIdioms ?? shellHonoursPipeIdioms();
  const parts = topLevelParts(line);
  if (!parts) return [];
  // Cut into `;`-lists. Only the last one's status reaches the caller.
  const lists: Part[][] = [[]];
  for (const part of parts) {
    lists[lists.length - 1]!.push(part);
    if (part.then === ";") lists.push([]);
  }
  if (lists[lists.length - 1]!.length === 0) lists.pop();

  let pipefail = false;
  let last = lists.length - 1;
  let statusByName = false;
  const finalList = lists[last]!;
  if (finalList.length === 1 && FIRST_STAGE_STATUS_RE.test(finalList[0]!.text) && last > 0) {
    statusByName = true;
    last--;
  }
  // Every earlier list must be the option and nothing else: a list that could
  // redefine a command, change directory or move the tree is not read here.
  for (let i = 0; i < last; i++) {
    const list = lists[i]!;
    if (list.length !== 1 || !SET_PIPEFAIL_RE.test(list[0]!.text)) return [];
    pipefail = true;
  }

  const list = lists[last]!;
  const pipes = list.filter((p) => p.then === "|").length;
  if (list.some((p) => p.then === "||")) return [];
  let commands: string[];
  if (pipes === 0) {
    // A name-check needs a pipe to be about; without one it is just a wrong shape.
    if (statusByName) return [];
    commands = list.map((p) => p.text);
  } else {
    // One pipe, at the end, into a trimmer — and something making the first
    // stage's failure the line's.
    if (pipes !== 1 || list.length < 2) return [];
    const stage = list[list.length - 2]!;
    const trimmer = list[list.length - 1]!;
    if (stage.then !== "|" || !TRIMMER_RE.test(trimmer.text)) return [];
    if (!pipeIdioms || (!pipefail && !statusByName)) return [];
    commands = list.slice(0, -1).map((p) => p.text);
  }
  if (commands.some((c) => SET_PIPEFAIL_RE.test(c) || /^set\s/.test(c))) return [];

  // `cd dir && A` is A somewhere else. It keeps its place in the name, and a
  // `cd` anywhere but first makes the rest unreadable.
  const moved = /^cd\s+(\S+)$/.exec(commands[0] ?? "");
  const rest = moved ? commands.slice(1) : commands;
  if (rest.some((c) => /^cd(?:\s|$)/.test(c))) return [];
  const prefix = moved ? `cd ${moved[1]} && ` : "";
  return rest.map((c) => normalizeCommand(prefix + c));
}

// ─── Is this the same check ───

/**
 * The spellings of one check: the command, and — when it runs a package
 * script that is one plain command with no `pre`/`post` hook — that command.
 *
 * `bun run test` in a project whose `test` script is `bun test tests/unit/`
 * is the second by another name, and a run usually types the second. `bun
 * test` is NOT a script: it is Bun's own runner, so only `run <name>` reads
 * the manifest for bun, and `test` alone does for the others.
 */
export function equivalentCommands(root: string, command: string): string[] {
  const own = normalizeCommand(command);
  const script =
    /^(?:cd (\S+) && )?(?:(?:bun|npm|pnpm|yarn) run ([\w:.-]+)|(?:npm|pnpm|yarn) (test))$/.exec(
      own,
    );
  if (!script) return [own];
  const dir = script[1];
  const name = script[2] ?? script[3]!;
  try {
    const manifest = JSON.parse(readFileSync(join(root, dir ?? "", "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = manifest.scripts ?? {};
    const body = scripts[name];
    if (typeof body !== "string" || scripts[`pre${name}`] || scripts[`post${name}`]) return [own];
    const parts = topLevelParts(body);
    if (!parts || parts.length !== 1) return [own];
    return [own, normalizeCommand(`${dir ? `cd ${dir} && ` : ""}${parts[0]!.text}`)];
  } catch {
    return [own];
  }
}

// ─── Is the tree what it was ───

/** Past this many changed files the answer is "unknown", which reuses nothing. */
const MAX_FINGERPRINT_FILES = 2_000;

/**
 * The work tree's content, as one short string: the commit it stands on and
 * the bytes of every file that differs from it, tracked or not.
 *
 * `StampedRevision` cannot answer this: its digest covers the files a claim
 * NAMES, and a suite names none. Ignored files are left out, as everywhere
 * else — a build directory is not the work — and so is Rune's own footprint.
 * Null when there is no repository, git fails, or too much has changed to
 * read: null never equals anything, so an unknown tree reuses no receipt.
 */
export function workTreeFingerprint(root: string): string | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch {
      return null;
    }
  };
  const head = git(["rev-parse", "HEAD"]);
  if (head === null) return null;
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return null;
  // `XY path\0`, and for a rename `XY new\0old\0`.
  const fields = status.split("\0");
  const changed: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++;
    if (isHarnessOwnedPath(path)) continue;
    changed.push(path);
    if (changed.length > MAX_FINGERPRINT_FILES) return null;
  }
  const hash = createHash("sha256");
  hash.update(head.trim());
  for (const path of changed.sort()) {
    hash.update(`\0${path}\0`);
    try {
      const full = join(root, path);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) hash.update(`link:${readlinkSync(full)}`);
      else if (stats.isDirectory()) hash.update("dir");
      else hash.update(readFileSync(full));
    } catch {
      hash.update("gone");
    }
  }
  return hash.digest("hex").slice(0, 24);
}

// ─── The ledger ───

/** One command the runtime saw pass, and the tree it passed on. */
export interface PassReceipt {
  command: string;
  /** The line that ran, when it was not the command alone. */
  ranAs: string;
  at: number;
  durationMs?: number;
  fingerprint: string;
}

const MAX_RECEIPTS = 96;

/**
 * Passes the runtime itself observed this session, by command and by tree.
 *
 * Written from two places and from nowhere a model can reach: the shell tool's
 * own result (exit status read by the runtime) and the verifier's own runs.
 * There is no path from a tool argument to a receipt.
 */
export class PassLedger {
  private readonly receipts: PassReceipt[] = [];

  constructor(
    private readonly fingerprintNow: () => string | null,
    private readonly pipeIdioms: boolean = shellHonoursPipeIdioms(),
  ) {}

  /** A shell line that exited 0. Records every command its status speaks for. */
  noteShell(line: string, pass: { at: number; durationMs?: number }): void {
    // A check, not any command that happened to exit 0: reading the tree costs
    // two git calls, and `ls` passing is not something a verifier will ask about.
    const commands = faithfullyReports(line, { pipeIdioms: this.pipeIdioms }).filter(
      isVerificationCommand,
    );
    if (commands.length === 0) return;
    this.add(commands, line, pass);
  }

  /** A check the verifier ran itself, to completion, green. */
  noteCheck(command: string, pass: { at: number; durationMs?: number }): void {
    this.add([normalizeCommand(command)], command, pass);
  }

  private add(commands: string[], ranAs: string, pass: { at: number; durationMs?: number }): void {
    const fingerprint = this.fingerprintNow();
    if (!fingerprint) return;
    for (const command of commands) {
      this.receipts.push({
        command,
        ranAs,
        at: pass.at,
        ...(pass.durationMs != null ? { durationMs: pass.durationMs } : {}),
        fingerprint,
      });
    }
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
  }

  /** The newest pass of any of these commands on the tree as it stands now. */
  fresh(commands: readonly string[]): PassReceipt | undefined {
    if (this.receipts.length === 0) return undefined;
    const wanted = new Set(commands.map(normalizeCommand));
    if (![...this.receipts].some((r) => wanted.has(r.command))) return undefined;
    const now = this.fingerprintNow();
    if (!now) return undefined;
    for (let i = this.receipts.length - 1; i >= 0; i--) {
      const receipt = this.receipts[i]!;
      if (receipt.fingerprint === now && wanted.has(receipt.command)) return receipt;
    }
    return undefined;
  }
}
