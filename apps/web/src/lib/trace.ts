// ─── Trace model: the run tree of a turn ───
// Every turn is a tree: model calls → the tools they decided on → the
// permission decisions, checkpoints, fallbacks and compactions around them.
// Built client-side from the engine-host's `chat_event` stream (the host
// forwards every engine event), so v1 needs no protocol change. Pure reducer —
// unit-testable without React or a browser.

import type { EngineEvent, PermissionDecision, PermissionPrompt } from "./types";
import { assertNeverSoft } from "@gear/protocol";

export type SpanKind =
  | "model"
  | "tool"
  | "permission"
  | "checkpoint"
  | "fallback"
  | "compaction"
  | "verification"
  | "error"
  | "response";

export type SpanStatus = "running" | "ok" | "error" | "denied" | "pending";

export interface TraceSpan {
  id: string;
  turn: number;
  parentId?: string;
  kind: SpanKind;
  label: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  tokens?: { in?: number; out?: number; thinkingMs?: number };
  model?: { provider: string; model: string; servedBy?: string };
  tool?: {
    name: string;
    callId: string;
    args: Record<string, unknown>;
    result?: string;
    error?: string;
    durationMs?: number;
    exitCode?: number;
    posture?: "sandboxed" | "host" | "network";
    diff?: string;
    hashGuarded?: boolean;
  };
  permission?: {
    requestId?: string;
    decision?: PermissionDecision | "auto";
    prompt?: PermissionPrompt;
    waitedMs?: number;
  };
  checkpoint?: { version: number; runId: string };
  fallback?: {
    from: { provider: string; model: string };
    to: { provider: string; model: string };
    status?: number;
    reason?: string;
    chain?: string[];
  };
  compaction?: {
    beforeTokens: number;
    afterTokens: number;
    limitTokens: number;
    summarizedCount?: number;
  };
  verification?: { ran?: boolean; passed?: boolean; report?: string };
  response?: { chars: number };
}

export interface TraceTotals {
  modelCalls: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  thinkingMs: number;
  wallMs: number;
  permissions: number;
}

export interface TraceTurn {
  turn: number;
  task: string;
  startedAt: number;
  endedAt?: number;
  spans: TraceSpan[];
  totals: TraceTotals;
  contextPercent?: number;
}

export interface TraceState {
  turns: TraceTurn[];
  /** Index into `turns` of the turn receiving events, or null between turns. */
  current: number | null;
  nextId: number;
  /** The model span that is generating right now (closed by `usage`). */
  openModel: string | null;
  modelCalls: number;
  lastThinkingAt: number;
  /** A fallback that will serve the NEXT model call. */
  pendingServedBy?: string;
  /** Posture applied to shell spans, from engine status. */
  posture: "sandboxed" | "host";
  provider: { provider: string; model: string };
}

export type TraceAction =
  | { type: "turn_start"; task: string; turn?: number; now?: number }
  | { type: "event"; event: EngineEvent; now?: number }
  | { type: "permission_request"; requestId: string; prompt: PermissionPrompt; now?: number }
  | { type: "permission_decided"; requestId: string; decision: PermissionDecision; now?: number }
  | { type: "status"; provider?: string; model?: string; posture?: "sandboxed" | "host" }
  | { type: "reset" };

export const INITIAL_TRACE: TraceState = {
  turns: [],
  current: null,
  nextId: 1,
  openModel: null,
  modelCalls: 0,
  lastThinkingAt: 0,
  posture: "sandboxed",
  provider: { provider: "", model: "" },
};

const emptyTotals = (): TraceTotals => ({
  modelCalls: 0,
  tools: 0,
  tokensIn: 0,
  tokensOut: 0,
  thinkingMs: 0,
  wallMs: 0,
  permissions: 0,
});

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : ".../" + parts.slice(-3).join("/");
}

