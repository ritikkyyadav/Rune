// ─── Promotion: how a candidate earns a place in the next session's prompt ───
//
// Quarantine is the whole point of the store. Writing a candidate is cheap and
// nearly free of consequence; PROMOTING one puts a sentence in front of every
// future run, so the bar is per-source and it is mechanical:
//
//   user-said / user-corrected  → immediately. They are the user's.
//   observed                    → two distinct sessions. One is an anecdote.
//   verified-outcome            → immediately, but only WITH its evidence.
//   distilled                   → never, by construction.
//
// Two things happen alongside promotion, and both are about not letting the
// store rot: a newer correction SUPERSEDES the older entry it contradicts
// (kept, not deleted — what changed the user's mind is worth keeping), and
// entries that live on repetition expire when the repetition stops.

import type { MemoryStore } from "./store";
import {
  OBSERVED_DECAY_DAYS,
  OBSERVED_SESSIONS_TO_PROMOTE,
  VERIFIED_DECAY_DAYS,
  type MemoryEntry,
  sameScope,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromotionResult {
  promoted: MemoryEntry[];
  superseded: MemoryEntry[];
  expired: MemoryEntry[];
  /** Still in quarantine after this pass. */
  waiting: MemoryEntry[];
}

/** Whether a candidate has earned injection. Pure — the tests read this directly. */
export function readyToPromote(entry: MemoryEntry): boolean {
  if (entry.pinned) return true;
  switch (entry.provenance.source) {
    case "user-said":
    case "user-corrected":
      return true;
    case "verified-outcome":
      // Evidence is what makes it a verified outcome rather than a claim. An
      // entry that lost its citation is a claim again.
      return Boolean(entry.provenance.evidence);
    case "observed":
      return entry.provenance.sessionIds.length >= OBSERVED_SESSIONS_TO_PROMOTE;
    case "distilled":
      return false;
  }
}

/**
 * One pass over the store: promote what qualifies, supersede what a newer
 * correction contradicts, drop what has decayed. Idempotent — running it twice
 * with no new candidates changes nothing on disk, which is what keeps the
 * rendered guide byte-stable across runs.
 */
export function promoteAll(store: MemoryStore, now: Date = new Date()): PromotionResult {
  const result: PromotionResult = { promoted: [], superseded: [], expired: [], waiting: [] };
  const nowMs = now.getTime();

  // ── Decay first, so an expired entry cannot supersede a live one ──
  for (const entry of store.all()) {
    if (entry.pinned || !entry.expiresAt) continue;
    if (Date.parse(entry.expiresAt) <= nowMs) {
      if (store.remove(entry.id)) result.expired.push(entry);
    }
  }

  // ── Promote ──
  for (const entry of store.all()) {
    if (entry.status !== "candidate") continue;
    if (!readyToPromote(entry)) {
      result.waiting.push(entry);
      continue;
    }
    result.promoted.push(store.put({ ...entry, status: "promoted", ...expiryFor(entry, now) }));
  }

  // ── Refresh the clock on entries that were seen again ──
  // Re-observation is what an `observed` entry lives on; without this the
  // sixtieth day retires a fact the agent confirmed yesterday.
  for (const entry of store.all()) {
    if (entry.status !== "promoted" || entry.pinned) continue;
    const want = expiryFor(entry, now).expiresAt;
    if (want && want !== entry.expiresAt) store.put({ ...entry, expiresAt: want });
  }

  // ── Supersede ──
  // Only a CORRECTION supersedes. A second "always X" that happens to share
  // vocabulary with an older one is agreement, not a reversal.
  const live = store.all().filter((e) => e.status === "promoted");
  for (const fresh of live) {
    if (fresh.provenance.source !== "user-corrected") continue;
    for (const old of live) {
      if (old.id === fresh.id) continue;
      if (old.status !== "promoted") continue;
      if (old.kind !== fresh.kind || !sameScope(old.scope, fresh.scope)) continue;
      if (!isNewer(fresh, old)) continue;
      if (!sameTopic(old.text, fresh.text)) continue;
      old.status = "superseded";
      store.put({ ...old, status: "superseded", supersededBy: fresh.id });
      store.put({ ...fresh, supersedes: old.id });
      result.superseded.push(old);
    }
  }

  store.prune();
  return result;
}

function isNewer(a: MemoryEntry, b: MemoryEntry): boolean {
  const at = Date.parse(a.provenance.lastSeenAt ?? a.provenance.at);
  const bt = Date.parse(b.provenance.lastSeenAt ?? b.provenance.at);
  return at > bt;
}

function expiryFor(entry: MemoryEntry, now: Date): { expiresAt?: string } {
  if (entry.pinned) return {};
  const from = Date.parse(entry.provenance.lastSeenAt ?? entry.provenance.at) || now.getTime();
  switch (entry.provenance.source) {
    case "observed":
      return { expiresAt: new Date(from + OBSERVED_DECAY_DAYS * DAY_MS).toISOString() };
    case "verified-outcome":
      return { expiresAt: new Date(from + VERIFIED_DECAY_DAYS * DAY_MS).toISOString() };
    default:
      // The user's own words do not expire. Neither does distilled prose — it
      // dies with the entries it traces to, not on a clock of its own.
      return {};
  }
}

// ─── Topic matching ───
//
// Keyword overlap, not embeddings. It catches "always run typecheck first" vs
// "no, run the tests first" — the reversal a user actually types — and it will
// miss a subtle one, which is why `/memory forget` exists and why the design
// doc says so out loud rather than claiming otherwise.

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "it",
  "this",
  "that",
  "you",
  "your",
  "i",
  "me",
  "my",
  "we",
  "us",
  "do",
  "does",
  "did",
  "should",
  "must",
  "can",
  "will",
  "would",
  "just",
  "please",
  "want",
  "like",
  "need",
  "prefer",
  "always",
  "never",
  "dont",
  "not",
  "no",
  "actually",
  "first",
  "before",
  "after",
  "when",
  "then",
  "at",
  "by",
  "as",
  "or",
]);

/** The words that decide what an entry is ABOUT, polarity stripped. */
export function topicWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard ≥ 0.5 on topic words. Two entries about the same thing. */
export function sameTopic(a: string, b: string): boolean {
  const wa = topicWords(a);
  const wb = topicWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  const union = wa.size + wb.size - shared;
  return union > 0 && shared / union >= 0.5;
}
