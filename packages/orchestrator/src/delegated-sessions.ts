import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { Message } from "@rune/llm-gateway";
import type { SessionManager } from "@rune/shared";
import type { ToolHandler, ToolCallOutput } from "@rune/tool-registry";
import { isSpentBudget, type SpentBudget } from "./subagent-budget";

export type Kind = "task" | "worker";
export interface Checkpoint {
  version: 1;
  id: string;
  kind: Kind;
  workspace: string;
  files: string[];
  provider: string;
  model: string;
  messages: Message[];
  retainedWorker?: { branch: string; baseCommit: string; recoveryPath?: string };
  /**
   * The parent task's id. It was always the `events.session_id` of the row this
   * payload lives in, which made every reader infer it from where it found the
   * record; carrying it explicitly is what the lifecycle contract's `parentId`
   * reads.
   */
  parentId?: string;
  /**
   * Who this child WAS, as the surface showed it: the one-word role and the
   * 2-5 word brief the master wrote, and the call that dispatched it.
   *
   * The record held a child's whole conversation and nothing that named it, so
   * a session reopened later could list `task_4f1c…` and not `planner`. The
   * panel's card is keyed by the dispatching call and titled by these two
   * words; carrying them here is what lets a finished child be found again
   * under the name it ran as. All three absent on a row written before this.
   */
  name?: string;
  label?: string;
  callId?: string;
  /** When this run of the child began, so a restored card can state a span. */
  startedAt?: string;
  /** What this child has spent across every run of this `task_id` so far. */
  budget?: SpentBudget;
  /** When this record was written, and whether it was written mid-run. */
  at?: string;
  /** True for a checkpoint saved at a tool boundary rather than on resolve. */
  atBoundary?: boolean;
  /**
   * Set on the final save when mid-run boundary saves stopped at the run's byte
   * budget, with the last boundary that DID reach disk.
   *
   * The budget used to be a bare `return`: past it a long child's crash
   * granularity silently collapsed to "the final save only", and nothing in the
   * record said when. A resume that has to explain a gap can now read where the
   * gap starts.
   */
  boundaryBudgetExhausted?: {
    bytes: number;
    budgetBytes: number;
    at: string;
    lastCheckpointAt?: string;
  };
  /**
   * How the child ENDED, on the final save only.
   *
   * A boundary checkpoint has no status, because a child that is between two
   * model calls has not ended. That asymmetry is the whole signal the turn
   * ceiling reads: a record with no status is a record of a child that was
   * still running when its process died.
   */
  status?: string;
}

/**
 * How long a persisted resume lease is honoured when its owner's liveness
 * cannot be judged.
 *
 * The pid check is the primary reaper and it is instant: a crashed holder's
 * lease is ignored the moment another process looks at it, exactly as
 * `TeamBus.sweep` treats a dead instance. This TTL only backstops the case
 * where the pid tells us nothing — a recycled pid, or a lease written by a
 * different machine against a shared database.
 *
 * 30 minutes, because the longest legitimate single hold is a `thorough`
 * child's 25-minute wall-clock deadline (`EFFORT_BUDGETS`, subagent-budget.ts)
 * plus its checks and merge-back. A shorter TTL would let a second resume race
 * a worker that is still running.
 */
export const DELEGATION_LEASE_TTL_MS = 30 * 60_000;

interface Lease {
  id: string;
  pid: number;
  at: number;
  ttlMs: number;
  released?: boolean;
  /**
   * WHERE the holder is, and WHICH process it is.
   *
   * A lease used to name a pid and nothing else, so it could be wrongly held
   * (an unrelated process that inherited the pid kept a `task_id` for the full
   * TTL) and — the dangerous direction — wrongly CLEARED: a lease written on
   * another machine against a shared database was reaped the instant its pid
   * looked dead here, which is exactly the collision the lease exists to stop.
   * `host` decides whether a local pid probe means anything at all; `pidStart`
   * decides whether the live pid is still the process that took the lease.
   */
  host?: string;
  pidStart?: string;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When a pid started, as the OS reports it — the discriminator against pid reuse.
 *
 * Linux answers from `/proc/<pid>/stat` field 22 (boot-relative ticks); everything
 * else asks `ps`, which is accurate to the second. Null where neither can answer
 * (Windows, a hardened container): the caller then has no evidence of reuse and
 * honours the lease, because refusing a live holder is recoverable and stealing
 * a task from one is not.
 */
function defaultPidStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    if (fields[19]) return `linux:${fields[19]}`;
  } catch {
    // Not Linux, or the process is gone; `ps` below is the portable answer.
  }
  try {
    const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const line = (res.stdout ?? "").trim();
    if (res.status === 0 && line) return `ps:${line}`;
  } catch {
    // No `ps` on PATH.
  }
  return null;
}

