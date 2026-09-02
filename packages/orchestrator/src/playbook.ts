// ─── The playbook: a skill Gear writes for itself, in the repository ───
//
// The notebook is the machine-facing memory: scoped rows in ~/.gear, injected
// under a token budget, invisible to anyone but the model. The playbook is
// the same knowledge made a file in the workspace — `.gear/skills/playbook/
// SKILL.md` — where a person can read it, edit it, diff it, and commit it,
// and where the skills loader lists it to the model like any other skill.
//
// Only lessons that RECURRED get in (two sessions or more): one session's
// observation is a note, two are a fact about the repository. The generated
// block sits between markers; everything a person writes outside them is
// kept on every rewrite.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NotebookEntry } from "./notebook/store";

export const PLAYBOOK_REL = join(".gear", "skills", "playbook", "SKILL.md");

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
}

/** The entries a playbook may carry: this repo's, alive, seen in ≥ minSessions sessions. */
export function playbookEntries(
  entries: NotebookEntry[],
  opts: { minSessions?: number } = {},
): NotebookEntry[] {
  const min = opts.minSessions ?? 2;
  return entries
    .filter((e) => e.scope === "repo" && !e.retired && e.provenance.sessions.length >= min)
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
  opts: { minSessions?: number } = {},
): PlaybookWrite | null {
  const rows = playbookEntries(entries, opts);
  const path = join(workspaceRoot, PLAYBOOK_REL);
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
        return { path, changed: false, lessons: rows.length, sessions };
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
  return { path, changed: true, lessons: rows.length, sessions };
}
