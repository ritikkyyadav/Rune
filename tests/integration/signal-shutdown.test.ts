/**
 * T1 — what `rune` does when it is told to stop.
 *
 * SIGTERM is not a crash and not a cancel. It is the machine shutting down, a
 * harness's wall limit, a supervisor's `kill`: the work was interrupted, and
 * what the process owes is to stop what it started, keep what it had
 * acknowledged, and leave a run the next process can continue.
 *
 * It used to `engine.close()` and `process.exit(143)` on the spot. That was
 * fast, and it left three things undone:
 *
 *   · the run in flight was never told. Nothing wrote how it ended, a check
 *     being replayed kept its worktree registered in the user's repository,
 *     and whatever the engine itself had spawned was reaped only if an exit
 *     hook happened to know about it;
 *   · a cited check being replayed on the parent commit ran through a BLOCKING
 *     spawn, so for as long as that check took the process could not even
 *     hear the signal;
 *   · SIGINT in a headless run had no handler at all.
 *
 * The real CLI, the native tools, a loopback model that is scripted. Every
 * process a scenario starts carries a marker, and "no orphans" is read off the
 * process table.
 *
 * Zero live model calls.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previousRunWasInterrupted } from "../../packages/orchestrator/src/lifecycle";
import {
  startMockModelServer,
  type MockAction,
  type MockModelServer,
} from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

/** The longest a signalled process may take to be gone. The card's number. */
const EXIT_WITHIN_MS = 10_000;

const DONE_WHEN = ["node check.mjs exits 0"];

function tool(name: string, args: Record<string, unknown>): MockAction {
  return { kind: "tools", calls: [{ name, args }] };
}

const READ_BACK = tool("read_back", {
  reading: "You want a version() endpoint on the api.",
  touch: ["src/api.ts"],
  leave: ["src/notes.md — your untracked notes"],
  done_when: DONE_WHEN,
});
const PLAN = (first: string, second: string) =>
  tool("todo_write", {
    items: [
      { content: "add version() to src/api.ts", kind: "change", status: first },
      { content: "run the long job", kind: "verify", status: second },
    ],
  });
const EDIT_API = tool("edit_file", {
  path: "src/api.ts",
  old_text: '    hello: () => "hello",',
  new_text: '    hello: () => "hello",\n    version: () => "1.0.0",',
});

interface Rig {
  fixture: S.Fixture;
  home: S.ScratchHome;
  server: MockModelServer;
}

let root = "";
let toolsBin = "";
const rigs: Rig[] = [];
const runs: S.Run[] = [];
const markers: string[] = [];

