import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../packages/shared/src/session";
import { DelegatedSessions } from "../../../packages/orchestrator/src/delegated-sessions";
import { createSubagentTool } from "../../../packages/orchestrator/src/subagent";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { UsageProvider } from "../../helpers/usage-provider";
import {
  CHECKPOINT_MAX_BYTES,
  bindDelegatedBudget,
  bindDelegatedLoop,
  checkpointDelegated,
  compactCheckpointMessages,
  delegatedBudgetSeed,
  delegatedHistory,
  delegatedTurnCeiling,
  withDelegatedSessions,
} from "../../../packages/orchestrator/src/delegated-sessions";
import { checkBudget, resumeBudgetState } from "../../../packages/orchestrator/src/subagent-budget";
import type { Checkpoint } from "../../../packages/orchestrator/src/delegated-sessions";
import type { Message } from "../../../packages/llm-gateway/src/types";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";
const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) {
    // Windows keeps a directory busy for a moment after the SQLite file inside
    // it is closed — the handle, its WAL sidecars and any scanner reading them
    // are released asynchronously — so this removal raised EBUSY on
    // windows-latest and failed a test whose assertions had all passed. Retry,
    // then let it go: a temp directory the OS will reap is not a test result.
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* the directory outlives the run rather than failing it */
    }
  }
});

test("a child retains findings across follow-up, process restart, and parent scoping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-child-"));
  dirs.push(dir);
  const path = join(dir, "sessions.db");
  let sessions = new SessionManager(path);
  const parent = sessions.createSession(dir, "claude-sonnet-5", "anthropic").id;
  const provider = new UsageProvider();
  provider.onRequest = () => [
    { type: "text", text: "The parser is in source/parser.ts; preserve escaped quotes." },
  ];
  const gateway = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 0,
    retryBaseMs: 1,
  });
  gateway.registerProvider(provider);
  const build = (model = "claude-sonnet-5") =>
    createSubagentTool({
      gateway,
      registry: new ToolRegistry(),
      model,
      provider: "anthropic",
      delegatedSessions: new DelegatedSessions(sessions),
    });
  const input = {
    toolName: "task",
    callId: "first",
    workspaceRoot: dir,
    sessionId: parent,
    args: { prompt: "Locate the parser" },
  };
  const first = await build().execute(input);
  expect(first.success).toBe(true);
  const id = first.structured?.task_id as string;
  expect(id).toMatch(/^task_/);
  sessions.close();
  sessions = new SessionManager(path);
  const second = await build().execute({
    ...input,
    callId: "follow",
    args: { prompt: "What constraint did you find?", task_id: id },
  });
  expect(second.success).toBe(true);
  expect(second.structured?.task_id).toBe(id);
  expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("preserve escaped quotes");
  const count = provider.requests.length;
  expect(
    (
      await build().execute({
        ...input,
        sessionId: "different",
        args: { prompt: "Continue", task_id: id },
      })
    ).success,
  ).toBe(false);
  expect(
    (
      await build("claude-haiku-4-5").execute({
        ...input,
        args: { prompt: "Continue", task_id: id },
      })
    ).error,
  ).toContain("Resume with that model");
  expect(provider.requests).toHaveLength(count);
  sessions.close();
});

test("a delegated session cannot run overlapping follow-ups and releases its lease", () => {
  const store = new DelegatedSessions();
  const release = store.claim("parent", "child");
  expect(() => store.claim("parent", "child")).toThrow("already running");
  release();
  expect(() => store.claim("parent", "child")()).not.toThrow();
});

