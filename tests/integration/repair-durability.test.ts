/**
 * M4 exit R4 — a repair limit survives a SIGKILL.
 *
 * The claim M4 makes about its limits is that they are **shared and durable**:
 * "attempts and repair turns are counted on the run's `decision` rows, so a
 * restart continues the count" (`docs/program/m4-repair-and-delegation.md`).
 * A count held in a local survives nothing, and a count read from a projection
 * is only as fresh as its last emission — which is a turn stale at exactly the
 * kill the rule exists for. So it is read from the run's OWN `decision` rows,
 * which are written BEFORE their acts.
 *
 * Proved here on the real rig: real `rune` children, a real `rune.db`, a
 * scripted loopback server that kills the child mid-request, and a resume.
 * Four runs, because a durability claim needs its controls:
 *
 *   killed    one nudge spent, then SIGKILL — the row is on disk, no terminal
 *   resumed   the nudge is NOT handed back; the first rut ends the run
 *   control   the same script in ONE process, no kill — the same shape
 *   rollback  the same kill with the key ABSENT — a fresh nudge, as before
 *
 * The class driven here is `no_progress`, because it is the one repair class a
 * child process can be driven into deterministically with nothing but a
 * scripted model: `transport` needs the gateway's own 5xx ladder underneath it
 * (which retries with backoff before the loop ever counts one), `check_failed`
 * needs a project with a red check installed in the fixture, and `acceptance`
 * needs a staged `--acceptance` file. The DURABLE COUNTER is one mechanism for
 * all six — `inheritedRepairTurns` over the same `decision` rows — and the
 * other three classes' inheritance is pinned in
 * `tests/unit/orchestrator/repair-controller.test.ts` against the real loop.
 *
 * **This file spends nothing.** The only configured route is the loopback
 * mock, in a scratch home with no credential of any provider in it.
 *
 * **Needs the sandbox off** — `Bun.serve({port: 0})` fails with EADDRINUSE
 * under the repository's restricted profile — and the native tools binary,
 * which it reports as a FAILURE rather than vanishing as a skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppliedDecisionRow } from "../../packages/orchestrator/src/arbiter";
import { startMockModelServer, type MockModelServer } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

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

/** `[controller] authority = "no_progress"`, in the child's own config. */
const AUTHORITY_CONFIG = '[controller]\nauthority = "no_progress"';

/**
 * The rut: the same read, of the same file, with the same answer.
 *
 * The loop detector counts a repeat only when the write count AND the answer
 * are unchanged, so a read of a fixture file that nothing writes is the
 * shortest honest rut there is. The call id varies (see `MockToolCall.id`);
 * the SIGNATURE does not, which is what the detector reads.
 */
const READ_SAME = {
  kind: "tools" as const,
  calls: [{ name: "read_file", args: { path: "src/api.ts" } }],
};

const PROMPT = "Summarise src/api.ts. Do not change anything.";

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
    maxTurns: 16,
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

let killed: {
  rig: Rig;
  sessionId: string;
  afterKill: AppliedDecisionRow[];
  rowsAfterKill: S.SessionEventRow[];
} | null = null;
let resumedRequests = 0;
let resumedStopReasons: string[] = [];
let rollbackRequests = 0;

beforeAll(() => {
  toolsBin = S.requireNativeBinary();
  root = mkdtempSync(join(tmpdir(), "rune-repair-durability-"));
});

afterAll(() => {
  for (const run of runs) run.kill("SIGKILL");
  for (const rig of rigs) rig.server.stop();
  if (root) rmTemp(root);
});

