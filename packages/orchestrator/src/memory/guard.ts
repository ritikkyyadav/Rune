// ─── The memory guard — what may not be remembered ───
//
// `evolve/gardener-guard.ts` made a prompt-level rule mechanical for the
// gardener: a run may not COMMIT to the paths that decide what a run may do.
// This is the same move one layer further in. A memory entry is injected into
// every future session, so a line that reads as "skip the sandbox" is not a bad
// memory — it is a persistent prompt injection with the user's own store as its
// delivery vehicle, and the attacker does not even have to be an attacker: a
// frustrated "just stop asking me and push it" is a sentence a person really
// types, and the user's own words are otherwise the most trusted source here.
//
// So the guard sits BETWEEN the extractor and the store, and it refuses the
// same four classes the guarantees review named — permissions, budgets,
// sandbox, acceptance — plus verification and the duty to ask, plus secrets,
// plus anything shaped like file contents rather than like a fact.
//
// The corpus these patterns are tested against is a test file
// (tests/unit/orchestrator/memory-guard.test.ts), not a comment. A guard whose
// evidence is prose is the thing this file exists to stop being.

import { MAX_TEXT_CHARS, type MemoryRefusal } from "./types";

/**
 * Lines that would weaken the harness. Each is a SHAPE, not a keyword: "the
 * sandbox caught a bug" must survive, "turn off the sandbox" must not.
 *
 * Deliberately over-inclusive on the imperative side. A refused true fact costs
 * the user one `/memory add`; an accepted weakening costs them the guard.
 */
