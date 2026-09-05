/**
 * Security and safety layer per Section 9.
 *
 * Defenses:
 * - Prompt injection detection (Threats 1, 2)
 * - Untrusted input tagging
 * - Output filtering for PII/secrets (Threat 4)
 * - Egress filtering (Threat 4)
 * - Data minimization principle (Section 9.3)
 */

// ─── Prompt Injection Detection ───

export interface ScanFinding {
  type: string;
  match: string;
  position: number;
  confidence?: "low" | "medium" | "high";
  /** Which pattern family produced the finding (see InjectionPatternFamily). */
  family?: InjectionPatternFamily;
}

export interface InjectionScanResult {
  detected: boolean;
  confidence: "low" | "medium" | "high";
  patterns: string[];
  findings: ScanFinding[];
  input: string;
}

/**
 * Pattern families.
 *
 * - `override`: instruction override / privileged-message spoofing / jailbreak
 *   phrasing. These are meaningful both in tool RESULTS (indirect injection)
 *   and in tool ARGUMENTS (an agent relaying an injection onward through a
 *   shell, webhook or MCP call), so the pre-execution guard scans for them.
 * - `output`: exfiltration, credential steering and concealment phrasing that
 *   only makes sense as instructions smuggled INTO the agent's context. They
 *   collide with ordinary code and prose far too often to veto a tool call, so
 *   they are used by the result probe only.
 */
export type InjectionPatternFamily = "override" | "output";

export interface InjectionScanOptions {
  /** Restrict the scan to these families. Default: every family. */
  families?: InjectionPatternFamily[];
}

interface InjectionPattern {
  pattern: RegExp;
  name: string;
  confidence: "medium" | "high";
  family: InjectionPatternFamily;
  /**
   * Skip a match that sits on a line of code or inside a fenced code block.
   * Used for credential steering, whose verbs ("read", "open", "send") and
   * nouns ("token", "secret", ".env") are everyday programming vocabulary.
   */
  ignoreCodeIdioms?: boolean;
}

const CREDENTIAL_NOUN =
  "(?:\\.env\\b|\\benv\\s+file|credentials?|private\\s+keys?|api[\\s_-]?keys?|secrets?|tokens?|passwords?|ssh\\s+keys?)";
const EXFIL_VERB =
  "(?:upload|send|post|exfiltrate|email|transmit|leak|forward|paste|publish|share|submit)";
const DETERMINER =
  "(?:the\\s+|your\\s+|all\\s+|any\\s+|every\\s+|its\\s+|their\\s+|my\\s+|our\\s+)?";
const DESTINATION =
  "(?:https?:\\/\\/|[\\w.-]+\\.(?:com|net|org|io|dev|app|xyz|sh|co|me|ai|ru|cn|to|cc|gg)\\b|(?:the|this|that|my|our|an?)\\s+(?:server|endpoint|url|webhook|address|attacker|link|bucket|paste|service|email|inbox|channel|bot|form|api)\\b|\\S+@\\S+\\.\\w+)";

/**
 * Known prompt injection patterns.
 * Defense-in-depth: this catches known patterns but has false negatives.
 * Not a primary mitigation — tool surface restriction is the primary defense.
 *
 * Confidence discipline: `high` patterns must read as an instruction aimed at
 * an AI agent; phrasing that is also everyday code or documentation vocabulary
 * stays `medium` (informational — it never trips the probe on its own).
 */
