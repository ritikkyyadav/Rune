import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Message } from "@rune/llm-gateway";
import type { SessionManager } from "@rune/shared";
import type { ToolHandler, ToolCallOutput } from "@rune/tool-registry";

type Kind = "task" | "worker";
interface Checkpoint {
  version: 1;
  id: string;
  kind: Kind;
  workspace: string;
  files: string[];
  provider: string;
  model: string;
  messages: Message[];
  retainedWorker?: { branch: string; baseCommit: string; recoveryPath?: string };
}

/** Child history shares the parent's durable event store and deletion/rewind
 * lifecycle. No independent auth, billing, or competing task scheduler. */
export class DelegatedSessions {
  private memory = new Map<string, Checkpoint>();
  private busy = new Set<string>();
  constructor(private sessions?: Pick<SessionManager, "appendEvent" | "getLatestKeyedEvent">) {}
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
  claim(parent: string, id: string): () => void {
    const key = `${parent}:${id}`;
    if (this.busy.has(key))
      throw new Error(
        `Delegated session ${id} is already running. Wait for its result before resuming.`,
      );
    this.busy.add(key);
    return () => {
      this.busy.delete(key);
    };
  }
}

interface Active {
  checkpoint?: Checkpoint;
  identity?: { provider: string; model: string };
  messages?: () => Message[];
  retainedWorker?: Checkpoint["retainedWorker"];
}
const active = new AsyncLocalStorage<Active>();

/** Ceiling for one resume checkpoint. Above it the child's oldest exchanges go, oldest first. */
export const CHECKPOINT_MAX_BYTES = 256 * 1024;
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
        let result = await active.run(run, async () => {
          try {
            return await handler.execute(input);
          } catch (error) {
            return failed(error);
          }
        });
        if (run.messages && run.identity) {
          try {
            store.save(input.sessionId, {
              version: 1,
              id,
              kind,
              workspace,
              files,
              ...run.identity,
              messages: compactCheckpointMessages(run.messages()),
              retainedWorker: run.retainedWorker,
            });
            result = {
              ...result,
              result: `${result.result}\n\ntask_id: ${id}`,
              structured: { ...result.structured, task_id: id },
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
