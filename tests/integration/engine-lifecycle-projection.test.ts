// ─── The lifecycle projection, across a restart ───
//
// Phase 2's acceptance is about what SURVIVES. Every assertion here reads a
// real sqlite file written by a real Engine and then read back by a SECOND
// Engine object built on the same file — the closest an in-process test gets
// to the restart the scenario harness performs with a real kill.
//
// Only the provider is scripted. No native binary is needed: every tool these
// scripts call is a built-in TypeScript one, so the file cannot be silently
// skipped on a checkout without `cargo build -p rune-tools`.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine, replayEvents } from "../../packages/orchestrator/src/engine";
import { resumeFromCheckpoint } from "../../packages/orchestrator/src/session-replay";
import {
  filesChangedFrom,
  inheritedBudget,
  previousRunWasInterrupted,
  runSeqFromEvents,
  checkpointRunId,
} from "../../packages/orchestrator/src/lifecycle";
import {
  SqliteCheckpointStore,
  reportCheckpoints,
  pruneCheckpoints,
} from "../../packages/shared/src/state";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent, TaskLifecycle } from "../../packages/protocol/src/index";
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
  // The profile lives OUTSIDE the workspace: a RUNE_HOME inside it would make
  // every tree dirty before the run started, which is the one thing these
  // assertions are about.
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
    // In the profile, not the workspace: an untracked rune.db inside the tree
    // is itself a dirty file, and the revision assertions are about the tree.
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
  });
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

async function drain(
  engine: Engine,
  sessionId: string,
  message: string,
): Promise<AgentTurnEvent[]> {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
  return events;
}

function lifecycles(
  events: AgentTurnEvent[],
): Array<Extract<AgentTurnEvent, { type: "lifecycle" }>> {
  return events.filter(
    (e): e is Extract<AgentTurnEvent, { type: "lifecycle" }> => e.type === "lifecycle",
  );
}

