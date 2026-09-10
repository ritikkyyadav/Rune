/**
 * A delegated child's checkpoint, budget and resume lease survive the PROCESS.
 *
 * Two real `rune` processes against one scratch home, through a loopback mock:
 * the first dispatches a worker and is handed a `task_id`, the second resumes
 * that id and gets the same child back. Written by an independent verifier,
 * and red until the store was wired: `Engine`'s constructor registered the
 * delegation tools before it built `this.delegatedSessions`, and
 * `registerDelegationTools` snapshots that field on its first line. The
 * snapshot was `undefined` (the declaration's `!` hid it from tsc) and
 * `withDelegatedSessions` silently substituted a store with no SessionManager
 * — checkpoints in a per-process Map, no lease read or written at all — so
 * the database held zero `delegation_checkpoint` and zero `delegation_lease`
 * rows and a second process answered "Unknown task_id in this parent session".
 *
 * Runs under the same two conditions as tests/integration/lifecycle-durability
 * .test.ts: the OS sandbox OFF (it needs `Bun.serve({port: 0})`) and the native
 * binary built and exported (`cargo build --locked -p rune-tools`,
 * `RUNE_TOOLS_BIN=$PWD/target/debug/rune-tools`). It spends nothing: the
 * child's environment is built by `curatedEnv`, and its only route is the
 * loopback mock.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

const MARKER = "V3-WORKER-CONTRACT-DELEGATION";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const call = (name: string, args: Record<string, unknown>): MockAction => ({
  kind: "tools",
  calls: [{ name, args }],
});
const workerCall = (extra: Record<string, unknown> = {}) =>
  call("worker", {
    files: ["src/client.ts"],
    label: "wire the client",
    prompt: `${MARKER}: add a version() passthrough to src/client.ts.`,
    ...extra,
  });

test(
  "a delegated child's checkpoint and lease reach the database, so the task_id " +
    "one process hands out resumes in the next",
  async () => {
    const base = mkdtempSync(join(tmpdir(), "v3-delegation-"));
    dirs.push(base);
    const dir = join(base, "rig");
    mkdirSync(dir, { recursive: true });
    const fixture = S.makeFixture(dir);
    const toolsBin = S.requireNativeBinary();
    const server = startMockModelServer({
      model: "fake-model",
      childMarker: MARKER,
      script: {
        lead: [workerCall(), { kind: "text", text: "the worker came back." }],
        child: [
          call("read_file", { path: "src/client.ts" }),
          call("edit_file", {
            path: "src/client.ts",
            old_text: "  return makeApi().hello();",
            new_text:
              "  return makeApi().hello();\n}\n\nexport function version(): string {\n  return makeApi().version();",
          }),
          { kind: "text", text: "Added version() to src/client.ts as contracted." },
        ],
        summarizer: [{ kind: "text", text: "SUMMARY: a worker is wiring the client." }],
        utility: [{ kind: "text", text: "ok" }],
      },
    });
    const home = S.makeScratchHome(dir, {
      baseUrl: server.baseUrl,
      model: "fake-model",
      maxTurns: 30,
    });
    try {
      const first = S.spawnRun({
        home,
        fixture,
        toolsBin,
        prompt: "Wire version() through src/client.ts with a worker.",
      });
      server.attach(first.proc);
      await first.wait(180_000);

      const taskId = JSON.stringify(first.events).match(
        /task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      )?.[0];
      // The tool advertises `task_id` as the way to resume the child, so a run
      // that dispatched a worker must have handed one out.
      expect(typeof taskId).toBe("string");

      // G12: two per delegated call. G10: one per child tool boundary.
      const db = new Database(home.dbPath, { readonly: true });
      const count = (type: string) =>
        (db.query("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(type) as { n: number }).n;
      const leases = count("delegation_lease");
      const checkpoints = count("delegation_checkpoint");
      db.close();
      expect(leases).toBeGreaterThan(0);
      expect(checkpoints).toBeGreaterThan(0);

      // And the durability claim itself: a FRESH process resumes that child.
      const sessionId = S.listSessions(home.dbPath)[0]!.id;
      server.scriptFrom("lead", 1);
      const second = S.spawnRun({
        home,
        fixture,
        toolsBin,
        prompt: "Follow up with the same worker.",
        resume: sessionId,
      });
      server.attach(second.proc);
      await second.wait(180_000);
      const end = second.events.find(
        (e) => e.type === "tool_call_end" && JSON.stringify(e).includes("wire the client"),
      );
      const output = (end?.output ?? {}) as { success?: boolean; error?: string };
      expect(String(output.error ?? "")).not.toMatch(/unknown task_id/i);
      expect(output.success).toBe(true);
    } finally {
      server.stop();
    }
  },
  240_000,
);