describe("R4 — a repair limit survives a SIGKILL", () => {
  test("the scenario runs: a rut, one nudge, a kill, a resume, and a second rut", async () => {
    // Three identical calls make the detector fire; the nudge is entry 3's
    // answer. The kill lands when the child asks for its fourth step, so the
    // nudge's `decision` row is on disk and nothing after it happened.
    const rig = makeRig(
      "killed",
      [
        READ_SAME,
        READ_SAME,
        READ_SAME,
        { kind: "kill", signal: "SIGKILL" },
        READ_SAME,
        READ_SAME,
        READ_SAME,
      ],
      true,
    );
    const runA = start(rig, PROMPT);
    expect(await runA.wait(180_000)).toBe(137);

    const sessions = S.listSessions(rig.home.dbPath);
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0]!.id;
    killed = {
      rig,
      sessionId,
      afterKill: appliedRows(rig.home.dbPath, sessionId),
      rowsAfterKill: S.readEvents(rig.home.dbPath, sessionId),
    };

    rig.server.scriptFrom("lead", 5);
    const before = rig.server.countOf("lead");
    const runB = start(rig, "Carry on.", sessionId);
    await runB.wait(180_000);
    resumedRequests = rig.server.countOf("lead") - before;
    resumedStopReasons = stopReasons(rig.home.dbPath, sessionId);
  }, 420_000);

  test("the killed run spent its nudge and left the row, written before the act", () => {
    const state = killed!;
    const progress = state.afterKill.filter((d) => d.guard === "REPAIR_PROGRESS");
    expect(progress.length).toBe(1);
    expect(progress[0]!.transition).toBe("working");
    expect(progress[0]!.applied).toBe(true);
    expect(progress[0]!.class).toBe(5);
    // A failure has a type, and the ledger says which.
    expect(progress[0]!.inputs.repairClass).toBe("no_progress");
    expect(progress[0]!.inputs.nudges).toBe(0);
    // No terminal row and no `session_ended`: the kill ran no `finally`, which
    // is exactly the shape a projection would have been stale for.
    expect(
      state.rowsAfterKill.some((r) => r.type === "run_trace" && r.payload.type === "turn_complete"),
    ).toBe(false);
    expect(
      state.rowsAfterKill.some(
        (r) => r.type === "checkpoint" && r.payload.summary === "session_ended",
      ),
    ).toBe(false);
  });

  test("the resumed run is NOT handed the nudge back — its first rut ends it", () => {
    const state = killed!;
    const all = appliedRows(state.rig.home.dbPath, state.sessionId).filter(
      (d) => d.guard === "REPAIR_PROGRESS",
    );
    expect(all.map((d) => d.transition)).toEqual(["working", "abandoned(no_progress)"]);
    // The second decision SAW the inherited count rather than a fresh zero.
    expect(all[1]!.inputs.nudges).toBe(1);
    expect(resumedStopReasons.at(-1)).toBe("loop_detected");
    // Three calls to reach the rut again, and no fourth: it did not buy a
    // second nudge.
    expect(resumedRequests).toBe(3);
  });

  test("the control: the same script in ONE process spends one nudge and bails", async () => {
    const rig = makeRig(
      "control",
      [READ_SAME, READ_SAME, READ_SAME, READ_SAME, READ_SAME, READ_SAME, READ_SAME],
      true,
    );
    const run = start(rig, PROMPT);
    await run.wait(180_000);
    const sessionId = S.listSessions(rig.home.dbPath)[0]!.id;
    const all = appliedRows(rig.home.dbPath, sessionId).filter(
      (d) => d.guard === "REPAIR_PROGRESS",
    );
    expect(all.map((d) => d.transition)).toEqual(["working", "abandoned(no_progress)"]);
    expect(stopReasons(rig.home.dbPath, sessionId).at(-1)).toBe("loop_detected");
  }, 300_000);

  test("the rollback control: with the key ABSENT the resumed run gets a fresh nudge", async () => {
    const rig = makeRig(
      "rollback",
      [
        READ_SAME,
        READ_SAME,
        READ_SAME,
        { kind: "kill", signal: "SIGKILL" },
        READ_SAME,
        READ_SAME,
        READ_SAME,
        READ_SAME,
        READ_SAME,
        READ_SAME,
      ],
      false,
    );
    const runA = start(rig, PROMPT);
    expect(await runA.wait(180_000)).toBe(137);
    const sessionId = S.listSessions(rig.home.dbPath)[0]!.id;
    // No authority, no rows: the guard decided, exactly as it did before M4.
    expect(appliedRows(rig.home.dbPath, sessionId)).toEqual([]);

    rig.server.scriptFrom("lead", 5);
    const before = rig.server.countOf("lead");
    const runB = start(rig, "Carry on.", sessionId);
    await runB.wait(180_000);
    rollbackRequests = rig.server.countOf("lead") - before;
    expect(stopReasons(rig.home.dbPath, sessionId).at(-1)).toBe("loop_detected");
    // Six: three to reach the rut, a nudge, and three more to reach it again.
    // The allowance was reset, which is the behaviour the switch rolls back TO.
    expect(rollbackRequests).toBeGreaterThan(resumedRequests);
  }, 420_000);
});
