// ─── Browser-preview demo turn ───
// Outside Tauri there is no engine, so `gear desktop dev` in a plain browser
// would show an empty workbench. This scripted event sequence — the same
// reference turn as the design contract — lets the real reducers and
// components be exercised and reviewed without a model. It is never used
// inside the native app.

import type { EngineEvent, PermissionPrompt } from "./types";

export const DEMO_TASK = "Wire the context meter into the TUI footer";

export type DemoStep =
  | { at: number; event: EngineEvent }
  | { at: number; permission: { requestId: string; prompt: PermissionPrompt } };

const STATUS_PATH = "packages/orchestrator/src/bin/ui/status.ts";

export function demoSteps(): DemoStep[] {
  const steps: DemoStep[] = [];
  let t = 0;
  const ev = (delay: number, event: EngineEvent) => steps.push({ at: (t += delay), event });
  ev(300, { type: "thinking_delta", text: "…" });
  ev(900, { type: "thinking_delta", text: "…" });
  ev(200, {
    type: "text_delta",
    text: "Extend renderStatus with an optional context meter, thread the engine's token budget through the TUI event loop, and verify with the unit suite.",
  });
  ev(400, { type: "tool_call_start", callId: "r1", toolName: "read_file" });
  ev(120, { type: "tool_call_args_delta", callId: "r1", partialJson: `{"path":"${STATUS_PATH}"}` });
  ev(200, { type: "tool_call_start", callId: "r2", toolName: "read_file" });
  ev(100, {
    type: "tool_call_args_delta",
    callId: "r2",
    partialJson: `{"path":"packages/orchestrator/src/bin/ui/tui.ts"}`,
  });
  ev(150, { type: "tool_call_start", callId: "g1", toolName: "grep" });
  ev(100, {
    type: "tool_call_args_delta",
    callId: "g1",
    partialJson: `{"pattern":"renderStatus","path":"packages/orchestrator/src/bin/ui/"}`,
  });
  ev(100, {
    type: "usage",
    inputTokens: 6200,
    outputTokens: 400,
    context: { used: 38_000, limit: 100_000, percent: 38 },
  });
  ev(300, {
    type: "tool_call_end",
    callId: "r1",
    args: { path: STATUS_PATH },
    output: {
      toolName: "read_file",
      success: true,
      result:
        "export function renderStatus(state: StatusState): string {\n  return `${glyph(state)} ${label(state)} ${meta(state)}`;\n}",
      durationMs: 4,
    },
  });
  ev(200, {
    type: "tool_call_end",
    callId: "r2",
    args: { path: "packages/orchestrator/src/bin/ui/tui.ts" },
    output: { toolName: "read_file", success: true, result: "…", durationMs: 9 },
  });
  ev(300, {
    type: "tool_call_end",
    callId: "g1",
    args: { pattern: "renderStatus", path: "packages/orchestrator/src/bin/ui/" },
    output: {
      toolName: "grep",
      success: true,
      result: JSON.stringify({ total_matches: 3, matches: [{}, {}, {}], truncated: false }),
      durationMs: 12,
    },
  });
  ev(900, { type: "thinking_delta", text: "…" });
  ev(1400, { type: "thinking_delta", text: "…" });
  ev(300, {
    type: "text_delta",
    text: "I will extend renderStatus with an optional ContextMeter, keep the classic path untouched, then run the unit suite.",
  });
  ev(400, { type: "tool_call_start", callId: "e1", toolName: "edit_file" });
  ev(150, {
    type: "tool_call_args_delta",
    callId: "e1",
    partialJson: `{"path":"${STATUS_PATH}","old_text":"…","new_text":"…"}`,
  });
  ev(150, {
    type: "usage",
    inputTokens: 9100,
    outputTokens: 1400,
    context: { used: 41_000, limit: 100_000, percent: 41 },
  });
  ev(500, {
    type: "tool_call_end",
    callId: "e1",
    args: { path: STATUS_PATH },
    output: {
      toolName: "edit_file",
      success: true,
      durationMs: 12,
      result: JSON.stringify({
        path: STATUS_PATH,
        diff: '@@ -41,2 +41,3 @@\n-export function renderStatus(state: StatusState): string {\n-  return `${glyph(state)} ${label(state)} ${meta(state)}`;\n+export function renderStatus(state: StatusState, ctx?: ContextMeter): string {\n+  const pct = ctx ? ` · ctx ${Math.round((ctx.used / ctx.budget) * 100)}%` : "";\n+  return `${glyph(state)} ${label(state)} ${meta(state)}${pct}`;',
      }),
    },
  });
  ev(400, { type: "tool_call_start", callId: "b1", toolName: "bash" });
  ev(120, {
    type: "tool_call_args_delta",
    callId: "b1",
    partialJson: `{"command":"bun test tests/unit/"}`,
  });
  ev(200, { type: "usage", inputTokens: 9800, outputTokens: 200 });
  steps.push({
    at: (t += 300),
    permission: {
      requestId: "demo-perm-1",
      prompt: {
        toolName: "bash",
        argsSummary: "bash: bun test tests/unit/",
        rawArgs: { command: "bun test tests/unit/" },
        rateLimit: { used: 2, limit: 10 },
      },
    },
  });
  // The sequence pauses here until the permission is answered (see App).
  ev(0, {
    type: "tool_call_end",
    callId: "b1",
    args: { command: "bun test tests/unit/" },
    output: {
      toolName: "bash",
      success: true,
      durationMs: 1210,
      result: JSON.stringify({
        stdout:
          "bun test v1.3.14\n…\n 214 pass\n 0 fail\n 1180 expect() calls\nRan 214 tests across 12 files. [1.21s]",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      }),
    },
  });
  ev(300, { type: "checkpoint_saved", runId: "run-demo", version: 3, turnCount: 3 });
  ev(600, { type: "thinking_delta", text: "…" });
  ev(800, {
    type: "text_delta",
    text: "The TUI footer now shows a live context meter fed by the engine's token budget. ",
  });
  ev(500, {
    type: "text_delta",
    text: "I extended `renderStatus` with an optional `ContextMeter`, wired the budget through the status event in `tui.ts`, and verified with the unit suite — 214 pass. ",
  });
  ev(500, { type: "text_delta", text: "The classic readline path is untouched." });
  ev(300, {
    type: "usage",
    inputTokens: 12_400,
    outputTokens: 4300,
    context: { used: 44_000, limit: 100_000, percent: 44 },
  });
  ev(200, { type: "turn_complete", stopReason: "end_turn", totalTurns: 3 });
  return steps;
}
