/**
 * M3 — the Engine hands the empty-completion decision to the controller, and a
 * restart does not hand back the allowance it already spent.
 *
 * Two halves, because the claim has two halves:
 *
 *   * **In process.** A real `Engine` with `[controller] authority = "E4"`
 *     writes one applied `decision` row per empty completion, into the same
 *     session log as every other row, and with the key absent writes none —
 *     with a byte-identical event stream either way (B4, B5, B7).
 *   * **Across processes.** A real `rune` child, a real `rune.db`, a scripted
 *     loopback server that kills the child when its third request arrives, and
 *     a resume. The resumed run gets its THIRD empty completion, not a fresh
 *     three (B3). Two controls: the same three empties in one process abandon
 *     at the same count, and the same kill with authority OFF does not
 *     abandon on the resumed run's first empty.
 *
 * **This file spends nothing.** The in-process half scripts the provider
 * object; the process half's only configured route is the loopback mock, in a
 * built environment with no credential of any provider in it.
 *
 * **The process half needs the sandbox off** — `Bun.serve({port: 0})` fails
 * with EADDRINUSE under the repository's restricted profile — and the native
 * tools binary, which it reports as a FAILURE rather than vanishing as a skip.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { AppliedDecisionRow } from "../../packages/orchestrator/src/arbiter";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { startMockModelServer, type MockModelServer } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";
import { UsageProvider } from "../helpers/usage-provider";

// ══════════════════════════════════════════════════════════════════════════
// In process — the rows the Engine writes
// ══════════════════════════════════════════════════════════════════════════

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-controller-e4-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "rune-controller-e4-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  });
  return dir;
}

function makeEngine(dir: string, authority?: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
    ...(authority ? { controller: { authority } } : {}),
  });
  cleanup.push(() => engine.close());
  return engine;
}

/** Two empty completions, then a plain answer: one nudge, one accept. */
const SCRIPT: ContentBlock[][] = [[], [], [{ type: "text", text: "Done." }]];

async function runEngine(authority?: string): Promise<{
  rows: Array<{ seq: number; event: { type: string; payload: Record<string, unknown> } }>;
  events: AgentTurnEvent[];
  session: string;
  dir: string;
}> {
  const dir = tempWorkspace();
  const engine = makeEngine(dir, authority);
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) => SCRIPT[index - 1] ?? [{ type: "text", text: "Done." }];
  const session = engine.createSession();
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(session, "read the config and summarise it")) {
    events.push(event);
  }
  const rows = (engine as unknown as Internals).sessions.getEvents(session, 1);
  return { rows, events, session, dir };
}

/**
 * The event stream with the two things that differ between ANY two runs taken
 * out: the session's own id and the temporary directory it ran in, plus the
 * clock. Nothing else is normalised — a nudge, a notice or a stop reason that
 * moved would still show.
 */
function fingerprint(run: { events: AgentTurnEvent[]; session: string; dir: string }): string {
  return JSON.stringify(run.events)
    .split(run.session)
    .join("<session>")
    .split(run.dir)
    .join("<workspace>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<at>");
}

const appliedOf = (
  rows: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): AppliedDecisionRow[] =>
  rows
    .filter((r) => r.event.type === "decision")
    .map((r) => r.event.payload as unknown as AppliedDecisionRow);

