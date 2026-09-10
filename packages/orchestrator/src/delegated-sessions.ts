import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
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
  /** What this child has spent across every run of this `task_id` so far. */
  budget?: SpentBudget;
  /** When this record was written, and whether it was written mid-run. */
  at?: string;
  /** True for a checkpoint saved at a tool boundary rather than on resolve. */
  atBoundary?: boolean;
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

export interface DelegatedSessionsOptions {
  /** Test seam: liveness probe for a lease holder (default `process.kill(pid, 0)`). */
  pidAlive?: (pid: number) => boolean;
  /** Override the lease TTL. */
  leaseTtlMs?: number;
}

/** Child history shares the parent's durable event store and deletion/rewind
 * lifecycle. No independent auth, billing, or competing task scheduler. */
export class DelegatedSessions {
  private memory = new Map<string, Checkpoint>();
  private busy = new Set<string>();
  private readonly pidAlive: (pid: number) => boolean;
  private readonly leaseTtlMs: number;
  constructor(
    private sessions?: Pick<SessionManager, "appendEvent" | "getLatestKeyedEvent">,
    opts: DelegatedSessionsOptions = {},
  ) {
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
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

  /** The live lease on `id`, or null when there is none to honour. */
  private heldLease(parent: string, id: string): Lease | null {
    if (!this.sessions) return null;
    const row = this.sessions.getLatestKeyedEvent(parent, "delegation_lease", id);
    const lease = row?.payload as unknown as Lease | undefined;
    if (!lease || typeof lease.pid !== "number" || lease.released) return null;
    const ttl = Number.isFinite(lease.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : this.leaseTtlMs;
    // Liveness first, TTL second — the same order `TeamBus.sweep` uses, and the
    // reason a crash does not strand a `task_id` for half an hour.
    if (!this.pidAlive(lease.pid)) return null;
    if (Date.now() - lease.at > ttl) return null;
    return { ...lease, ttlMs: ttl };
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
      const minutes = Math.max(1, Math.round(held.ttlMs / 60_000));
      const age = Math.max(0, Math.round((Date.now() - held.at) / 1000));
      throw new Error(
        `Delegated session ${id} is already running: process ${held.pid} has held it for ${age}s. ` +
          `Wait for its result before resuming. The hold lasts at most ${minutes} minutes and ` +
          `clears as soon as process ${held.pid} exits — if that process is already gone, retry and ` +
          `the lease is reaped automatically.`,
      );
    }
    this.busy.add(key);
    this.writeLease(parent, { id, pid: process.pid, at: Date.now(), ttlMs: this.leaseTtlMs });
    return () => {
      this.busy.delete(key);
      this.writeLease(parent, {
        id,
        pid: process.pid,
        at: Date.now(),
        ttlMs: this.leaseTtlMs,
        released: true,
      });
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
        return { type: "text" as const, text: "[image omitted from the resume checkpoint]" };
      if (
        block.type === "tool_result" &&
        block.toolResultContent.length > RESULT_KEEP_CHARS + 200
      ) {
        const cut = block.toolResultContent.length - RESULT_KEEP_CHARS;
        return {
          ...block,
          toolResultContent: `${block.toolResultContent.slice(0, RESULT_KEEP_CHARS)}\n…[${cut} characters omitted from the resume checkpoint; re-read the source if you need them]`,
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
        // Mid-run save state: the last body's hash (dedup) and the bytes spent
        // on boundary saves (the run's bound).
        let lastHash = "";
        let boundaryBytes = 0;
        let boundaryFailure: unknown;
        const compose = (atBoundary: boolean): Checkpoint | null => {
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
            ...(budget ? { budget } : {}),
            at: new Date().toISOString(),
            ...(atBoundary ? { atBoundary: true } : {}),
          };
        };
        run.saveBoundary = () => {
          if (boundaryFailure || boundaryBytes >= CHECKPOINT_BOUNDARY_BUDGET_BYTES) return;
          try {
            const next = compose(true);
            if (!next) return;
            // Dedup on the transcript alone: `at` and the elapsed clock move on
            // every call and would defeat a hash taken over the whole record.
            const body = JSON.stringify(next.messages);
            const hash = createHash("sha256").update(body).digest("hex");
            if (hash === lastHash) return;
            lastHash = hash;
            boundaryBytes += Buffer.byteLength(body);
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
            const final = compose(false);
            if (final) store.save(input.sessionId, final);
            // The child summary in the shape the lifecycle contract's
            // `children[]` uses. The child itself cannot fill in `id`/`kind` —
            // both are minted here — so it reports the rest and this completes it.
            const child = result.structured?.child as Record<string, unknown> | undefined;
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