test("a resume checkpoint is bounded: results trimmed, exchanges dropped whole, prompt and final report kept", () => {
  const big = "x".repeat(40_000);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Locate the parser" }] },
  ];
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: `call-${i}`,
          toolName: "read_file",
          toolInput: { path: `f${i}.ts` },
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: `call-${i}`, toolResultContent: big },
        { type: "image", mediaType: "image/png", data: big },
      ],
    });
  }
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "The parser is in source/parser.ts." }],
  });
  const pairsHold = (list: Message[]) => {
    for (const [i, m] of list.entries())
      for (const b of m.content)
        if (b.type === "tool_result") {
          const prev = list[i - 1]!;
          expect(prev.role).toBe("assistant");
          expect(
            prev.content.some((p) => p.type === "tool_use" && p.toolCallId === b.toolCallId),
          ).toBe(true);
        }
  };
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(CHECKPOINT_MAX_BYTES);
  const compact = compactCheckpointMessages(messages);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(CHECKPOINT_MAX_BYTES);
  expect(compact).toHaveLength(messages.length);
  expect(compact[0]).toEqual(messages[0]);
  expect(compact.at(-1)).toEqual(messages.at(-1));
  expect(JSON.stringify(compact)).not.toContain("image/png");
  expect(JSON.stringify(compact)).toContain("omitted from the resume checkpoint");
  pairsHold(compact);
  const tight = compactCheckpointMessages(messages, 8_000);
  expect(tight.length).toBeLessThan(compact.length);
  expect(tight[0]).toEqual(messages[0]);
  expect(tight.at(-1)).toEqual(messages.at(-1));
  expect(JSON.stringify(tight)).toMatch(/earlier exchanges? omitted/);
  pairsHold(tight);
  // The original is never mutated.
  expect(messages[1]!.content[0]).toMatchObject({ type: "tool_use" });
  expect((messages[2]!.content[0] as { toolResultContent: string }).toolResultContent).toHaveLength(
    40_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// G10 — the child checkpoint is written at every tool boundary, not only on
// resolve. A crash four minutes into a worker used to lose the whole child
// transcript, and the task_id the parent already held resolved to nothing.
// ─────────────────────────────────────────────────────────────────────────────

function stubHandler(body: (input: ToolCallInput) => Promise<void> | void): ToolHandler {
  return {
    schema: {
      name: "task",
      version: "0.1.0",
      description: "stub",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      await body(input);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "done",
        durationMs: 1,
      };
    },
  };
}

function sessionsAt(prefix: string): { manager: SessionManager; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const path = join(dir, "sessions.db");
  return { manager: new SessionManager(path), path, dir };
}

const say = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

/** Every resume checkpoint written for `parent`, oldest first. */
function checkpointsOf(manager: SessionManager, parent: string) {
  return manager
    .getEvents(parent, 1)
    .filter((e) => e.event.type === "delegation_checkpoint")
    .map((e) => e.event.payload as unknown as Record<string, unknown>);
}

test("G10 — the resume checkpoint exists BEFORE the child returns, at each tool boundary", async () => {
  const { manager, dir } = sessionsAt("rune-g10-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  // What a process restarting after a crash at that instant would find on disk.
  const durableMidRun: number[] = [];

  await withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      for (const step of ["read src/a.ts", "read src/b.ts"]) {
        messages.push(say(step));
        checkpointDelegated();
        const latest = checkpointsOf(manager, parent).at(-1);
        durableMidRun.push((latest?.messages as Message[] | undefined)?.length ?? 0);
      }
    }),
    "task",
    new DelegatedSessions(manager),
  ).execute({
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput);

  // The transcript was durable at both boundaries, and grew with the run —
  // before this the answer at both points was "nothing is saved yet".
  expect(durableMidRun).toEqual([2, 3]);
  manager.close();
});

test("G10 — boundary checkpoints are bounded: identical content is not written twice", async () => {
  const { manager, dir } = sessionsAt("rune-g10b-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  await withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      messages.push(say("one"));
      checkpointDelegated();
      // Four more boundaries with nothing new to say: a run that reads the same
      // file again must not pay a checkpoint row for it.
      for (let i = 0; i < 4; i++) checkpointDelegated();
      messages.push(say("two"));
      checkpointDelegated();
    }),
    "task",
    new DelegatedSessions(manager),
  ).execute({
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput);

  const rows = checkpointsOf(manager, parent);
  // Two distinct boundaries plus the final save — not six.
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.atBoundary === true)).toHaveLength(2);
  expect(rows.at(-1)!.atBoundary).toBeUndefined();
  // The parent link is explicit now rather than inferred from where the row sat.
  expect(rows.at(-1)!.parentId).toBe(parent);
  manager.close();
});