describe("the lifecycle projection", () => {
  test("a run emits it at the start and at the end, and both are durable", async () => {
    const dir = tempWorkspace("rune-lifecycle-");
    const engine = makeEngine(dir);
    script(engine, [
      [
        tool("todo_write", {
          items: [{ content: "Read the config", kind: "read", status: "in_progress" }],
        }),
      ],
      [{ type: "text", text: "Read it." }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, "Read the config file and tell me what it says.");

    const seen = lifecycles(events);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]!.moment).toBe("start");
    expect(seen.at(-1)!.moment).toBe("terminal");

    const first = seen[0]!.lifecycle;
    expect(first.id).toBe(session);
    expect(first.kind).toBe("lead");
    expect(first.status).toBe("running");
    expect(first.workspace.root).toBe(dir);
    expect(first.budget.turnsMax).toBeGreaterThan(0);

    // The ending is a real verdict, not a boolean, and the plan it left open
    // is on the projection rather than only inside a task_state blob.
    const last = seen.at(-1)!.lifecycle;
    expect(last.status).toBe("open_steps");
    expect(last.evidence.todos.map((t) => t.status)).toContain("in_progress");
    expect(last.budget.turnsUsed).toBeGreaterThan(0);

    // …and it survives the process that produced it. `replayEvents` is the
    // third consumer: a reconnecting client rebuilds the same events.
    const rows = (engine as unknown as Internals).sessions.getEvents(session, 1);
    const replayed = replayEvents(rows).frames.filter((f) => f.event.type === "lifecycle");
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    const durable = replayed.at(-1)!.event as Extract<AgentTurnEvent, { type: "lifecycle" }>;
    expect(durable.lifecycle.status).toBe("open_steps");

    // Gap 1.8a: the terminal verdict itself now has a row.
    const terminal = rows.filter(
      (r) =>
        r.event.type === "run_trace" &&
        (r.event.payload as { type?: string }).type === "turn_complete",
    );
    expect(terminal.length).toBeGreaterThanOrEqual(1);
  });

  test("the workspace revision is recorded on the run's own marker", () => {
    const dir = tempWorkspace("rune-lifecycle-git-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    const engine = makeEngine(dir);
    script(engine, [[{ type: "text", text: "Nothing to do." }]]);
    const session = engine.createSession();
    return drain(engine, session, "Say hello.").then(() => {
      const rows = (engine as unknown as Internals).sessions.getEvents(session, 1);
      const marker = rows.find(
        (r) =>
          r.event.type === "checkpoint" &&
          (r.event.payload as { summary?: string }).summary === "session_started",
      );
      expect(marker).toBeDefined();
      const payload = marker!.event.payload as { head?: string; dirty?: boolean; runId?: string };
      expect(payload.head).toBe(head);
      expect(payload.dirty).toBe(false);
      // And the run id it was written under is addressable after a restart.
      expect(payload.runId).toBe(`${session}#1`);
    });
  });
});

describe("user constraints survive a restart", () => {
  test("the brief and its rungs are restored beside the task spine", async () => {
    const dir = tempWorkspace("rune-brief-");
    const engineA = makeEngine(dir);
    script(engineA, [
      [
        tool("read_back", {
          reading: "the export is dropping the last row",
          touch: ["src/export.ts"],
          leave: ["src/import.ts"],
          done_when: ["the exporter writes every row", "the existing tests still pass"],
        }),
      ],
      [{ type: "text", text: "Understood." }],
    ]);
    const session = engineA.createSession();
    await drain(engineA, session, "Fix the exporter — it drops the last row.");

    const rowsA = (engineA as unknown as Internals).sessions.getEvents(session, 1);
    const briefRows = rowsA.filter((r) => r.event.type === "brief");
    expect(briefRows.length).toBeGreaterThanOrEqual(1);
    const stored = briefRows.at(-1)!.event.payload as {
      version: number;
      brief: { criteria: Array<{ text: string }> };
    };
    expect(stored.version).toBe(1);
    expect(stored.brief.criteria.map((c) => c.text)).toEqual([
      "the exporter writes every row",
      "the existing tests still pass",
    ]);

    engineA.close();

    // A second Engine on the same file — the restart. Before Phase 2 there was
    // no `brief` row anywhere in the repo, so this read nothing at all.
    const engineB = makeEngine(dir);
    script(engineB, [[{ type: "text", text: "Resuming." }]]);
    await drain(engineB, session, "Carry on.");
    const restored = engineB.currentBrief();
    expect(restored?.criteria.map((c) => c.text)).toEqual([
      "the exporter writes every row",
      "the existing tests still pass",
    ]);
    expect(engineB.currentLedger()?.total).toBe(2);
  });
});

describe("an interrupted run hands its budget forward", () => {
  test("a lifecycle row with open steps narrows the next run; a clean end does not", () => {
    const spent = (turnsUsed: number, status: TaskLifecycle["status"], open: boolean) => ({
      event: {
        type: "run_trace",
        payload: {
          type: "lifecycle",
          moment: "budget",
          lifecycle: {
            id: "s1",
            kind: "lead",
            objective: "build it",
            constraints: [],
            workspace: { root: "/w", head: null, dirty: false },
            status,
            budget: {
              turnsUsed,
              turnsMax: 80,
              secondWindsUsed: 1,
              tokensIn: 0,
              tokensOut: 0,
              spentUsd: 1.25,
              capUsd: null,
              reservedUsd: 0,
            },
            checkpoint: null,
            evidence: {
              todos: open ? [{ content: "step", status: "in_progress", kind: "edit" }] : [],
              checks: [],
              verifiedCriteria: 0,
            },
            children: [],
          },
        } as unknown as Record<string, unknown>,
      },
    });

    expect(inheritedBudget([spent(60, "running", true)])).toEqual({
      turnsUsed: 60,
      secondWindsUsed: 1,
      spentUsd: 1.25,
      from: "running",
    });
    // A finished run hands nothing on, and neither does one whose plan closed.
    expect(inheritedBudget([spent(60, "end_turn", true)])).toBeNull();
    expect(inheritedBudget([spent(60, "running", false)])).toBeNull();
  });

  test("a run that wrote its close is not treated as interrupted", () => {
    const marker = (summary: string) => ({ event: { type: "checkpoint", payload: { summary } } });
    expect(previousRunWasInterrupted([marker("session_started"), marker("session_ended")])).toBe(
      false,
    );
    expect(previousRunWasInterrupted([marker("session_started")])).toBe(true);
    expect(
      previousRunWasInterrupted([
        marker("session_started"),
        marker("session_ended"),
        marker("session_started"),
      ]),
    ).toBe(true);
    expect(runSeqFromEvents([marker("session_started"), marker("session_ended")])).toBe(2);
  });

  test("the resume line reaches the stream, and the loop's ceiling with it", async () => {
    const dir = tempWorkspace("rune-inherit-");
    const engineA = makeEngine(dir);
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

    // Simulate the kill: delete the close marker the finally wrote, which is
    // exactly the state a SIGKILL leaves behind (no `finally` ever ran).
    const db = new Database(join(process.env.RUNE_HOME!, "rune.db"));
    db.prepare(
      "DELETE FROM events WHERE session_id = ? AND json_extract(payload_json,'$.payload.summary') = 'session_ended'",
    ).run(session);
    db.close();
    engineA.close();

    const engineB = makeEngine(dir);
    script(engineB, [[{ type: "text", text: "Picking it up." }]]);
    const events = await drain(engineB, session, "Keep going with the long job please.");
    const resumeLine = events.find(
      (e) => e.type === "notice" && e.message.startsWith("Resuming interrupted work:"),
    );
    expect(resumeLine).toBeDefined();
    // …and the projection reports the CUMULATIVE turns, so a machine that
    // crashes twice cannot narrow from the full ceiling twice.
    const last = lifecycles(events).at(-1)!.lifecycle;
    expect(last.budget.turnsUsed).toBeGreaterThan(1);
  });
});

describe("checkpoints are addressable, bounded and prunable", () => {
  test("the run id is stable, the payload is a pointer, and old versions rotate", async () => {
    const dir = tempWorkspace("rune-checkpoint-");
    const engine = makeEngine(dir, { checkpoints: true });
    script(engine, [
      [tool("write_file", { path: "one.txt", content: "1" })],
      [tool("write_file", { path: "two.txt", content: "2" })],
      [tool("write_file", { path: "three.txt", content: "3" })],
      [{ type: "text", text: "Wrote three files." }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, "Write three small files.");
    const saves = events.filter((e) => e.type === "checkpoint_saved");
    expect(saves.length).toBeGreaterThanOrEqual(2);
    expect(saves.every((s) => s.type === "checkpoint_saved" && s.runId === `${session}#1`)).toBe(
      true,
    );

    const db = new Database(join(process.env.RUNE_HOME!, "rune.db"));
    const store = new SqliteCheckpointStore(db);
    // Rotation: at most `keepVersions` rows survive for one run.
    expect(store.listCheckpoints(`${session}#1`).length).toBeLessThanOrEqual(2);

    // The payload is a pointer. This is the whole 184-MiB fix: the messages
    // are in the `events` table and were never worth a second copy.
    const latest = resumeFromCheckpoint(checkpointRunId(session, 1), store)!;
    expect(latest).toBeTruthy();
    expect(latest.sessionId).toBe(session);
    expect(latest.lastSeq).toBeGreaterThan(0);
    expect(latest.budget.turnsUsed).toBeGreaterThan(0);
    expect(Object.keys(latest)).not.toContain("messages");
    expect(JSON.stringify(latest).length).toBeLessThan(2000);

    // And the doctor can report and prune what accumulated.
    const report = reportCheckpoints(db);
    expect(report.rows).toBeGreaterThan(0);
    const dry = pruneCheckpoints(db, {});
    expect(dry.applied).toBe(false);
    expect(reportCheckpoints(db).rows).toBe(report.rows);
    db.close();
  });
});

describe("one definition of what a run changed", () => {
  test("apply_patch and worker files count, and a read does not", () => {
    expect(filesChangedFrom("edit_file", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(filesChangedFrom("multi_edit", { path: "src/b.ts" })).toEqual(["src/b.ts"]);
    expect(
      filesChangedFrom(
        "apply_patch",
        {},
        JSON.stringify({ files: [{ path: "src/c.ts" }, { path: "src/d.ts", action: "added" }] }),
      ),
    ).toEqual(["src/c.ts", "src/d.ts"]);
    expect(filesChangedFrom("worker", { files: ["src/client.ts", "src/api.ts"] })).toEqual([
      "src/client.ts",
      "src/api.ts",
    ]);
    expect(filesChangedFrom("read_file", { path: "src/a.ts" })).toEqual([]);
    expect(filesChangedFrom(undefined, undefined)).toEqual([]);
  });
});
