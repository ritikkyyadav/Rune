/**
 * The yardstick's process suite (R0.1 of
 * docs/program/rune-reliability-plan-20261014.md): the real `rune -P` is sent
 * a signal at four points — while the model is answering, while a tool runs,
 * while a compaction is summarising, and while the end-of-turn check runs —
 * and a resume of the same session has to finish the work. A SIGTERM or
 * SIGINT exits with that signal's own code (R4).
 *
 * SIGKILL mid-tool, with the orphan and lease checks, is
 * tests/integration/lifecycle-durability.test.ts; this suite adds the signals
 * a person or a CI runner sends, at the points that one does not reach.
 *
 * POSIX only: Windows has no SIGTERM or SIGINT to send a process, only a
 * forced stop, and its console Ctrl+C cannot be sent to a detached child.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startMockModelServer,
  type MockAction,
  type MockScript,
} from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

const POSIX = process.platform !== "win32";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

async function until(check: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const FINISHED = "Finished after the resume.";

function rig(script: (fixture: S.Fixture) => MockScript, prepare?: (fixture: S.Fixture) => void) {
  const base = mkdtempSync(join(tmpdir(), "rune-reliability-process-"));
  dirs.push(base);
  const dir = join(base, "rig");
  mkdirSync(dir, { recursive: true });
  const fixture = S.makeFixture(dir);
  prepare?.(fixture);
  const toolsBin = S.requireNativeBinary();
  const server = startMockModelServer({ model: "fake-model", script: script(fixture) });
  const home = S.makeScratchHome(dir, {
    baseUrl: server.baseUrl,
    model: "fake-model",
    maxTurns: 20,
  });
  const first = S.spawnRun({ home, fixture, toolsBin, prompt: "Do the task." });
  server.attach(first.proc);
  return { fixture, toolsBin, server, home, first };
}

type Rig = ReturnType<typeof rig>;

/** Resume the session the first run wrote; it must finish, exit 0. */
async function resumeFinishes(r: Rig): Promise<S.Run> {
  const sessionId = S.listSessions(r.home.dbPath)[0]!.id;
  const second = S.spawnRun({
    home: r.home,
    fixture: r.fixture,
    toolsBin: r.toolsBin,
    prompt: "Continue.",
    resume: sessionId,
  });
  r.server.attach(second.proc);
  expect(await second.wait(120_000)).toBe(0);
  expect(second.envelope()?.text).toContain(FINISHED);
  return second;
}

const text = (t: string): MockAction => ({ kind: "text", text: t });
const tool = (name: string, args: Record<string, unknown>): MockAction => ({
  kind: "tools",
  calls: [{ name, args }],
});
const quiet = { summarizer: [text("SUMMARY: nothing to keep.")], utility: [text("ok")] };

describe.skipIf(!POSIX)("a signal while the model is answering, then a resume", () => {
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    test(`${signal} exits ${code}, and a resume finishes`, async () => {
      const r = rig(() => ({
        // The first request is held open; the signal lands while it is.
        lead: [{ kind: "hang", ms: 60_000, then: text("too late") }, text(FINISHED)],
        ...quiet,
      }));
      try {
        await until(() => r.server.requests.some((q) => q.role === "lead"));
        r.first.proc.kill(signal);
        expect(await r.first.wait(60_000)).toBe(code);
        await resumeFinishes(r);
      } finally {
        r.server.stop();
      }
    }, 240_000);
  }

  test("SIGKILL leaves a session a resume finishes", async () => {
    const r = rig(() => ({
      lead: [{ kind: "hang", ms: 60_000, then: text("too late") }, text(FINISHED)],
      ...quiet,
    }));
    try {
      await until(() => r.server.requests.some((q) => q.role === "lead"));
      r.first.proc.kill("SIGKILL");
      await r.first.wait(60_000);
      expect(r.first.proc.signalCode).toBe("SIGKILL");
      await resumeFinishes(r);
    } finally {
      r.server.stop();
    }
  }, 240_000);
});

const SIGNALS = [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGKILL", null],
] as const;

/** Send `signal`, and check the run ended the way that signal ends one. */
async function stopWith(run: S.Run, signal: NodeJS.Signals, code: number | null): Promise<void> {
  run.proc.kill(signal);
  const exit = await run.wait(60_000);
  // A SIGKILL is never seen by the process: no handler, no code of its own.
  if (code === null) expect(run.proc.signalCode).toBe("SIGKILL");
  else expect(exit).toBe(code);
}

