// ─── The extractor — the only thing that proposes new memories ───
//
// Deterministic. No model call, ever, on this path: the run that just ended is
// the worst possible witness to itself, and paying a model to summarise it
// would buy a confident summary of an unreliable account.
//
// Three admissible sources, and the list is closed:
//
//   (a) the USER'S OWN WORDS, quoted verbatim — a correction, a standing rule,
//       a stated taste;
//   (b) a VERIFIED OUTCOME — a lesson minted only from a run whose verdict was
//       `met`, or from a check whose exit code is on record;
//   (c) REPETITION — a fact seen in two distinct sessions.
//
// What is NOT here is the point: there is no code path from an assistant
// message into a candidate. Not a filter over the model's prose — an absence of
// any reader for it.

import { guardMemoryText } from "./guard";
import {
  MAX_TEXT_CHARS,
  type MemoryCandidate,
  type MemoryKind,
  type MemoryRefusal,
  type MemoryScope,
} from "./types";
import { normalizeText } from "./store";

/** What the engine hands over at run end. Deliberately plain data — the
 *  extractor knows nothing about the Engine, and the tests drive it directly. */
export interface RunMemoryInput {
  sessionId: string;
  /** Workspace root — the key every `project` fact is scoped to. */
  workspace: string;
  /** Only the user's messages. Assistant text is not passed and has no reader. */
  userMessages: readonly string[];
  outcome: {
    /** The contract verdict this run wrote, when it wrote one. */
    verdictKind?: "none" | "met" | "unmet" | "partial";
    runError?: boolean;
    aborted?: boolean;
    /** `halted`, `provider_lost`, … — anything but a clean finish blocks lessons. */
    stopReason?: string;
  };
  /** Checks the run actually ran, with the exit the runtime read. */
  checks?: ReadonlyArray<{ command: string; passed: boolean }>;
  /** The retro's own rule-derived lessons. Produced from the persisted check
   *  log by retro.ts — never from the transcript. */
  retroLessons?: ReadonlyArray<{ kind: string; title: string; body: string; evidence?: string }>;
}

export interface Extraction {
  candidates: MemoryCandidate[];
  /**
   * What the guard turned away before it ever became a proposal.
   *
   * V7 finding 5. The guard used to stand only in front of the STORE, so a
   * weakening line was proposed, refused, and counted as a proposal — which
   * made "the extractor proposed eight things and stored none" the same
   * number as "the extractor proposed eight things". A candidate that cannot
   * be stored was never a candidate; it is a refusal, and it is reported as
   * one. `captureRunMemory` still writes every one of these to the store's
   * diary, so nothing is lost by moving the gate earlier.
   */
  refusals: MemoryRefusal[];
  /** Why a source was skipped wholesale (e.g. the run did not succeed). */
  notes: string[];
}

// ─── (a) The user's own words ───

/** A correction: the user telling the agent it got something wrong. */
const CORRECTION_RE =
  /^(?:no|nope|wrong)\b[\s,.:;—-]|^actually[\s,]|\bthat'?s\s+(?:wrong|not\s+(?:what|right))\b|\bstop\s+doing\s+that\b|\bi\s+(?:said|told\s+you)\b/i;

