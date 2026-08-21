/**
 * Desktop reducers: the transcript (v2 stream grammar) and the trace (run
 * tree) are both pure reducers over the engine-host event stream. These tests
 * drive the reference turn through them and assert the structure the
 * components render — no React, no Tauri.
 */

import { describe, expect, test } from "bun:test";
import {
  INITIAL_STREAM,
  streamReducer,
  splitResponse,
  commandOutcome,
  checkBadge,
  type StreamState,
} from "../../../apps/desktop/src/lib/stream";
import { INITIAL_TRACE, traceReducer, spanDepth, type TraceState } from "../../../apps/desktop/src/lib/trace";
import { demoSteps, DEMO_TASK } from "../../../apps/desktop/src/lib/demo";
import { gearInfo, nextGear, normalizeGear } from "../../../apps/desktop/src/lib/gears";

function runDemo(): { stream: StreamState; trace: TraceState } {
  let stream = streamReducer(INITIAL_STREAM, { type: "turn_start", task: DEMO_TASK, now: 1000 });
  let trace = traceReducer(traceReducer(INITIAL_TRACE, { type: "status", provider: "google", model: "gemini-2.5-flash", posture: "sandboxed" }), {
    type: "turn_start",
    task: DEMO_TASK,
    now: 1000,
  });
  for (const step of demoSteps()) {
    const now = 1000 + step.at;
    if ("permission" in step) {
      stream = streamReducer(stream, { type: "permission_request", ...step.permission, now });
      trace = traceReducer(trace, { type: "permission_request", ...step.permission, now });
      stream = streamReducer(stream, { type: "permission_decided", requestId: step.permission.requestId, decision: "allow_once", now: now + 6000 });
      trace = traceReducer(trace, { type: "permission_decided", requestId: step.permission.requestId, decision: "allow_once", now: now + 6000 });
      continue;
    }
    stream = streamReducer(stream, { type: "event", event: step.event, now });
    trace = traceReducer(trace, { type: "event", event: step.event, now });
  }
  return { stream, trace };
}

describe("desktop transcript reducer", () => {
  const { stream } = runDemo();
  const turn = stream.turns[0]!;

  test("the reference turn renders the v2 grammar in order", () => {
    const kinds = turn.items.map((i) => i.kind);
    expect(kinds[0]).toBe("plan");
    expect(kinds).toContain("summary"); // Read 2 files
    expect(kinds.filter((k) => k === "tool").length).toBe(3); // grep, edit, bash
    expect(kinds).toContain("permission");
    const summary = turn.items.find((i) => i.kind === "summary");
    expect(summary && summary.kind === "summary" ? summary.text : "").toBe("Read 2 files");
  });

  test("tool bullets carry verb · target · meta, cmd trees and diff cards", () => {
    const tools = turn.items.filter((i) => i.kind === "tool");
    const grep = tools.find((t) => t.kind === "tool" && t.toolName === "grep");
    const edit = tools.find((t) => t.kind === "tool" && t.toolName === "edit_file");
    const bash = tools.find((t) => t.kind === "tool" && t.toolName === "bash");
    expect(grep && grep.kind === "tool" ? grep.verb : "").toBe("Searching");
    expect(grep && grep.kind === "tool" ? grep.cmd?.hint : "").toBe("3 matches");
    expect(edit && edit.kind === "tool" ? edit.verb : "").toBe("Editing");
    expect(edit && edit.kind === "tool" ? edit.meta : []).toEqual(["hash-guarded"]);
    expect(edit && edit.kind === "tool" ? edit.diff?.added : 0).toBe(3);
    expect(edit && edit.kind === "tool" ? edit.diff?.removed : 0).toBe(2);
    expect(bash && bash.kind === "tool" ? bash.verb : "").toBe("Verifying");
    expect(bash && bash.kind === "tool" ? bash.target : "").toBe("tests/unit/");
    expect(bash && bash.kind === "tool" ? bash.meta : []).toEqual(["bash", "sandboxed"]);
    expect(bash && bash.kind === "tool" ? bash.cmd?.hint : "").toBe("214 pass · 0 fail");
  });

  test("the permission card records the decision and the turn completes with receipts", () => {
    const perm = turn.items.find((i) => i.kind === "permission");
    expect(perm && perm.kind === "permission" ? perm.decision : undefined).toBe("allow_once");
    expect(turn.status).toBe("complete");
    expect(turn.endedAt).toBeDefined();
    expect(turn.checkpoint?.version).toBe(3);
    expect(turn.files).toEqual([{ path: "packages/orchestrator/src/bin/ui/status.ts", added: 3, removed: 2 }]);
    expect(turn.checks.map((c) => checkBadge(c))).toEqual(["214 tests pass"]);
    expect(turn.tokensOut).toBe(400 + 1400 + 200 + 4300);
    expect(turn.thinkingMs).toBeGreaterThan(2000);
  });

  test("the answer splits into a headline and detail", () => {
    const { headline, detail } = splitResponse(turn.prose);
    expect(headline).toBe("The TUI footer now shows a live context meter fed by the engine's token budget.");
    expect(detail).toContain("`renderStatus`");
  });

  test("status ladder: waiting while a permission is pending, running while a tool is in flight", () => {
    let s = streamReducer(INITIAL_STREAM, { type: "turn_start", task: "t", now: 1 });
    s = streamReducer(s, { type: "event", event: { type: "tool_call_start", callId: "c1", toolName: "bash" }, now: 2 });
    expect(s.turns[0]!.status).toBe("running");
    s = streamReducer(s, { type: "permission_request", requestId: "p1", prompt: { toolName: "bash", argsSummary: "bash: ls", rawArgs: {} }, now: 3 });
    expect(s.turns[0]!.status).toBe("waiting");
    s = streamReducer(s, { type: "permission_decided", requestId: "p1", decision: "deny", now: 4 });
    expect(s.turns[0]!.status).toBe("running");
  });

  test("commandOutcome prefers a runner tally over the last line", () => {
    expect(commandOutcome("…\n 214 pass\n 0 fail\nRan 214 tests")).toBe("214 pass · 0 fail");
    expect(commandOutcome("a\nb\n")).toBe("b");
  });
});

