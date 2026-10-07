/**
 * T1 — the order a process stops in when it is told to.
 *
 * `signal-shutdown.ts` on a fake clock: ask the run to stop, wait for it to
 * have written how it ended but never past the grace period, release what the
 * process holds, and exit with the signal's own code. The process-level half —
 * a real CLI, a real signal, the process table — is
 * `tests/integration/signal-shutdown.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  SHUTDOWN_GRACE_MS,
  SIGNAL_EXIT_CODES,
  createSignalShutdown,
  type StopSignal,
} from "../../../packages/orchestrator/src/bin/signal-shutdown";

/** A process, as the shutdown sees it: what happened to it, in order, and a clock to move. */
function fakeProcess(opts: { closeThrows?: boolean; stopThrows?: boolean } = {}) {
  const log: string[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  let unwound: () => void = () => {};
  let failed: (err: Error) => void = () => {};
  const shutdown = createSignalShutdown({
    stop: (signal: StopSignal) => {
      log.push(`stop ${signal}`);
      if (opts.stopThrows) throw new Error("no engine");
      return new Promise<void>((resolve, reject) => {
        unwound = resolve;
        failed = reject;
      });
    },
    close: () => {
      log.push("close");
      if (opts.closeThrows) throw new Error("already closed");
    },
    exit: (code) => {
      log.push(`exit ${code}`);
    },
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
  });
  return {
    log,
    shutdown,
    /** The run finished winding up. Lets the promise's continuation run. */
    async unwind() {
      unwound();
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail() {
      failed(new Error("the run threw on its way out"));
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Move the clock, firing what came due. */
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) timer.fn();
        else timers.push(timer);
      }
    },
  };
}

describe("told to stop", () => {
  test("the run is asked first, and nothing is closed until it has wound up", async () => {
    const p = fakeProcess();
    p.shutdown.handle("SIGTERM");
    expect(p.log).toEqual(["stop SIGTERM"]);
    p.advance(SHUTDOWN_GRACE_MS - 1);
    expect(p.log).toEqual(["stop SIGTERM"]);

    await p.unwind();
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });

  test("each signal exits with its own conventional code", async () => {
    expect(SIGNAL_EXIT_CODES).toEqual({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
    for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES) as Array<[StopSignal, number]>) {
      const p = fakeProcess();
      p.shutdown.handle(signal);
      await p.unwind();
      expect(p.log.at(-1)).toBe(`exit ${code}`);
    }
  });

  test("a run that will not wind up is left behind when the grace period ends", () => {
    const p = fakeProcess();
    p.shutdown.handle("SIGTERM");
    p.advance(SHUTDOWN_GRACE_MS);
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });

  test("the grace period is five seconds", () => {
    expect(SHUTDOWN_GRACE_MS).toBe(5_000);
  });

  test("it leaves once: a run that winds up after the grace period closes nothing twice", async () => {
    const p = fakeProcess();
    p.shutdown.handle("SIGTERM");
    p.advance(SHUTDOWN_GRACE_MS);
    await p.unwind();
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });

  test("asked twice means now, and the code is the first signal's", () => {
    const p = fakeProcess();
    p.shutdown.handle("SIGTERM");
    p.shutdown.handle("SIGINT");
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });

  test("a run that throws on its way out does not keep the process", async () => {
    const p = fakeProcess();
    p.shutdown.handle("SIGHUP");
    await p.fail();
    expect(p.log).toEqual(["stop SIGHUP", "close", "exit 129"]);
  });

  test("nor does a stop that cannot even be asked", () => {
    const p = fakeProcess({ stopThrows: true });
    p.shutdown.handle("SIGTERM");
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });

  test("cleanup that throws is not what keeps the process alive", async () => {
    const p = fakeProcess({ closeThrows: true });
    p.shutdown.handle("SIGTERM");
    await p.unwind();
    expect(p.log).toEqual(["stop SIGTERM", "close", "exit 143"]);
  });
});

describe("the code a signal has made owed", () => {
  test("is null until one arrives, and then that signal's — for a path that exits by itself", () => {
    const p = fakeProcess();
    expect(p.shutdown.owedExitCode()).toBeNull();
    p.shutdown.handle("SIGINT");
    expect(p.shutdown.owedExitCode()).toBe(130);
    // A second signal does not change what stopped it.
    p.shutdown.handle("SIGTERM");
    expect(p.shutdown.owedExitCode()).toBe(130);
  });
});
