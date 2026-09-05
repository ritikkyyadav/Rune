/**
 * Hook system: run user-defined shell commands automatically around tool
 * execution and session lifecycle (linters, formatters, guards).
 *
 * This is a self-contained reliability module. Wiring into the Engine is
 * intentionally left to the orchestrator — nothing here imports the Engine.
 *
 * Configuration lives in `<workspaceRoot>/.rune/hooks.json` and looks like:
 *
 *   {
 *     "preToolUse":  [{ "match": "edit_*", "command": "./scripts/guard.sh", "blocking": true }],
 *     "postToolUse": [{ "match": "*",      "command": "./scripts/format.sh" }],
 *     "sessionStart":[{ "command": "echo session started" }],
 *     "sessionEnd":  [{ "command": "echo session ended" }]
 *   }
 *
 * Each command receives:
 *   - env vars: RUNE_TOOL_NAME, RUNE_TOOL_ARGS / RUNE_TOOL_OUTPUT, RUNE_HOOK_EVENT
 *   - stdin: a JSON payload ({ event, toolName, args } or { event, toolName, output })
 *
 * Blocking pre-tool hooks that exit non-zero veto the tool call. All other
 * failures (non-blocking hooks, post-tool hooks, lifecycle hooks, spawn
 * errors, timeouts) are reported but never propagate.
 */

import { join } from "node:path";
import { createLogger } from "@rune/shared";
const hookLog = createLogger("hooks");
import { workspaceConfigPath } from "@rune/shared";

// ─── Types ───

export type HookEvent = "preToolUse" | "postToolUse" | "sessionStart" | "sessionEnd";

export interface HookDef {
  /**
   * Optional tool-name pattern. Supports a simple glob with "*" wildcards
   * (e.g. "edit_*", "*", "*_file") or an exact tool name. If omitted, the
   * hook matches every tool. Ignored for session lifecycle hooks.
   */
  match?: string;
  /** Shell command to execute (run via the system shell in workspaceRoot). */
  command: string;
  /** Per-hook timeout in milliseconds. Defaults to DEFAULT_HOOK_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * If true and this is a preToolUse hook, a non-zero exit vetoes the tool
   * call. Has no blocking effect for any other event.
   */
  blocking?: boolean;
}

export interface HookConfig {
  preToolUse?: HookDef[];
  postToolUse?: HookDef[];
  sessionStart?: HookDef[];
  sessionEnd?: HookDef[];
}

/** Decision returned by a preToolUse pass (mirrors the permissions.ts shape). */
export interface HookGateDecision {
  allow: boolean;
  reason?: string;
}

/** Result of executing a single hook command. */
export interface HookRunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the command was killed because it exceeded its timeout. */
  timedOut: boolean;
  /** Populated when the process could not be spawned at all. */
  spawnError?: string;
  durationMs: number;
}

/** Default per-hook timeout when a HookDef omits `timeoutMs`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** Max length of stderr/stdout snippets surfaced in block reasons. */
const SNIPPET_LIMIT = 500;

// ─── Config loading ───

/**
 * Load hook configuration from `<workspaceRoot>/.rune/hooks.json`, plus any
 * extra hook files (plugin bundles). Event arrays concatenate — workspace
 * hooks first, then each extra file in order, so user hooks always run before
 * plugin hooks for the same event.
 *
 * - Missing file  -> returns {} (a full no-op; never throws).
 * - Malformed JSON -> throws a clear, actionable error (plugin files too —
 *   a plugin that ships broken hooks should fail loudly, not silently).
 */
export async function loadHookConfig(
  workspaceRoot: string,
  extraFiles: string[] = [],
): Promise<HookConfig> {
  const base = await loadHookFile(workspaceConfigPath(workspaceRoot, "hooks.json"));
  let merged = base;
  for (const extra of extraFiles) {
    merged = mergeHookConfigs(merged, await loadHookFile(extra));
  }
  return merged;
}

