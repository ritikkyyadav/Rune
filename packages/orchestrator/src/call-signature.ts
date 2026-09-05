// ─── Canonical tool-call signatures for the loop guards ───
//
// The failure breaker and the repeated-batch detector used to key on the raw
// `toolName:argsJson` string, so a model that shuffled whitespace, bumped a
// port, or re-rolled a timestamp re-ran a doomed call unbounded — the guard
// existed but was defeated by cosmetic variance. (Same family of signal as
// notebook/capture.ts `commandsAreVariants`, which pairs a failed command with
// its later successful variant; this module is the preventive side.)
//
// Two strengths, because the two consumers tolerate different false positives:
//
//  - breakerSignature (aggressive): counts FAILURES only. Folding all numbers
//    is safe there — retrying a failing bind on port 3001, 3002, 3003 is the
//    exact runaway being stopped, and two genuinely different calls that both
//    keep failing deserve a shared breaker anyway.
//
//  - batchSignature (conservative): feeds the same-batch loop detector, which
//    judges SUCCESSFUL work too. Small numbers must stay distinct or paginated
//    reads (`offset: 0/100/200`) would collapse into a fake "loop". Only
//    tokens that are volatile by construction (UUIDs, timestamps, long hashes)
//    and whitespace are folded.

import { createHash } from "node:crypto";
import { parseToolArguments } from "@rune/shared";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** Unix epoch seconds/millis, 2020s-plausible — matches nonce-ish arg noise. */
const EPOCH_RE = /\b1[6-9]\d{8}(?:\d{3})?\b/g;
/** Long hex runs: content hashes, session ids, cache keys. */
const LONG_HEX_RE = /\b[0-9a-f]{12,}\b/gi;
const NUM_RE = /\b\d+\b/g;

function normalizeText(value: string, aggressive: boolean): string {
  let out = value
    .replace(UUID_RE, "«uuid»")
    .replace(ISO_TS_RE, "«ts»")
    .replace(EPOCH_RE, "«ts»")
    .replace(LONG_HEX_RE, "«hex»")
    .replace(/\s+/g, " ")
    .trim();
  if (aggressive) out = out.replace(NUM_RE, "«n»");
  return out;
}

/** Recursively sort object keys and normalize string leaves. */
function canonicalize(value: unknown, aggressive: boolean): unknown {
  if (typeof value === "string") return normalizeText(value, aggressive);
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, aggressive));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key], aggressive);
    }
    return out;
  }
  return value;
}

function canonicalArgs(argsJson: string, aggressive: boolean): string {
  // parseToolArguments never throws; malformed JSON degrades to text-level
  // normalization of the raw string, which still kills whitespace variance.
  const parsed = parseToolArguments(argsJson);
  if (Object.keys(parsed).length === 0 && argsJson.trim() !== "" && argsJson.trim() !== "{}") {
    return normalizeText(argsJson, aggressive);
  }
  return JSON.stringify(canonicalize(parsed, aggressive));
}

/**
 * Signature for the consecutive-failure breaker. Aggressive: whitespace, key
 * order, UUIDs, timestamps, hashes, AND all numbers are folded.
 */
export function breakerSignature(toolName: string, argsJson: string): string {
  return `${toolName}:${canonicalArgs(argsJson, true)}`;
}

/**
 * Signature for the same-SHAPE failure streak: the tool and its ERROR, with
 * the arguments ignored entirely. breakerSignature stops a verbatim retry;
 * nothing stopped a model REWORDING a call that dies on the same rule every
 * time — nine differently-phrased ask_user calls, one identical validation
 * error, seven minutes of orbit (observed live 2026-08-31 on a free-tier
 * model). Only the error's first line is kept: stack tails and byte offsets
 * vary between attempts, the rule that refused the call does not.
 */
export function failureShapeSignature(toolName: string, error: string): string {
  const first = error.split("\n")[0] ?? "";
  return `${toolName}:${normalizeText(first, true).toLowerCase().slice(0, 160)}`;
}

/**
 * Signature for the repeated-batch loop detector. Conservative: whitespace,
 * key order, and by-construction-volatile tokens only — numeric args that can
 * legitimately advance (offsets, limits, line numbers) stay distinct.
 */
export function batchSignature(
  calls: ReadonlyArray<{ toolName: string; argsJson: string }>,
): string {
  return calls.map((c) => `${c.toolName}:${canonicalArgs(c.argsJson, false)}`).join("|");
}

/** Wall-clock noise inside results: `12ms`, `1.23s`, `(2.4 s)`, `0.5 sec`. */
const DURATION_RE = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/gi;

/**
 * Signature of a tool RESULT, for the loop guards that judge whether the
 * world is changing. The batch detector keyed on arguments (plus the write
 * count) alone, so a poll whose answer changed every time — `bash_output` on
 * a running job, a test run after a fix — still read as a repeat, and a run
 * that varied its calls while the identical answer came back 29 times read
 * as progress. Conservative normalization (whitespace, by-construction
 * volatile tokens) plus durations, then a short hash: "3 failed" and
 * "2 failed" stay distinct, "(1.2s)" and "(1.4s)" do not.
 */
export function resultSignature(text: string): string {
  const normalized = normalizeText(text, false).replace(DURATION_RE, "«dur»");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}