function makeRig(name: string, lead: MockAction[]): Rig {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fixture = S.makeFixture(dir);
  const server = startMockModelServer({
    script: { lead, utility: [{ kind: "text", text: "ok" }] },
    model: "fake-model",
    childMarker: "SIGNAL-SCENARIO-NO-CHILD",
  });
  const home = S.makeScratchHome(dir, { baseUrl: server.baseUrl, model: "fake-model" });
  const rig = { fixture, home, server };
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

/** Signal the run and wait for it to be gone; how it exited and how long that took. */
async function stop(run: S.Run, signal: NodeJS.Signals, where: string) {
  const sentAt = performance.now();
  run.kill(signal);
  const code = await run.wait(60_000);
  const tookMs = performance.now() - sentAt;
  // The measurement itself, in the log: the assertion only says "under ten seconds".
  console.log(`${signal} ${where}: exit ${code} after ${Math.round(tookMs)} ms`);
  return { code, tookMs };
}

const checkpoints = (rows: S.SessionEventRow[]) =>
  rows.filter((r) => r.type === "checkpoint").map((r) => r.payload as Record<string, unknown>);

/** `previousRunWasInterrupted` takes the engine's own row shape. */
const asEvents = (rows: S.SessionEventRow[]) =>
  rows.map((r) => ({ event: { type: r.type, payload: r.payload as Record<string, unknown> } }));

beforeAll(() => {
  toolsBin = S.requireNativeBinary();
  root = mkdtempSync(join(tmpdir(), "rune-signal-"));
});

afterAll(() => {
  for (const run of runs) run.kill("SIGKILL");
  for (const rig of rigs) rig.server.stop();
  for (const marker of markers) S.killMatching(marker);
  if (root) rmTemp(root);
});

// ══════════════════════════════════════════════════════════════════════════
// A — the signal lands inside a tool call, after a write the run acknowledged.
// ══════════════════════════════════════════════════════════════════════════

for (const [signal, exitCode] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  describe(`${signal} inside a tool call`, () => {
    const MARKER = `SIGNAL-LONG-${signal}-3e7a`;
    markers.push(MARKER);
    let rig: Rig;
    let stopped: { code: number; tookMs: number } | null = null;
    let leftRunning: string[] = [];
    let sessionId = "";
    let rows: S.SessionEventRow[] = [];
    let runA: S.Run | null = null;
    let runB: S.Run | null = null;

    test("the scenario runs: a write is acknowledged, a command is running, the signal lands", async () => {
      rig = makeRig(`in-tool-${signal.toLowerCase()}`, [
        READ_BACK,
        PLAN("in_progress", "pending"),
        tool("read_file", { path: "src/api.ts" }),
        EDIT_API,
        PLAN("completed", "in_progress"),
        tool("bash", { command: `node long.mjs ${MARKER} 40` }),
        // ── the process that resumes picks up here ──
        { kind: "text", text: "The long job was interrupted; I have not re-run it." },
      ]);
      const run = start(rig, "Add a version() endpoint to src/api.ts, then run the long job.");
      runA = run;
      await run.waitForEvent((e) => JSON.stringify(e).includes(MARKER), {
        timeoutMs: 120_000,
        label: "the long-running bash call",
      });
      expect(
        (await S.waitForProcess(MARKER, { attempts: 80, delayMs: 100 })).length,
      ).toBeGreaterThan(0);

      stopped = await stop(run, signal, "inside a tool call");
      leftRunning = await S.waitForNoProcess(MARKER, { attempts: 8, delayMs: 250 });

      const sessions = S.listSessions(rig.home.dbPath);
      expect(sessions).toHaveLength(1);
      sessionId = sessions[0]!.id;
      rows = S.readEvents(rig.home.dbPath, sessionId);

      rig.server.scriptFrom("lead", 7);
      runB = start(rig, "Continue.", sessionId);
      expect([0, 1]).toContain(await runB.wait(120_000));
    }, 240_000);

    test(`it exits ${exitCode}, inside ten seconds`, () => {
      expect(stopped?.code).toBe(exitCode);
      expect(stopped!.tookMs).toBeLessThan(EXIT_WITHIN_MS);
    });

    test("no orphan processes: the command it was running is gone with it", () => {
      expect(leftRunning).toEqual([]);
      expect(S.matchingProcesses(`rune-tools --workspace ${rig.fixture.root}`)).toEqual([]);
    });

    test("acknowledged progress is kept: the write is on disk and its result is on the log", () => {
      expect(readFileSync(join(rig.fixture.root, "src", "api.ts"), "utf8")).toContain(
        'version: () => "1.0.0"',
      );
      const results = rows.filter((r) => r.type === "tool_result");
      expect(results.length).toBeGreaterThanOrEqual(3);
      // The spine the next process restores says the first step was done.
      const todos = S.todosOf(S.latestTaskState(rows));
      expect(todos[0]?.status).toBe("completed");
    });

    test("the run is left INTERRUPTED, and the log says by what", () => {
      // Not `session_ended`: that is a run that finished, and the next one
      // would start fresh. This one was stopped with work open.
      expect(previousRunWasInterrupted(asEvents(rows))).toBe(true);
      expect(checkpoints(rows).map((c) => c.summary)).not.toContain("session_ended");
      const interrupted = checkpoints(rows).filter((c) => c.summary === "session_interrupted");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]!.signal).toBe(signal);
    });

    test("the caller is told how it ended: an envelope on stdout, then the signal's exit code", () => {
      // A harness that stops a run at its wall limit gets what the run did,
      // not an empty stdout it has to treat as a crash.
      const envelope = runA?.envelope();
      expect(envelope?.ok).toBe(false);
      expect(envelope?.stopReason).toBe("aborted");
      expect(envelope?.filesChanged).toContain("src/api.ts");
    });

    test("how it ended is on the log: a terminal row, not silence", () => {
      const traces = rows.filter(
        (r) => r.type === "run_trace" && r.payload.type === "turn_complete",
      );
      expect(traces).toHaveLength(1);
      expect(traces[0]!.payload.stopReason).toBe("aborted");
    });

    test("the next process continues it: the criteria are still in force and nothing is redone", () => {
      const after = S.readEvents(rig.home.dbPath, sessionId);
      const contract = after.filter((r) => r.type === "contract").at(-1)!.payload as {
        contract?: { criteria?: Array<{ text?: string }> };
      };
      expect((contract.contract?.criteria ?? []).map((c) => c.text)).toEqual(DONE_WHEN);
      // The engine replayed nothing by itself: one edit on disk, no long job.
      const api = readFileSync(join(rig.fixture.root, "src", "api.ts"), "utf8");
      expect(api.split('version: () => "1.0.0"').length - 1).toBe(1);
      expect(S.matchingProcesses(MARKER)).toEqual([]);
      expect(runB?.envelope()?.text).toContain("interrupted");
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// B — the signal lands while the model is still answering.
// ══════════════════════════════════════════════════════════════════════════

describe("SIGTERM while the model is answering", () => {
  let stopped: { code: number; tookMs: number } | null = null;
  let rows: S.SessionEventRow[] = [];

  test("the scenario runs: a request is held open, and the signal lands in it", async () => {
    const rig = makeRig("in-stream", [{ kind: "hang", ms: 60_000 }]);
    const run = start(rig, "Say hello.");
    await rig.server.waitForRole("lead", 1, 120_000);
    stopped = await stop(run, "SIGTERM", "while the model is answering");
    rows = S.readEvents(rig.home.dbPath, S.listSessions(rig.home.dbPath)[0]!.id);
  }, 180_000);

  test("it exits 143, inside ten seconds, and the run is left interrupted", () => {
    expect(stopped?.code).toBe(143);
    expect(stopped!.tookMs).toBeLessThan(EXIT_WITHIN_MS);
    expect(previousRunWasInterrupted(asEvents(rows))).toBe(true);
    expect(checkpoints(rows).map((c) => c.summary)).toContain("session_interrupted");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C — the signal lands while a cited check is being replayed on the commit.
// ══════════════════════════════════════════════════════════════════════════

describe("SIGTERM while a cited check is being replayed", () => {
  const MARKER = "SIGNAL-REPLAY-8d21";
  markers.push(MARKER);
  /**
   * Fast where the run made `fast.flag`, and twenty-five seconds where it did
   * not — which is the commit the check is replayed on.
   */
  const SLOW_CHECK = `import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(here, "fast.flag"))) {
  console.log("1 pass, 0 fail");
  process.exit(0);
}
await new Promise((resolve) => setTimeout(resolve, 25_000));
console.log("0 pass, 1 fail");
process.exit(1);
`;
  let rig: Rig;
  let stopped: { code: number; tookMs: number } | null = null;
  let leftRunning: string[] = [];

  test("the scenario runs: the check is cited, its replay is running, the signal lands", async () => {
    rig = makeRig("in-replay", [
      tool("read_back", {
        reading: "You want the slow check to pass.",
        touch: ["fast.flag"],
        leave: ["src/notes.md — your untracked notes"],
        done_when: [`node check-slow.mjs ${MARKER} exits 0`],
      }),
      tool("write_file", { path: "fast.flag", content: "fast\n" }),
      tool("bash", { command: `node check-slow.mjs ${MARKER}` }),
      tool("record_evidence", { criterion: 0, command: `node check-slow.mjs ${MARKER}` }),
      { kind: "text", text: "Done." },
    ]);
    // The check is part of the repository: committed, so it is on the commit
    // the replay checks out.
    writeFileSync(join(rig.fixture.root, "check-slow.mjs"), SLOW_CHECK);
    for (const args of [
      ["add", "check-slow.mjs"],
      ["-c", "user.name=Scenario", "-c", "user.email=scenario@localhost", "commit", "-m", "check"],
    ]) {
      Bun.spawnSync(["git", ...args], { cwd: rig.fixture.root, stdout: "pipe", stderr: "pipe" });
    }

    const run = start(rig, "Make the slow check pass and cite it.");
    await run.waitForEvent(
      (e) => e.type === "tool_call_start" && JSON.stringify(e).includes("record_evidence"),
      { timeoutMs: 120_000, label: "the record_evidence call" },
    );
    // The replay is the only one of its runs that is still there a moment later.
    expect(
      (await S.waitForProcess(MARKER, { attempts: 100, delayMs: 100 })).length,
    ).toBeGreaterThan(0);

    stopped = await stop(run, "SIGTERM", "while a cited check is replayed");
    leftRunning = await S.waitForNoProcess(MARKER, { attempts: 8, delayMs: 250 });
  }, 240_000);

  test("it exits 143 inside ten seconds: the replay does not hold the process", () => {
    expect(stopped?.code).toBe(143);
    expect(stopped!.tookMs).toBeLessThan(EXIT_WITHIN_MS);
    // And not by running out the grace period: the replay heard the cancel.
    expect(stopped!.tookMs).toBeLessThan(4_000);
  });

  test("no orphan processes: the replayed check is gone with it", () => {
    expect(leftRunning).toEqual([]);
  });

  test("nothing is left in the user's repository: no worktree stays registered", () => {
    const listed = S.gitWorktrees(rig.fixture.root);
    expect(listed).toHaveLength(1);
    expect(listed.join("\n")).not.toContain("rune-parent-check");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D — killed, not stopped: inside a command that has already done something.
// ══════════════════════════════════════════════════════════════════════════

describe("SIGKILL inside a command that has already had its effect", () => {
  const MARKER = "SIGNAL-APPEND-5b90";
  markers.push(MARKER);
  /** Appends one line — the thing that must not happen twice — and then stays alive. */
  const APPEND_THEN_WAIT = `import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(here, "effects.log"), "published\\n");
await new Promise((resolve) => setTimeout(resolve, 40_000));
`;
  let rig: Rig;
  let effects = "";
  let code = 0;
  let rowsAfterKill: S.SessionEventRow[] = [];

  test("the scenario runs: the effect lands, the process is killed, another one resumes", async () => {
    rig = makeRig("killed-in-effect", [
      tool("bash", { command: `node append-then-wait.mjs ${MARKER}` }),
      // ── the process that resumes picks up here ──
      { kind: "text", text: "It had already been published; I did not repeat it." },
    ]);
    writeFileSync(join(rig.fixture.root, "append-then-wait.mjs"), APPEND_THEN_WAIT);
    effects = join(rig.fixture.root, "effects.log");

    const run = start(rig, "Publish it.");
    expect(
      (await S.waitForProcess(MARKER, { attempts: 300, delayMs: 100 })).length,
    ).toBeGreaterThan(0);
    // The effect is on disk before the kill: this is a command that RAN.
    for (let i = 0; i < 100 && S.countLines(effects) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(S.countLines(effects)).toBe(1);

    run.kill("SIGKILL");
    code = await run.wait(30_000);
    await S.waitForNoProcess(MARKER, { attempts: 24, delayMs: 250 });

    const sessionId = S.listSessions(rig.home.dbPath)[0]!.id;
    rowsAfterKill = S.readEvents(rig.home.dbPath, sessionId);
    rig.server.scriptFrom("lead", 2);
    const runB = start(rig, "Continue.", sessionId);
    expect([0, 1]).toContain(await runB.wait(120_000));
  }, 240_000);

  test("it was a kill: 137, and nothing was written on the way down", () => {
    expect(code).toBe(137);
  });

  test("the call is on the log before it runs: a kill inside it leaves the call, and no result", () => {
    // Nothing is yielded between the model's call and the tool's return, so
    // this row used to be written only afterwards — and a kill in between
    // left no record that the command had been issued at all.
    const calls = rowsAfterKill
      .filter((r) => r.type === "assistant_msg")
      .map((r) => JSON.stringify(r.payload));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("append-then-wait.mjs");
    expect(rowsAfterKill.filter((r) => r.type === "tool_result")).toEqual([]);
  });

  test("the effect happened exactly once: resuming repeated nothing by itself", () => {
    expect(S.countLines(effects)).toBe(1);
    expect(S.matchingProcesses(MARKER)).toEqual([]);
  });

  test("the next process is told what is known about the call that never returned", () => {
    const resumed = rig.server.matching((r) => r.role === "lead").at(-1)!;
    expect(resumed.raw).toContain(
      "No result was recorded: the previous Rune run ended before bash returned.",
    );
    expect(resumed.raw).toContain("It may not have run, or it may have run in part or in full.");
    // Not that it did not run, and not to run it again.
    expect(resumed.raw).not.toContain("Not executed: the previous Rune run ended");
    expect(resumed.raw).not.toContain("Re-run it if the result is still needed");
  });
});
