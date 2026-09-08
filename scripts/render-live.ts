#!/usr/bin/env bun
// --- render-live: replay a stored session through the REAL TurnRenderer ---
//
// The TUI cannot look at itself. Every screenshot of "Rune" the founder has
// filed since 2026-09-05 turned out to be another product, and the six-phase
// transcript work of 2026-09-06 was only possible once the renderer could be
// driven from the events a real run had already written down. This is that
// method, made rerunnable.
//
// It reads `~/.rune/rune.db` READ-ONLY (`file:…?mode=ro`; a lane never writes
// to the founder's run DB), rebuilds the `AgentTurnEvent` stream a session
// produced, and feeds it to the same `TurnRenderer` the fixed frame drives,
// through a sink that captures blocks instead of painting them. The capture
// sink implements `amend`, because the fixed frame does: without it the
// renderer takes the commit-at-end path and the rows that land while a call is
// running — the ones the whole 2026-09-06 diagnosis was about — never exist.
//
// Usage
//   bun --preload ./scripts/fake-tty.ts scripts/render-live.ts --largest 5 \
//       --width 80 --width 120 --out docs/evidence/ui-render-20260908/before
//   bun --preload ./scripts/fake-tty.ts scripts/render-live.ts --session <id> --width 100
//
// Flags
//   --session <id>   render one session (repeatable)
//   --largest <n>    render the n largest sessions since --since
//   --since <date>   ISO prefix, default 2026-09-01
//   --width <n>      render at this width (repeatable, default 80 and 120)
//   --db <path>      a different rune.db
//   --out <dir>      write `<session>.<width>.txt` (ANSI stripped) instead of stdout
//   --keep-ansi      leave the escapes in the written files
//   --no-amend       drive the commit-at-end sink (the --inline surface)
//
// Everything here is replay. It opens no provider, spends nothing, and the
// only file it writes is the transcript you asked for.

import "./fake-tty";

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentTurnEvent } from "@rune/protocol";
import { TurnRenderer, userBlock, type TurnSink } from "../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../packages/orchestrator/src/bin/ui/render";

// ─── the capture sink ───

interface CapturedBlock {
  handle: number;
  /** null once the block was amended away — the fixed viewport splices it out. */
  block: string | null;
  detail?: string;
}

/**
 * A sink that keeps the transcript in an array, the way the fixed viewport
 * keeps it in its buffer. `amend` is offered unless the caller asks for the
 * inline surface, so the renderer takes the live path.
 */
class CaptureSink implements TurnSink {
  readonly blocks: CapturedBlock[] = [];
  readonly previews: (string[] | null)[] = [];
  private seq = 0;
  /** Every commit and amend in order — the tape the jitter diff is taken from. */
  readonly tape: Array<{ op: "commit" | "amend"; handle: number; block: string }> = [];

  constructor(private readonly live: boolean) {
    if (!live) {
      // A sink without `amend` is a different renderer path, and TypeScript is
      // how the renderer asks. Deleting the method is the honest way to say no.
      delete (this as Partial<CaptureSink>).amend;
    }
  }

  commit(block: string, detail?: string): number {
    const handle = ++this.seq;
    this.blocks.push({ handle, block, detail });
    this.tape.push({ op: "commit", handle, block });
    return handle;
  }

  amend(handle: number, block: string, detail?: string): void {
    const found = this.blocks.find((b) => b.handle === handle);
    if (!found) return;
    found.block = block === "" ? null : block;
    found.detail = detail;
    this.tape.push({ op: "amend", handle, block });
  }

  preview(lines: string[] | null): void {
    this.previews.push(lines);
  }

  transcript(): string {
    return this.blocks
      .map((b) => b.block)
      .filter((b): b is string => b != null)
      .join("\n");
  }
}

// ─── stored events → AgentTurnEvent ───

interface StoredEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

