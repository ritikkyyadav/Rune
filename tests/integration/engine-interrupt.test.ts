/**
 * T1 — a run the process is stopping, at the engine.
 *
 * `Engine.interrupt` is what the CLI calls on SIGTERM. It cancels the run in
 * flight as a person's cancel does, and differs in one row: the run is left
 * `session_interrupted`, not `session_ended` — open on the log, so the next
 * process continues it instead of starting fresh.
 *
 * A real Engine, the native tools, a scripted model, and a command that is
 * really running when the stop arrives. The process-level half — a real
 * signal, exit codes, the process table — is `signal-shutdown.test.ts`.
 *
 * Zero live model calls. Needs the native tools binary.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import { Engine } from "../../packages/orchestrator/src/engine";
import { previousRunWasInterrupted } from "../../packages/orchestrator/src/lifecycle";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { UsageProvider } from "../helpers/usage-provider";

const native = resolveRuneToolsBinary();

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function fixture(): Engine {
  const dir = mkdtempSync(join(tmpdir(), "t1-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "t1-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    ["-c", "user.name=T1", "-c", "user.email=t1@localhost", "commit", "-m", "base"],
  ]) {
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  }
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: native.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `t1c${++callSeq}`,
  toolName: name,
  toolInput: args,
});
const say = (text: string): ContentBlock[] => [{ type: "text", text }];

/** A command that is still running long after anything here should have stopped it. */
const SLOW = [call("bash", { command: "sleep 30" })];

type Row = { event: { type: string; payload: Record<string, unknown> } };
const rowsOf = (engine: Engine, session: string): Row[] =>
  (
    engine as unknown as { sessions: { getEvents(id: string, from: number): Row[] } }
  ).sessions.getEvents(session, 0);
/** The rows that mark where a run begins and how it stopped — not the per-turn saves between. */
const checkpointsOf = (rows: Row[]) =>
  rows
    .filter((r) => r.event.type === "checkpoint")
    .map((r) => r.event.payload)
    .filter((payload) => String(payload.summary).startsWith("session_"));

/** One message. `onToolStart` is called when the first tool call begins to run. */
async function drive(
  engine: Engine,
  session: string,
  script: ContentBlock[][],
  onToolStart: () => void = () => {},
) {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) => script[index - 1] ?? say("Done.");
  const startedAt = performance.now();
  let stopReason: string | undefined;
  let asked = false;
  for await (const event of engine.chat(
    session,
    "Run the slow job.",
  ) as AsyncIterable<AgentTurnEvent>) {
    if (event.type === "tool_call_start" && !asked) {
      asked = true;
      // The command has been handed to the native executor; give it a moment to be running.
      setTimeout(onToolStart, 300);
    }
    if (event.type === "turn_complete") stopReason = event.stopReason;
  }
  return { stopReason, tookMs: performance.now() - startedAt };
}

describe.skipIf(!native.exists)("a run the process is stopping", () => {
  test("is cancelled like any other, and left OPEN on the log with what stopped it", async () => {
    const engine = fixture();
    const session = engine.createSession();
    let wound: Promise<void> | null = null;
    let rowsWhenWound: Row[] = [];
    const run = await drive(engine, session, [SLOW], () => {
      wound = engine.interrupt("SIGTERM").then(() => {
        rowsWhenWound = rowsOf(engine, session);
      });
    });
    await wound;

    // Cancelled: the thirty-second command did not hold it.
    expect(run.stopReason).toBe("aborted");
    expect(run.tookMs).toBeLessThan(10_000);

    const rows = rowsOf(engine, session);
    expect(checkpointsOf(rows).map((c) => c.summary)).toEqual([
      "session_started",
      "session_interrupted",
    ]);
    expect(checkpointsOf(rows).at(-1)).toMatchObject({ signal: "SIGTERM" });
    // Which is what the next process reads as "continue this one".
    expect(previousRunWasInterrupted(rows)).toBe(true);
    // And the promise resolved only once that row was written: a caller that
    // exits when it resolves leaves a log that says how the run ended.
    expect(checkpointsOf(rowsWhenWound).map((c) => c.summary)).toContain("session_interrupted");
  }, 60_000);

  test("a person's cancel still ENDS the run: the next message starts fresh", async () => {
    const engine = fixture();
    const session = engine.createSession();
    const run = await drive(engine, session, [SLOW], () => engine.abort());
    expect(run.stopReason).toBe("aborted");
    const rows = rowsOf(engine, session);
    expect(checkpointsOf(rows).map((c) => c.summary)).toEqual(["session_started", "session_ended"]);
    expect(previousRunWasInterrupted(rows)).toBe(false);
  }, 60_000);

  test("a signal is not counted as the person losing patience with the run", async () => {
    // The struggle detector counts a person's cancels within one run; a
    // shutdown is not one of them.
    const cancels = async (stop: (engine: Engine) => void): Promise<number> => {
      const engine = fixture();
      let counted = 0;
      (engine as unknown as { struggles: unknown }).struggles = new Proxy(
        {},
        { get: (_target, name) => (name === "onAbort" ? () => counted++ : () => {}) },
      );
      await drive(engine, engine.createSession(), [SLOW], () => stop(engine));
      return counted;
    };
    expect(await cancels((engine) => engine.abort())).toBe(1);
    expect(await cancels((engine) => void engine.interrupt("SIGTERM"))).toBe(0);
  }, 60_000);

  test("with nothing running there is nothing to wait for, and nothing is marked", async () => {
    const engine = fixture();
    const session = engine.createSession();
    const startedAt = performance.now();
    await engine.interrupt("SIGTERM");
    expect(performance.now() - startedAt).toBeLessThan(100);

    // A run that starts afterwards is an ordinary run.
    const run = await drive(engine, session, [say("Hello.")]);
    expect(run.stopReason).toBe("end_turn");
    expect(checkpointsOf(rowsOf(engine, session)).map((c) => c.summary)).toEqual([
      "session_started",
      "session_ended",
    ]);
  }, 60_000);

  test("the mark belongs to the run it stopped: the next run on the same engine ends normally", async () => {
    const engine = fixture();
    const session = engine.createSession();
    await drive(engine, session, [SLOW], () => void engine.interrupt("SIGHUP"));
    const run = await drive(engine, session, [say("Continuing.")]);
    expect(run.stopReason).toBe("end_turn");
    expect(checkpointsOf(rowsOf(engine, session)).map((c) => c.summary)).toEqual([
      "session_started",
      "session_interrupted",
      "session_started",
      "session_ended",
    ]);
  }, 60_000);
});