function oneLine(value: unknown, max = 60): string {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** `read_file status.ts`, `grep "renderStatus" src/`, `bash bun test` */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "list_dir":
      return `${name} ${shortPath(String(args.path ?? ""))}`.trim();
    case "grep":
      return `grep "${oneLine(args.pattern, 32)}" ${shortPath(String(args.path ?? "."))}`;
    case "bash":
      return `bash ${oneLine(args.command, 48)}`;
    case "web_search":
      return `web_search "${oneLine(args.query ?? args.q, 40)}"`;
    case "web_fetch":
      return `web_fetch ${oneLine(args.url ?? args.uri, 48)}`;
    default:
      return name;
  }
}

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function currentTurn(state: TraceState): TraceTurn | null {
  return state.current == null ? null : (state.turns[state.current] ?? null);
}

function withTurn(state: TraceState, update: (turn: TraceTurn) => TraceTurn): TraceState {
  if (state.current == null) return state;
  const turns = state.turns.slice();
  turns[state.current] = update(turns[state.current]!);
  return { ...state, turns };
}

function addSpan(
  state: TraceState,
  span: Omit<TraceSpan, "id" | "turn">,
): { state: TraceState; id: string } {
  const turn = currentTurn(state);
  if (!turn) return { state, id: "" };
  const id = `s${state.nextId}`;
  const full: TraceSpan = { ...span, id, turn: turn.turn };
  const next = withTurn({ ...state, nextId: state.nextId + 1 }, (t) => ({
    ...t,
    spans: [...t.spans, full],
  }));
  return { state: next, id };
}

function updateSpan(
  state: TraceState,
  id: string,
  patch: (span: TraceSpan) => TraceSpan,
): TraceState {
  return withTurn(state, (t) => ({
    ...t,
    spans: t.spans.map((s) => (s.id === id ? patch(s) : s)),
  }));
}

/** Open the next model span — the model is generating. */
function openModel(state: TraceState, now: number): TraceState {
  if (state.openModel) return state;
  const n = state.modelCalls + 1;
  const served = state.pendingServedBy;
  const { state: next, id } = addSpan(state, {
    kind: "model",
    label: `model call #${n}`,
    detail: `${state.provider.provider}/${state.provider.model}`,
    startedAt: now,
    status: "running",
    model: { provider: state.provider.provider, model: state.provider.model, servedBy: served },
  });
  return { ...next, openModel: id, modelCalls: n, pendingServedBy: undefined };
}

function closeModel(
  state: TraceState,
  now: number,
  tokens?: { in?: number; out?: number },
): TraceState {
  if (!state.openModel) return state;
  const id = state.openModel;
  const next = updateSpan(state, id, (s) => ({
    ...s,
    endedAt: now,
    status: "ok",
    tokens: { ...(s.tokens ?? {}), ...(tokens ?? {}) },
  }));
  return { ...next, openModel: null };
}

