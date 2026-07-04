// ─── Notebook injection: budgeted, fenced, honest about fallibility ───
// The whole point of the token-frugality contract: injection is the ONLY
// recurring cost of the evolution loop, and it is hard-capped (default 600
// tokens ≈ 0.06% of a 1M-token session). Entries are pre-ranked by the store
// (repo > stack > global, then win-rate); we take what fits.

import type { NotebookEntry, NotebookStore } from "./store";

const CHARS_PER_TOKEN = 4; // the same coarse heuristic the context engine uses

export interface NotebookBlock {
  text: string;
  injectedIds: string[];
}

export function buildNotebookBlock(
  store: NotebookStore,
  opts: { repoKey: string; stackKey: string; maxTokens?: number },
): NotebookBlock {
  const budgetChars = (opts.maxTokens ?? 600) * CHARS_PER_TOKEN;
  const entries = store.retrieve({ repoKey: opts.repoKey, stackKey: opts.stackKey, limit: 30 });
  if (entries.length === 0) return { text: "", injectedIds: [] };

  const header =
    "## Notebook (learned from past sessions in this and similar codebases — " +
    "treat as hints, verify against reality, they may be stale)\n";
  let used = header.length;
  const lines: string[] = [];
  const ids: string[] = [];
  for (const e of entries) {
    const line = `- ${scopeTag(e)} ${e.body}\n`;
    if (used + line.length > budgetChars) break;
    used += line.length;
    lines.push(line);
    ids.push(e.id);
  }
  if (lines.length === 0) return { text: "", injectedIds: [] };
  return { text: header + lines.join(""), injectedIds: ids };
}

function scopeTag(e: NotebookEntry): string {
  if (e.scope === "repo") return "[this repo]";
  if (e.scope === "stack") return `[${e.stackKey ?? "stack"}]`;
  return "[general]";
}