test("G10 — two boundaries the compaction truncates alike are still saved apart", async () => {
  // The dedup hashed `compactCheckpointMessages(messages)`, which cuts every
  // tool result to its first 1,500 characters and replaced every image with one
  // constant string. Two boundaries differing only past that cut hashed the
  // same, so the second was never written: a crash between them lost that
  // tool's result from the checkpoint and the child re-ran the call on resume —
  // for a `bash`, a duplicated side effect.
  const { manager, dir } = sessionsAt("rune-g10d-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const shared = "X".repeat(1_600);
  const result = (tail: string): Message =>
    ({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: `t${tail}`,
          toolResultContent: `${shared}${tail.repeat(200)}`,
          isError: false,
        },
      ],
    }) as unknown as Message;
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  await withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      messages.push(say("ran the first command"), result("A"));
      checkpointDelegated();
      messages.push(say("ran the second command"), result("B"));
      checkpointDelegated();
    }),
    "task",
    new DelegatedSessions(manager),
  ).execute({
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput);

  const boundaries = checkpointsOf(manager, parent).filter((r) => r.atBoundary === true);
  expect(boundaries).toHaveLength(2);
  // And the surviving record can still tell the two results apart: the
  // truncation note carries a digest of exactly the bytes it dropped.
  const notes = boundaries.map((r) => JSON.stringify(r.messages));
  expect(notes[0]).not.toBe(notes[1]);
  manager.close();
});

test("G10 — an image is not a hole in the checkpoint: its placeholder names the bytes it replaced", () => {
  const shot = (data: string): Message[] =>
    [
      { role: "user", content: [{ type: "text", text: "look" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", toolUseId: "t1", toolName: "screenshot", toolInput: {} }],
      },
      { role: "user", content: [{ type: "image", data, mediaType: "image/png" }] },
    ] as unknown as Message[];
  const first = JSON.stringify(compactCheckpointMessages(shot("FIRST-SHOT")));
  const second = JSON.stringify(compactCheckpointMessages(shot("SECOND-SHOT")));
  expect(first).toContain("image omitted from the resume checkpoint");
  expect(first).not.toContain("FIRST-SHOT"); // the bytes still do not go in
  expect(second).not.toBe(first);
});

test("G10 — when the byte budget stops mid-run checkpointing, the record says so", async () => {
  const { manager, dir } = sessionsAt("rune-g10e-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  // An assistant turn is the one thing compaction never edits — providers
  // reject altered thinking blocks — so each of these boundaries costs a real
  // ~300 KB row, and the run crosses its 2 MiB budget partway through.
  const bulk = (n: number) => say(`step ${n} `.repeat(40_000));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, bulk(0)];
  const ROUNDS = 12;

  await withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      for (let i = 1; i <= ROUNDS; i++) {
        messages[1] = bulk(i); // new content every time: never a dedup skip
        checkpointDelegated();
      }
    }),
    "task",
    new DelegatedSessions(manager),
  ).execute({
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput);

  // Bounded, as designed: the boundary saves stop.
  const rows = checkpointsOf(manager, parent);
  const boundaries = rows.filter((r) => r.atBoundary === true);
  expect(boundaries.length).toBeGreaterThan(0);
  expect(boundaries.length).toBeLessThan(ROUNDS);
  // And observable, which is the fix: past the cap a crash resumes from a
  // checkpoint that is no longer near the crash, and the log now says when
  // that became true instead of simply having no more rows.
  const notices = manager
    .getEvents(parent, 1)
    .filter((e) => e.event.type === "delegation_notice")
    .map((e) => e.event.payload as Record<string, unknown>);
  expect(notices).toHaveLength(1); // once per run, not once per boundary
  expect(notices[0]!.reason).toBe("boundary_budget");
  expect(String(notices[0]!.message)).toContain("resumes from the last checkpoint at");
  expect(String(notices[0]!.lastCheckpointAt)).toBe(String(boundaries.at(-1)!.at));
  // The final save carries the same fact, for a reader holding only the checkpoint.
  const final = rows.at(-1)!;
  expect(final.atBoundary).toBeUndefined();
  expect(final.boundaryBudgetExhausted).toMatchObject({
    lastCheckpointAt: String(boundaries.at(-1)!.at),
  });
  manager.close();
});

