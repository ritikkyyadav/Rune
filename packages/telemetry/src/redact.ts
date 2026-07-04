// ─── The single redaction chokepoint ───
// Everything the black box persists (messages, stacks, trail summaries, raw
// snippets) passes through here first. Property-tested: known secret shapes
// must never survive. Deliberately pattern-based and conservative — a false
// positive redacts a harmless string; a false negative leaks a credential.

import { homedir } from "node:os";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Private key blocks first (multi-line, would otherwise partially match below)
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted:private-key]",
  ],
  // Vendor token shapes
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted:api-key]"], // OpenAI / Anthropic (sk-ant-…)
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted:github-token]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted:aws-key]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted:slack-token]"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[redacted:google-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted:jwt]"],
  // Bearer headers
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]"],
  // key=value / key: value assignments whose key smells secret. Keeps the key,
  // drops the value.
  [
    /\b(api[_-]?key|apikey|token|secret|password|passwd|credential|auth(?:orization)?)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi,
    "$1$2[redacted]",
  ],
];

export interface RedactOptions {
  /** Also collapse the user's home directory to `~`. Default true. */
  collapseHome?: boolean;
}

export function redactText(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;
  let s = input;
  for (const [re, replacement] of SECRET_PATTERNS) {
    s = s.replace(re, replacement);
  }
  if (opts.collapseHome !== false) {
    const home = homedir();
    if (home && home !== "/") s = s.split(home).join("~");
  }
  return s;
}

/** True if redaction would change the input — used by tests and pre-flight checks. */
export function containsSecret(input: string): boolean {
  return redactText(input, { collapseHome: false }) !== input;
}
