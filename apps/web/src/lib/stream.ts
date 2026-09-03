// ─── Transcript model: what the user reads ───
// The desktop transcript speaks the exact v2 CLI grammar (see
// packages/orchestrator/src/bin/ui/turn.ts + activity.ts): task bar, summary
// ledger, Plan bullet, tool bullets with cmd trees / diff cards, the status
// ladder, permission / fallback / compaction cards, and the headline + detail
// answer with summary strips. This module is the pure reducer that turns the
// engine-host's event stream into that structure; components only render it.

import type { EngineEvent, PermissionDecision, PermissionPrompt } from "./types";
import type {
  DecisionRecord,
  Hypothesis,
  PendingDecision,
  TaskArtifact,
  TaskDecision,
  TaskKind,
} from "@gear/protocol";
import { assertNeverSoft } from "@gear/protocol";

export interface DiffLine {
  kind: "add" | "rem" | "ctx";
  no: number | null;
  text: string;
}

export interface DiffCard {
  path: string;
  range: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  hiddenLines: number;
}

export type StreamItem =
  | { kind: "summary"; id: string; text: string }
  | { kind: "plan"; id: string; text: string; first: boolean }
  | { kind: "todo"; id: string; items: { content: string; status: string }[] }
  | {
      kind: "tool";
      id: string;
      callId: string;
      toolName: string;
      verb: string;
      target: string;
      meta: string[];
      status: "running" | "ok" | "error";
      cmd?: { text: string; hint?: string; bad?: boolean };
      diff?: DiffCard;
      error?: string;
    }
  | {
      kind: "permission";
      id: string;
      requestId: string;
      prompt: PermissionPrompt;
      decision?: PermissionDecision;
      startedAt: number;
    }
  | {
      kind: "fallback";
      id: string;
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      status?: number;
      reason?: string;
      chain?: string[];
    }
  | {
      kind: "compaction";
      id: string;
      beforeTokens: number;
      afterTokens: number;
      limitTokens: number;
      summarizedCount?: number;
      forced?: boolean;
    }
  | { kind: "verification"; id: string; ran: boolean; passed: boolean; report: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "notice"; id: string; message: string };

export type StatusKind =
  | "thinking"
  | "running"
  | "verifying"
  | "synthesizing"
  | "waiting"
  | "complete"
  | "notes"
  | "failed"
  | "interrupted";

export interface CheckRecord {
  label: string;
  status: "passed" | "failed" | "not-run";
  tests?: number;
}

export interface TurnState {
  turn: number;
  task: string;
  startedAt: number;
  endedAt?: number;
  items: StreamItem[];
  prose: string;
  status: StatusKind;
  /** The faint detail under the status rung (in-flight tool, plan step, intent). */
  statusDetail?: string;
  tokensOut: number;
  thinkingMs: number;
  contextPercent?: number;
  checkpoint?: { version: number };
  files: { path: string; added: number; removed: number }[];
  checks: CheckRecord[];
  reroutes: number;
  failures: number;
  hardError: boolean;
  /** Running tally for the routine ledger ("Read 2 files, ran 1 search"). */
  routine: { reads: number; lists: number; searches: number; commands: number };
  /** Index of the ledger item for the current routine burst, if open. */
  burstIndex: number | null;
  currentTool?: { callId: string; toolName: string; label: string };
  pendingPermission?: string;
  lastThinkingAt: number;
  nextId: number;
  // ─── The narrative (P11.1) ───
  // Reduced into turn state rather than pushed as transcript items: the
  // composed task surface binds to these paths (a hypothesis card folds when
  // its status turns `refuted`), and a transcript row would say the same thing
  // twice. The Decision Record arrives whole at task end.
  /** What shape of work this is — the composer picks a projection from it. */
  taskKind?: TaskKind;
  /** Every hypothesis raised this turn, in order; refuted ones are kept. */
  hypotheses: Hypothesis[];
  /** What the run committed to, with the evidence it stood on. */
  decisions: TaskDecision[];
  /** What the run produced. */
  artifacts: TaskArtifact[];
  /** Decisions waiting on a person — the inbox's material. */
  pending: PendingDecision[];
  /** The record generated at task end. */
  record?: DecisionRecord;
}

