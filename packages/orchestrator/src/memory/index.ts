// ─── Autonomous memory — the seam the engine sees ───
//
// Two calls, and the engine should need no more than these: one at run end that
// learns, one at session start that renders. Everything expensive to get wrong
// (what may be remembered, what earns injection, what a sub-agent sees) is
// decided inside, so a future edit to the engine cannot widen the door by
// accident.
//
// Design: docs/program/memory-autonomous.md

export { MemoryStore, entryId, normalizeText } from "./store";
export {
  guardMemoryText,
  guardMemoryNarrative,
  isMemorySafe,
  GUARD_RULES,
  type GuardVerdict,
  type NarrativeVerdict,
} from "./guard";
export {
  extractFromRun,
  extractUserPreferences,
  outcomeAllowsPositiveLessons,
  type RunMemoryInput,
  type Extraction,
} from "./extract";
export { promoteAll, readyToPromote, sameTopic, topicWords, type PromotionResult } from "./promote";
export {
  renderMemoryGuide,
  selectForGuide,
  provenanceNote,
  guideTokens,
  type RenderOptions,
  type MemoryAudience,
} from "./render";
export {
  buildMemoryBlock,
  buildSubagentMemoryBlock,
  memoryNoticeLine,
  countInjected,
  MEMORY_BLOCK_HEADING,
} from "./inject";
export {
  createMemoryUpdateTool,
  MEMORY_UPDATE_TOOL_SCHEMA,
  type MemoryUpdateResult,
  type MemoryUpdateToolDeps,
} from "./update-tool";
export * from "./types";

import { MemoryStore } from "./store";
import { extractFromRun, type RunMemoryInput } from "./extract";
import { promoteAll } from "./promote";
import { buildMemoryBlock } from "./inject";
import type { MemoryRefusal } from "./types";

export interface CaptureResult {
  proposed: number;
  stored: number;
  promoted: number;
  superseded: number;
  expired: number;
  waiting: number;
  refusals: MemoryRefusal[];
  notes: string[];
}

/**
 * Run end. Deterministic, zero model calls, and it never throws — a memory that
 * can fail a run is worse than no memory at all.
 */
export function captureRunMemory(
  store: MemoryStore,
  input: RunMemoryInput,
  now: Date = new Date(),
): CaptureResult {
  const empty: CaptureResult = {
    proposed: 0,
    stored: 0,
    promoted: 0,
    superseded: 0,
    expired: 0,
    waiting: 0,
    refusals: [],
    notes: [],
  };
  try {
    const { candidates, notes, refusals: preRefusals } = extractFromRun(input);
    // The extractor's own refusals still reach the diary: moving the guard
    // earlier changed WHEN a weakening line is turned away, not whether the
    // user can read that it was.
    const refusals: MemoryRefusal[] = [...preRefusals];
    for (const refusal of preRefusals) store.logRefusal(refusal, now);
    let stored = 0;
    for (const candidate of candidates) {
      const r = store.observe(candidate, now);
      if (r.refusal) refusals.push(r.refusal);
      else stored += 1;
    }
    const promotion = promoteAll(store, now);
    return {
      proposed: candidates.length,
      stored,
      promoted: promotion.promoted.length,
      superseded: promotion.superseded.length,
      expired: promotion.expired.length,
      waiting: promotion.waiting.length,
      refusals,
      notes,
    };
  } catch {
    return empty;
  }
}

/** Session start. "" when memory has nothing to say. Never throws. */
export function memoryBlockFor(
  store: MemoryStore,
  opts: { workspace?: string; maxTokens: number; audience?: "session" | "subagent" },
): string {
  try {
    return buildMemoryBlock(store.all(), opts);
  } catch {
    return "";
  }
}