function mergeHookConfigs(a: HookConfig, b: HookConfig): HookConfig {
  const events: HookEvent[] = ["preToolUse", "postToolUse", "sessionStart", "sessionEnd"];
  const out: HookConfig = {};
  for (const event of events) {
    const list = [...(a[event] ?? []), ...(b[event] ?? [])];
    if (list.length > 0) out[event] = list;
  }
  return out;
}

async function loadHookFile(path: string): Promise<HookConfig> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return {};
  }

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    // Existed a moment ago but unreadable now (race / permissions). Treat as a
    // hard error rather than silently dropping a config the user wrote.
    throw new Error(
      `Failed to read hook config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (text.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Malformed hook config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed hook config at ${path}: expected a JSON object`);
  }

  return normalizeConfig(parsed as Record<string, unknown>, path);
}

/** Coerce a parsed object into a HookConfig, validating each event's shape. */
function normalizeConfig(raw: Record<string, unknown>, path: string): HookConfig {
  const events: HookEvent[] = ["preToolUse", "postToolUse", "sessionStart", "sessionEnd"];
  const config: HookConfig = {};

  for (const event of events) {
    const value = raw[event];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(`Malformed hook config at ${path}: "${event}" must be an array`);
    }
    config[event] = value.map((entry, i) => validateHookDef(entry, event, i, path));
  }

  return config;
}

/** Validate and shape a single hook definition. */
function validateHookDef(entry: unknown, event: HookEvent, index: number, path: string): HookDef {
  const where = `${event}[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Malformed hook config at ${path}: ${where} must be an object`);
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.command !== "string" || obj.command.trim() === "") {
    throw new Error(
      `Malformed hook config at ${path}: ${where}.command must be a non-empty string`,
    );
  }
  if (obj.match !== undefined && typeof obj.match !== "string") {
    throw new Error(`Malformed hook config at ${path}: ${where}.match must be a string`);
  }
  if (obj.timeoutMs !== undefined && typeof obj.timeoutMs !== "number") {
    throw new Error(`Malformed hook config at ${path}: ${where}.timeoutMs must be a number`);
  }
  if (obj.blocking !== undefined && typeof obj.blocking !== "boolean") {
    throw new Error(`Malformed hook config at ${path}: ${where}.blocking must be a boolean`);
  }

  const def: HookDef = { command: obj.command };
  if (obj.match !== undefined) def.match = obj.match as string;
  if (obj.timeoutMs !== undefined) def.timeoutMs = obj.timeoutMs as number;
  if (obj.blocking !== undefined) def.blocking = obj.blocking as boolean;
  return def;
}

// ─── Glob matching ───

/**
 * Match a tool name against a simple glob pattern.
 * Supports "*" as a wildcard (any run of characters); everything else is
 * matched literally. An empty/undefined pattern matches everything.
 */