/** This machine, for a lease read on another one. Never fatal: an unnamed host is treated as local. */
function safeHostId(): string {
  try {
    return hostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

export interface DelegatedSessionsOptions {
  /** Test seam: liveness probe for a lease holder (default `process.kill(pid, 0)`). */
  pidAlive?: (pid: number) => boolean;
  /** Test seam: the OS's start time for a pid (default `/proc` then `ps`). */
  pidStart?: (pid: number) => string | null;
  /** Test seam: this machine's identity in a lease (default `os.hostname()`). */
  hostId?: string;
  /** Override the lease TTL. */
  leaseTtlMs?: number;
}

/** Child history shares the parent's durable event store and deletion/rewind
 * lifecycle. No independent auth, billing, or competing task scheduler. */
export class DelegatedSessions {
  private memory = new Map<string, Checkpoint>();
  private busy = new Set<string>();
  private readonly pidAlive: (pid: number) => boolean;
  private readonly pidStart: (pid: number) => string | null;
  private readonly hostId: string;
  private readonly leaseTtlMs: number;
  private ownStart?: string;
  constructor(
    private sessions?: Pick<SessionManager, "appendEvent" | "getLatestKeyedEvent">,
    opts: DelegatedSessionsOptions = {},
  ) {
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.pidStart = opts.pidStart ?? defaultPidStart;
    this.hostId = opts.hostId ?? safeHostId();
    this.leaseTtlMs = opts.leaseTtlMs ?? DELEGATION_LEASE_TTL_MS;
  }
  load(parent: string, id: string): Checkpoint | undefined {
    if (this.sessions) {
      const row = this.sessions.getLatestKeyedEvent(parent, "delegation_checkpoint", id);
      const c = row?.payload as unknown as Checkpoint | undefined;
      return c?.version === 1 && Array.isArray(c.messages) ? c : undefined;
    }
    return this.memory.get(`${parent}:${id}`);
  }
  save(parent: string, c: Checkpoint): void {
    if (this.sessions)
      this.sessions.appendEvent(parent, {
        type: "delegation_checkpoint",
        payload: c as unknown as Record<string, unknown>,
      });
    else this.memory.set(`${parent}:${c.id}`, structuredClone(c));
  }

  /**
   * The live lease on `id`, or null when there is none to honour.
   *
   * A local pid probe is evidence about a LOCAL process and nothing else, so it
   * only clears a lease this host wrote. Three questions, in order:
   *
   * 1. Is the holder on this machine? If not, the pid on the record names some
   *    unrelated process here; only the TTL may clear it.
   * 2. Is that pid still alive? A crashed holder is reaped on sight, which is
   *    why a crash does not strand a `task_id` for half an hour.
   * 3. Is the live pid still the SAME process? A recycled pid used to hold a
   *    task for the full TTL — measured against a `sleep 30`. Start times settle
   *    it; where the OS will not say, the lease is honoured.
   */
  private heldLease(parent: string, id: string): Lease | null {
    if (!this.sessions) return null;
    const row = this.sessions.getLatestKeyedEvent(parent, "delegation_lease", id);
    const lease = row?.payload as unknown as Lease | undefined;
    if (!lease || typeof lease.pid !== "number" || lease.released) return null;
    const ttl = Number.isFinite(lease.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : this.leaseTtlMs;
    if (Date.now() - lease.at > ttl) return null;
    const local = !lease.host || lease.host === this.hostId;
    if (local) {
      if (!this.pidAlive(lease.pid)) return null;
      if (lease.pidStart) {
        const now = this.pidStart(lease.pid);
        if (now && now !== lease.pidStart) return null; // the pid was reused
      }
    }
    return { ...lease, ttlMs: ttl };
  }

  /**
   * A record that mid-run checkpointing stopped, so the gap is in the log
   * rather than only in the absence of rows.
   */
  notice(parent: string, payload: Record<string, unknown>): void {
    if (!this.sessions) return;
    try {
      this.sessions.appendEvent(parent, { type: "delegation_notice", payload });
    } catch {
      // A notice that cannot be recorded must never fail the delegation.
    }
  }

  /**
   * Take the resume lease on one delegated child, or refuse.
   *
   * The lease is persisted (owner pid + TTL) so two PROCESSES cannot resume one
   * `task_id` at once, not just two calls in one process — the in-memory `Set`
   * alone let a second Rune do exactly that, and both would then write
   * checkpoints over each other.
   */
  claim(parent: string, id: string): () => void {
    const key = `${parent}:${id}`;
    if (this.busy.has(key))
      throw new Error(
        `Delegated session ${id} is already running. Wait for its result before resuming.`,
      );
    const held = this.heldLease(parent, id);
    if (held) {
      const age = Math.max(0, Math.round((Date.now() - held.at) / 1000));
      const left = Math.max(1, Math.round((held.at + held.ttlMs - Date.now()) / 60_000));
      const where = held.host && held.host !== this.hostId ? ` on ${held.host}` : "";
      const clears =
        held.host && held.host !== this.hostId
          ? `That machine's processes cannot be judged from here, so the hold is not cleared by a ` +
            `local check: it expires in ${left} minutes, or as soon as ${held.host} releases it.`
          : `The hold expires in ${left} minutes and clears as soon as process ${held.pid} exits — ` +
            `if that process is already gone, retry and the lease is reaped automatically.`;
      throw new Error(
        `Delegated session ${id} is already running: process ${held.pid}${where} has held it for ` +
          `${age}s. Wait for its result before resuming. ${clears}`,
      );
    }
    this.busy.add(key);
    // Probed once per store: `ps` is a process spawn, and this process's own
    // start time does not change.
    this.ownStart ??= this.pidStart(process.pid) ?? "";
    const mine = (): Lease => ({
      id,
      pid: process.pid,
      at: Date.now(),
      ttlMs: this.leaseTtlMs,
      host: this.hostId,
      ...(this.ownStart ? { pidStart: this.ownStart } : {}),
    });
    this.writeLease(parent, mine());
    return () => {
      this.busy.delete(key);
      this.writeLease(parent, { ...mine(), released: true });
    };
  }

  private writeLease(parent: string, lease: Lease): void {
    if (!this.sessions) return;
    try {
      this.sessions.appendEvent(parent, {
        type: "delegation_lease",
        payload: lease as unknown as Record<string, unknown>,
      });
    } catch {
      // A lease that cannot be recorded degrades to the in-memory guard rather
      // than failing the delegation it was meant to protect.
    }
  }
}

interface Active {
  checkpoint?: Checkpoint;
  identity?: { provider: string; model: string };
  messages?: () => Message[];
  retainedWorker?: Checkpoint["retainedWorker"];
  /** Save a checkpoint now (installed by `withDelegatedSessions`). */
  saveBoundary?: () => void;
  /** What the running child has spent, read at save time. */
  budget?: () => SpentBudget;
}
const active = new AsyncLocalStorage<Active>();

/** Ceiling for one resume checkpoint. Above it the child's oldest exchanges go, oldest first. */
export const CHECKPOINT_MAX_BYTES = 256 * 1024;
/**
 * Total bytes one child run may spend on MID-RUN checkpoints.
 *
 * Eight full-size checkpoints. Beyond it the boundary saves stop and the final
 * save on resolve still happens, so the cost of a very long child is bounded
 * crash granularity late in the run rather than unbounded rows in `events`.
 */
export const CHECKPOINT_BOUNDARY_BUDGET_BYTES = 8 * CHECKPOINT_MAX_BYTES;
/** How much of a tool result survives into the checkpoint. The file is still on disk. */
const RESULT_KEEP_CHARS = 1_500;
/**
 * A fixed-width fingerprint of what a placeholder replaced.
 *
 * Without it the compaction below was lossy in a way that mattered downstream:
 * two boundaries whose tool results shared their first 1,500 characters — or
 * differed only in an image — produced byte-identical output, so anything
 * hashing a compacted checkpoint could not tell them apart. Eight hex
 * characters keep the placeholder a constant size while making it stand for
 * the exact bytes it dropped.
 */
const short = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

/**
 * A follow-up needs the child's findings, not its every file read.
 *
 * Without this, each follow-up re-saved the child's entire transcript as one
 * event row: a scout that read a dozen files wrote megabytes into rune.db per
 * resume, and nothing ever shrank it. Tool results are the bulk of that
 * transcript and the least valuable part of it on resume — the files are
 * still there to re-read — so they are cut first, in place. Images go the
 * same way. If the checkpoint is still over the ceiling, whole exchanges are
 * dropped, oldest first, always as the assistant turn plus every reply that
 * answers it, so no tool_result is ever left without its tool_use and the
 * roles keep alternating. The prompt and the final exchange always survive.
 * Assistant messages are never edited: providers reject altered thinking
 * blocks, and a summary that changes what the child said is not a checkpoint.
 */
export function compactCheckpointMessages(
  messages: Message[],
  maxBytes = CHECKPOINT_MAX_BYTES,
): Message[] {
  const out: Message[] = structuredClone(messages);
  for (const message of out) {
    if (message.role === "assistant") continue;
    message.content = message.content.map((block) => {
      if (block.type === "image")
        return {
          type: "text" as const,
          text: `[image omitted from the resume checkpoint (#${short(block.data)})]`,
        };
      if (
        block.type === "tool_result" &&
        block.toolResultContent.length > RESULT_KEEP_CHARS + 200
      ) {
        const cut = block.toolResultContent.length - RESULT_KEEP_CHARS;
        const tail = block.toolResultContent.slice(RESULT_KEEP_CHARS);
        return {
          ...block,
          toolResultContent: `${block.toolResultContent.slice(0, RESULT_KEEP_CHARS)}\n…[${cut} characters omitted from the resume checkpoint (#${short(tail)}); re-read the source if you need them]`,
        };
      }
      return block;
    });
  }
  const bytes = () => Buffer.byteLength(JSON.stringify(out));
  let omitted = 0;
  while (bytes() > maxBytes) {
    const at = out.findIndex((m, i) => i > 0 && m.role === "assistant");
    if (at < 0) break;
    const next = out.findIndex((m, i) => i > at && m.role === "assistant");
    if (next < 0) break; // only the final exchange is left; it stays
    out.splice(at, next - at);
    omitted++;
  }
  if (omitted > 0) {
    const note = `[${omitted} earlier exchange${omitted === 1 ? "" : "s"} omitted from the resume checkpoint]\n`;
    const carrier = out.find(
      (m, i) =>
        i > 0 &&
        m.role !== "assistant" &&
        m.content.some((b) => b.type === "tool_result" || b.type === "text"),
    );
    const block =
      carrier?.content.find((b) => b.type === "tool_result") ??
      carrier?.content.find((b) => b.type === "text");
    if (block?.type === "tool_result") block.toolResultContent = note + block.toolResultContent;
    else if (block?.type === "text") block.text = note + block.text;
  }
  return out;
}

/** Passed directly into AgentLoop.priorMessages, preserving opaque provider blocks. */
export function delegatedHistory(identity: {
  provider: string;
  model: string;
}): Message[] | undefined {
  const run = active.getStore();
  if (!run) return undefined;
  const prior = run.checkpoint;
  if (prior && (prior.provider !== identity.provider || prior.model !== identity.model)) {
    throw new Error(
      `This task_id used ${prior.provider}/${prior.model}. Resume with that model or start a new delegated task.`,
    );
  }
  run.identity = { provider: identity.provider, model: identity.model };
  return prior ? structuredClone(prior.messages) : undefined;
}
export function bindDelegatedLoop(loop: { getMessages(): Message[] }): void {
  const run = active.getStore();
  if (run) run.messages = () => loop.getMessages();
}

/**
 * Report the running child's spend so its checkpoint can carry it.
 *
 * Read at save time rather than pushed, so a checkpoint written at a tool
 * boundary and one written on resolve both carry the number as of that moment.
 */
export function bindDelegatedBudget(read: () => SpentBudget): void {
  const run = active.getStore();
  if (run) run.budget = read;
}

/** What earlier runs of this `task_id` already spent, for the child to seed from. */
export function delegatedBudgetSeed(): SpentBudget | undefined {
  const prior = active.getStore()?.checkpoint?.budget;
  return isSpentBudget(prior) ? prior : undefined;
}

/**
 * The turn ceiling this run of the child gets, per the director's rule.
 *
 * Two resumes look identical from the tool's side — both arrive as a
 * `task_id` and a prompt — and they are not the same event:
 *
 * - **A crash-resume of an UNFINISHED child** picks up work that was still in
 *   flight. Its checkpoint is a boundary record (`atBoundary`, no `status`),
 *   because the final save never happened. Handing it a fresh ceiling would
 *   mean a user who kills and resumes twice gets three full budgets for one
 *   task, which is the lead-side G6 hole in child form. It inherits:
 *   `remaining = max - used`.
 * - **A follow-up to a child that REACHED a terminal state** is new work the
 *   parent asked for, on a child that already reported. Its checkpoint carries
 *   a `status`. It starts a fresh turn ceiling — Lane W's point holds, a child
 *   resumed after `max_turns` with nothing left cannot take a single turn and
 *   would return an empty failure. The cumulative CAPS still apply either way:
 *   `resumeBudgetState` inherits spend and backdates the clock, so cost and
 *   wall-clock bound the task, not the call.
 *
 * The floor is one turn. A crash-resume that had already spent its ceiling is
 * a shape a live run cannot reach (a child at `max_turns` ends and writes a
 * final save), and zero turns would produce a child with no receipts and no
 * prose — the opposite of a usable partial result.
 */
export function delegatedTurnCeiling(maxTurns: number): number {
  const prior = active.getStore()?.checkpoint;
  if (!prior) return maxTurns;
  // A terminal record means the child ended and this is a follow-up.
  if (typeof prior.status === "string" && prior.status) return maxTurns;
  if (!prior.atBoundary) return maxTurns;
  const used = Number(prior.budget?.turnsUsed);
  if (!Number.isFinite(used) || used <= 0) return maxTurns;
  return Math.max(1, maxTurns - Math.floor(used));
}

/**
 * Save the child's resume checkpoint mid-run, at a tool boundary.
 *
 * The checkpoint used to be written only after `handler.execute` resolved, so a
 * crash during a four-minute worker lost the entire child transcript — and the
 * `task_id` it had already handed the parent resolved to nothing. A tool
 * boundary is the right cut: the child is between two model calls, its messages
 * are consistent, and the work it has done is on disk.
 *
 * Bounded on purpose. One save per boundary and no more; a save whose content
 * hashes the same as the last one is skipped; and the whole run has a byte
 * budget, after which boundary saves stop and only the final save remains.
 * `events` is append-only — the older rows cannot be deleted — so an unbounded
 * version of this would rebuild the 184 MiB write-only `checkpoints` table one
 * delegation at a time.
 */
export function checkpointDelegated(): void {
  active.getStore()?.saveBoundary?.();
}
export function delegatedFallback(identity: { provider: string; model: string }): void {
  const run = active.getStore();
  if (run) run.identity = { provider: identity.provider, model: identity.model };
}

export function delegatedWorkerSnapshot(): Checkpoint["retainedWorker"] {
  return active.getStore()?.checkpoint?.retainedWorker;
}
export function retainDelegatedWorker(snapshot: Checkpoint["retainedWorker"]): void {
  const run = active.getStore();
  if (run) run.retainedWorker = snapshot;
}

export function withDelegatedSessions(
  handler: ToolHandler,
  kind: Kind,
  store = new DelegatedSessions(),
): ToolHandler {
  return {
    ...handler,
    schema: {
      ...handler.schema,
      description:
        handler.schema.description +
        " Returns task_id: pass it with a follow-up prompt to resume this child and its findings. Workers must retain the same files ownership; each follow-up gets a fresh current-workspace snapshot.",
      inputSchema: {
        ...handler.schema.inputSchema,
        properties: {
          ...(handler.schema.inputSchema.properties as object),
          task_id: {
            type: "string",
            description:
              "Resume the delegated session returned by an earlier call in this parent session.",
          },
        },
      },
      outputSchema: handler.schema.outputSchema
        ? {
            ...handler.schema.outputSchema,
            properties: {
              ...(handler.schema.outputSchema.properties as object),
              task_id: { type: "string" },
            },
          }
        : undefined,
    },
    validate(args) {
      if (
        args.task_id !== undefined &&
        (typeof args.task_id !== "string" || !/^task_[a-f0-9-]{36}$/.test(args.task_id))
      ) {
        return {
          valid: false,
          error: "task_id must be an identifier returned by an earlier delegation",
        };
      }
      return handler.validate(args);
    },
    async execute(input) {
      const started = performance.now();
      const id =
        typeof input.args.task_id === "string" ? input.args.task_id : `task_${randomUUID()}`;
      let release: (() => void) | undefined;
      const failed = (error: unknown): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - started,
      });
      try {
        const valid = this.validate(input.args);
        if (!valid.valid) return failed(valid.error);
        release = store.claim(input.sessionId, id);
        const checkpoint = input.args.task_id ? store.load(input.sessionId, id) : undefined;
        if (input.args.task_id && !checkpoint)
          return failed("Unknown task_id in this parent session. Start a new delegation.");
        const workspace = resolve(input.workspaceRoot);
        const files =
          kind === "worker"
            ? (input.args.files as string[]).map((p) => resolve(workspace, p)).sort()
            : [];
        if (
          checkpoint &&
          (checkpoint.kind !== kind ||
            checkpoint.workspace !== workspace ||
            JSON.stringify(checkpoint.files) !== JSON.stringify(files))
        ) {
          return failed(
            "This task_id belongs to a different tool, workspace, or worker ownership set. Start a new delegation for that scope.",
          );
        }
        const run: Active = { checkpoint, retainedWorker: checkpoint?.retainedWorker };
        // What every earlier run of this task_id spent. A resume adds to it, so
        // the ceiling bounds the TASK and not one call of it.
        const priorBudget = isSpentBudget(checkpoint?.budget) ? checkpoint.budget : undefined;
        // Mid-run save state: the last body's hash (dedup), the bytes spent on
        // boundary saves (the run's bound), and where the last one landed.
        let lastHash = "";
        let boundaryBytes = 0;
        let boundaryFailure: unknown;
        let lastCheckpointAt: string | undefined;
        let cappedAt: string | undefined;
        // The identity the surface gave this child, read once from the call
        // that dispatched it. Bounded: both are display strings, and a model
        // that wrote a paragraph into `label` must not make every checkpoint
        // row carry it.
        const word = (value: unknown, max: number): string | undefined => {
          const clean = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
          return clean ? clean.slice(0, max) : undefined;
        };
        const identity = {
          name: word(input.args.name, 32),
          label: word(input.args.label, 80),
        };
        const runStartedAt = new Date().toISOString();
        const compose = (atBoundary: boolean, status?: string): Checkpoint | null => {
          if (!run.messages || !run.identity) return null;
          const live = run.budget?.();
          const budget: SpentBudget | undefined = isSpentBudget(live)
            ? {
                spentUsd: live.spentUsd,
                elapsedMs: live.elapsedMs,
                turnsUsed: live.turnsUsed,
              }
            : priorBudget;
          return {
            version: 1,
            id,
            kind,
            workspace,
            files,
            ...run.identity,
            messages: compactCheckpointMessages(run.messages()),
            retainedWorker: run.retainedWorker,
            parentId: input.sessionId,
            ...(identity.name ? { name: identity.name } : {}),
            ...(identity.label ? { label: identity.label } : {}),
            callId: input.callId,
            startedAt: runStartedAt,
            ...(budget ? { budget } : {}),
            at: new Date().toISOString(),
            ...(atBoundary ? { atBoundary: true } : {}),
            ...(!atBoundary && status ? { status } : {}),
            ...(!atBoundary && cappedAt
              ? {
                  boundaryBudgetExhausted: {
                    bytes: boundaryBytes,
                    budgetBytes: CHECKPOINT_BOUNDARY_BUDGET_BYTES,
                    at: cappedAt,
                    ...(lastCheckpointAt ? { lastCheckpointAt } : {}),
                  },
                }
              : {}),
          };
        };
        /**
         * Say it, once, when mid-run checkpointing stops.
         *
         * The budget used to be a bare `return`: past it the child's crash
         * granularity collapsed to "the final save only" and nothing recorded
         * when that happened, so a resume from an old checkpoint looked like a
         * checkpoint that was simply never taken.
         */
        const noticeCap = () => {
          if (cappedAt) return;
          cappedAt = new Date().toISOString();
          store.notice(input.sessionId, {
            id,
            kind,
            parentId: input.sessionId,
            reason: "boundary_budget",
            bytes: boundaryBytes,
            budgetBytes: CHECKPOINT_BOUNDARY_BUDGET_BYTES,
            at: cappedAt,
            ...(lastCheckpointAt ? { lastCheckpointAt } : {}),
            message:
              `Child checkpointing stopped at its ${Math.round(CHECKPOINT_BOUNDARY_BUDGET_BYTES / 1024)} KiB ` +
              `per-run cap; a crash after this point resumes from the last checkpoint at ` +
              `${lastCheckpointAt ?? "the start of this run"}.`,
          });
        };
        run.saveBoundary = () => {
          if (boundaryFailure) return;
          if (boundaryBytes >= CHECKPOINT_BOUNDARY_BUDGET_BYTES) {
            noticeCap();
            return;
          }
          try {
            if (!run.messages || !run.identity) return;
            // Dedup on the UNTRUNCATED transcript, and on the transcript alone:
            // `at` and the elapsed clock move on every call and would defeat a
            // hash over the whole record, while `compactCheckpointMessages`
            // moves the other way — it cut every tool result to its first 1,500
            // characters, so two boundaries differing only past that cut hashed
            // the same, the second was never written, and the child re-ran that
            // call on resume. For a `bash` that is a duplicated side effect,
            // which is the criterion the durability suite grades.
            const hash = createHash("sha256").update(JSON.stringify(run.messages())).digest("hex");
            if (hash === lastHash) return;
            const next = compose(true);
            if (!next) return;
            lastHash = hash;
            // The ROW is the whole checkpoint, not just its messages; counting
            // the messages alone under-counted what the budget is bounding.
            boundaryBytes += Buffer.byteLength(JSON.stringify(next));
            lastCheckpointAt = next.at;
            store.save(input.sessionId, next);
          } catch (error) {
            // A mid-run checkpoint must never take the child down with it. The
            // failure is remembered so the final save reports it if it recurs.
            boundaryFailure = error;
          }
        };
        let result = await active.run(run, async () => {
          try {
            return await handler.execute(input);
          } catch (error) {
            return failed(error);
          }
        });
        if (run.messages && run.identity) {
          try {
            // The child summary in the shape the lifecycle contract's
            // `children[]` uses. The child itself cannot fill in `id`/`kind` —
            // both are minted here — so it reports the rest and this completes it.
            const child = result.structured?.child as Record<string, unknown> | undefined;
            // How it ended, on the final save only. `delegatedTurnCeiling`
            // reads this to tell a follow-up (fresh ceiling) from a
            // crash-resume of a child that never got here (inherits).
            const declared =
              typeof child?.status === "string" && child.status
                ? child.status
                : typeof result.structured?.stopReason === "string" && result.structured.stopReason
                  ? (result.structured.stopReason as string)
                  : result.success
                    ? "end_turn"
                    : "stalled";
            const final = compose(false, declared);
            if (final) store.save(input.sessionId, final);
            result = {
              ...result,
              result: `${result.result}\n\ntask_id: ${id}`,
              structured: {
                ...result.structured,
                task_id: id,
                ...(child ? { child: { ...child, id, kind } } : {}),
              },
            };
          } catch (error) {
            result = {
              ...result,
              success: false,
              error: `Delegation finished, but its resume checkpoint could not be saved: ${String(error)}`,
            };
          }
        }
        return result;
      } catch (error) {
        return failed(error);
      } finally {
        release?.();
      }
    },
  };
}