const WEAKENING_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  {
    rule: "sandbox",
    re: /\b(?:turn(?:\s+it)?\s+off|disable|bypass|skip|ignore|drop|without|don'?t\s+(?:use|enable))\b[^.]{0,40}\bsandbox\b|\bsandbox\b[^.]{0,30}\b(?:off|disabled|bypass(?:ed)?|unnecessary|not\s+needed)\b|--?dangerously[-\w]*|\bdangerouslyDisableSandbox\b/i,
  },
  {
    rule: "permissions",
    re: /\b(?:auto[-\s]?approve|approve\s+everything|allow\s+everything|grant\s+(?:all|every)|skip\s+(?:the\s+)?(?:permission|approval|confirm\w*)|no\s+(?:permission|approval)\s+(?:needed|required)|bypass\s+(?:the\s+)?(?:permission|broker)|yolo\s*mode)\b/i,
  },
  {
    rule: "asking",
    re: /\b(?:(?:don'?t|do\s+not|never|stop)\s+(?:bother\s+)?(?:ask(?:ing)?|confirm(?:ing)?|check(?:ing)?\s+with\s+me|prompt(?:ing)?\s+me)|without\s+asking|no\s+need\s+to\s+ask|just\s+do\s+it\s+without)\b/i,
  },
  {
    rule: "verification",
    re: /\b(?:skip|no\s+need\s+for|don'?t\s+(?:bother\s+)?(?:run|running|writ\w+)|never\s+run)\b[^.]{0,40}\b(?:tests?|typecheck|lint|verif\w+|check\w*|gates?)\b|--no-verify|\bassume\s+(?:it\s+)?(?:works|passes|passed)\b|\b(?:tests?|checks?)\s+(?:are\s+)?(?:optional|a\s+waste|unnecessary)\b/i,
  },
  {
    rule: "budget",
    re: /\b(?:ignore|raise|remove|lift|disable|no)\b[^.]{0,30}\b(?:budget|cost\s+cap|spend\s+limit|token\s+limit|turn\s+limit|max\s*turns)\b|\b(?:spend|cost)\b[^.]{0,20}\b(?:doesn'?t\s+matter|no\s+object|unlimited)\b/i,
  },
  {
    rule: "acceptance",
    re: /\b(?:skip|drop|lower|relax|ignore|waive)\b[^.]{0,30}\b(?:acceptance|criteri\w+|definition\s+of\s+done|the\s+contract)\b|\bmark\s+(?:it|steps?|everything)\s+(?:as\s+)?(?:done|complete|satisfied)\s+(?:anyway|regardless|without)/i,
  },
  {
    rule: "git-safety",
    re: /\b(?:force[-\s]?push|push\s+(?:straight\s+)?to\s+(?:main|master)|git\s+push\s+(?:--force|-f)\b|reset\s+--hard|git\s+stash|--force-with-lease)\b|\b(?:it'?s\s+)?(?:fine|ok(?:ay)?|safe)\s+to\s+push\b/i,
  },
  {
    rule: "override",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system|your)\s+(?:instructions?|prompt|rules?|doctrine|guidelines?)\b|\byou\s+are\s+now\b|\bfrom\s+now\s+on\s+you\s+(?:must|will|should)\s+(?:ignore|disregard)/i,
  },
];

/**
 * Credential shapes. The refusal never echoes the match — see MemoryRefusal.
 *
 * The long-run patterns at the end are the crude ones and they are kept crude:
 * a 32-char hex string in a memory entry is either a secret or a commit hash,
 * and neither belongs in a sentence about how the user likes their answers.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)\s*[:=]\s*\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/**
 * Shapes that say "this is a file, or a tool's output" rather than "this is a
 * fact". Memory holds facts ABOUT work, never the work.
 */
const ARTEFACT_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "code", re: /```|^\s*(?:function|class|const|let|var|import|export|def|fn)\s/m },
  { rule: "diff", re: /^(?:[+-]{3}\s|@@\s-\d|[+-]\s*\w.*\n[+-])/m },
  { rule: "stack-trace", re: /^\s*at\s+\S+\s*\(?[^\s)]+:\d+(?::\d+)?\)?/m },
  {
    rule: "compiler-output",
    re: /^[\w./-]+\([\d,]+\):\s*(?:error|warning)\b|\berror\s+TS\d{3,}\b/im,
  },
  { rule: "path-dump", re: /^[\w./-]*\/[\w./-]+:\d+:/m },
];

export interface GuardVerdict {
  ok: boolean;
  refusal?: MemoryRefusal;
}

const OK: GuardVerdict = { ok: true };

/**
 * The one entry point. Every write into the store goes through it — the
 * extractor, the manual `/memory add`, and the distillation path alike, because
 * a guard the manual path can walk around is a guard with a door in it.
 */
export function guardMemoryText(text: string): GuardVerdict {
  const raw = text ?? "";
  const trimmed = raw.trim();

  if (!trimmed) {
    return refuse("empty", "nothing to remember");
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    return refuse(
      "too-long",
      `a memory entry is a fact, not a document (${trimmed.length} > ${MAX_TEXT_CHARS} chars)`,
      clip(trimmed),
    );
  }
  // Multi-line text is almost always pasted output. Two lines is the ceiling:
  // a user's own sentence wrapping once is legitimate, a paste is not.
  if (trimmed.split("\n").length > 2) {
    return refuse("multiline", "looks like pasted output rather than a fact", clip(trimmed));
  }

  for (const re of SECRET_PATTERNS) {
    if (re.test(trimmed)) {
      // No `sample`. Deliberate.
      return refuse("secret", "contains something credential-shaped");
    }
  }

  for (const { rule, re } of ARTEFACT_PATTERNS) {
    if (re.test(trimmed)) {
      return refuse(rule, "looks like file contents or tool output, not a fact", clip(trimmed));
    }
  }

  for (const { rule, re } of WEAKENING_PATTERNS) {
    if (re.test(trimmed)) {
      return refuse(
        rule,
        `would weaken the ${rule} guard — memory may not carry an instruction that lowers a boundary`,
        clip(trimmed),
      );
    }
  }

  return OK;
}

/** True when the text is safe to store. The thin form, for call sites that
 *  only branch and do not report. */
export function isMemorySafe(text: string): boolean {
  return guardMemoryText(text).ok;
}

function refuse(rule: string, reason: string, sample?: string): GuardVerdict {
  return { ok: false, refusal: sample ? { rule, reason, sample } : { rule, reason } };
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 77) + "…" : one;
}

/** The rule names the guard can emit — used by the tests and by `/memory`. */
export const GUARD_RULES: readonly string[] = [
  "empty",
  "too-long",
  "multiline",
  "secret",
  ...ARTEFACT_PATTERNS.map((p) => p.rule),
  ...WEAKENING_PATTERNS.map((p) => p.rule),
];