/** A standing rule: always / never / don't. */
const RULE_RE = /\b(?:always|never)\b|\b(?:don'?t|do\s+not)\b/i;

/** A stated taste. */
const TASTE_RE = /\bi\s+(?:want|like|hate|prefer|need|expect|don'?t\s+want)\b/i;

/**
 * The topic filter, and the reason this extractor is conservative rather than
 * clever.
 *
 * "I want a login page" is a TASK. "I want short answers" is a PREFERENCE. Both
 * match TASTE_RE, and only the second belongs in memory — a store that learns
 * the first will brief every future session about a login page nobody is
 * building any more. So a sentence only survives if it is ABOUT how answers
 * read or how work gets done.
 *
 * The cost of this filter is real preferences it misses. That is the correct
 * side to be wrong on: a missed preference costs one `/memory add`, a captured
 * task pollutes every session until someone notices.
 */
const PERSON_TOPIC_RE =
  /\b(?:answers?|repl(?:y|ies)|responses?|tone|short|brief|concise|terse|verbose|detail(?:ed|s)?|format|markdown|bullets?|tables?|emoji|prose|explain(?:ation)?s?|summar(?:y|ies|ise|ize)|sugar[-\s]?coat\w*|padding|fluff|hedg\w+|jargon|honest|unsugared|facts?|invent\w*|made[-\s]?up|guess\w*|language|english|hindi)\b/i;

const WORKING_TOPIC_RE =
  /\b(?:tests?|typecheck|tsc|lint|verif\w+|checks?|gates?|commit(?:s|ting)?|push(?:ing|es)?|branch(?:es)?|merge|pull\s+request|pr\b|ask(?:ing)?|confirm\w*|plan(?:ning|s)?|report(?:s|ing)?|budget|cost|spend|credits?|prove|evidence|proceed|review\w*|build|run(?:ning)?|install|deploy|refactor|document\w*)\b/i;

/**
 * Split into sentences without swallowing the ones that matter. Deliberately
 * naive: a memory is a sentence the user typed, and a sentence boundary that
 * occasionally keeps two clauses together is better than one that cuts a
 * preference in half.
 */
function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Which bucket a preference belongs in. Working wins a tie: "give me a report
 *  before you proceed" is about the work, not about the prose. */
function bucketOf(sentence: string): MemoryKind | null {
  if (WORKING_TOPIC_RE.test(sentence)) return "working";
  if (PERSON_TOPIC_RE.test(sentence)) return "person";
  return null;
}

/** The user's words, verbatim. Never rewritten, never summarised. */
export function extractUserPreferences(
  userMessages: readonly string[],
  sessionId: string,
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const message of userMessages) {
    // A slash command or a pasted block is not a person making a request.
    if (!message || message.trimStart().startsWith("/")) continue;
    for (const sentence of sentences(message)) {
      if (sentence.length > MAX_TEXT_CHARS) continue;
      const corrected = CORRECTION_RE.test(sentence);
      const stated = RULE_RE.test(sentence) || TASTE_RE.test(sentence);
      if (!corrected && !stated) continue;
      const kind = bucketOf(sentence);
      if (!kind) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind,
        text: sentence,
        source: corrected ? "user-corrected" : "user-said",
        sessionId,
        scope: "global",
      });
    }
  }
  return out;
}

// ─── (b) and (c): what the machine can vouch for ───

/**
 * A run that did not succeed teaches nothing positive. `met` and nothing else —
 * a `partial` run is exactly the shape of "the model claimed success and one
 * criterion says otherwise", which is the failure the founder named.
 */
export function outcomeAllowsPositiveLessons(outcome: RunMemoryInput["outcome"]): boolean {
  if (outcome.runError || outcome.aborted) return false;
  if (outcome.stopReason && outcome.stopReason !== "finished" && outcome.stopReason !== "done") {
    return false;
  }
  return outcome.verdictKind === "met";
}

/** The whole extraction for one run. */
export function extractFromRun(input: RunMemoryInput): Extraction {
  const notes: string[] = [];
  const refusals: MemoryRefusal[] = [];
  const candidates: MemoryCandidate[] = [
    ...extractUserPreferences(input.userMessages, input.sessionId),
  ];
  const scope: MemoryScope = { workspace: input.workspace };
  const positive = outcomeAllowsPositiveLessons(input.outcome);

  if (!positive) {
    notes.push(
      `no positive lesson: verdict ${input.outcome.verdictKind ?? "none"}${
        input.outcome.runError ? " (errored)" : input.outcome.aborted ? " (aborted)" : ""
      }`,
    );
  }

  // (b) Verified outcomes. The body is the retro's rule-derived lesson, which
  // comes from the check log rather than from anything the model wrote.
  if (positive) {
    for (const lesson of input.retroLessons ?? []) {
      if (lesson.kind !== "check" && lesson.kind !== "fix") continue;
      candidates.push({
        kind: "lesson",
        text: lesson.body,
        source: "verified-outcome",
        sessionId: input.sessionId,
        scope,
        evidence: `verdict=met; ${lesson.evidence ?? lesson.title}`,
      });
    }
  }

  // The avoid side needs no clean verdict — a check that failed is an exit
  // code, and an exit code is true whether or not the run went well. This is
  // the one thing a failed run may teach.
  for (const check of input.checks ?? []) {
    if (check.passed) continue;
    candidates.push({
      kind: "lesson",
      text: `avoid: \`${clipCommand(check.command)}\` — it failed here`,
      source: "verified-outcome",
      sessionId: input.sessionId,
      scope,
      evidence: `check failed: ${clipCommand(check.command)}`,
    });
  }

  // (c) Repetition. A command that passes here is a fact about this workspace
  // once it has passed in two different sessions — the store counts the
  // sessions, this only proposes.
  for (const check of input.checks ?? []) {
    if (!check.passed) continue;
    candidates.push({
      kind: "project",
      text: `a check that passes here: \`${clipCommand(check.command)}\``,
      source: "observed",
      sessionId: input.sessionId,
      scope,
    });
  }

  // The guard, here rather than only at the store's door. A line it refuses is
  // not a proposal that failed; it is a refusal, and the count has to say so.
  const kept: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const verdict = guardMemoryText(normalizeText(candidate.text));
    if (verdict.ok) kept.push(candidate);
    else refusals.push(verdict.refusal!);
  }
  return { candidates: kept, refusals, notes };
}

function clipCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}