export function matchesPattern(pattern: string | undefined, toolName: string): boolean {
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === toolName;

  // Escape regex metacharacters, then turn "*" into ".*".
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

// ─── Runner ───

/**
 * Runs configured hooks around tool calls and session lifecycle events.
 *
 * Construct directly with a HookConfig, or use `createHookRunner` for a
 * factory-style call site (matching security.ts conventions). Use
 * `HookRunner.load(workspaceRoot)` to read the on-disk config first.
 */
export class HookRunner {
  private readonly config: HookConfig;
  private readonly workspaceRoot: string;
  /** Optional sink for non-fatal diagnostics; defaults to console.warn. */
  private readonly logger: (message: string) => void;

  constructor(
    config: HookConfig,
    workspaceRoot: string,
    options?: { logger?: (message: string) => void },
  ) {
    this.config = config ?? {};
    this.workspaceRoot = workspaceRoot;
    this.logger = options?.logger ?? ((m) => hookLog.warn(m));
  }

  /** Convenience: load `<workspaceRoot>/.rune/hooks.json` then build a runner. */
  static async load(
    workspaceRoot: string,
    options?: { logger?: (message: string) => void; extraHookFiles?: string[] },
  ): Promise<HookRunner> {
    const config = await loadHookConfig(workspaceRoot, options?.extraHookFiles ?? []);
    return new HookRunner(config, workspaceRoot, options);
  }

  /** True if no hooks are configured for any event (the no-op fast path). */
  isEmpty(): boolean {
    return (
      (this.config.preToolUse?.length ?? 0) === 0 &&
      (this.config.postToolUse?.length ?? 0) === 0 &&
      (this.config.sessionStart?.length ?? 0) === 0 &&
      (this.config.sessionEnd?.length ?? 0) === 0
    );
  }

  /**
   * Run all matching preToolUse hooks before a tool executes.
   *
   * A blocking hook that exits non-zero (or times out, or fails to spawn)
   * vetoes the call: returns { allow: false, reason } with a stderr snippet.
   * Non-blocking hooks never block — failures are logged and ignored.
   * Returns { allow: true } when nothing matches.
   */
  async runPreToolUse(toolName: string, args: Record<string, unknown>): Promise<HookGateDecision> {
    const hooks = this.matching(this.config.preToolUse, toolName);
    if (hooks.length === 0) return { allow: true };

    const payload = safeStringify({ event: "preToolUse", toolName, args });
    const env: Record<string, string> = {
      RUNE_HOOK_EVENT: "preToolUse",
      RUNE_TOOL_NAME: toolName,
      RUNE_TOOL_ARGS: payload,
    };

    for (const hook of hooks) {
      const result = await this.execute(hook, payload, env);
      const failed = result.timedOut || result.spawnError !== undefined || result.exitCode !== 0;

      if (!failed) continue;

      if (hook.blocking) {
        return { allow: false, reason: this.describeFailure(hook, result) };
      }
      // Non-blocking: report but allow.
      this.logger(
        `[hooks] non-blocking preToolUse hook failed: ${this.describeFailure(hook, result)}`,
      );
    }

    return { allow: true };
  }

  /**
   * Run all matching postToolUse hooks after a tool executes. Failures are
   * logged, never thrown — but the hooks' OUTPUT is returned so the caller can
   * feed it back to the model. (It used to be discarded entirely, which made a
   * format/lint hook a silent bystander: its findings never reached the agent,
   * so nothing was ever fixed because of one.)
   *
   * @returns concatenated hook stdout (plus failure one-liners), capped, or
   *          null when there is nothing worth feeding back.
   */
  async runPostToolUse(toolName: string, output: unknown): Promise<string | null> {
    const hooks = this.matching(this.config.postToolUse, toolName);
    if (hooks.length === 0) return null;

    const outputStr = safeStringify(output);
    const payload = safeStringify({ event: "postToolUse", toolName, output });
    const env: Record<string, string> = {
      RUNE_HOOK_EVENT: "postToolUse",
      RUNE_TOOL_NAME: toolName,
      RUNE_TOOL_OUTPUT: outputStr,
    };

    const feedback: string[] = [];
    for (const hook of hooks) {
      const result = await this.execute(hook, payload, env);
      if (result.timedOut || result.spawnError !== undefined || result.exitCode !== 0) {
        this.logger(`[hooks] postToolUse hook failed: ${this.describeFailure(hook, result)}`);
        const detail = (result.stderr || result.stdout || "").trim().slice(0, 400);
        feedback.push(
          `hook \`${hook.command}\` exited ${result.exitCode ?? "?"}${detail ? `:\n${detail}` : ""}`,
        );
      } else if (result.stdout.trim()) {
        feedback.push(result.stdout.trim());
      }
    }
    if (feedback.length === 0) return null;
    const joined = feedback.join("\n");
    return joined.length > 2_000 ? joined.slice(0, 2_000) + "\n…[hook output truncated]" : joined;
  }

  /** Run sessionStart hooks. Report-only; never throws. */
  async runSessionStart(): Promise<void> {
    await this.runLifecycle("sessionStart", this.config.sessionStart);
  }

  /** Run sessionEnd hooks. Report-only; never throws. */
  async runSessionEnd(): Promise<void> {
    await this.runLifecycle("sessionEnd", this.config.sessionEnd);
  }

  // ── internals ──

  private async runLifecycle(event: HookEvent, hooks: HookDef[] | undefined): Promise<void> {
    if (!hooks || hooks.length === 0) return;
    const payload = safeStringify({ event });
    const env: Record<string, string> = { RUNE_HOOK_EVENT: event };
    for (const hook of hooks) {
      const result = await this.execute(hook, payload, env);
      if (result.timedOut || result.spawnError !== undefined || result.exitCode !== 0) {
        this.logger(`[hooks] ${event} hook failed: ${this.describeFailure(hook, result)}`);
      }
    }
  }

  /** Filter a hook list down to those whose `match` matches the tool name. */
  private matching(hooks: HookDef[] | undefined, toolName: string): HookDef[] {
    if (!hooks || hooks.length === 0) return [];
    return hooks.filter((h) => matchesPattern(h.match, toolName));
  }

  /**
   * Execute a single hook command with a hard timeout. Never throws — spawn
   * failures and timeouts are returned as part of the HookRunResult so callers
   * can decide whether to block or merely log.
   */
  private async execute(
    hook: HookDef,
    stdin: string,
    extraEnv: Record<string, string>,
  ): Promise<HookRunResult> {
    const start = performance.now();
    const timeoutMs =
      hook.timeoutMs !== undefined && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["/bin/sh", "-c", hook.command], {
        cwd: this.workspaceRoot,
        // Inherit the parent env, then layer the hook-specific vars on top.
        env: { ...process.env, ...extraEnv },
        stdin: new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        // detached → this shell leads its own process group, so a timeout
        // can kill the ENTIRE tree, not just the shell — a leader-only kill
        // orphans any grandchild the command spawned (e.g. `sleep 5` under
        // `sh -c`), which keeps holding the stdout/stderr pipes open and
        // stalls the read below until it exits on its own.
        detached: true,
      });
    } catch (err) {
      return {
        command: hook.command,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - start),
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Negative pid → signal the whole process group (see detached above).
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process (group) may have already exited — nothing to do.
        }
      }
    }, timeoutMs);

    try {
      // `stdout`/`stderr` are configured as "pipe", so these are always
      // ReadableStreams; the cast narrows Bun's wider declared union.
      const out = proc.stdout as ReadableStream<Uint8Array>;
      const err = proc.stderr as ReadableStream<Uint8Array>;
      const [stdout, stderr] = await Promise.all([
        new Response(out).text().catch(() => ""),
        new Response(err).text().catch(() => ""),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      return {
        command: hook.command,
        // A killed process reports a non-zero/negative code; surface it as a
        // failure but flag the real cause via `timedOut`.
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        command: hook.command,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut,
        spawnError: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Build a human-readable reason describing why a hook failed. */
  private describeFailure(hook: HookDef, result: HookRunResult): string {
    if (result.timedOut) {
      const limit = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
      return `hook "${hook.command}" timed out after ${limit}ms`;
    }
    if (result.spawnError !== undefined) {
      return `hook "${hook.command}" failed to start: ${result.spawnError}`;
    }
    const snippet = snippetOf(result.stderr) || snippetOf(result.stdout);
    const base = `hook "${hook.command}" exited with code ${result.exitCode}`;
    return snippet ? `${base}: ${snippet}` : base;
  }
}

/**
 * Factory mirroring the security.ts style (createToolExecutionGuard etc.).
 * Equivalent to `new HookRunner(config, workspaceRoot, options)`.
 */
export function createHookRunner(
  config: HookConfig,
  workspaceRoot: string,
  options?: { logger?: (message: string) => void },
): HookRunner {
  return new HookRunner(config, workspaceRoot, options);
}

// ─── helpers ───

/** JSON.stringify that never throws (cycles / BigInt fall back to a marker). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

/** Collapse whitespace and clamp a string for use in a one-line reason. */
function snippetOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const collapsed = trimmed.replace(/\s+/g, " ");
  return collapsed.length > SNIPPET_LIMIT ? collapsed.slice(0, SNIPPET_LIMIT) + "…" : collapsed;
}
