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
}

export interface InjectionScanResult {
  detected: boolean;
  confidence: "low" | "medium" | "high";
  patterns: string[];
  findings: ScanFinding[];
  input: string;
}

/**
 * Known prompt injection patterns.
 * Defense-in-depth: this catches known patterns but has false negatives.
 * Not a primary mitigation — tool surface restriction is the primary defense.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string; confidence: "medium" | "high" }> =
  [
    // Direct instruction override
    {
      pattern: /ignore\s+(all\s+)?previous\s+(instructions|prompts)/i,
      name: "instruction_override",
      confidence: "high",
    },
    {
      pattern: /disregard\s+(all\s+)?prior\s+(instructions|context)/i,
      name: "instruction_override",
      confidence: "high",
    },
    {
      pattern: /forget\s+(everything|all|your)\s+(instructions|rules|constraints)/i,
      name: "instruction_override",
      confidence: "high",
    },
    { pattern: /you\s+are\s+now\s+(a\s+)?/i, name: "role_injection", confidence: "medium" },
    { pattern: /new\s+instructions?:\s/i, name: "instruction_injection", confidence: "medium" },
    { pattern: /system\s*:\s*you\s+are/i, name: "system_prompt_injection", confidence: "high" },

    // Data exfiltration
    {
      pattern: /send\s+(this|the|all)\s+(data|information|content)\s+to/i,
      name: "exfiltration_attempt",
      confidence: "high",
    },
    {
      pattern: /email\s+(this|the|all)\s+(data|information|content)\s+to/i,
      name: "exfiltration_attempt",
      confidence: "high",
    },
    {
      pattern: /post\s+(this|the|all)\s+(data|information|content)\s+to/i,
      name: "exfiltration_attempt",
      confidence: "high",
    },
    {
      pattern: /fetch\s*\(\s*["']https?:\/\/[^"']*["']\s*,\s*\{[^}]*body/i,
      name: "exfiltration_via_fetch",
      confidence: "high",
    },

    // Encoded injection
    { pattern: /base64[_\s]*decode/i, name: "encoded_injection", confidence: "medium" },
    { pattern: /eval\s*\(/i, name: "code_injection", confidence: "medium" },

    // Jailbreak patterns
    { pattern: /\bDAN\b.*\bmode\b/i, name: "dan_jailbreak", confidence: "high" },
    {
      pattern: /developer\s+mode\s+(enabled|activated|on)/i,
      name: "developer_mode_jailbreak",
      confidence: "high",
    },
    {
      pattern: /act\s+as\s+if\s+(you\s+)?(have\s+)?(no\s+)?(restrictions|limitations|boundaries)/i,
      name: "restriction_bypass",
      confidence: "high",
    },
  ];

/**
 * Scan input for known prompt injection patterns.
 */
export function scanForInjection(input: string): InjectionScanResult {
  const matches: string[] = [];
  const findings: ScanFinding[] = [];
  let maxConfidence: "low" | "medium" | "high" = "low";

  for (const { pattern, name, confidence } of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      matches.push(name);
      findings.push({
        type: name,
        match: input.slice(0, 50),
        position: 0,
        confidence,
      });
      if (confidence === "high") maxConfidence = "high";
      else if (confidence === "medium" && maxConfidence !== "high") maxConfidence = "medium";
    }
  }

  return {
    detected: matches.length > 0,
    confidence: matches.length > 0 ? maxConfidence : "low",
    patterns: matches,
    findings,
    input: input.slice(0, 200),
  };
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
      // Check for URLs in args and validate egress
      if (config.scanInputs !== false) {
        const inputStr = JSON.stringify(args);
        const injection = scanForInjection(inputStr);
        if (
          injection.findings.length > 0 &&
          injection.findings.some((f) => f.confidence === "high")
        ) {
          return {
            allowed: false,
            reason: "Prompt injection detected in tool args",
            findings: injection.findings,
          };
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
