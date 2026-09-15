// ─── What Rune is allowed to remember ───
//
// The shapes behind docs/program/memory-autonomous.md. One rule decides every
// field here: nothing enters memory unless a PERSON said it or a MACHINE proved
// it. Everything below exists to make that rule checkable after the fact —
// which is what `provenance` is for, and why it is not optional.

/** What an entry IS. */
export type MemoryKind = "person" | "working" | "project" | "lesson";

/**
 * Where an entry SITS. `candidate` is the quarantine the design calls the fifth
 * kind: an entry of one of the four kinds that has not earned injection yet.
 * `superseded` is kept rather than deleted — what changed the user's mind is
 * worth more than a tidy store.
 */
export type MemoryStatus = "candidate" | "promoted" | "superseded";

/**
 * Where the claim came from. The ordering matters: the first two are the user's
 * own words and promote on sight; `distilled` is prose ABOUT promoted entries
 * and can never promote on its own.
 */
export type MemorySource =
  "user-said" | "user-corrected" | "observed" | "verified-outcome" | "distilled";

export interface MemoryProvenance {
  source: MemorySource;
  /** Distinct sessions this claim was seen in. Length is the `observed` gate. */
  sessionIds: string[];
  /** ISO, first seen. */
  at: string;
  /** ISO, most recent sighting — what decay is measured from. */
  lastSeenAt?: string;
  /**
   * The verdict, check or correction that proves it. Required in practice for
   * `verified-outcome`; the promotion rules refuse that source without one.
   */
  evidence?: string;
}

/**
 * `global` reaches every workspace; `{ workspace }` reaches exactly one. The
 * scope is enforced by a filter in the renderer, not by a sentence in a prompt
 * — a project fact from another repo is a wrong fact, not a distracting one.
 */
export type MemoryScope = "global" | { workspace: string };

export interface MemoryEntry {
  /** Content-derived, 12 hex chars: the same fact never lands twice. */
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  /** ≤ MAX_TEXT_CHARS. User words are VERBATIM — never paraphrased. */
  text: string;
  provenance: MemoryProvenance;
  /** 0..1. Drives the render order and what overflow drops first. */
  confidence: number;
  observedCount: number;
  /** Never decays, never trimmed by the cap. */
  pinned?: boolean;
  expiresAt?: string;
  scope: MemoryScope;
  supersededBy?: string;
  supersedes?: string;
}

/** The store's hard bound. Overflow drops lowest-confidence oldest first. */
export const MAX_ENTRIES = 500;

/** An entry is a fact, not a document. */
export const MAX_TEXT_CHARS = 200;

/** `observed` needs this many DISTINCT sessions before it is a pattern. */
export const OBSERVED_SESSIONS_TO_PROMOTE = 2;

/** Days an `observed` entry survives without being seen again. */
export const OBSERVED_DECAY_DAYS = 60;

/** Days a `verified-outcome` lesson survives without re-verification. */
export const VERIFIED_DECAY_DAYS = 90;

/** A proposal from the extractor — an entry that has not been stored yet. */
export interface MemoryCandidate {
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  sessionId: string;
  scope: MemoryScope;
  evidence?: string;
  confidence?: number;
}

/** Why a candidate was refused. Surfaced by `/memory`; never silent. */
export interface MemoryRefusal {
  /** The rule that refused it. */
  rule: string;
  /** One line the user can read. NEVER contains the refused text when the rule
   *  is `secret` — printing the credential to explain that it was a credential
   *  is the one mistake this whole file exists to avoid. */
  reason: string;
  /** Present only when the refused text is safe to show. */
  sample?: string;
}

export function scopeKey(scope: MemoryScope): string {
  return scope === "global" ? "global" : `ws:${scope.workspace}`;
}

export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return scopeKey(a) === scopeKey(b);
}