describe("desktop trace reducer", () => {
  const { trace } = runDemo();
  const turn = trace.turns[0]!;

  test("builds the run tree: model calls → tools → permission; checkpoint and response", () => {
    const kinds = turn.spans.map((s) => s.kind);
    expect(kinds.filter((k) => k === "model").length).toBe(4);
    expect(kinds.filter((k) => k === "tool").length).toBe(5);
    expect(kinds).toContain("permission");
    expect(kinds).toContain("checkpoint");
    expect(kinds).toContain("response");
    const grep = turn.spans.find((s) => s.tool?.name === "grep")!;
    const parent = turn.spans.find((s) => s.id === grep.parentId)!;
    expect(parent.kind).toBe("model");
    expect(spanDepth(turn, grep)).toBe(1);
    const perm = turn.spans.find((s) => s.kind === "permission")!;
    const bash = turn.spans.find((s) => s.tool?.name === "bash")!;
    expect(perm.parentId).toBe(bash.id);
    expect(spanDepth(turn, perm)).toBe(2);
    expect(perm.permission?.decision).toBe("allow_once");
    expect(perm.status).toBe("ok");
  });

  test("model spans close on usage with tokens; tools carry posture, exit code and diff", () => {
    const models = turn.spans.filter((s) => s.kind === "model");
    expect(models[0]!.tokens).toMatchObject({ in: 6200, out: 400 });
    expect(models.every((m) => m.status === "ok")).toBe(true);
    const bash = turn.spans.find((s) => s.tool?.name === "bash")!;
    expect(bash.tool?.posture).toBe("sandboxed");
    expect(bash.tool?.exitCode).toBe(0);
    const edit = turn.spans.find((s) => s.tool?.name === "edit_file")!;
    expect(edit.tool?.hashGuarded).toBe(true);
    expect(edit.tool?.diff).toContain("@@ -41,2 +41,3 @@");
  });

  test("totals add up and the turn closes", () => {
    expect(turn.endedAt).toBeDefined();
    expect(turn.totals.tokensOut).toBe(400 + 1400 + 200 + 4300);
    expect(turn.totals.tokensIn).toBe(6200 + 9100 + 9800 + 12_400);
    expect(turn.totals.permissions).toBe(1);
    expect(turn.contextPercent).toBe(44);
  });

  test("a fallback marks the next model call as served by the fallback provider", () => {
    let t = traceReducer(INITIAL_TRACE, { type: "turn_start", task: "x", now: 1 });
    t = traceReducer(t, { type: "event", event: { type: "usage", inputTokens: 1, outputTokens: 1 }, now: 2 });
    t = traceReducer(t, { type: "event", event: { type: "fallback", from: { provider: "anthropic", model: "a" }, to: { provider: "openrouter", model: "b" }, status: 429 }, now: 3 });
    t = traceReducer(t, { type: "event", event: { type: "text_delta", text: "hi" }, now: 4 });
    const models = t.turns[0]!.spans.filter((s) => s.kind === "model");
    expect(models.at(-1)!.model?.servedBy).toBe("openrouter/b");
    expect(t.turns[0]!.spans.some((s) => s.kind === "fallback")).toBe(true);
  });
});

describe("gears vocabulary", () => {
  test("normalizes legacy ids and cycles the ladder", () => {
    expect(normalizeGear("autonomy-i")).toBe("gear-2");
    expect(normalizeGear("trusted")).toBe("gear-3");
    expect(normalizeGear("yolo")).toBe("gear-4");
    expect(gearInfo("gear-2").label).toBe("2nd gear");
    expect(nextGear("gear-4")).toBe("auto");
    expect(nextGear("auto")).toBe("gear-1");
  });
});