export interface StreamState {
  turns: TurnState[];
  current: number | null;
}

export const INITIAL_STREAM: StreamState = { turns: [], current: null };

export type StreamAction =
  | { type: "turn_start"; task: string; turn?: number; now?: number }
  | { type: "event"; event: EngineEvent; now?: number }
  | { type: "permission_request"; requestId: string; prompt: PermissionPrompt; now?: number }
  | { type: "permission_decided"; requestId: string; decision: PermissionDecision; now?: number }
  | { type: "abort"; now?: number }
  | { type: "reset" };

// ── helpers (ported from the CLI renderers so both surfaces agree) ──

const ROUTINE = new Set(["read_file", "list_dir", "glob", "symbol_search", "lsp"]);

export function isVerificationCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)/.test(cmd) ||
    /(^|[\s;&|])(lint|eslint|ruff|mypy|typecheck|tsc|check|build)([\s;&|]|$)/.test(cmd) ||
    /\b(cargo\s+(test|check|clippy)|go\s+test|swift\s+test|xcodebuild|gradle\w*\s+test|mvn\w*\s+test)\b/.test(
      cmd,
    )
  );
}

function listingPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (!p.startsWith("/") && parts.length <= 6) return p;
  if (parts.length <= 4) return p;
  return ".../" + parts.slice(-4).join("/");
}