export function traceReducer(state: TraceState, action: TraceAction): TraceState {
  const now = ("now" in action && action.now) || Date.now();
  switch (action.type) {
    case "reset":
      return { ...INITIAL_TRACE, posture: state.posture, provider: state.provider };

    case "status":
      return {
        ...state,
        posture: action.posture ?? state.posture,
        provider: {
          provider: action.provider ?? state.provider.provider,
          model: action.model ?? state.provider.model,
        },
      };

    case "turn_start": {
      const turn: TraceTurn = {
        turn: action.turn ?? state.turns.length + 1,
        task: action.task,
        startedAt: now,
        spans: [],
        totals: emptyTotals(),
      };
      const next: TraceState = {
        ...state,
        turns: [...state.turns, turn],
        current: state.turns.length,
        openModel: null,
        modelCalls: 0,
        lastThinkingAt: 0,
      };
      return openModel(next, now);
    }

    case "permission_request": {
      const turn = currentTurn(state);
      const parent = turn?.spans
        .slice()
        .reverse()
        .find(
          (s) =>
            s.kind === "tool" && s.status === "running" && s.tool?.name === action.prompt.toolName,
        );
      return addSpan(state, {
        kind: "permission",
        parentId: parent?.id,
        label: `permission · ${action.prompt.toolName}`,
        detail: "waiting on approval",
        startedAt: now,
        status: "pending",
        permission: { requestId: action.requestId, prompt: action.prompt },
      }).state;
    }

    case "permission_decided": {
      const turn = currentTurn(state);
      const span = turn?.spans.find((s) => s.permission?.requestId === action.requestId);
      if (!span) return state;
      const label =
        action.decision === "deny"
          ? "denied"
          : action.decision === "allow_session"
            ? "allowed for session"
            : "allowed once";
      return updateSpan(state, span.id, (s) => ({
        ...s,
        endedAt: now,
        status: action.decision === "deny" ? "denied" : "ok",
        detail: label,
        permission: { ...s.permission, decision: action.decision, waitedMs: now - s.startedAt },
      }));
    }

    case "event": {
      // No cast: the union is `@gear/protocol`'s, and the switch is exhaustive.
      const ev = action.event;
      if (state.current == null) return state;
      switch (ev.type) {
        case "thinking_delta": {
          let next = openModel(state, now);
          if (next.lastThinkingAt > 0 && now - next.lastThinkingAt < 3000 && next.openModel) {
            const gained = now - next.lastThinkingAt;
            next = updateSpan(next, next.openModel, (s) => ({
              ...s,
              tokens: { ...(s.tokens ?? {}), thinkingMs: (s.tokens?.thinkingMs ?? 0) + gained },
            }));
          }
          return { ...next, lastThinkingAt: now };
        }
        case "text_delta": {
          let next = openModel(state, now);
          const turn = currentTurn(next)!;
          const open = turn.spans.find((s) => s.kind === "response" && s.status === "running");
          const len = String(ev.text ?? "").length;
          if (open) {
            return updateSpan(next, open.id, (s) => ({
              ...s,
              response: { chars: (s.response?.chars ?? 0) + len },
            }));
          }
          next = addSpan(next, {
            kind: "response",
            parentId: next.openModel ?? undefined,
            label: "response",
            detail: "streaming",
            startedAt: now,
            status: "running",
            response: { chars: len },
          }).state;
          return next;
        }
        case "tool_call_start": {
          let next = openModel(state, now);
          // Prose that precedes a tool call was narration (the Plan bullet),
          // not the answer — close it under that name.
          const turnNow = currentTurn(next);
          const narr = turnNow?.spans.find((s) => s.kind === "response" && s.status === "running");
          if (narr) {
            next = updateSpan(next, narr.id, (s) => ({
              ...s,
              label: "narration",
              detail: `${s.response?.chars ?? 0} chars · before acting`,
              status: "ok",
              endedAt: now,
            }));
          }
          return addSpan(next, {
            kind: "tool",
            parentId: next.openModel ?? undefined,
            label: String(ev.toolName ?? "tool"),
            startedAt: now,
            status: "running",
            tool: {
              name: String(ev.toolName ?? "tool"),
              callId: String(ev.callId ?? ""),
              args: {},
            },
          }).state;
        }
        case "tool_call_args_delta": {
          // Args stream in; the label sharpens once JSON parses.
          const turn = currentTurn(state)!;
          const span = turn.spans.find(
            (s) => s.tool?.callId === ev.callId && s.status === "running",
          );
          if (!span) return state;
          const parsed = tryJson(
            String((span.tool as { partial?: string } | undefined)?.partial ?? "") +
              String(ev.partialJson ?? ""),
          );
          const partial =
            String((span.tool as { partial?: string })?.partial ?? "") +
            String(ev.partialJson ?? "");
          return updateSpan(state, span.id, (s) => ({
            ...s,
            label: parsed ? toolLabel(s.tool!.name, parsed) : s.label,
            tool: { ...s.tool!, args: parsed ?? s.tool!.args, ...({ partial } as object) },
          }));
        }
        case "tool_call_end": {
          const turn = currentTurn(state)!;
          const output = (ev.output ?? {}) as {
            toolName?: string;
            success?: boolean;
            result?: string;
            error?: string;
            durationMs?: number;
          };
          const args = (ev.args ?? {}) as Record<string, unknown>;
          const name = String(output.toolName ?? "tool");
          let span = turn.spans.find((s) => s.tool?.callId === ev.callId);
          let next = state;
          if (!span) {
            const created = addSpan(state, {
              kind: "tool",
              parentId: state.openModel ?? undefined,
              label: toolLabel(name, args),
              startedAt: now - (output.durationMs ?? 0),
              status: "running",
              tool: { name, callId: String(ev.callId ?? ""), args },
            });
            next = created.state;
            span = currentTurn(next)!.spans.find((s) => s.id === created.id)!;
          }
          const parsed = tryJson(String(output.result ?? ""));
          const exitCode =
            typeof parsed?.exit_code === "number" ? (parsed.exit_code as number) : undefined;
          const diff = typeof parsed?.diff === "string" ? (parsed.diff as string) : undefined;
          const posture: "sandboxed" | "host" | "network" | undefined =
            name === "bash" ? (args.network === true ? "network" : state.posture) : undefined;
          const failed = output.success === false || (exitCode != null && exitCode !== 0);
          next = updateSpan(next, span.id, (s) => ({
            ...s,
            label: toolLabel(name, args),
            endedAt: now,
            status: failed ? "error" : "ok",
            tool: {
              ...s.tool!,
              name,
              args,
              result: output.result,
              error: output.error,
              durationMs: output.durationMs,
              exitCode,
              posture,
              diff,
              hashGuarded: name === "edit_file" || name === "multi_edit" ? true : undefined,
            },
          }));
          return withTurn(next, (t) => ({
            ...t,
            totals: { ...t.totals, tools: t.totals.tools + 1 },
          }));
        }
        case "usage": {
          const tokensIn = Number(ev.inputTokens ?? 0);
          const tokensOut = Number(ev.outputTokens ?? 0);
          const ctx = (ev.context as { percent?: number } | undefined)?.percent;
          let next = closeModel(state, now, { in: tokensIn, out: tokensOut });
          next = withTurn(next, (t) => ({
            ...t,
            contextPercent: typeof ctx === "number" && ctx > 0 ? ctx : t.contextPercent,
            totals: {
              ...t.totals,
              modelCalls: t.totals.modelCalls + 1,
              tokensIn: t.totals.tokensIn + tokensIn,
              tokensOut: t.totals.tokensOut + tokensOut,
            },
          }));
          return next;
        }
        case "fallback": {
          const to = ev.to as { provider: string; model: string };
          const from = ev.from as { provider: string; model: string };
          const next = addSpan(state, {
            kind: "fallback",
            label: `fallback · ${from.provider} → ${to.provider}/${to.model}`,
            detail:
              ev.status === 429
                ? "429 rate limited"
                : String(ev.reason ?? ev.status ?? "provider degraded"),
            startedAt: now,
            endedAt: now,
            status: "error",
            fallback: {
              from,
              to,
              status: ev.status as number | undefined,
              reason: ev.reason as string | undefined,
              chain: ev.chain as string[] | undefined,
            },
          }).state;
          return { ...next, pendingServedBy: `${to.provider}/${to.model}`, openModel: null };
        }
        case "compaction": {
          const before = Number(ev.beforeTokens ?? 0);
          const after = Number(ev.afterTokens ?? 0);
          const limit = Number(ev.limitTokens ?? 0);
          const pct = (n: number) => (limit > 0 ? `${Math.round((n / limit) * 100)}%` : `${n}`);
          return addSpan(state, {
            kind: "compaction",
            label: `compacted · ${pct(before)} → ${pct(after)}`,
            detail: `−${Math.max(0, before - after)} tokens${ev.summarizedCount ? ` · ${ev.summarizedCount} messages summarized` : ""}`,
            startedAt: now,
            endedAt: now,
            status: "ok",
            compaction: {
              beforeTokens: before,
              afterTokens: after,
              limitTokens: limit,
              summarizedCount: ev.summarizedCount as number | undefined,
            },
          }).state;
        }
        case "checkpoint_saved":
          return addSpan(state, {
            kind: "checkpoint",
            label: `checkpoint v${ev.version}`,
            detail: "/rewind restores it",
            startedAt: now,
            endedAt: now,
            status: "ok",
            checkpoint: { version: Number(ev.version ?? 0), runId: String(ev.runId ?? "") },
          }).state;
        case "verification_started":
          return addSpan(state, {
            kind: "verification",
            label: "verification",
            detail: "running the project checks",
            startedAt: now,
            status: "running",
            verification: {},
          }).state;
        case "verification_completed": {
          const turn = currentTurn(state)!;
          const open = turn.spans
            .slice()
            .reverse()
            .find((s) => s.kind === "verification" && s.status === "running");
          const ran = Boolean(ev.ran);
          const passed = Boolean(ev.passed);
          const patch = (s: TraceSpan): TraceSpan => ({
            ...s,
            endedAt: now,
            status: !ran ? "ok" : passed ? "ok" : "error",
            detail: !ran ? "no checks detected" : passed ? "checks passed" : "checks failed",
            verification: { ran, passed, report: String(ev.report ?? "") },
          });
          if (open) return updateSpan(state, open.id, patch);
          return addSpan(
            state,
            patch({
              id: "",
              turn: 0,
              kind: "verification",
              label: "verification",
              startedAt: now,
              status: "ok",
            }),
          ).state;
        }
        case "error":
          return addSpan(state, {
            kind: "error",
            label: "error",
            detail: oneLine(ev.error, 120),
            startedAt: now,
            endedAt: now,
            status: "error",
          }).state;
        case "stream_reset":
          return { ...state, openModel: null };
        case "turn_complete": {
          let next = closeModel(state, now);
          next = withTurn(next, (t) => {
            const spans = t.spans.map((s) =>
              s.status === "running"
                ? {
                    ...s,
                    status: "ok" as const,
                    endedAt: s.endedAt ?? now,
                    detail: s.kind === "response" ? `${s.response?.chars ?? 0} chars` : s.detail,
                  }
                : s,
            );
            const thinkingMs = spans.reduce((sum, s) => sum + (s.tokens?.thinkingMs ?? 0), 0);
            const permissions = spans.filter((s) => s.kind === "permission").length;
            return {
              ...t,
              endedAt: now,
              spans,
              totals: { ...t.totals, thinkingMs, permissions, wallMs: now - t.startedAt },
            };
          });
          return { ...next, current: null, openModel: null };
        }

        // ─── Named, and deliberately not given a span ───
        // The trace rail records what the RUN did to the outside world — model
        // calls, tool calls, permissions, verification. These are transcript or
        // status-rung material and would only add noise to a causal rail. They
        // are named rather than defaulted so a member added to AgentTurnEvent
        // is a type error here until the rail has decided about it.
        case "notice":
        case "context_warning":
        case "todo_updated":
        case "step_check":
        case "retry":
        case "handoff":
        case "replanning":
        case "tool_progress":
          return state;

        default:
          // Compile-time exhaustiveness (see @gear/protocol assertNever).
          return assertNeverSoft(ev, state);
      }
    }
    default:
      return state;
  }
}

/** Depth of a span in its turn (0 = top level). */
export function spanDepth(turn: TraceTurn, span: TraceSpan): number {
  let depth = 0;
  let cursor: TraceSpan | undefined = span;
  const byId = new Map(turn.spans.map((s) => [s.id, s]));
  while (cursor?.parentId && byId.has(cursor.parentId) && depth < 4) {
    depth++;
    cursor = byId.get(cursor.parentId);
  }
  return depth;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function fmtMs(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
