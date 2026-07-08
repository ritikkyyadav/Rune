// ─── Sandboxed-bash network preflight ───
//
// Foreground bash runs inside a deny-net OS sandbox. Network commands don't
// fail fast in there — npm/pip/git retry DNS until the 120s timeout, so one
// forgotten `network: true` costs two silent minutes (observed live
// 2026-07-07: `npm install` burned exactly 120,031ms before the timeout
// message taught the model). This preflight recognizes the well-known
// network commands BEFORE execution and returns the same teaching error in
// ~0ms. It only ever fires for sandboxed foreground calls — `network: true`
// and `run_in_background: true` (both unsandboxed) pass straight through.
//
// Deliberately a precision list, not a heuristic: a false positive would
// block an offline-capable command, so anything ambiguous (npx, cargo build,
// go build) is left to run. Escape hatches: `--offline`-style flags skip the
// match, and BERNE_NET_PREFLIGHT=0 disables the whole check.

import { isSandboxEnabled } from "../sandbox-mode";
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
 * If `command` contains a segment that needs the network, return a short
 * description of what it is; otherwise null. Segments are split on shell
 * separators so `cd x && npm install` is still caught.
 */
export function needsNetwork(command: string): string | null {
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const segment = rawSegment.trim().replace(/^(sudo|env(\s+\w+=\S*)*)\s+/, "");
    if (!segment || OFFLINE_FLAG.test(segment)) continue;
    for (const { re, what } of NETWORK_PATTERNS) {
      if (re.test(segment)) return what;
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
      // When the user disabled the sandbox (/sandbox off), every command has
      // network — there is nothing to preflight.
      const sandboxed =
        isSandboxEnabled() && args.network !== true && args.run_in_background !== true;
      if (sandboxed && process.env.BERNE_NET_PREFLIGHT !== "0") {
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
