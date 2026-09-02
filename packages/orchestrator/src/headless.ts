// ─── Headless runs ───
//
// Until this existed, nothing could drive Gear without a terminal. Every path
// through the CLI ended in the TUI, which is why the eval suite has to import
// Engine and drive it in-process, and why the external anchors its README
// scopes as P1 — Terminal-Bench, SWE-bench — were never built: the benchmark
// harnesses shell out to an agent command, and there was no command to shell
// out to.
//
// So this is not a benchmark adapter. It is the thing every benchmark adapter,
// CI step, git hook and shell pipeline needs first: one prompt in, an answer
// and an exit code out, no cursor addressing, no prompts to answer.

import type { Engine } from "./engine";
import type { AgentTurnEvent, PermissionPrompt, UserPermissionDecision } from "@gear/protocol";
import { assertNeverSoft } from "@gear/protocol";

export interface HeadlessOptions {
  /** Emit a JSON envelope instead of plain text — for machine consumers. */
  json?: boolean;
  /**
   * Auto-approve every permission request.
   *
   * OFF by default, and that default matters: a headless run has nobody to ask,
   * so the alternative to denying is silently granting whatever the model
   * requests to a process nobody is watching. A benchmark inside a container
   * turns this on deliberately.
   */
  autoApprove?: boolean;
  /** Sink for progress; defaults to nothing. Never stdout — that is the answer. */
  onProgress?: (line: string) => void;
}

export interface HeadlessResult {
  /** The assistant's final text. */
  text: string;
  /** True when the turn ran to completion without a terminal error. */
  ok: boolean;
  /** Why it failed, when it did. */
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** Workspace-relative paths the run wrote or edited. */
  filesChanged: string[];
  /** Permission requests refused because nobody was there to approve them. */
  permissionsDenied: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
}

/** Process exit codes. Distinct so a caller can tell WHY a run failed. */
export const HEADLESS_EXIT = {
  ok: 0,
  /** The turn raised a terminal error. */
  failed: 1,
  /**
   * The run stopped because it needed permission and had no way to ask.
   * Separate from a plain failure: the fix is a flag, not a retry.
   */
  needsPermission: 3,
} as const;

/**
 * A permission handler for a run with no human attached.
 *
 * Denies by default and counts the denials, so the caller can exit with a code
 * that says "this needed approval" rather than reporting a mysterious refusal
 * as a capability failure.
 */
export function headlessPermissionHandler(
  autoApprove: boolean,
  onDenied: (prompt: PermissionPrompt) => void,
): (prompt: PermissionPrompt) => Promise<UserPermissionDecision> {
  return async (prompt) => {
    if (autoApprove) return { kind: "allow_session" };
    onDenied(prompt);
    return { kind: "deny" };
  };
}

/**
 * Run one turn to completion and return what happened.
 *
 * Deliberately consumes the same event stream the TUI does, rather than a
 * parallel "simple" path — a headless mode that diverges from the interactive
 * one measures something the product does not actually do.
 */
export async function runHeadless(
  engine: Engine,
  sessionId: string,
  prompt: string,
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const started = Date.now();
  const filesChanged = new Set<string>();
  let text = "";
  let toolCalls = 0;
  let toolErrors = 0;
  let permissionsDenied = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  engine.setPermissionHandler(
    headlessPermissionHandler(opts.autoApprove === true, (p) => {
      permissionsDenied++;
      opts.onProgress?.(`permission denied (no approver): ${p.toolName} ${p.argsSummary}`);
    }),
  );

  try {
    for await (const event of engine.chat(sessionId, prompt) as AsyncIterable<AgentTurnEvent>) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        // A retry or provider failover re-streams the answer from the top. The
        // TUI clears its buffer here; so must this, or a fallback mid-turn
        // yields the answer twice concatenated.
        case "stream_reset":
          text = "";
          break;
        case "tool_call_start":
          opts.onProgress?.(`→ ${event.toolName}`);
          break;
        case "tool_call_end": {
          toolCalls++;
          if (!event.output?.success) toolErrors++;
          const name = event.output?.toolName;
          const path = event.args?.path;
          if (
            event.output?.success &&
            (name === "edit_file" || name === "write_file" || name === "multi_edit") &&
            typeof path === "string"
          ) {
            filesChanged.add(path);
          }
          break;
        }
        case "usage":
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          cacheReadTokens += event.cacheReadTokens ?? 0;
          break;
        case "notice":
        case "context_warning":
          opts.onProgress?.(event.message);
          break;

        // ── Named and deliberately not counted ──
        // A headless run reports what the turn DID: text, tools, files, usage.
        // These carry no counter of their own here, but they are named rather
        // than defaulted so a member added upstream is a compile error until
        // this reducer has decided what it means for a machine consumer.
        case "thinking_delta":
        case "tool_call_args_delta":
        case "turn_complete":
        case "error":
        case "verification_started":
        case "verification_completed":
        case "todo_updated":
        case "step_check":
        case "fallback":
        case "retry":
        case "compaction":
        case "checkpoint_saved":
        case "handoff":
        case "replanning":
        case "tool_progress":
          break;

        default:
          // Compile-time exhaustiveness (see @gear/protocol assertNever).
          assertNeverSoft(event, undefined);
          break;
      }
    }
  } catch (err) {
    return {
      text,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      toolCalls,
      toolErrors,
      filesChanged: [...filesChanged],
      permissionsDenied,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      durationMs: Date.now() - started,
    };
  }

  return {
    text,
    ok: true,
    toolCalls,
    toolErrors,
    filesChanged: [...filesChanged],
    permissionsDenied,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    durationMs: Date.now() - started,
  };
}

/** The exit code a result deserves. */
export function headlessExitCode(r: HeadlessResult): number {
  // Checked BEFORE ok, because a denied permission does not raise: the turn
  // completes, the model explains it could not write the file, and `ok` is
  // true. Observed exactly that — a run that created nothing exiting 0.
  // A caller reading only the exit code would record a success.
  //
  // A blocked run is a configuration problem, not a capability one, and a
  // benchmark that cannot tell them apart scores the agent for the harness's
  // missing flag.
  if (r.permissionsDenied > 0) return HEADLESS_EXIT.needsPermission;
  if (r.ok) return HEADLESS_EXIT.ok;
  return HEADLESS_EXIT.failed;
}

/** What a machine consumer reads off stdout. */
export function headlessEnvelope(r: HeadlessResult): string {
  return JSON.stringify(
    {
      ok: r.ok,
      text: r.text,
      error: r.error,
      toolCalls: r.toolCalls,
      toolErrors: r.toolErrors,
      filesChanged: r.filesChanged,
      permissionsDenied: r.permissionsDenied,
      usage: {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
      },
      durationMs: r.durationMs,
    },
    null,
    2,
  );
}