const INJECTION_PATTERNS: InjectionPattern[] = [
  // Direct instruction override
  {
    pattern:
      /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)?(?:previous|prior|earlier|above|preceding|foregoing)\s+(?:instructions?|prompts?|directions?|rules?|guidance|context|messages?)\b/i,
    name: "instruction_override",
    confidence: "high",
    family: "override",
  },
  {
    pattern:
      /\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|earlier|above|preceding)\s+(?:instructions?|prompts?|directions?|rules?|context|messages?)\b/i,
    name: "instruction_override",
    confidence: "high",
    family: "override",
  },
  {
    pattern:
      /\bforget\s+(?:everything\s+|all\s+(?:of\s+)?(?:your\s+|the\s+)?|your\s+|the\s+)(?:previous\s+|prior\s+|earlier\s+)?(?:instructions|rules|constraints|guidelines|system\s+prompt)\b/i,
    name: "instruction_override",
    confidence: "high",
    family: "override",
  },
  {
    pattern: /\byou\s+are\s+now\s+(?:a|an)\s+\w+/i,
    name: "role_injection",
    confidence: "medium",
    family: "override",
  },
  {
    pattern:
      /\byou\s+are\s+now\s+(?:unrestricted|unfiltered|uncensored|unlocked|jailbroken|free\s+(?:of|from)\s+(?:all\s+|any\s+)?(?:restrictions|rules|limitations|guidelines|filters))\b/i,
    name: "restriction_bypass",
    confidence: "high",
    family: "override",
  },
  {
    pattern: /\bnew\s+instructions?:\s/i,
    name: "instruction_injection",
    confidence: "medium",
    family: "override",
  },
  {
    pattern: /\bsystem\s*:\s*you\s+are\b/i,
    name: "system_prompt_injection",
    confidence: "high",
    family: "override",
  },
  // A spoofed privileged header is only high-confidence when it is followed
  // by an imperative; a bare "System prompt:" is ordinary documentation.
  {
    pattern:
      /(?:^|\n)[ \t]*(?:\[|<|#+\s*|\*\*|>\s*)?(?:system|developer|admin(?:istrator)?)\s*(?:message|instructions?|prompt|note|override)\s*(?:\]|>|\*\*)?\s*:\s*(?:you\s+(?:are|must|should|will|may\s+now|can\s+now|have\s+to)|ignore|disregard|always|never|from\s+now|do\s+not|don['’]t|new\s+|stop\s+|immediately)/i,
    name: "privileged_message_spoofing",
    confidence: "high",
    family: "override",
  },
  {
    pattern: /\b(?:system|developer)\s+(?:message|instruction|prompt)\s*:/i,
    name: "privileged_message_spoofing",
    confidence: "medium",
    family: "override",
  },

  // Concealment: telling the agent to hide its actions from the person.
  // "the user" is required (not "user emails" / "the user's id"), and the
  // object must not be the user's own possession (product copy such as
  // "...show the user their raw email" passes; "...tell the user about this
  // message" does not).
  {
    pattern:
      /\b(?:do\s+not|don['’]t|never)\s+(?:tell|show|mention|reveal|disclose|inform|alert|notify|warn)\s+(?:this\s+to\s+|it\s+to\s+|that\s+to\s+|anything\s+to\s+)?the\s+user\b(?!['’]s\b|\s+(?:their|his|her|its|your|own)\b)/i,
    name: "concealment_instruction",
    confidence: "high",
    family: "output",
  },

  // Credential steering: an imperative exfiltration verb, a credential noun,
  // and a destination — or read-the-secret-then-send-it. Plain "read the
  // token" / "open .env" is everyday shell and code vocabulary.
  {
    pattern: new RegExp(
      `\\b${EXFIL_VERB}\\s+(?:me\\s+|us\\s+|them\\s+)?${DETERMINER}(?:contents?\\s+of\\s+(?:the\\s+)?)?[^\\n]{0,40}?\\b${CREDENTIAL_NOUN}\\b[^\\n]{0,60}?\\b(?:to|into|at|via)\\s+${DESTINATION}`,
      "i",
    ),
    name: "credential_steering",
    confidence: "high",
    family: "output",
    ignoreCodeIdioms: true,
  },
  {
    pattern: new RegExp(
      `\\b(?:read|open|cat|print|dump|reveal|extract|collect|gather|grab|copy|find|locate)\\s+(?:out\\s+)?${DETERMINER}(?:contents?\\s+of\\s+(?:the\\s+)?)?[^\\n]{0,40}?\\b${CREDENTIAL_NOUN}\\b[^\\n]{0,80}?\\b(?:and|then)\\s+(?:${EXFIL_VERB}|include\\s+(?:it|them)\\s+in|put\\s+(?:it|them)\\s+in)\\b`,
      "i",
    ),
    name: "credential_steering",
    confidence: "high",
    family: "output",
    ignoreCodeIdioms: true,
  },

  // Data exfiltration
  {
    pattern:
      /\b(?:send|email|post|forward|transmit|exfiltrate)\s+(?:all\s+(?:of\s+)?)?(?:this|the|these|those|every|any|our|your|my|all)\s+(?:(?:user|customer|private|internal|collected|gathered|session|conversation)\s+)?(?:data|information|content|contents|conversation|transcript|history)\s+(?:to|into)\s+/i,
    name: "exfiltration_attempt",
    confidence: "high",
    family: "output",
  },
  // A literal fetch(url, {body}) is ordinary JavaScript; informational only.
  {
    pattern: /fetch\s*\(\s*["']https?:\/\/[^"']*["']\s*,\s*\{[^}]*body/i,
    name: "exfiltration_via_fetch",
    confidence: "medium",
    family: "output",
  },

  // Encoded injection (code vocabulary — informational only)
  {
    pattern: /base64[_\s]*decode/i,
    name: "encoded_injection",
    confidence: "medium",
    family: "output",
  },
  { pattern: /\beval\s*\(/i, name: "code_injection", confidence: "medium", family: "output" },

  // Jailbreak patterns
  {
    pattern:
      /\bDAN\s+mode\b|\b(?:enable|enter|activate|switch\s+to)\s+DAN\b|\bdo\s+anything\s+now\b/i,
    name: "dan_jailbreak",
    confidence: "high",
    family: "override",
  },
  {
    pattern: /\bdeveloper\s+mode\s+(?:enabled|activated|on)\b/i,
    name: "developer_mode_jailbreak",
    confidence: "high",
    family: "override",
  },
  {
    pattern:
      /\b(?:act|behave|respond)\s+as\s+if\s+(?:you\s+)?(?:have\s+|had\s+|there\s+(?:are|were)\s+)?(?:no\s+)?(?:restrictions|limitations|boundaries|rules|guidelines|filters)\b|\bpretend\s+(?:that\s+)?you\s+have\s+no\s+(?:restrictions|limitations|rules|guidelines|filters)\b/i,
    name: "restriction_bypass",
    confidence: "high",
    family: "override",
  },
  // Imperative only: "Bypass the safety checks." / "You must disable the
  // sandbox." — never "rules cannot bypass the classifier" in a design doc.
  {
    pattern:
      /(?:^|[.!?:]\s*|\n\s*|\b(?:please|now|then|and|first|immediately|you\s+(?:must|should|need\s+to|have\s+to|will|can\s+now|may\s+now))\s+)(?:bypass|disable|override|turn\s+off|switch\s+off|circumvent)\s+(?:the\s+|all\s+|any\s+|your\s+|its\s+|rune['’]s\s+)?(?:safety|security|permission|policy|classifier|guardrail|sandbox|content\s+filter|safeguard|restriction)s?\b/i,
    name: "safety_bypass",
    confidence: "high",
    family: "override",
  },
];

const CODE_IDIOM_LINE =
  /process\.env|os\.environ|getenv\(|\.env\.example|dotenv|import\s|require\(|=>|^\s*(?:\/\/|#|\*|--)|[{};]\s*$|\bconst\s|\blet\s|\bvar\s|\bfn\s|\bdef\s|\bfunction\s/;

/** Byte ranges of fenced code blocks (``` … ```) so code samples are not read as instructions. */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /(?:^|\n)[ \t]*(```|~~~)/g;
  let open: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (open === null) open = m.index;
    else {
      ranges.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, text.length]);
  return ranges;
}

function lineAt(text: string, position: number): string {
  const start = text.lastIndexOf("\n", position) + 1;
  const end = text.indexOf("\n", position);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Scan input for known prompt injection patterns.
 */
export function scanForInjection(
  input: string,
  options: InjectionScanOptions = {},
): InjectionScanResult {
  const matches: string[] = [];
  const findings: ScanFinding[] = [];
  let maxConfidence: "low" | "medium" | "high" = "low";
  const families = options.families ? new Set(options.families) : null;

  // Normalize compatibility glyphs and remove common invisible separators so
  // trivial full-width/zero-width obfuscation does not bypass the probe.
  const normalized = input
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/(?:&nbsp;|&#x?0*20;)/gi, " ");
  let fences: Array<[number, number]> | null = null;

  for (const { pattern, name, confidence, family, ignoreCodeIdioms } of INJECTION_PATTERNS) {
    if (families && !families.has(family)) continue;
    // Walk every occurrence: the first hit of a code-idiom pattern may sit in
    // a code block while a later one is a real instruction.
    const scanner = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
    );
    let matched: RegExpExecArray | null;
    let recorded = false;
    while (!recorded && (matched = scanner.exec(normalized)) !== null) {
      if (matched[0].length === 0) {
        scanner.lastIndex++;
        continue;
      }
      if (ignoreCodeIdioms) {
        fences ??= fencedRanges(normalized);
        const at = matched.index;
        if (fences.some(([from, to]) => at >= from && at < to)) continue;
        if (CODE_IDIOM_LINE.test(lineAt(normalized, at))) continue;
      }
      recorded = true;
      matches.push(name);
      findings.push({
        type: name,
        match: matched[0].trim().slice(0, 120),
        position: matched.index,
        confidence,
        family,
      });
      if (confidence === "high") maxConfidence = "high";
      else if (confidence === "medium" && maxConfidence !== "high") maxConfidence = "medium";
    }
  }

  return {
    detected: matches.length > 0,
    confidence: matches.length > 0 ? maxConfidence : "low",
    patterns: [...new Set(matches)],
    findings,
    input: normalized.slice(0, 200),
  };
}

/** True when a scan holds at least one high-confidence finding (the probe's bar). */
export function hasHighConfidenceFinding(scan: InjectionScanResult): boolean {
  return scan.findings.some((finding) => finding.confidence === "high");
}

// ─── Untrusted Input Tagging (Section 9.2) ───

/**
 * Wrap untrusted content in XML tags so the model treats it as data, not instructions.
 */
export function tagUntrustedInput(content: string, source: string): string {
  return `<untrusted_input source="${escapeXmlAttr(source)}">\n${content}\n</untrusted_input>`;
}

/**
 * Wrap tool results as untrusted (they may contain injected content).
 */
export function tagToolResult(toolName: string, result: string): string {
  return `<tool_result tool="${escapeXmlAttr(toolName)}">\n${result}\n</tool_result>`;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Output Filtering (Section 9.2 - Threat 4) ───

export interface OutputScanResult {
  clean: boolean;
  redacted: string;
  findings: Array<{ type: string; match: string; position: number }>;
}

/**
 * PII and secrets patterns for output filtering.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; type: string; replacement: string }> = [
  // API keys and tokens
  {
    pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g,
    type: "api_key_openai",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    pattern: /\b(sk-ant-[a-zA-Z0-9-]{20,})\b/g,
    type: "api_key_anthropic",
    replacement: "[REDACTED_API_KEY]",
  },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/g, type: "github_pat", replacement: "[REDACTED_TOKEN]" },
  { pattern: /\b(gho_[a-zA-Z0-9]{36})\b/g, type: "github_oauth", replacement: "[REDACTED_TOKEN]" },
  {
    pattern: /\b(glpat-[a-zA-Z0-9_-]{20,})\b/g,
    type: "gitlab_pat",
    replacement: "[REDACTED_TOKEN]",
  },
  { pattern: /\b(xoxb-[a-zA-Z0-9-]+)\b/g, type: "slack_token", replacement: "[REDACTED_TOKEN]" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, type: "aws_access_key", replacement: "[REDACTED_AWS_KEY]" },
  {
    pattern: /\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}/gi,
    type: "bearer_token",
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    pattern: /\bBasic\s+[a-zA-Z0-9+/=]{12,}/gi,
    type: "basic_auth",
    replacement: "Basic [REDACTED_CREDENTIAL]",
  },
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret[_-]?key|session[_-]?token)\s*[:=]\s*["']?([a-zA-Z0-9._~+/=-]{8,})["']?/gi,
    type: "named_secret",
    replacement: "$1=[REDACTED_SECRET]",
  },

  // Private keys
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    type: "private_key",
    replacement: "[REDACTED_PRIVATE_KEY]",
  },

  // Passwords in common formats
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi,
    type: "password",
    replacement: "password=[REDACTED]",
  },

  // Connection strings
  {
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/gi,
    type: "connection_string",
    replacement: "[REDACTED_CONNECTION_STRING]",
  },

  // Email addresses (PII)
  {
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    type: "email",
    replacement: "[REDACTED_EMAIL]",
  },

  // Phone numbers (PII)
  {
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    type: "phone",
    replacement: "[REDACTED_PHONE]",
  },

  // SSN (PII)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, type: "ssn", replacement: "[REDACTED_SSN]" },

  // Credit card numbers
  {
    pattern:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    type: "credit_card",
    replacement: "[REDACTED_CC]",
  },
];

/**
 * Scan output for sensitive data and optionally redact it.
 * Per Section 9.2: scan model outputs for patterns matching sensitive data
 * before delivering to the user.
 *
 * Redaction is ON by default for defense-in-depth.
 */
export function scanOutput(output: string, redact = true): OutputScanResult {
  const findings: OutputScanResult["findings"] = [];
  let redacted = output;

  for (const { pattern, type, replacement } of SENSITIVE_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      findings.push({
        type,
        match: match[0].slice(0, 20) + (match[0].length > 20 ? "..." : ""),
        position: match.index,
      });
    }
    if (redact) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, replacement);
    }
  }

  return {
    clean: findings.length === 0,
    redacted,
    findings,
  };
}

// ─── Egress Filtering ───

/**
 * Default egress allowlist of well-known package registries and CDNs.
 * Used when no explicit allowlist is configured.
 */
export const DEFAULT_EGRESS_ALLOWLIST = [
  "registry.npmjs.org",
  "api.github.com",
  "pypi.org",
  "raw.githubusercontent.com",
  "crates.io",
  "cdn.jsdelivr.net",
];

/**
 * Check if a URL is in the egress allowlist.
 * Per Section 9.2: tools that can send data externally are restricted
 * to allowlisted destinations.
 */
export function isAllowedEgress(url: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true; // No restrictions configured
  try {
    const parsed = new URL(url);
    return allowlist.some(
      (allowed) => parsed.hostname === allowed || parsed.hostname.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

/** Loopback hosts are always allowed egress: verification loops (curl the dev
 * server you just started) and local tooling depend on them, and they never
 * leave the machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/**
 * Create a reusable egress guard function.
 *
 * Semantics match `isAllowedEgress`: NO configured allowlist means NO
 * restriction. Egress limits are an opt-in hardening feature (org policy,
 * `egressAllowlist` in the engine config) — they must never be the silent
 * default, or every web_fetch/research/localhost-verification call in a normal
 * session dies with "Egress blocked" and the agent learns to answer from
 * memory instead of evidence. (That exact failure shipped once: the old
 * fallback-to-DEFAULT_EGRESS_ALLOWLIST behavior blocked the entire internet
 * except six package registries, including `curl http://127.0.0.1:3000`.)
 */
export function createEgressGuard(allowlist?: string[]): (url: string) => boolean {
  const list = allowlist ?? [];
  return (url: string) => {
    try {
      const hostname = new URL(url).hostname;
      if (LOOPBACK_HOSTS.has(hostname)) return true;
      if (list.length === 0) return true; // no allowlist configured = unrestricted
      return list.some((allowed) => hostname === allowed || hostname.endsWith("." + allowed));
    } catch {
      return false; // Invalid URL = blocked
    }
  };
}

// ─── Tool Execution Guard ───

/** Tools whose arguments leave the process (shell, webhooks, network, MCP). */
const ARG_SCAN_TOOLS = new Set(["bash", "n8n_trigger", "web_fetch", "web_search", "research"]);

/** True when a tool's arguments are scanned for override/jailbreak phrasing before execution. */
export function isArgScanTool(toolName: string): boolean {
  return (
    ARG_SCAN_TOOLS.has(toolName) || toolName.startsWith("mcp_") || toolName.startsWith("browser_")
  );
}

/** Every string value in a (possibly nested) argument object, depth-first. */
export function collectStringLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(item, out, depth + 1);
    }
  }
  return out;
}

/**
 * Create a composable tool execution guard with pre/post execution hooks.
 * Combines egress filtering, injection scanning, and output redaction.
 */
export function createToolExecutionGuard(config: {
  egressAllowlist?: string[];
  redactOutputs?: boolean;
  scanInputs?: boolean;
}): {
  preExecution: (
    toolName: string,
    args: Record<string, unknown>,
  ) => { allowed: boolean; reason?: string; findings?: ScanFinding[] };
  postExecution: (output: string) => string;
} {
  const egressCheck = createEgressGuard(config.egressAllowlist);
  return {
    preExecution: (toolName, args) => {
      // Argument scanning is restricted to the override/jailbreak family and to
      // executable, network and MCP payloads. The output-oriented patterns
      // (exfiltration, credential steering, concealment) collide with ordinary
      // shell/code vocabulary ("read -p 'Enter token: '", "open .env") and with
      // Rune writing tests or docs ABOUT prompt injection, so they never veto a
      // tool call — the tool-result probe is the indirect-injection layer.
      if (config.scanInputs !== false && isArgScanTool(toolName)) {
        // Scan every string leaf on its own rather than the JSON blob: JSON
        // escaping turns newlines into "\\n" and prefixes values with quotes,
        // which defeats the line-anchored privileged-header patterns.
        for (const text of collectStringLeaves(args)) {
          const injection = scanForInjection(text, { families: ["override"] });
          if (hasHighConfidenceFinding(injection)) {
            return {
              allowed: false,
              reason: "Prompt injection detected in tool args",
              findings: injection.findings,
            };
          }
        }
      }
      // Check egress for network tools
      if (["web_fetch", "web_search", "bash"].includes(toolName)) {
        const urlMatch = JSON.stringify(args).match(/https?:\/\/[^\s"']+/g);
        if (urlMatch) {
          for (const url of urlMatch) {
            if (!egressCheck(url)) {
              return { allowed: false, reason: `Egress blocked: ${url}` };
            }
          }
        }
      }
      return { allowed: true };
    },
    postExecution: (output) => {
      if (config.redactOutputs !== false) {
        return scanOutput(output, true).redacted || output;
      }
      return output;
    },
  };
}

// ─── Security Context ───

export interface SecurityContext {
  /** Scan inputs for injection */
  scanInputs: boolean;
  /** Redact sensitive data from outputs */
  redactOutputs: boolean;
  /** Allowed egress domains */
  egressAllowlist: string[];
  /** Log security events */
  logSecurityEvents: boolean;
}

export const DEFAULT_SECURITY_CONTEXT: SecurityContext = {
  scanInputs: true,
  redactOutputs: true, // ON by default for defense-in-depth
  egressAllowlist: [], // Empty = no restrictions
  logSecurityEvents: true,
};