test("G10 — a boundary save that throws does not take the child down with it", async () => {
  const { manager, dir } = sessionsAt("rune-g10c-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  let saves = 0;
  const brittle = new DelegatedSessions({
    appendEvent: (_sid: string, event: { type: string }) => {
      if (event.type !== "delegation_checkpoint") return 0;
      saves++;
      throw new Error("disk went away");
    },
    getLatestKeyedEvent: () => null,
  } as unknown as SessionManager);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  const out = await withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      messages.push(say("one"));
      checkpointDelegated();
      messages.push(say("two"));
      checkpointDelegated();
    }),
    "task",
    brittle,
  ).execute({
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput);

  // The first boundary failed and the second was not even attempted; the child
  // still finished, and the FINAL save is the one allowed to report the fault.
  expect(saves).toBe(2); // one boundary, then the final save
  expect(out.success).toBe(false);
  expect(out.error).toContain("resume checkpoint could not be saved");
  manager.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// G11 — a resumed child inherits what it already spent.
// ─────────────────────────────────────────────────────────────────────────────

test("G11 — the checkpoint carries spend, and a resume seeds from it instead of restarting the clock", async () => {
  const { manager, dir } = sessionsAt("rune-g11-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const store = new DelegatedSessions(manager);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  let spent = 0;
  let turns = 0;
  let seeded: unknown;

  const tool = withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      // Captured once, exactly as worker.ts and subagent.ts do: the reader runs
      // after the child's async context is gone, so it must close over the seed
      // rather than look it up again.
      const prior = delegatedBudgetSeed();
      seeded = prior;
      const state = resumeBudgetState(prior);
      bindDelegatedBudget(() => ({
        spentUsd: state.spentUsd + spent,
        elapsedMs: Date.now() - state.startedAt,
        turnsUsed: (prior?.turnsUsed ?? 0) + turns,
      }));
      spent = 0.25;
      turns = 3;
    }),
    "task",
    store,
  );
  const base = {
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput;

  const first = await tool.execute(base);
  const taskId = first.structured!.task_id as string;
  const after = checkpointsOf(manager, parent).at(-1)!;
  expect(after.budget).toMatchObject({ spentUsd: 0.25, turnsUsed: 3 });

  // The follow-up sees what the first run spent, and adds to it.
  const second = await tool.execute({
    ...base,
    callId: "c2",
    args: { prompt: "more", task_id: taskId },
  } as unknown as ToolCallInput);
  expect(second.success).toBe(true);
  expect(seeded).toMatchObject({ spentUsd: 0.25, turnsUsed: 3 });
  const resumed = checkpointsOf(manager, parent).at(-1)!;
  expect((resumed.budget as { spentUsd: number }).spentUsd).toBeCloseTo(0.5, 5);
  expect(resumed.budget).toMatchObject({ turnsUsed: 6 });
  manager.close();
});