function oneLine(value: unknown, max = 80): string {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A test runner's `214 pass · 0 fail` tally when printed, else the last output line. */
export function commandOutcome(output: string): string {
  const passed = /^\s*(\d+)\s+pass(?:ed|ing)?\b/m.exec(output)?.[1];
  const failed = /^\s*(\d+)\s+fail(?:ed|ing|ures?)?\b/m.exec(output)?.[1];
  if (passed != null && failed != null) return `${passed} pass · ${failed} fail`;
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function verificationTarget(command: string): string {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const pathLike = tokens
    .slice(1)
    .reverse()
    .find((t) => !t.startsWith("-") && (t.includes("/") || /\.\w{1,5}$/.test(t)));
  if (pathLike) return pathLike.replace(/^['"]|['"]$/g, "");
  return tokens.slice(0, 2).join(" ") || command;
}

export function parseDiff(path: string, raw: string): DiffCard {
  const source = raw.split("\n").filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "));
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = [];
  const limit = 40;
  for (const row of source) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (row.startsWith("+")) added++;
    if (row.startsWith("-")) removed++;
    if (lines.length >= limit) continue;
    const kind = row.startsWith("+") ? "add" : row.startsWith("-") ? "rem" : "ctx";
    const no = kind === "add" ? newLine++ : kind === "rem" ? oldLine++ : newLine++;
    if (kind === "ctx") oldLine++;
    lines.push({
      kind,
      no: no || null,
      text: kind === "ctx" ? row.replace(/^ /, "") : row.slice(1),
    });
  }
  const range = source.find((r) => r.startsWith("@@"))?.match(/\+(\d+)(?:,(\d+))?/);
  const first = Number(range?.[1] ?? 1);
  const count = Number(range?.[2] ?? Math.max(1, added));
  return {
    path,
    range: `lines ${first}–${first + Math.max(0, count - 1)}`,
    lines,
    added,
    removed,
    hiddenLines: Math.max(0, source.filter((r) => !r.startsWith("@@")).length - limit),
  };
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ledger(r: TurnState["routine"]): string {
  const parts = [
    ...(r.reads ? [`Read ${plural(r.reads, "file")}`] : []),
    ...(r.lists ? [`listed ${plural(r.lists, "directory", "directories")}`] : []),
    ...(r.searches ? [`ran ${plural(r.searches, "search", "searches")}`] : []),
    ...(r.commands ? [`ran ${plural(r.commands, "shell command")}`] : []),
  ];
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** `● Verb target · meta` for a finished tool call, the CLI's grammar exactly. */
export function toolPresentation(
  name: string,
  args: Record<string, unknown>,
  result: string,
  success: boolean,
  posture: "sandboxed" | "host",
): {
  verb: string;
  target: string;
  meta: string[];
  cmd?: { text: string; hint?: string; bad?: boolean };
  diff?: DiffCard;
} {
  const parsed = tryJson(result);
  switch (name) {
    case "edit_file":
    case "multi_edit": {
      const path = String(parsed?.path ?? args.path ?? "");
      const diff =
        typeof parsed?.diff === "string" ? parseDiff(path, parsed.diff as string) : undefined;
      return { verb: "Editing", target: listingPath(path), meta: ["hash-guarded"], diff };
    }
    case "write_file": {
      const path = String(parsed?.path ?? args.path ?? "");
      const bytes = parsed?.bytes_written;
      return {
        verb: "Writing",
        target: listingPath(path),
        meta: bytes != null ? [`${bytes} bytes`] : [],
      };
    }
    case "grep": {
      const pattern = oneLine(args.pattern, 32);
      const target = listingPath(String(args.path ?? "."));
      const n = typeof parsed?.total_matches === "number" ? (parsed.total_matches as number) : null;
      const hint =
        n == null ? undefined : n === 0 ? "no matches" : `${n} ${n === 1 ? "match" : "matches"}`;
      return {
        verb: "Searching",
        target,
        meta: ["grep"],
        cmd: { text: `grep -rn "${pattern}" ${target}`, hint },
      };
    }
    case "bash": {
      const command = oneLine(args.command, 120);
      const stdout = typeof parsed?.stdout === "string" ? (parsed.stdout as string) : "";
      const stderr = typeof parsed?.stderr === "string" ? (parsed.stderr as string) : "";
      const exit = typeof parsed?.exit_code === "number" ? (parsed.exit_code as number) : null;
      const timedOut = parsed?.timed_out === true;
      const bad = !success || timedOut || (exit != null && exit !== 0);
      const hint = timedOut
        ? "timed out"
        : exit != null && exit !== 0
          ? `exit ${exit}`
          : commandOutcome(stdout.trim() ? stdout : stderr);
      const postureMeta =
        args.network === true
          ? ["bash", "host", "network"]
          : posture === "sandboxed"
            ? ["bash", "sandboxed"]
            : ["bash", "host"];
      if (bad)
        return {
          verb: "Command failed",
          target: "",
          meta: postureMeta,
          cmd: { text: command, hint, bad: true },
        };
      if (isVerificationCommand(command)) {
        return {
          verb: "Verifying",
          target: verificationTarget(command),
          meta: postureMeta,
          cmd: { text: command, hint },
        };
      }
      return {
        verb: "Running command",
        target: "",
        meta: postureMeta,
        cmd: { text: command, hint },
      };
    }
    case "web_search":
      return { verb: "Searching web", target: `"${oneLine(args.query ?? args.q, 48)}"`, meta: [] };
    case "web_fetch":
      return { verb: "Reading source", target: oneLine(args.url ?? args.uri, 56), meta: [] };
    case "read_file":
      return { verb: "Reading", target: listingPath(String(args.path ?? "")), meta: [] };
    case "list_dir":
      return { verb: "Exploring", target: listingPath(String(args.path ?? ".")) + "/", meta: [] };
    default:
      return {
        verb: name,
        target: "",
        meta: [oneLine(JSON.stringify(args), 60)].filter((s) => s && s !== "{}"),
      };
  }
}

/** The live label for an in-flight tool ("Reading src/x.ts", "Running bun test"). */
export function liveToolLabel(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  switch (name) {
    case "read_file":
      return path ? `Reading ${listingPath(path)}` : "Reading relevant code";
    case "list_dir":
      return path ? `Exploring ${listingPath(path)}` : "Mapping the workspace";
    case "grep":
      return args.pattern
        ? `Searching for "${oneLine(args.pattern, 40)}"`
        : "Searching the codebase";
    case "edit_file":
    case "multi_edit":
      return path ? `Updating ${listingPath(path)}` : "Applying the change";
    case "write_file":
      return path ? `Creating ${listingPath(path)}` : "Creating the implementation";
    case "bash": {
      const c = oneLine(args.command, 64);
      return c
        ? isVerificationCommand(c)
          ? `Checking with ${c}`
          : `Running ${c}`
        : "Running a command";
    }
    case "web_search":
      return "Researching";
    case "web_fetch":
      return "Reading the primary source";
    default:
      return name;
  }
}

function checkFromBash(command: string, result: string, success: boolean): CheckRecord | null {
  if (!isVerificationCommand(command)) return null;
  const parsed = tryJson(result);
  const exit = typeof parsed?.exit_code === "number" ? (parsed.exit_code as number) : null;
  const timedOut = parsed?.timed_out === true;
  const stdout = typeof parsed?.stdout === "string" ? (parsed.stdout as string) : "";
  const passed = success && !timedOut && (exit == null || exit === 0);
  const tally =
    /^\s*(\d+)\s+pass(?:ed|ing)?\b/m.exec(stdout)?.[1] ??
    /\bRan\s+(\d+)\s+tests?\b/.exec(stdout)?.[1] ??
    /\b(\d+)\s+tests?\s+passed\b/i.exec(stdout)?.[1];
  return {
    label: oneLine(command, 62),
    status: passed ? "passed" : "failed",
    tests: tally && passed ? Number(tally) : undefined,
  };
}

/** `214 tests pass`, `typecheck clean`, `lint clean`, `build ok` — or the command. */
export function checkBadge(check: CheckRecord): string {
  const cmd = check.label.toLowerCase();
  if (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)|\b(cargo|go|swift)\s+test\b/.test(
      cmd,
    )
  )
    return check.tests ? `${check.tests} tests pass` : "tests pass";
  if (/\b(typecheck|tsc)\b/.test(cmd)) return "typecheck clean";
  if (/\b(lint|eslint|ruff|clippy|mypy)\b/.test(cmd)) return "lint clean";
  if (/\bbuild\b/.test(cmd)) return "build ok";
  return check.label;
}

const BLOCK_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||(?:-{3,}|\*{3,}|_{3,})$)/;

/** First sentence → headline, rest → detail (code-aware; mirrors the CLI). */
export function splitResponse(markdown: string): { headline: string; detail: string } {
  const source = markdown.replace(/\r\n/g, "\n").split("\n");
  const first = source.findIndex((l) => l.trim());
  if (first < 0) return { headline: "", detail: "" };
  const opener = source[first]!.trim();
  if (BLOCK_OPENER.test(opener) || /^(\*\*|__)/.test(opener))
    return { headline: "", detail: markdown };
  let end = first;
  while (
    end + 1 < source.length &&
    source[end + 1]!.trim() &&
    !BLOCK_OPENER.test(source[end + 1]!.trim())
  )
    end++;
  const paragraph = source
    .slice(first, end + 1)
    .map((l) => l.trim())
    .join(" ");
  let inCode = false;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i]!;
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (ch !== "." && ch !== "!" && ch !== "?")) continue;
    if (ch === "." && /\d/.test(paragraph[i + 1] ?? "")) continue;
    if (/\b(e\.g|i\.e|etc|vs|cf|approx|fig|no)$/i.test(paragraph.slice(0, i))) continue;
    let j = i + 1;
    while (j < paragraph.length && /[)"'*_\]]/.test(paragraph[j]!)) j++;
    const next = paragraph.slice(j);
    if (next.length > 0 && !/^\s+["'(`\[*_A-Z0-9]/.test(next)) continue;
    const headline = paragraph.slice(0, j).trim();
    if (headline.length > 200) break;
    return { headline, detail: [next.trim(), ...source.slice(end + 1)].join("\n").trim() };
  }
  if (paragraph.length <= 200)
    return {
      headline: paragraph,
      detail: source
        .slice(end + 1)
        .join("\n")
        .trim(),
    };
  return { headline: "", detail: markdown };
}

// ── reducer ──

function current(state: StreamState): TurnState | null {
  return state.current == null ? null : (state.turns[state.current] ?? null);
}

function patchTurn(state: StreamState, fn: (t: TurnState) => TurnState): StreamState {
  if (state.current == null) return state;
  const turns = state.turns.slice();
  turns[state.current] = fn(turns[state.current]!);
  return { ...state, turns };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function pushItem(
  t: TurnState,
  item: DistributiveOmit<StreamItem, "id"> & { id?: string },
): TurnState {
  const id = item.id ?? `i${t.nextId}`;
  return { ...t, nextId: t.nextId + 1, items: [...t.items, { ...item, id } as StreamItem] };
}

function deriveStatus(t: TurnState): TurnState {
  if (t.endedAt) return t;
  if (t.pendingPermission) return { ...t, status: "waiting", statusDetail: undefined };
  if (t.currentTool) return { ...t, status: "running", statusDetail: t.currentTool.label };
  if (t.items.some((i) => i.kind === "verification" && i.report === ""))
    return { ...t, status: "verifying", statusDetail: "running the project checks" };
  if (t.prose.trim()) return { ...t, status: "synthesizing", statusDetail: undefined };
  const todo = [...t.items].reverse().find((i) => i.kind === "todo");
  if (todo && todo.kind === "todo") {
    const active = todo.items.find((i) => i.status === "in_progress");
    const done = todo.items.filter((i) => i.status === "completed").length;
    if (active)
      return {
        ...t,
        status: "thinking",
        statusDetail: `${active.content} · ${done}/${todo.items.length} steps`,
      };
  }
  return { ...t, status: "thinking", statusDetail: undefined };
}

export function streamReducer(
  state: StreamState,
  action: StreamAction,
  posture: "sandboxed" | "host" = "sandboxed",
): StreamState {
  const now = ("now" in action && action.now) || Date.now();
  switch (action.type) {
    case "reset":
      return INITIAL_STREAM;
    case "turn_start": {
      const t: TurnState = {
        turn: action.turn ?? state.turns.length + 1,
        task: action.task,
        startedAt: now,
        items: [],
        prose: "",
        status: "thinking",
        tokensOut: 0,
        thinkingMs: 0,
        files: [],
        checks: [],
        reroutes: 0,
        failures: 0,
        hardError: false,
        routine: { reads: 0, lists: 0, searches: 0, commands: 0 },
        burstIndex: null,
        lastThinkingAt: 0,
        nextId: 1,
        hypotheses: [],
        decisions: [],
        artifacts: [],
        pending: [],
      };
      return { turns: [...state.turns, t], current: state.turns.length };
    }
    case "abort":
      return {
        ...patchTurn(state, (t) => ({
          ...t,
          endedAt: now,
          status: "interrupted",
          currentTool: undefined,
          pendingPermission: undefined,
        })),
        current: null,
      };
    case "permission_request":
      return patchTurn(state, (t) =>
        deriveStatus(
          pushItem(
            { ...t, pendingPermission: action.requestId },
            {
              kind: "permission",
              requestId: action.requestId,
              prompt: action.prompt,
              startedAt: now,
            },
          ),
        ),
      );
    case "permission_decided":
      return patchTurn(state, (t) =>
        deriveStatus({
          ...t,
          pendingPermission:
            t.pendingPermission === action.requestId ? undefined : t.pendingPermission,
          items: t.items.map((i) =>
            i.kind === "permission" && i.requestId === action.requestId
              ? { ...i, decision: action.decision }
              : i,
          ),
        }),
      );
    case "event": {
      const t0 = current(state);
      if (!t0) return state;
      // No cast. The union is `@gear/protocol`'s now, and the switch below is
      // exhaustive against it — which is the whole point of Phase 2.
      const ev = action.event;
      const next = patchTurn(state, (t) => {
        switch (ev.type) {
          case "thinking_delta": {
            const gained =
              t.lastThinkingAt > 0 && now - t.lastThinkingAt < 3000 ? now - t.lastThinkingAt : 0;
            return deriveStatus({ ...t, thinkingMs: t.thinkingMs + gained, lastThinkingAt: now });
          }
          case "text_delta":
            return deriveStatus({ ...t, prose: t.prose + String(ev.text ?? "") });
          case "stream_reset":
            return deriveStatus({ ...t, prose: "", currentTool: undefined });
          case "tool_call_start": {
            // Prose before a tool call is the model's intent — the Plan bullet
            // the first time, an ordinary step afterwards.
            let next = t;
            const narration = t.prose.trim();
            if (narration) {
              const hasPlan = t.items.some((i) => i.kind === "plan");
              next = pushItem(
                { ...next, prose: "", burstIndex: null },
                {
                  kind: "plan",
                  text: hasPlan ? narration : narration.replace(/^plan\s*:\s*/i, ""),
                  first: !hasPlan,
                },
              );
            }
            const name = String(ev.toolName ?? "tool");
            return deriveStatus({
              ...next,
              currentTool: {
                callId: String(ev.callId ?? ""),
                toolName: name,
                label: liveToolLabel(name, {}),
              },
            });
          }
          case "tool_call_args_delta": {
            if (!t.currentTool || (ev.callId && ev.callId !== t.currentTool.callId)) return t;
            const partial =
              String((t.currentTool as { partial?: string }).partial ?? "") +
              String(ev.partialJson ?? "");
            const parsed = tryJson(partial) ?? {};
            return deriveStatus({
              ...t,
              currentTool: {
                ...t.currentTool,
                label: liveToolLabel(t.currentTool.toolName, parsed),
                ...({ partial } as object),
              },
            });
          }
          case "tool_call_end": {
            const output = (ev.output ?? {}) as {
              toolName?: string;
              success?: boolean;
              result?: string;
              error?: string;
              durationMs?: number;
            };
            const args = (ev.args ?? {}) as Record<string, unknown>;
            const name = String(output.toolName ?? "tool");
            const result = String(output.result ?? "");
            const success = output.success !== false;
            let next: TurnState = { ...t, currentTool: undefined };
            // Plan narration that preceded a tool call which started without a start event.
            const narration = next.prose.trim();
            if (narration) {
              const hasPlan = next.items.some((i) => i.kind === "plan");
              next = pushItem(
                { ...next, prose: "", burstIndex: null },
                {
                  kind: "plan",
                  text: hasPlan ? narration : narration.replace(/^plan\s*:\s*/i, ""),
                  first: !hasPlan,
                },
              );
            }
            if (!success) {
              next.failures++;
              next = { ...next, failures: t.failures + 1, burstIndex: null };
              const p = toolPresentation(name, args, result, false, posture);
              return deriveStatus(
                pushItem(next, {
                  kind: "tool",
                  callId: String(ev.callId ?? ""),
                  toolName: name,
                  verb: p.verb || name,
                  target: p.target,
                  meta: p.meta,
                  status: "error",
                  cmd: p.cmd,
                  error: oneLine(output.error ?? "failed", 120),
                }),
              );
            }
            // Edits feed the summary strip.
            if (name === "edit_file" || name === "multi_edit" || name === "write_file") {
              const parsed = tryJson(result);
              const path = String(args.path ?? parsed?.path ?? "");
              const diff =
                typeof parsed?.diff === "string" ? parseDiff(path, parsed.diff as string) : null;
              const existing = next.files.find((f) => f.path === path);
              const files = existing
                ? next.files.map((f) =>
                    f.path === path
                      ? {
                          ...f,
                          added: f.added + (diff?.added ?? 0),
                          removed: f.removed + (diff?.removed ?? 0),
                        }
                      : f,
                  )
                : [...next.files, { path, added: diff?.added ?? 0, removed: diff?.removed ?? 0 }];
              next = { ...next, files };
            }
            if (name === "bash") {
              const check = checkFromBash(String(args.command ?? ""), result, success);
              if (check)
                next = {
                  ...next,
                  checks: [...next.checks, check],
                  failures: check.status === "failed" ? next.failures + 1 : next.failures,
                };
            }
            // Routine reads collapse into the ledger row; everything else is a bullet.
            if (ROUTINE.has(name)) {
              const routine = { ...next.routine };
              if (name === "read_file") routine.reads++;
              else if (name === "list_dir") routine.lists++;
              else routine.searches++;
              const text = ledger(routine);
              if (next.burstIndex != null && next.items[next.burstIndex]?.kind === "summary") {
                const items = next.items.slice();
                items[next.burstIndex] = {
                  ...(items[next.burstIndex] as StreamItem),
                  text,
                } as StreamItem;
                return deriveStatus({ ...next, routine, items });
              }
              const withItem = pushItem({ ...next, routine }, { kind: "summary", text });
              return deriveStatus({ ...withItem, burstIndex: withItem.items.length - 1 });
            }
            const p = toolPresentation(name, args, result, true, posture);
            return deriveStatus(
              pushItem(
                { ...next, burstIndex: null },
                {
                  kind: "tool",
                  callId: String(ev.callId ?? ""),
                  toolName: name,
                  verb: p.verb,
                  target: p.target,
                  meta: p.meta,
                  status: "ok",
                  cmd: p.cmd,
                  diff: p.diff,
                },
              ),
            );
          }
          case "todo_updated":
            return deriveStatus(
              pushItem(
                { ...t, burstIndex: null },
                {
                  kind: "todo",
                  items: Array.isArray(ev.items)
                    ? (ev.items as { content: string; status: string }[])
                    : [],
                },
              ),
            );
          case "usage": {
            const ctx = (ev.context as { percent?: number } | undefined)?.percent;
            return {
              ...t,
              tokensOut: t.tokensOut + Number(ev.outputTokens ?? 0),
              contextPercent: typeof ctx === "number" && ctx > 0 ? ctx : t.contextPercent,
            };
          }
          case "fallback":
            return deriveStatus(
              pushItem(
                { ...t, reroutes: t.reroutes + 1, burstIndex: null },
                {
                  kind: "fallback",
                  from: ev.from as { provider: string; model: string },
                  to: ev.to as { provider: string; model: string },
                  status: ev.status as number | undefined,
                  reason: ev.reason as string | undefined,
                  chain: ev.chain as string[] | undefined,
                },
              ),
            );
          case "compaction":
            return deriveStatus(
              pushItem(
                { ...t, burstIndex: null },
                {
                  kind: "compaction",
                  beforeTokens: Number(ev.beforeTokens ?? 0),
                  afterTokens: Number(ev.afterTokens ?? 0),
                  limitTokens: Number(ev.limitTokens ?? 0),
                  summarizedCount: ev.summarizedCount as number | undefined,
                  forced: Boolean(ev.forced),
                },
              ),
            );
          case "checkpoint_saved":
            return { ...t, checkpoint: { version: Number(ev.version ?? 0) } };
          case "verification_started":
            return deriveStatus(
              pushItem(
                { ...t, burstIndex: null, currentTool: undefined },
                { kind: "verification", ran: false, passed: false, report: "" },
              ),
            );
          case "verification_completed": {
            const idx = [...t.items]
              .map((i, k) => ({ i, k }))
              .reverse()
              .find(({ i }) => i.kind === "verification" && i.report === "")?.k;
            const item = {
              kind: "verification" as const,
              ran: Boolean(ev.ran),
              passed: Boolean(ev.passed),
              report: String(ev.report ?? ""),
            };
            const report = item.report;
            const command = oneLine(
              report
                .split("\n")
                .find((l) => l.startsWith("$ "))
                ?.replace(/^\$ /, "")
                .replace(/\s+\(ok\)$/, "") ?? "project checks",
              62,
            );
            const checks = item.ran
              ? [
                  ...t.checks,
                  {
                    label: command,
                    status: item.passed ? ("passed" as const) : ("failed" as const),
                  },
                ]
              : t.checks;
            const failures = item.ran && !item.passed ? t.failures + 1 : t.failures;
            if (idx != null) {
              const items = t.items.slice();
              items[idx] = { ...(items[idx] as StreamItem), ...item } as StreamItem;
              return deriveStatus({ ...t, items, checks, failures });
            }
            return deriveStatus(pushItem({ ...t, checks, failures }, item));
          }
          case "notice":
          case "context_warning": {
            const message = String(ev.message ?? "");
            if (/unavailable.*Switching to/s.test(message))
              return { ...t, reroutes: t.reroutes + 1 };
            return deriveStatus(pushItem({ ...t, burstIndex: null }, { kind: "notice", message }));
          }
          case "error":
            return deriveStatus(
              pushItem(
                { ...t, hardError: true, failures: t.failures + 1, currentTool: undefined },
                { kind: "error", message: oneLine(ev.error, 200) },
              ),
            );
          case "turn_complete": {
            const latest = [...t.checks].reverse().find((c) => c.status !== "not-run");
            const repaired = t.failures > 0 && latest?.status === "passed";
            const failed = t.hardError && !repaired;
            const warned = !failed && t.failures > 0 && !repaired;
            return {
              ...t,
              endedAt: now,
              currentTool: undefined,
              pendingPermission: undefined,
              status: failed ? "failed" : warned ? "notes" : "complete",
              statusDetail: undefined,
            };
          }
          // ─── The four events this reducer had never learned ───
          // All of them are live on the terminal and were dropped here: a
          // retry looked like a hang, a step check never reached the ledger, a
          // handoff read as a clean finish, and a sub-agent's progress was
          // invisible. Named and reduced now; exhaustive from here on.
          case "retry":
            return deriveStatus({
              ...t,
              statusDetail: `retrying ${ev.provider}/${ev.model} — attempt ${ev.attempt} of ${ev.of}`,
            });

          case "step_check":
            return {
              ...t,
              checks: [
                ...t.checks,
                { label: ev.step, status: !ev.ran ? "not-run" : ev.passed ? "passed" : "failed" },
              ],
              failures: t.failures + (ev.ran && !ev.passed ? 1 : 0),
            };

          case "handoff":
            // A run that ended BEFORE finishing must never read as a clean
            // finish. `turn_complete` still closes the turn; this records why.
            return {
              ...t,
              statusDetail: `paused — ${ev.reason.replace(/_/g, " ")}`,
              items: [...t.items, { kind: "notice", id: `n${t.nextId}`, message: ev.state }],
              nextId: t.nextId + 1,
            };

          case "replanning":
            return {
              ...t,
              items: [
                ...t.items,
                { kind: "notice", id: `n${t.nextId}`, message: `re-planning — ${ev.reason}` },
              ],
              nextId: t.nextId + 1,
            };

          case "tool_progress":
            // A sub-agent heartbeat belongs on the live rung, never in the
            // transcript — the same rule the TUI holds.
            return ev.note ? { ...t, statusDetail: ev.note } : t;

          // ─── The narrative (P11.1) ───
          // State, not scrollback. A surface binds to these paths and updates
          // live; nothing here is pushed into `items`, so the transcript does
          // not say the same thing twice.
          case "task_kind":
            return { ...t, taskKind: ev.kind };

          case "hypothesis":
            return t.hypotheses.some((h) => h.id === ev.hypothesis.id)
              ? t
              : { ...t, hypotheses: [...t.hypotheses, ev.hypothesis] };

          case "hypothesis_updated":
            return {
              ...t,
              hypotheses: t.hypotheses.map((h) =>
                h.id === ev.id
                  ? {
                      ...h,
                      status: ev.status,
                      ...(ev.reason ? { reason: ev.reason } : {}),
                      evidence: ev.evidence ?? h.evidence,
                    }
                  : h,
              ),
            };

          case "decision":
            return { ...t, decisions: [...t.decisions, ev.decision] };

          case "artifact":
            return t.artifacts.some((a) => a.id === ev.artifact.id)
              ? t
              : { ...t, artifacts: [...t.artifacts, ev.artifact] };

          case "pending_decision":
            return {
              ...t,
              pending: [...t.pending.filter((p) => p.id !== ev.decision.id), ev.decision],
            };

          case "decision_resolved":
            return {
              ...t,
              pending: t.pending.map((p) =>
                p.id === ev.id
                  ? { ...p, resolution: { at: new Date(now).toISOString(), outcome: ev.outcome } }
                  : p,
              ),
            };

          case "decision_record":
            return { ...t, record: ev.record };

          // ─── Named, and deliberately not reduced here ───
          case "tool_call_args_delta":
            return t;

          default:
            // Compile-time exhaustiveness: adding a member to AgentTurnEvent is
            // a type error here until the desktop has decided what it means.
            return assertNeverSoft(ev, t);
        }
      });
      // A completed turn is no longer the one receiving events.
      return ev.type === "turn_complete" ? { ...next, current: null } : next;
    }
    default:
      return state;
  }
}

/** The elapsed · ↓ tokens · thought-for receipt under the status rung. */
export function receipt(t: TurnState, now = Date.now()): string {
  const ms = (t.endedAt ?? now) - t.startedAt;
  const secs = Math.max(0, Math.floor(ms / 1000));
  const parts = [secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`];
  if (t.tokensOut > 0)
    parts.push(
      `↓ ${t.tokensOut >= 1000 ? `${(t.tokensOut / 1000).toFixed(t.tokensOut >= 10_000 ? 0 : 1)}k` : t.tokensOut} tokens`,
    );
  if (t.thinkingMs >= 100) parts.push(`thought for ${(t.thinkingMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}
