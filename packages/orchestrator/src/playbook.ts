// ─── The playbook: a skill Gear writes for itself, in the repository ───
//
// The notebook is the machine-facing memory: scoped rows in ~/.gear, injected
// under a token budget, invisible to anyone but the model. The playbook is
// the same knowledge made a file in the workspace — `.gear/skills/playbook/
// SKILL.md` — where a person can read it, edit it, diff it, and commit it,
// and where the skills loader lists it to the model like any other skill.
//
// Only ACTIVE lessons get in (P7.7). "Recurred twice" was the old bar, and it
// was the weakest gate in the whole loop attached to its widest action: two
// observations, no measurement, and an executable skill written into the user's
// workspace. Active means the lesson was injected at least five times and won
// more often than the ambient rate — the same ladder every other lesson climbs.
//
// The generated block sits between markers; everything a person writes outside
// them is kept on every rewrite.
//
// And the file is INERT until the user enables it once. A skill can direct
// multi-step behaviour, so a machine writing one into a workspace and having it
// load on the next run is a capability change nobody consented to. Until
// consent is recorded the block is written to PENDING.md, which the skills
// loader does not read (it globs for SKILL.md and nothing else).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NotebookEntry } from "./notebook/store";

export const PLAYBOOK_REL = join(".gear", "skills", "playbook", "SKILL.md");
/**
 * Where the block lands before the user has enabled learned skills. The loader
 * globs for `SKILL.md` and ignores every other file, so this is inert by
 * construction rather than by a flag something could misread.
 */
export const PLAYBOOK_PENDING_REL = join(".gear", "skills", "playbook", "PENDING.md");

const START = "<!-- gear:learned:start -->";
const END = "<!-- gear:learned:end -->";

export interface PlaybookWrite {
  path: string;
  /** False when the generated block already matched what was on disk. */
  changed: boolean;
  /** Lessons in the block. */
  lessons: number;
  /** Distinct sessions the lessons came from. */
  sessions: number;
  /**
   * True when the block went to PENDING.md because learned skills have not been
   * enabled. The file exists and is readable; nothing loads it.
   */
  pending: boolean;
}

/**
 * The entries a playbook may carry: this repo's, ACTIVE, and seen in at least
 * `minSessions` sessions.
 *
 * The stage filter is the change P7.7 makes. A `trial` lesson is being measured;
 * writing it into an executable skill would be acting on it before the
 * measurement finished.
 */
export function playbookEntries(
  entries: NotebookEntry[],
  opts: { minSessions?: number } = {},
): NotebookEntry[] {
  const min = opts.minSessions ?? 2;
  return entries
    .filter(
      (e) =>
        e.scope === "repo" &&
        !e.retired &&
        e.stage === "active" &&
        e.provenance.sessions.length >= min,
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}

type Section = "Verified commands" | "Layout" | "Pitfalls" | "Fixes" | "Other";

function sectionOf(e: NotebookEntry): Section {
  if (e.title.endsWith("-command") || e.title === "verified-check") return "Verified commands";
  if (e.title === "monorepo-layout") return "Layout";
  if (e.title.startsWith("avoid:")) return "Pitfalls";
  if (e.title.startsWith("fix:") || e.title.startsWith("prefer:")) return "Fixes";
  return "Other";
}

const SECTION_ORDER: Section[] = ["Verified commands", "Layout", "Fixes", "Pitfalls", "Other"];

function distinctSessions(entries: NotebookEntry[]): number {
  const all = new Set<string>();
  for (const e of entries) for (const s of e.provenance.sessions) all.add(s);
  return all.size;
}

/** The generated block, markers included. Deterministic for the same entries. */
export function renderPlaybookBlock(entries: NotebookEntry[]): string {
  const sessions = distinctSessions(entries);
  const lines: string[] = [
    START,
    `Learned by Gear from ${sessions} session${sessions === 1 ? "" : "s"} in this repository. ` +
      "Rewritten when a lesson recurs; anything outside these markers is kept.",
  ];
  for (const section of SECTION_ORDER) {
    const rows = entries.filter((e) => sectionOf(e) === section);
    if (rows.length === 0) continue;
    lines.push("", `## ${section}`);
    for (const e of rows) {
      const n = e.provenance.sessions.length;
      lines.push(`- ${e.body.replace(/\s+/g, " ").trim()} _(${n} session${n === 1 ? "" : "s"})_`);
    }
  }
  lines.push(END);
  return lines.join("\n");
}

function frontmatter(workspaceName: string, sessions: number): string {
  return [
    "---",
    "name: playbook",
    `description: How to work in ${workspaceName} — verified commands, fixes and pitfalls Gear learned from ${sessions} session${sessions === 1 ? "" : "s"} here. Load before running builds, tests or shell commands in this repository.`,
    "---",
    "",
    "# Playbook",
    "",
  ].join("\n");
}

/**
 * Write (or rewrite) the playbook from the repo's notebook entries. Returns
 * null when there is nothing to say and no file to maintain; `changed:false`
 * when the block on disk already matched, so callers can stay quiet.
 */
export function writePlaybook(
  workspaceRoot: string,
  entries: NotebookEntry[],
  opts: { minSessions?: number; enabled?: boolean } = {},
): PlaybookWrite | null {
  const rows = playbookEntries(entries, opts);
  // Consent gate: until the user has enabled learned skills once, the block
  // goes to a file the loader does not read. Writing a skill and letting it
  // load is a capability change; writing a file a person can read is not.
  const pending = opts.enabled !== true;
  const path = join(workspaceRoot, pending ? PLAYBOOK_PENDING_REL : PLAYBOOK_REL);
  const exists = existsSync(path);
  if (rows.length === 0 && !exists) return null;

  const block = renderPlaybookBlock(rows);
  const sessions = distinctSessions(rows);
  let next: string;
  if (exists) {
    const current = readFileSync(path, "utf8");
    const s = current.indexOf(START);
    const e = current.indexOf(END);
    if (s !== -1 && e !== -1 && e > s) {
      const existing = current.slice(s, e + END.length);
      if (existing === block) {
        return { path, changed: false, lessons: rows.length, sessions, pending };
      }
      next = current.slice(0, s) + block + current.slice(e + END.length);
    } else {
      // A hand-written playbook without markers: append ours, keep theirs.
      next = `${current.replace(/\s*$/, "")}\n\n${block}\n`;
    }
  } else {
    next = `${frontmatter(basename(workspaceRoot) || "this repository", sessions)}${block}\n\n## Notes\n\nYour own notes — Gear keeps everything outside the markers.\n`;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true, lessons: rows.length, sessions, pending };
}