describe.skipIf(!POSIX)("a run killed outright takes its background shells with it", () => {
  test("SIGKILL while a background shell runs: the shell is stopped, and a resume finishes", async () => {
    // A dev server or a watch build the model started with run_in_background.
    // No exit handler runs on a SIGKILL; the shell's own watch has to stop it.
    const marker = `reliability-background-${process.pid}-${Date.now()}`;
    const r = rig((fixture) => ({
      lead: [
        tool("bash", { command: fixture.longCommand(marker, 60), run_in_background: true }),
        { kind: "hang", ms: 60_000, then: text("too late") },
        text(FINISHED),
      ],
      ...quiet,
    }));
    try {
      expect((await S.waitForProcess(marker, { attempts: 600 })).length).toBeGreaterThan(0);
      await stopWith(r.first, "SIGKILL", null);
      expect(await S.waitForNoProcess(marker, { attempts: 40, delayMs: 250 })).toEqual([]);
      await resumeFinishes(r);
    } finally {
      r.server.stop();
      S.killMatching(marker);
    }
  }, 240_000);
});

describe.skipIf(!POSIX)("a signal at the other three points, then a resume", () => {
  for (const [signal, code] of SIGNALS) {
    test(`mid-tool, ${signal}: the command it was running is stopped, and a resume finishes`, async () => {
      const marker = `reliability-mid-tool-${signal}-${process.pid}-${Date.now()}`;
      const r = rig((fixture) => ({
        lead: [tool("bash", { command: fixture.longCommand(marker, 60) }), text(FINISHED)],
        ...quiet,
      }));
      try {
        expect((await S.waitForProcess(marker, { attempts: 600 })).length).toBeGreaterThan(0);
        await stopWith(r.first, signal, code);
        // The command does not outlive the run that started it.
        expect(await S.waitForNoProcess(marker, { attempts: 40, delayMs: 250 })).toEqual([]);
        await resumeFinishes(r);
      } finally {
        r.server.stop();
        S.killMatching(marker);
      }
    }, 240_000);

    test(`mid-compaction, ${signal}: a resume finishes`, async () => {
      const r = rig(() => ({
        // Six large reads, then the host rejects the prompt as over-limit: the
        // loop compacts, and the summarizer's request is held open. (With two
        // there is nothing old enough to fold, and the run rightly ends
        // `max_tokens` without asking the summarizer.)
        lead: [
          ...[1, 2, 3, 4, 5, 6].map((n) => tool("read_file", { path: `docs/note-${n}.md` })),
          { kind: "context_length", limit: 100_000 },
          text(FINISHED),
        ],
        summarizer: [
          { kind: "hang", ms: 60_000, then: text("SUMMARY: too late.") },
          text("SUMMARY: six notes were read; nothing else is open."),
        ],
        utility: [text("ok")],
      }));
      try {
        await until(() => r.server.requests.some((q) => q.role === "summarizer"), 90_000).catch(
          (e: unknown) => {
            // What the run did instead, for a failure seen only in CI.
            console.log(`requests: ${r.server.requests.map((q) => q.role).join(", ")}`);
            console.log(`the run's last output:\n${r.first.stdout.slice(-3000)}`);
            throw e;
          },
        );
        await stopWith(r.first, signal, code);
        await resumeFinishes(r);
      } finally {
        r.server.stop();
      }
    }, 240_000);

    test(`mid-check, ${signal}: the check is stopped, and a resume finishes`, async () => {
      // The project's own `npm test` is what the end-of-turn check runs after
      // an edit. The first time it is slow, so the signal lands inside it.
      const marker = `reliability-mid-check-${signal}-${process.pid}-${Date.now()}`;
      const r = rig(
        () => ({
          lead: [
            tool("write_file", { path: "src/extra.ts", content: "export const extra = 1;\n" }),
            text("The file is written."),
            text(FINISHED),
          ],
          ...quiet,
        }),
        (fixture) => {
          writeFileSync(
            join(fixture.root, "slow-check.mjs"),
            [
              'import { existsSync, writeFileSync } from "node:fs";',
              'if (!existsSync(".check-ran")) {',
              '  writeFileSync(".check-ran", "1");',
              "  await new Promise((r) => setTimeout(r, 60_000));",
              "}",
              'console.log("check: ok");',
            ].join("\n"),
          );
          writeFileSync(
            join(fixture.root, "package.json"),
            JSON.stringify(
              { name: "scenario-fixture", scripts: { test: `node slow-check.mjs ${marker}` } },
              null,
              2,
            ),
          );
        },
      );
      try {
        expect((await S.waitForProcess(marker, { attempts: 900 })).length).toBeGreaterThan(0);
        await stopWith(r.first, signal, code);
        expect(await S.waitForNoProcess(marker, { attempts: 40, delayMs: 250 })).toEqual([]);
        await resumeFinishes(r);
      } finally {
        r.server.stop();
        S.killMatching(marker);
      }
    }, 240_000);
  }
});
