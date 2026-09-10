/**
 * A delegated child's checkpoint and lease reach the DATABASE, and a second
 * process resumes its `task_id`.
 *
 * The regression this guards: `Engine`'s constructor registered the delegation
 * tools BEFORE it built `this.delegatedSessions`, and `registerDelegationTools`
 * snapshots that field on its first line. The snapshot was `undefined`, the
 * declaration's `!` hid it from tsc, and `withDelegatedSessions` silently
 * substituted `new DelegatedSessions()` — a store with no SessionManager, which
 * keeps checkpoints in a per-process Map and never reads or writes a lease at
 * all. So no `delegation_checkpoint` and no `delegation_lease` row was ever
 * written by the product, and a `task_id` handed to the caller by one process
 * was answered by the next with "Unknown task_id in this parent session".
 *
 * Two Engine objects over one sqlite file, a scripted provider, no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";

const CHILD_MARKER = "map the parser surface";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

function scratch(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "engine-delegation-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "engine-delegation-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  return { dir, dbPath: join(home, "rune.db") };
}

function makeEngine(dir: string, dbPath: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath,
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    // The child runs on the session's own model, so the scripted provider is
    // the only one either agent can reach.
    subagents: { mode: "mirror" },
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as never);
  cleanup.push(() => engine.close());
  return engine;
}

/**
 * Script the lead's turns; every request that carries the child's prompt is
 * answered as the child. Lead and child share one provider, which is what a
 * `mirror` delegation does in production.
 */
function script(engine: Engine, leadTurns: ContentBlock[][]): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  let lead = 0;
  provider.onRequest = (request) => {
    // The sub-agent registry never carries `task` (a scout cannot recurse), so
    // the tool list — not the transcript, which replays the child's prompt back
    // into the lead's history on a resume — is what tells the two apart.
    const isChild = !(request.tools ?? []).some((t) => t.name === "task");
    if (isChild)
      return [{ type: "text", text: "The parser lives in src/csv.ts; nothing else reads it." }];
    return leadTurns[lead++] ?? [{ type: "text", text: "Done for now." }];
  };
  return provider;
}

let callSeq = 0;
const taskCall = (args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `c${++callSeq}`,
  toolName: "task",
  toolInput: {
    label: "map the parser",
    prompt: `${CHILD_MARKER}: where does parsing happen?`,
    ...args,
  },
});

async function drain(
  engine: Engine,
  sessionId: string,
  message: string,
): Promise<AgentTurnEvent[]> {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
  return events;
}

function rowsOfType(engine: Engine, sessionId: string, type: string): number {
  return (engine as unknown as Internals).sessions
    .getEvents(sessionId, 1)
    .filter((row) => row.event.type === type).length;
}

function delegationOutput(events: AgentTurnEvent[]): {
  success?: boolean;
  error?: string;
  structured?: Record<string, unknown>;
} {
  const end = events.find(
    (e) =>
      e.type === "tool_call_end" &&
      (e as { output?: { toolName?: string } }).output?.toolName === "task",
  ) as { output?: Record<string, unknown> } | undefined;
  return (end?.output ?? {}) as {
    success?: boolean;
    error?: string;
    structured?: Record<string, unknown>;
  };
}

describe("a delegated child's checkpoint and lease are durable", () => {
  test("one dispatch writes lease and checkpoint rows, and a second Engine resumes the task_id", async () => {
    const { dir, dbPath } = scratch();

    const engineA = makeEngine(dir, dbPath);
    const session = engineA.createSession();
    script(engineA, [[taskCall({})], [{ type: "text", text: "The scout came back." }]]);
    const first = await drain(engineA, session, "Send a scout at the parser.");

    const dispatched = delegationOutput(first);
    expect(dispatched.success).toBe(true);
    const taskId = dispatched.structured?.task_id;
    expect(typeof taskId).toBe("string");

    // G10/G12: the child's resume state is in the parent's event log, not in a
    // Map that dies with the process.
    expect(rowsOfType(engineA, session, "delegation_lease")).toBeGreaterThan(0);
    expect(rowsOfType(engineA, session, "delegation_checkpoint")).toBeGreaterThan(0);

    engineA.close();

    // A FRESH Engine on the same database resumes that child.
    const engineB = makeEngine(dir, dbPath);
    script(engineB, [
      [taskCall({ task_id: taskId })],
      [{ type: "text", text: "The scout came back again." }],
    ]);
    const second = await drain(engineB, session, "Ask the same scout one more thing.");

    const resumed = delegationOutput(second);
    expect(String(resumed.error ?? "")).not.toMatch(/unknown task_id/i);
    expect(resumed.success).toBe(true);
    expect(resumed.structured?.task_id).toBe(taskId);
  }, 60_000);
});
