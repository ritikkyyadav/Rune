/**
 * The durable half of the lifecycle, on a real sqlite file, driven by two
 * Engine objects.
 *
 * Written by an independent verifier, asserting what the lane's own suite
 * does not: rotation keeps EXACTLY two (≤ 2 is also satisfied by a store that
 * saved nothing); a checkpoint run id is distinct across sessions; the
 * restored brief still carries the revision its evidence was taken at; a
 * CLEAN end hands nothing forward end to end; a resumed run duplicates
 * neither the previous run's tool executions nor its lifecycle rows; and a
 * demotion the run announces is actually WRITTEN — the digest that decides
 * whether to persist the brief used to be taken after the demotion had
 * already mutated it, so the notice appeared and the durable row still said
 * `verified` against a HEAD that had moved.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import { checkpointRunId } from "../../packages/orchestrator/src/lifecycle";
import { SqliteCheckpointStore } from "../../packages/shared/src/state";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

function tempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  });
  return dir;
}

function makeEngine(dir: string, opts: { checkpoints?: boolean } = {}): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-4",
    enableCheckpoints: opts.checkpoints === true,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as never);
  cleanup.push(() => engine.close());
  return engine;
}

function script(engine: Engine, turns: ContentBlock[][]): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) =>
    turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
  return provider;
}

let callSeq = 0;
function tool(name: string, args: Record<string, unknown>): ContentBlock {
  return { type: "tool_use", toolCallId: `c${++callSeq}`, toolName: name, toolInput: args };
}

async function drain(engine: Engine, sessionId: string, message: string) {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
  return events;
}

describe("checkpoints", () => {
  test("rotation keeps EXACTLY two, and the id is distinct per session", async () => {
    const dir = tempWorkspace("v2-ckpt-");
    const engine = makeEngine(dir, { checkpoints: true });
    script(engine, [
      [tool("write_file", { path: "a.txt", content: "1" })],
      [tool("write_file", { path: "b.txt", content: "2" })],
      [tool("write_file", { path: "c.txt", content: "3" })],
      [tool("write_file", { path: "d.txt", content: "4" })],
      [{ type: "text", text: "Wrote four files." }],
    ]);
    const s1 = engine.createSession();
    const events = await drain(engine, s1, "Write four small files.");
    const saves = events.filter((e) => e.type === "checkpoint_saved");
    expect(saves.length).toBeGreaterThanOrEqual(3);

    const db = new Database(join(process.env.RUNE_HOME!, "rune.db"));
    const store = new SqliteCheckpointStore(db);
    // ≤ 2 is satisfied by a store that saved nothing. Exactly 2 is the claim.
    expect(store.listCheckpoints(checkpointRunId(s1, 1))).toHaveLength(2);

    // A second session on the same database must not share the run id.
    const s2 = engine.createSession();
    expect(checkpointRunId(s2, 1)).not.toBe(checkpointRunId(s1, 1));
    expect(store.listCheckpoints(checkpointRunId(s2, 1))).toHaveLength(0);
    db.close();
  });
});

describe("what a CLEAN end hands forward", () => {
  test("nothing: no resume line, no narrowed ceiling, no checkpoint recovery", async () => {
    const dir = tempWorkspace("v2-clean-");
    const engineA = makeEngine(dir, { checkpoints: true });
    script(engineA, [
      [
        tool("todo_write", {
          items: [{ content: "Do the thing", kind: "edit", status: "in_progress" }],
        }),
      ],
      [{ type: "text", text: "Partly done." }],
    ]);
    const session = engineA.createSession();
    await drain(engineA, session, "Do the thing, it is a long job.");
    engineA.close();

    // No kill: the `finally` wrote `session_ended`, so the next run is fresh
    // even though the plan is still open.
    const engineB = makeEngine(dir, { checkpoints: true });
    script(engineB, [[{ type: "text", text: "Picking it up." }]]);
    const events = await drain(engineB, session, "Keep going with the long job please.");
    expect(
      events.filter(
        (e) =>
          e.type === "notice" &&
          (/^Resuming interrupted work:/.test(e.message) ||
            /^Recovered the previous run's checkpoint/.test(e.message)),
      ),
    ).toHaveLength(0);
    const start = events.find((e) => e.type === "lifecycle" && e.moment === "start");
    expect(start && start.type === "lifecycle" && start.lifecycle.budget.turnsUsed).toBe(0);
  });
});

describe("a restart does not replay side effects", () => {
  test("no tool is executed twice, and no lifecycle transition is written twice", async () => {
    const dir = tempWorkspace("v2-replay-");
    const engineA = makeEngine(dir);
    script(engineA, [
      [tool("write_file", { path: "once.txt", content: "1" })],
      [{ type: "text", text: "Wrote it." }],
    ]);
    const session = engineA.createSession();
    await drain(engineA, session, "Write once.txt.");
    const rowsA = (engineA as unknown as Internals).sessions.getEvents(session, 1);
    const writesA = rowsA.filter(
      (r) =>
        r.event.type === "run_trace" &&
        (r.event.payload as { type?: string; toolName?: string }).type === "tool_call_end",
    );
    engineA.close();

    const engineB = makeEngine(dir);
    script(engineB, [[{ type: "text", text: "Nothing more to do." }]]);
    await drain(engineB, session, "Anything left?");
    const rowsB = (engineB as unknown as Internals).sessions.getEvents(session, 1);
    const writesB = rowsB.filter(
      (r) =>
        r.event.type === "run_trace" &&
        (r.event.payload as { type?: string }).type === "tool_call_end",
    );
    // The second run executed no tools: the count is unchanged.
    expect(writesB.length).toBe(writesA.length);

    // Each run writes its own start and terminal; no run writes two of either.
    const moments = rowsB
      .filter(
        (r) =>
          r.event.type === "run_trace" &&
          (r.event.payload as { type?: string }).type === "lifecycle",
      )
      .map((r) => (r.event.payload as { moment?: string }).moment);
    expect(moments.filter((m) => m === "start")).toHaveLength(2);
    expect(moments.filter((m) => m === "terminal")).toHaveLength(2);
  });
});

describe("the restored brief and the demotion notice", () => {
  test("a demoted criterion is written to the log, not just to memory", async () => {
    const dir = tempWorkspace("v2-demote-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });

    const engine = makeEngine(dir);
    const session = engine.createSession();
    // A brief proven against a commit that is about to stop being HEAD.
    (engine as unknown as Internals).sessions.appendEvent(session, {
      type: "brief",
      payload: {
        version: 1,
        brief: {
          reading: "the exporter drops the last row",
          touch: ["src/export.ts"],
          leave: [],
          criteria: [
            {
              text: "the exporter writes every row",
              rung: "verified",
              evidence: { source: "bun test", head: "0".repeat(40), dirty: false },
            },
          ],
        },
      },
    } as never);

    writeFileSync(join(dir, "a.txt"), "two\n");
    execFileSync("git", ["commit", "-qam", "move HEAD"], { cwd: dir });

    script(engine, [[{ type: "text", text: "Resuming." }]]);
    const events = await drain(engine, session, "Carry on with the exporter.");
    // These two hold: the rule fires and the run says so.
    const notice = events.find((e) => e.type === "notice" && /dropped a rung/.test(e.message));
    expect(notice).toBeDefined();
    expect(engine.currentBrief()?.criteria[0]?.rung).toBe("reproduced");

    // And so does this. `Engine.restoreBrief` used to seed `lastBriefDigest`
    // from the criteria AFTER `demoteStaleCriteria` had mutated them, so the
    // `if (moved.length > 0) this.persistBrief()` on the next line — and the
    // terminal `persistBrief()` — both hit the `digest === lastBriefDigest`
    // early return and wrote nothing: the durable record still claimed
    // `verified` against a HEAD that had moved, which is the exact state the
    // rule exists to prevent.
    const rows = (engine as unknown as Internals).sessions.getEvents(session, 1);
    const briefs = rows.filter((r) => r.event.type === "brief");
    expect(briefs).toHaveLength(2);
    const last = briefs.at(-1)!.event.payload as {
      brief: { criteria: Array<{ rung: string }> };
    };
    expect(last.brief.criteria[0]!.rung).toBe("reproduced");
  });
});
