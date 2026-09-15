// ─── Rendering the guide ───
//
// The store is the record; this is the thing a model reads. Two properties
// matter more than prettiness:
//
//   · DETERMINISM. The same promoted set renders the same bytes, always. A
//     memory file whose contents shuffle every run is a file nobody can diff
//     and therefore nobody can audit — and "did memory change?" is the first
//     question anyone debugging a weird session will ask.
//   · SCOPE. A `project` fact reaches exactly the workspace it was learned in,
//     by a filter here, not by a sentence asking the model to ignore it.

import { clampToBudget, estimateMemoryTokens } from "@rune/shared";

import type { MemoryEntry, MemoryKind } from "./types";

export type MemoryAudience = "session" | "subagent";

export interface RenderOptions {
  /** Workspace root. Project facts from anywhere else are dropped. */
  workspace?: string;
  /** Hard ceiling — the `[memory] maxTokens` budget. */
  maxTokens: number;
  /**
   * `subagent` renders project facts and nothing else. A sub-agent is a bounded
   * worker on one file; the founder's taste in prose is not its business and
   * shipping it there is pure token cost.
   */
  audience?: MemoryAudience;
}

const SECTIONS: ReadonlyArray<{ kind: MemoryKind; heading: string }> = [
  { kind: "person", heading: "How you like answers" },
  { kind: "working", heading: "How you work" },
  { kind: "project", heading: "This workspace" },
  { kind: "lesson", heading: "What worked here" },
];

/** Selection + ordering, before any text is produced. Exported because the cap
 *  test and the scope test both want the set rather than the prose. */
export function selectForGuide(
  entries: readonly MemoryEntry[],
  opts: RenderOptions,
): MemoryEntry[] {
  const now = Date.now();
  const subagent = opts.audience === "subagent";
  return entries
    .filter((e) => {
      if (e.status !== "promoted") return false;
      if (!e.pinned && e.expiresAt && Date.parse(e.expiresAt) <= now) return false;
      if (subagent && e.kind !== "project") return false;
      if (e.scope === "global") return true;
      return opts.workspace !== undefined && e.scope.workspace === opts.workspace;
    })
    .sort(compareForGuide);
}

/**
 * Pinned first, then by how much the store is entitled to believe it, then
 * newest, then by id so the order is total. Every term is a stored value — no
 * clock, no randomness, no insertion order.
 */
function compareForGuide(a: MemoryEntry, b: MemoryEntry): number {
  const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pin !== 0) return pin;
  const rank = sourceRank(b) - sourceRank(a);
  if (rank !== 0) return rank;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const at = (b.provenance.lastSeenAt ?? b.provenance.at).localeCompare(
    a.provenance.lastSeenAt ?? a.provenance.at,
  );
  if (at !== 0) return at;
  return a.id.localeCompare(b.id);
}

function sourceRank(e: MemoryEntry): number {
  switch (e.provenance.source) {
    case "user-corrected":
      return 4;
    case "user-said":
      return 3;
    case "verified-outcome":
      return 2;
    case "observed":
      return 1;
    case "distilled":
      return 0;
  }
}

/** The one-line provenance a reader can check. Absolute dates, never relative —
 *  "3 days ago" would make the guide's bytes a function of when it was read. */
export function provenanceNote(e: MemoryEntry): string {
  const day = (e.provenance.at ?? "").slice(0, 10);
  switch (e.provenance.source) {
    case "user-corrected":
      return `you corrected this${day ? `, ${day}` : ""}`;
    case "user-said":
      return `you said this${day ? `, ${day}` : ""}`;
    case "verified-outcome":
      return `verified${e.provenance.evidence ? `: ${e.provenance.evidence}` : ""}`;
    case "observed":
      return `seen in ${e.provenance.sessionIds.length} sessions`;
    case "distilled":
      return "distilled from the above";
  }
}

/** The guide body — sections, bullets, provenance. Empty string when there is
 *  nothing promoted, so callers can test it with a truthiness check. */
export function renderMemoryGuide(entries: readonly MemoryEntry[], opts: RenderOptions): string {
  const chosen = selectForGuide(entries, opts);
  if (chosen.length === 0) return "";
  const parts: string[] = [];
  for (const { kind, heading } of SECTIONS) {
    const rows = chosen.filter((e) => e.kind === kind);
    if (rows.length === 0) continue;
    parts.push(heading);
    for (const e of rows) {
      const note = provenanceNote(e);
      parts.push(`- ${e.text}${note ? `   (${note})` : ""}`);
    }
    parts.push("");
  }
  return clampToBudget(parts.join("\n").trimEnd(), opts.maxTokens);
}

/** What the guide costs, for `/memory` and the prompt inspector. */
export function guideTokens(guide: string): number {
  return estimateMemoryTokens(guide);
}
