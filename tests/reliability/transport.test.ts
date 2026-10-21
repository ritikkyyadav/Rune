/**
 * The yardstick's transport suite (R0.1 of
 * docs/program/rune-reliability-plan-20261014.md): faults injected at the
 * wire, against the REAL process — `rune -P` spawned from source, talking to
 * a scripted OpenAI-compatible model on a loopback port, with a scratch home
 * whose only route is that model. What is asserted is what a script would
 * see: the exit code, the envelope, and what the model was sent.
 *
 * Unit suites pin each mechanism (agent-loop-slept, agent-loop-stream-cut,
 * stream-reset, upgrade-cli, …); this one asks whether the run survives.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A fixture, a scratch home and a model that plays `lead` for the run. */
function rig(lead: MockAction[]) {
  const base = mkdtempSync(join(tmpdir(), "rune-reliability-"));
  dirs.push(base);
  const dir = join(base, "rig");
  mkdirSync(dir, { recursive: true });
  const fixture = S.makeFixture(dir);
  const toolsBin = S.requireNativeBinary();
  const server = startMockModelServer({
    model: "fake-model",
    script: {
      lead,
      summarizer: [{ kind: "text", text: "SUMMARY: nothing to keep." }],
      utility: [{ kind: "text", text: "ok" }],
    },
  });
  const home = S.makeScratchHome(dir, {
    baseUrl: server.baseUrl,
    model: "fake-model",
    maxTurns: 10,
  });
  return { base, fixture, toolsBin, server, home };
}

type Rig = ReturnType<typeof rig>;

function spawn(r: Rig, extra: Pick<S.RunOptions, "env" | "preload"> = {}) {
  const run = S.spawnRun({
    home: r.home,
    fixture: r.fixture,
    toolsBin: r.toolsBin,
    prompt: "Say hello in one sentence.",
    ...extra,
  });
  r.server.attach(run.proc);
  return run;
}

async function finish(r: Rig, run: S.Run) {
  try {
    const code = await run.wait(120_000);
    return {
      code,
      envelope: run.envelope(),
      lead: r.server.requests.filter((q) => q.role === "lead"),
    };
  } finally {
    r.server.stop();
  }
}

const runOnce = (r: Rig) => finish(r, spawn(r));

async function until(check: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((res) => setTimeout(res, 25));
  }
}

const CLOCK_JUMP_PRELOAD = join(import.meta.dir, "clock-jump-preload.ts");

describe("faults at the wire, through the real process", () => {
  test("a response cut mid-stream is sent again, and the run finishes", async () => {
    const r = rig([
      { kind: "cut", text: "An answer that the connection drops half way through." },
      { kind: "text", text: "The whole answer, sent again." },
    ]);
    const { code, envelope, lead } = await runOnce(r);
    expect(code).toBe(0);
    expect(envelope?.text).toContain("The whole answer, sent again.");
    expect(lead).toHaveLength(2);
  }, 180_000);

  test("an overloaded host's 529 with Retry-After is waited out", async () => {
    const r = rig([
      { kind: "status", status: 529, retryAfterSec: 1, message: "Overloaded" },
      { kind: "text", text: "Answered after the wait." },
    ]);
    const { code, envelope, lead } = await runOnce(r);
    expect(code).toBe(0);
    expect(envelope?.text).toContain("Answered after the wait.");
    expect(lead).toHaveLength(2);
    // The host asked for a second; the retry did not come sooner.
    expect(lead[1]!.at - lead[0]!.at).toBeGreaterThanOrEqual(900);
  }, 180_000);

  test("a malformed event fails that attempt, and the retry's answer arrives", async () => {
    // A data line that is not JSON fails the attempt — passing over it could
    // drop a tool call's arguments in silence — and the retry is clean.
    const r = rig([
      { kind: "malformed", text: "A reply with a junk line in it." },
      { kind: "text", text: "The answer, sent again." },
    ]);
    const { code, envelope, lead } = await runOnce(r);
    expect(code).toBe(0);
    expect(envelope?.text).toContain("The answer, sent again.");
    expect(lead).toHaveLength(2);
  }, 180_000);

  test("a stream that goes quiet mid-answer is given up on, and sent again", async () => {
    // A wedged proxy: the first bytes arrive, then nothing, with the
    // connection held open. Only the idle watchdog can end it, and its
    // allowance between chunks is 45 s for a model that streams as it writes.
    const r = rig([
      { kind: "stall", text: "An answer whose connection goes quiet half way through." },
      { kind: "text", text: "The answer after the stall." },
    ]);
    const { code, envelope, lead } = await runOnce(r);
    expect(code).toBe(0);
    expect(envelope?.text).toContain("The answer after the stall.");
    expect(lead).toHaveLength(2);
    expect(lead[1]!.at - lead[0]!.at).toBeGreaterThanOrEqual(44_000);
  }, 240_000);

  test("a wall clock set an hour forward mid-request is not taken for a sleep", async () => {
    // 1.4.4's sleep check read the wall clock alone: an hour's jump looked like
    // an hour asleep, and the cut that followed was held for the wake settle
    // and announced as a sleep. The process's monotonic clock does not move.
    // Four cuts: the gateway's own three retries run out, so the failure
    // reaches the loop, which is where the sleep check is asked.
    const cut = { kind: "cut", text: "An answer cut after the clock moved." } as const;
    const r = rig([
      { kind: "hang", ms: 4_000, then: cut },
      cut,
      cut,
      cut,
      { kind: "text", text: "The answer, sent again." },
    ]);
    const trigger = join(r.base, "clock-jump");
    const run = spawn(r, { preload: [CLOCK_JUMP_PRELOAD], env: { RUNE_TEST_CLOCK_JUMP: trigger } });
    await until(() => r.server.requests.some((q) => q.role === "lead"));
    writeFileSync(trigger, String(60 * 60_000));
    await until(() => existsSync(`${trigger}.done`));
    const { code, envelope, lead } = await finish(r, run);
    expect(code).toBe(0);
    expect(envelope?.text).toContain("The answer, sent again.");
    expect(lead).toHaveLength(5);
    expect(run.stdout).not.toMatch(/asleep/i);
    // The half answer the last cut left is not part of the answer.
    expect(envelope?.text).not.toContain("An answer cut");
  }, 180_000);

  test("a key the host refuses ends the run at once, without a retry storm", async () => {
    const r = rig([{ kind: "status", status: 401, message: "Incorrect API key provided." }]);
    const { code, envelope, lead } = await runOnce(r);
    expect(code).not.toBe(0);
    expect(envelope?.ok).toBe(false);
    expect(String(envelope?.error ?? "")).toMatch(/rejected the request|Incorrect API key/i);
    expect(lead.length).toBeLessThanOrEqual(1);
  }, 180_000);
});