interface ToolUseRecord {
  callId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

/**
 * One replayed turn: what the user said, and the events the loop emitted
 * before the next thing the user said.
 */
export interface ReplayTurn {
  prompt: string;
  events: AgentTurnEvent[];
}

/**
 * Rebuild the turn events from what the session store kept.
 *
 * The store is not a recording of the UI stream — it keeps what a resume
 * needs. Three of the renderer's events survive verbatim inside `run_trace`
 * (usage, todo_updated, verification_*, notice, handoff, retry, replanning,
 * step_check, context_warning); the rest are reconstructed:
 *
 *   assistant_msg  → `text_delta` for the prose, then one `tool_call_start`
 *                    per tool use, which is where the call's row lands.
 *   tool_result    → `tool_call_end`, with the arguments taken from the call
 *                    that opened it and the tool name carried across. A result
 *                    whose call was never seen is dropped, exactly as the
 *                    replay path drops it for the model.
 *   auto_compaction→ `compaction`.
 *
 * Durations are not stored, so every call replays as 0ms. That is visible in
 * the receipts and is the one thing in a replayed transcript that is not what
 * the founder saw.
 */
export function replayTurns(events: StoredEvent[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let current: ReplayTurn | null = null;
  const calls = new Map<string, ToolUseRecord>();

  const open = (prompt: string) => {
    current = { prompt, events: [] };
    turns.push(current);
  };
  const push = (event: AgentTurnEvent) => {
    if (!current) open("");
    current!.events.push(event);
  };

  for (const { type, payload } of events) {
    switch (type) {
      case "user_msg": {
        open(String(payload.content ?? ""));
        break;
      }
      case "assistant_msg": {
        const content = typeof payload.content === "string" ? payload.content : "";
        if (content) push({ type: "text_delta", text: content });
        const uses = Array.isArray(payload.toolUses) ? (payload.toolUses as ToolUseRecord[]) : [];
        for (const use of uses) {
          if (!use?.callId) continue;
          calls.set(use.callId, use);
          push({ type: "tool_call_start", callId: use.callId, toolName: use.toolName ?? "" });
        }
        break;
      }
      case "tool_result": {
        const callId = String(payload.callId ?? "");
        const call = calls.get(callId);
        if (!call) break;
        calls.delete(callId);
        const isError = payload.isError === true;
        push({
          type: "tool_call_end",
          callId,
          args: call.toolInput ?? {},
          output: {
            callId,
            toolName: call.toolName ?? "",
            success: !isError,
            result: String(payload.content ?? ""),
            durationMs: 0,
            ...(isError ? { error: String(payload.content ?? "") } : {}),
          },
        });
        break;
      }
      case "run_trace": {
        // Already an AgentTurnEvent — the loop wrote it down as it emitted it.
        if (typeof payload.type === "string") push(payload as unknown as AgentTurnEvent);
        break;
      }
      case "auto_compaction": {
        push({
          type: "compaction",
          beforeTokens: Number(payload.beforeTokens ?? 0),
          afterTokens: Number(payload.afterTokens ?? 0),
          limitTokens: Number(payload.limitTokens ?? 0),
          ...(payload.tier ? { tier: payload.tier as "tool_results" | "summarized" } : {}),
          ...(payload.trigger ? { trigger: payload.trigger as "auto" | "requested" } : {}),
        });
        break;
      }
      default:
        // checkpoint / cost / task_state / safety_decision / retro / … are
        // ledger rows, not turn events. The renderer never saw them.
        break;
    }
  }
  return turns.filter((turn) => turn.events.length > 0 || turn.prompt);
}

/** Render one session's turns the way the fixed frame would. */
export function renderSession(
  turns: ReplayTurn[],
  opts: { width: number; live?: boolean },
): string {
  setTermWidthOverride(opts.width);
  try {
    const out: string[] = [];
    let priorPlanKey: string | undefined;
    for (const turn of turns) {
      const sink = new CaptureSink(opts.live !== false);
      const renderer = new TurnRenderer(sink, { priorPlanKey, getCost: () => 0 });
      if (turn.prompt) out.push(userBlock(turn.prompt));
      for (const event of turn.events) renderer.onEvent(event);
      renderer.finish();
      out.push(sink.transcript());
      priorPlanKey = renderer.planKey() ?? priorPlanKey;
    }
    return out.join("\n");
  } finally {
    setTermWidthOverride(null);
  }
}

// ─── the CLI ───

interface Args {
  sessions: string[];
  largest: number | null;
  since: string;
  widths: number[];
  db: string;
  out: string | null;
  keepAnsi: boolean;
  live: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sessions: [],
    largest: null,
    since: "2026-09-01",
    widths: [],
    db: join(homedir(), ".rune", "rune.db"),
    out: null,
    keepAnsi: false,
    live: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--session":
        if (value) (args.sessions.push(value), i++);
        break;
      case "--largest":
        if (value) ((args.largest = Number(value)), i++);
        break;
      case "--since":
        if (value) ((args.since = value), i++);
        break;
      case "--width":
        if (value) (args.widths.push(Number(value)), i++);
        break;
      case "--db":
        if (value) ((args.db = value), i++);
        break;
      case "--out":
        if (value) ((args.out = value), i++);
        break;
      case "--keep-ansi":
        args.keepAnsi = true;
        break;
      case "--no-amend":
        args.live = false;
        break;
      default:
        break;
    }
  }
  if (args.widths.length === 0) args.widths = [80, 120];
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // Read-only, always. This is the founder's run history, and a lane that
  // renders it must not be able to change it.
  const db = new Database(`file:${args.db}?mode=ro`, { readonly: true });

  const ids = [...args.sessions];
  if (args.largest != null) {
    const rows = db
      .query<{ id: string }, [string, number]>(
        `select s.id as id, count(e.id) as n
           from sessions s join events e on e.session_id = s.id
          where s.created_at >= ?
          group by s.id order by n desc limit ?`,
      )
      .all(args.since, args.largest);
    for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
  }
  if (ids.length === 0) {
    console.error("render-live: nothing to render — pass --session or --largest");
    process.exit(2);
  }

  if (args.out) mkdirSync(args.out, { recursive: true });

  for (const id of ids) {
    const stored = db
      .query<{ seq: number; type: string; payload_json: string }, [string]>(
        `select seq, type, payload_json from events where session_id = ? order by seq`,
      )
      .all(id)
      .map((row) => {
        const parsed = JSON.parse(row.payload_json) as { payload?: Record<string, unknown> };
        return { seq: row.seq, type: row.type, payload: parsed.payload ?? {} };
      });
    const turns = replayTurns(stored);
    for (const width of args.widths) {
      const rendered = renderSession(turns, { width, live: args.live });
      const body = args.keepAnsi ? rendered : stripAnsi(rendered);
      if (args.out) {
        const file = join(args.out, `${id}.${width}.txt`);
        writeFileSync(file, `${body}\n`);
        console.error(`${file}  (${turns.length} turns, ${stored.length} stored events)`);
      } else {
        console.log(`\n===== ${id} @ ${width} cols =====\n${body}`);
      }
    }
  }
  db.close();
}

if (import.meta.main) main();