describe("the Engine gives the controller the empty-completion decision", () => {
  test("B4 — with authority on, every empty completion leaves one applied row", async () => {
    const { rows, events } = await runEngine("E4");
    const applied = appliedOf(rows);
    expect(applied.length).toBe(2);
    expect(new Set(applied.map((d) => d.eventId)).size).toBe(2);
    for (const d of applied) {
      expect(d.applied).toBe(true);
      expect(d.guard).toBe("E4");
      expect(d.class).toBe(3);
      // The run id is the Engine's own, so an event id is unique across the
      // resumes of one session rather than restarting at 1 every run.
      expect(d.runId).toContain("#");
    }
    expect(applied.map((d) => d.transition)).toEqual(["working", "working"]);
    // The run still finished, and the shadow lane still watched it.
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(rows.some((r) => r.event.type === "shadow_summary")).toBe(true);
  });

  test("B5 / B7 — with authority off the log and the events are the same, minus the rows", async () => {
    const off = await runEngine();
    const on = await runEngine("E4");
    expect(appliedOf(off.rows)).toEqual([]);
    // Every row type, in order, ignoring the new rows themselves: a
    // permission, safety, cost, contract or verdict row that moved would show
    // up here, and none does.
    const shape = (rows: typeof off.rows) =>
      rows.map((r) => r.event.type).filter((t) => t !== "decision");
    expect(shape(on.rows)).toEqual(shape(off.rows));
    expect(fingerprint(on)).toBe(fingerprint(off));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Across processes — B3, on the real SIGKILL rig
// ══════════════════════════════════════════════════════════════════════════

interface Rig {
  dir: string;
  fixture: S.Fixture;
  home: S.ScratchHome;
  server: MockModelServer;
}

let root = "";
let toolsBin = "";
const rigs: Rig[] = [];
const runs: S.Run[] = [];

/** `[controller] authority = "E4"`, written into the child's own config. */
const AUTHORITY_CONFIG = '[controller]\nauthority = "E4"';

function makeRig(
  name: string,
  lead: Parameters<typeof startMockModelServer>[0]["script"]["lead"],
  authority: boolean,
): Rig {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fixture = S.makeFixture(dir);
  const server = startMockModelServer({ script: { lead }, model: "fake-model" });
  const home = S.makeScratchHome(dir, {
    baseUrl: server.baseUrl,
    model: "fake-model",
    maxTurns: 12,
    team: false,
    ...(authority ? { extraConfig: AUTHORITY_CONFIG } : {}),
  });
  const rig = { dir, fixture, home, server };
  rigs.push(rig);
  return rig;
}

function start(rig: Rig, prompt: string, resume?: string): S.Run {
  const run = S.spawnRun({
    home: rig.home,
    fixture: rig.fixture,
    toolsBin,
    prompt,
    ...(resume ? { resume } : {}),
  });
  rig.server.attach(run.proc);
  runs.push(run);
  return run;
}

const EMPTY = { kind: "empty" as const };
const PROMPT = "Summarise src/api.ts. Do not change anything.";

/** Applied E4 decisions in a session log, oldest first. */
function appliedRows(dbPath: string, sessionId: string): AppliedDecisionRow[] {
  return S.readEvents(dbPath, sessionId)
    .filter((r) => r.type === "decision")
    .map((r) => r.payload as unknown as AppliedDecisionRow);
}

function stopReasons(dbPath: string, sessionId: string): string[] {
  return S.readEvents(dbPath, sessionId)
    .filter((r) => r.type === "run_trace" && r.payload.type === "turn_complete")
    .map((r) => String(r.payload.stopReason));
}

let killedRun: {
  rig: Rig;
  sessionId: string;
  afterKill: AppliedDecisionRow[];
  rowsAfterKill: S.SessionEventRow[];
} | null = null;
let resumedStopReasons: string[] = [];
let resumedRequests = 0;
let controlRequests = 0;
let controlStopReasons: string[] = [];
let rollbackRequests = 0;

beforeAll(() => {
  toolsBin = S.requireNativeBinary();
  root = mkdtempSync(join(tmpdir(), "rune-controller-e4-proc-"));
});

afterAll(() => {
  for (const run of runs) run.kill("SIGKILL");
  for (const rig of rigs) rig.server.stop();
  if (root) rmTemp(root);
});

describe("B3 — a SIGKILL does not hand the allowance back", () => {
  test("the scenario runs: two empty completions, a kill, a resume, and a third", async () => {
    // Entries 1 and 2 are answered empty; the kill lands when the child asks
    // for its third step, so the two decisions are on disk and the act that
    // would have followed the third never happened.
    const rig = makeRig("killed", [EMPTY, EMPTY, { kind: "kill", signal: "SIGKILL" }, EMPTY], true);
    const runA = start(rig, PROMPT);
    const codeA = await runA.wait(120_000);
    expect(codeA).toBe(137);

    const sessions = S.listSessions(rig.home.dbPath);
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0]!.id;
    const afterKill = appliedRows(rig.home.dbPath, sessionId);
    // Read as the kill left it: every assertion about the killed run is about
    // THIS snapshot, not about the log after the resume wrote to it.
    const rowsAfterKill = S.readEvents(rig.home.dbPath, sessionId);
    killedRun = { rig, sessionId, afterKill, rowsAfterKill };

    // ── the resume ──
    rig.server.scriptFrom("lead", 4);
    const before = rig.server.countOf("lead");
    const runB = start(rig, "Carry on.", sessionId);
    await runB.wait(120_000);
    resumedRequests = rig.server.countOf("lead") - before;
    resumedStopReasons = stopReasons(rig.home.dbPath, sessionId);
  }, 300_000);

  test("the killed run left its decisions on disk, written before their acts", () => {
    const state = killedRun!;
    expect(state.afterKill.map((d) => d.transition)).toEqual(["working", "working"]);
    for (const d of state.afterKill) {
      expect(d.applied).toBe(true);
      expect(d.guard).toBe("E4");
    }
    // The kill landed before the third answer: the killed run wrote no
    // terminal row, which is what makes the resumed run's re-act necessary
    // and what `hasTerminalRow` reads.
    expect(
      state.rowsAfterKill.some((r) => r.type === "run_trace" && r.payload.type === "turn_complete"),
    ).toBe(false);
    // …and no `session_ended`: the signature `previousRunWasInterrupted` reads.
    expect(
      state.rowsAfterKill.some(
        (r) => r.type === "checkpoint" && r.payload.summary === "session_ended",
      ),
    ).toBe(false);
  });

  test("the resumed run abandons on its FIRST empty completion — the third overall", () => {
    const state = killedRun!;
    const all = appliedRows(state.rig.home.dbPath, state.sessionId);
    expect(all.length).toBe(3);
    expect(all.map((d) => d.transition)).toEqual(["working", "working", "abandoned(environment)"]);
    // The third decision saw the inherited count, not a fresh one.
    expect(all[2]!.inputs.emptyCompletions).toBe(3);
    expect(resumedStopReasons.at(-1)).toBe("provider_lost");
    // One model call: it did not buy three more.
    expect(resumedRequests).toBe(1);
  });

  test("the control: the same three empties in ONE process abandon at the same count", async () => {
    const rig = makeRig("control", [EMPTY, EMPTY, EMPTY, EMPTY], true);
    const run = start(rig, PROMPT);
    await run.wait(120_000);
    const sessionId = S.listSessions(rig.home.dbPath)[0]!.id;
    controlRequests = rig.server.countOf("lead");
    controlStopReasons = stopReasons(rig.home.dbPath, sessionId);
    const all = appliedRows(rig.home.dbPath, sessionId);
    expect(all.map((d) => d.transition)).toEqual(["working", "working", "abandoned(environment)"]);
    expect(controlRequests).toBe(3);
    expect(controlStopReasons.at(-1)).toBe("provider_lost");
  }, 180_000);

  test("the rollback control: with authority off the resumed run gets a fresh three", async () => {
    const rig = makeRig(
      "rollback",
      [EMPTY, EMPTY, { kind: "kill", signal: "SIGKILL" }, EMPTY, EMPTY, EMPTY],
      false,
    );
    const runA = start(rig, PROMPT);
    expect(await runA.wait(120_000)).toBe(137);
    const sessionId = S.listSessions(rig.home.dbPath)[0]!.id;
    // No authority, no rows: the guard decided, exactly as at b5632fb.
    expect(appliedRows(rig.home.dbPath, sessionId)).toEqual([]);

    rig.server.scriptFrom("lead", 4);
    const before = rig.server.countOf("lead");
    const runB = start(rig, "Carry on.", sessionId);
    await runB.wait(120_000);
    rollbackRequests = rig.server.countOf("lead") - before;
    // Three of its own before it abandons — the allowance was reset, which is
    // the behaviour the switch rolls back TO.
    expect(rollbackRequests).toBe(3);
    expect(stopReasons(rig.home.dbPath, sessionId).at(-1)).toBe("provider_lost");
    expect(resumedRequests).toBeLessThan(rollbackRequests);
  }, 300_000);
});