test("G11 — a resumed child never gets a fresh ceiling: the elapsed clock carries", () => {
  // Real clock: checkBudget below reads Date.now() itself.
  const now = Date.now();
  const fresh = resumeBudgetState(undefined, now);
  expect(fresh).toEqual({ spentUsd: 0, startedAt: now });
  // Seeding backdates startedAt, so checkBudget's existing arithmetic measures
  // the TASK rather than this one call of it.
  const resumed = resumeBudgetState({ spentUsd: 1.5, elapsedMs: 90_000, turnsUsed: 4 }, now);
  expect(resumed).toEqual({ spentUsd: 1.5, startedAt: now - 90_000 });
  // Already over both ceilings on the first between-turn check.
  expect(checkBudget({ costCapUsd: 1.0, deadlineMs: null }, resumed)).toMatchObject({
    kind: "cost",
    spentUsd: 1.5,
  });
  expect(checkBudget({ costCapUsd: null, deadlineMs: 60_000 }, resumed)).toMatchObject({
    kind: "time",
  });
  // A fresh child with the same caps is admitted — the difference is the seed.
  expect(checkBudget({ costCapUsd: 1.0, deadlineMs: 60_000 }, fresh)).toBeNull();
  // Nonsense on the record never becomes a negative or NaN clock.
  expect(resumeBudgetState({ spentUsd: Number.NaN, elapsedMs: -5, turnsUsed: 0 }, now)).toEqual({
    spentUsd: 0,
    startedAt: now,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G12 — the resume lease is persisted, pid-owned, TTL'd and reaped.
// ─────────────────────────────────────────────────────────────────────────────

test("G12 — a second PROCESS is refused while the holder lives, and told how long and how to clear it", () => {
  const { manager, dir } = sessionsAt("rune-g12-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  // Two DelegatedSessions over one database stand in for two processes: the
  // in-memory Set never crossed that line, which is exactly the hole.
  const holder = new DelegatedSessions(manager);
  const other = new DelegatedSessions(manager, { pidAlive: () => true });
  const release = holder.claim(parent, "task_x");

  let refusal = "";
  try {
    other.claim(parent, "task_x");
  } catch (err) {
    refusal = String(err);
  }
  expect(refusal).toContain("already running");
  expect(refusal).toContain(String(process.pid));
  // What §6.2 requires the message to carry: who holds it, how much of the
  // hold is LEFT (not how long a hold may last), and how it clears.
  expect(refusal).toMatch(/expires in \d+ minutes/);
  expect(refusal).toContain("clears as soon as process");

  release();
  // Released: the same "other process" now takes it without waiting for the TTL.
  expect(() => other.claim(parent, "task_x")()).not.toThrow();
  manager.close();
});

test("G12 — a lease whose owner died is reaped on sight, not waited out", () => {
  const { manager, dir } = sessionsAt("rune-g12b-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const crashed = new DelegatedSessions(manager);
  crashed.claim(parent, "task_y"); // never released: the process was killed

  // A holder that still looks alive is honoured, unreleased lease and all.
  const stubborn = new DelegatedSessions(manager, { pidAlive: () => true });
  expect(() => stubborn.claim(parent, "task_y")).toThrow("already running");

  // Liveness first, TTL second — TeamBus.sweep's order, and the reason a crash
  // does not strand a task_id for half an hour.
  const recovered = new DelegatedSessions(manager, { pidAlive: () => false });
  expect(() => recovered.claim(parent, "task_y")()).not.toThrow();
  manager.close();
});

test("G12 — an expired lease is not honoured even when its owner still looks alive", async () => {
  const { manager, dir } = sessionsAt("rune-g12c-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const brief = new DelegatedSessions(manager, { leaseTtlMs: 5 });
  brief.claim(parent, "task_z"); // never released
  await new Promise((r) => setTimeout(r, 25));
  const later = new DelegatedSessions(manager, { pidAlive: () => true });
  expect(() => later.claim(parent, "task_z")()).not.toThrow();
  manager.close();
});

test("G12 — a recycled pid does not inherit the lease its predecessor held", () => {
  const { manager, dir } = sessionsAt("rune-g12d-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  // The holder records the start time of the process that took the lease.
  const holder = new DelegatedSessions(manager, { pidStart: () => "start-A" });
  holder.claim(parent, "task_r"); // never released: the process was killed

  // Where the OS will not say when a pid started, the lease is honoured:
  // refusing a live holder is recoverable, stealing its task is not.
  const blind = new DelegatedSessions(manager, { pidAlive: () => true, pidStart: () => null });
  expect(() => blind.claim(parent, "task_r")).toThrow("already running");

  // The pid is alive again — as something else entirely. Measured before this
  // fix: the lease was honoured for the full 30 minutes, and the process
  // holding a delegated task hostage was a `sleep 30`.
  const reused = new DelegatedSessions(manager, {
    pidAlive: () => true,
    pidStart: () => "start-B",
  });
  expect(() => reused.claim(parent, "task_r")()).not.toThrow();
  manager.close();
});

test("G12 — a lease taken on another machine is never cleared by a local pid probe", () => {
  const { manager, dir } = sessionsAt("rune-g12e-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const elsewhere = new DelegatedSessions(manager, { hostId: "build-box" });
  elsewhere.claim(parent, "task_h"); // still running over there

  // `process.kill(pid, 0)` is evidence about a LOCAL process. Judging a remote
  // holder by it is the dangerous direction of this failure: two machines then
  // resume one task_id and write checkpoints over each other.
  const here = new DelegatedSessions(manager, { hostId: "laptop", pidAlive: () => false });
  let refusal = "";
  try {
    here.claim(parent, "task_h");
  } catch (err) {
    refusal = String(err);
  }
  expect(refusal).toContain("already running");
  expect(refusal).toContain("build-box");
  expect(refusal).toMatch(/expires in \d+ minutes/);
  expect(refusal).toContain("cannot be judged from here");

  // Only the TTL clears it — the one bound that does not depend on being able
  // to see the holder.
  // 500 ms, not 5: on a Windows runner the SQLite write and read between the
  // two claims alone outlasted a 5 ms lease (CI run 36301706676), so the
  // "still running" half passed or failed on the disk's speed.
  const brief = new DelegatedSessions(manager, { hostId: "build-box", leaseTtlMs: 500 });
  brief.claim(parent, "task_h2");
  expect(() => here.claim(parent, "task_h2")).toThrow("already running");
  const start = Date.now();
  while (Date.now() - start < 600) {
    /* the TTL is 500 ms; this is the wait */
  }
  expect(() => here.claim(parent, "task_h2")()).not.toThrow();
  manager.close();
});

test("G12 — with no store the lease stays the in-process guard it always was", () => {
  const store = new DelegatedSessions();
  const release = store.claim("parent", "child");
  expect(() => store.claim("parent", "child")).toThrow("already running");
  release();
  expect(() => store.claim("parent", "child")()).not.toThrow();
});

// ── The director's rule on a child's turn ceiling ────────────────────────────
//
// Two resumes arrive through the same door — a `task_id` and a prompt — and
// they are different events. A crash-resume of a child that was still running
// inherits the turns the killed run spent; a follow-up on a child that already
// reported gets a fresh ceiling. The cost and wall-clock caps carry in both
// cases, so the ceiling is the only thing that differs.

test("turn ceiling — a crash-resume of an UNFINISHED child inherits the turns it spent", async () => {
  const { manager, dir } = sessionsAt("rune-turns-crash-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const ceilings: number[] = [];
  const seeds: Array<{ spentUsd: number; turnsUsed: number } | undefined> = [];

  // The durable shape a SIGKILL leaves: a boundary row written mid-run, and no
  // final row after it, because the process that would have written one is
  // gone. Reached here by a store that refuses the save on resolve — the same
  // end state, produced without killing the test runner.
  class CrashingStore extends DelegatedSessions {
    refuseFinal = false;
    override save(p: string, c: Checkpoint): void {
      if (this.refuseFinal && !c.atBoundary) throw new Error("the process died here");
      super.save(p, c);
    }
  }
  const store = new CrashingStore(manager);

  const tool = withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      const prior = delegatedBudgetSeed();
      seeds.push(prior ? { spentUsd: prior.spentUsd, turnsUsed: prior.turnsUsed } : undefined);
      bindDelegatedBudget(() => ({
        spentUsd: (prior?.spentUsd ?? 0) + 0.4,
        elapsedMs: 60_000,
        turnsUsed: (prior?.turnsUsed ?? 0) + 7,
      }));
      ceilings.push(delegatedTurnCeiling(12));
      messages.push(say("read src/a.ts"));
      checkpointDelegated();
    }),
    "task",
    store,
  );
  const base = {
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput;

  store.refuseFinal = true;
  const first = await tool.execute(base);
  // The child ran; only its terminal record is missing, exactly as after a kill.
  expect(first.success).toBe(false);
  const midRun = checkpointsOf(manager, parent).at(-1)!;
  expect(midRun.atBoundary).toBe(true);
  expect(midRun.status).toBeUndefined();
  expect(midRun.budget).toMatchObject({ turnsUsed: 7 });

  store.refuseFinal = false;
  const second = await tool.execute({
    ...base,
    callId: "c2",
    args: { prompt: "carry on", task_id: midRun.id as string },
  } as unknown as ToolCallInput);
  expect(second.success).toBe(true);

  // 12 fresh, then 12 - 7 = 5. And the spend and the clock came with it.
  expect(ceilings).toEqual([12, 5]);
  expect(seeds[1]).toMatchObject({ spentUsd: 0.4, turnsUsed: 7 });

  // A crash-resume that had already burned the whole ceiling still gets one
  // turn, so it can report rather than return an empty failure. Write the
  // boundary row a longer killed run would have left, and resume that.
  const killed: Record<string, unknown> = {
    ...midRun,
    atBoundary: true,
    budget: { spentUsd: 0.4, elapsedMs: 60_000, turnsUsed: 99 },
  };
  manager.appendEvent(parent, {
    type: "delegation_checkpoint",
    payload: killed as unknown as Record<string, unknown>,
  });
  const floor = withDelegatedSessions(
    stubHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      ceilings.push(delegatedTurnCeiling(3));
    }),
    "task",
    store,
  );
  await floor.execute({
    ...base,
    callId: "c3",
    args: { prompt: "again", task_id: midRun.id as string },
  } as unknown as ToolCallInput);
  expect(ceilings.at(-1)).toBe(1);
  manager.close();
});

test("turn ceiling — a follow-up on a child that ENDED starts fresh, and the spend cap does not", async () => {
  const { manager, dir } = sessionsAt("rune-turns-followup-");
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const store = new DelegatedSessions(manager);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const ceilings: number[] = [];
  const seeds: Array<{ spentUsd: number; turnsUsed: number } | undefined> = [];

  // A child that ran out of turns: it ENDS, so the final save records how.
  const tool = withDelegatedSessions(
    {
      ...stubHandler(() => {}),
      execute: async (input) => {
        delegatedHistory({ provider: "anthropic", model: "m" });
        bindDelegatedLoop({ getMessages: () => messages });
        const prior = delegatedBudgetSeed();
        seeds.push(prior ? { spentUsd: prior.spentUsd, turnsUsed: prior.turnsUsed } : undefined);
        bindDelegatedBudget(() => ({
          spentUsd: (prior?.spentUsd ?? 0) + 0.3,
          elapsedMs: 120_000,
          turnsUsed: (prior?.turnsUsed ?? 0) + 8,
        }));
        ceilings.push(delegatedTurnCeiling(8));
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: "out of turns",
          structured: { stopReason: "max_turns", child: { status: "max_turns" } },
          durationMs: 1,
        };
      },
    },
    "task",
    store,
  );
  const base = {
    toolName: "task",
    callId: "c1",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput;

  const first = await tool.execute(base);
  const taskId = first.structured!.task_id as string;
  const ended = checkpointsOf(manager, parent).at(-1)!;
  expect(ended.atBoundary).toBeUndefined();
  expect(ended.status).toBe("max_turns");

  const second = await tool.execute({
    ...base,
    callId: "c2",
    args: { prompt: "one more thing", task_id: taskId },
  } as unknown as ToolCallInput);
  expect(second.success).toBe(true);

  // Fresh ceiling both times — a child resumed after max_turns with 8 - 8 = 0
  // turns could not take one, which is Lane W's objection and it is right.
  expect(ceilings).toEqual([8, 8]);
  // The cumulative caps did NOT reset: the follow-up starts from what the
  // first run spent.
  expect(seeds[1]).toMatchObject({ spentUsd: 0.3, turnsUsed: 8 });
  const after = checkpointsOf(manager, parent).at(-1)!;
  expect((after.budget as { spentUsd: number }).spentUsd).toBeCloseTo(0.6, 5);
  expect(after.budget).toMatchObject({ turnsUsed: 16 });
  manager.close();
});
