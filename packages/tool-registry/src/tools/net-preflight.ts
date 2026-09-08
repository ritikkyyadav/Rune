// ─── Sandboxed-bash network preflight ───
//
// Foreground bash runs inside a deny-net OS sandbox. Network commands don't
// fail fast in there — npm/pip/git retry DNS until the 120s timeout, so one
// forgotten `network: true` costs two silent minutes (observed live
// 2026-07-07: `npm install` burned exactly 120,031ms before the timeout
// message taught the model). This preflight recognizes the well-known
// network commands BEFORE execution and returns the same teaching error in
// ~0ms. It covers foreground and background calls; `network: true` enables
// networking while keeping filesystem containment.
//
// Deliberately a precision list, not a heuristic: a false positive would
// block an offline-capable command, so anything ambiguous (npx, cargo build,
// go build) is left to run. Escape hatches: `--offline`-style flags skip the
// match, and RUNE_NET_PREFLIGHT=0 disables the whole check.

import { isOsIsolationAvailable } from "../sandbox-capability";
import { resolveSandboxLaunch } from "../sandbox-mode";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../types";

/** Flags that mean "this package-manager run is intentionally offline". */
const OFFLINE_FLAG = /--(offline|prefer-offline|frozen-lockfile.*--offline)\b/;

const NETWORK_PATTERNS: Array<{ re: RegExp; what: string }> = [
  {
    re: /^(npm|pnpm|yarn|bun)\s+(-[^\s]+\s+)*(install|i|ci|add|update|upgrade|outdated|audit|publish|dedupe)\b/,
    what: "package install",
  },
  { re: /^(pip3?|uv)\s+(install|download|sync)\b/, what: "pip install" },
  { re: /-m\s+pip\s+(install|download)\b/, what: "pip install" },
  { re: /^poetry\s+(install|add|update|lock)\b/, what: "poetry install" },
  { re: /^cargo\s+(install|add|update|fetch|search|publish)\b/, what: "cargo fetch" },
  { re: /^gem\s+(install|update|fetch)\b/, what: "gem install" },
  { re: /^composer\s+(install|update|require)\b/, what: "composer install" },
  { re: /^go\s+(get|install)\b/, what: "go get" },
  { re: /^go\s+mod\s+(download|tidy)\b/, what: "go mod download" },
  {
    re: /^git\s+(-[^\s]+\s+)*(push|pull|fetch|clone|ls-remote|remote\s+update|submodule\s+update)\b/,
    what: "git remote operation",
  },
  { re: /^(curl|wget|http|https)\b/, what: "HTTP request" },
  { re: /^(gh|glab)\s+(?!help\b|--version\b|version\b)\S/, what: "GitHub/GitLab CLI call" },
  { re: /^brew\s+(install|upgrade|update|fetch|tap)\b/, what: "brew install" },
  {
    re: /^(apt|apt-get|apk|dnf|yum)\s+(install|update|upgrade|add)\b/,
    what: "system package install",
  },
];

/**
 * A URL's host, for every `http(s)://host[:port]` in a segment. The bracketed
 * IPv6 form is tried FIRST: `[^\s/:"']+` happily matches the bare `[` of
 * `http://[::1]:8080` and stops at the colon, capturing a bracket instead of a
 * host.
 */
const URL_HOST_RE = /https?:\/\/(\[[0-9a-f:]+\]|[^\s/:"']+)(?::\d+)?/gi;
/** `curl localhost:3000` — a bare loopback target with no scheme. */
const BARE_LOOPBACK_RE =
  /(?:^|\s)(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?(?=\s|$)/i;
const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/**
 * True when every host the segment names is loopback. One remote host makes
 * the whole segment a network call; a segment with no URL at all counts only
 * when it names a bare loopback target.
 */
export function loopbackOnly(segment: string): boolean {
  const hosts = [...segment.matchAll(URL_HOST_RE)].map((m) => m[1]);
  if (hosts.length > 0) return hosts.every((h) => LOOPBACK_HOST_RE.test(h));
  return BARE_LOOPBACK_RE.test(segment);
}

/**
 * If `command` contains a segment that needs the network, return a short
 * description of what it is; otherwise null. Segments are split on shell
 * separators so `cd x && npm install` is still caught.
 */
export function needsNetwork(command: string): string | null {
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const segment = rawSegment.trim().replace(/^(sudo|env(\s+\w+=\S*)*)\s+/, "");
    if (!segment || OFFLINE_FLAG.test(segment)) continue;
    for (const { re, what } of NETWORK_PATTERNS) {
      if (!re.test(segment)) continue;
      // Loopback is open inside the sandbox: `curl http://127.0.0.1:8080` is
      // how a page the run just served gets verified, and it would not hang.
      if (what === "HTTP request" && loopbackOnly(segment)) continue;
      return what;
    }
  }
  return null;
}

/**
 * Wrap the bash handler: sandboxed foreground calls that clearly need the
 * network fail instantly with the same guidance the 120s timeout would have
 * eventually delivered.
 */
export function withNetworkPreflight(handler: ToolHandler): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const { args } = input;
      // When this call will not run sandboxed — the sandbox is off, the
      // command is excluded, or it is a fallback retry — it has network, and
      // there is nothing to preflight. Same when the machine has no
      // isolation backend: the degraded (path-guard-only) executor doesn't
      // deny network, so "this would hang" would be a false claim.
      const sandboxed =
        resolveSandboxLaunch(args).sandboxed && isOsIsolationAvailable() && args.network !== true;
      if (sandboxed && process.env.RUNE_NET_PREFLIGHT !== "0") {
        const what = typeof args.command === "string" ? needsNetwork(args.command) : null;
        if (what) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error:
              `Blocked before running: this looks like a ${what}, and sandboxed bash has NO network ` +
              "(it would hang until the timeout). Re-run the same command with network: true. " +
              "If it truly runs offline, add network: true anyway or an --offline flag.",
            durationMs: 0,
          };
        }
      }
      return handler.execute(input);
    },
  };
}
