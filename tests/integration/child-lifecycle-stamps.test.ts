/**
 * P3B I4, end to end: a delegated child's start and integrate stamps must
 * reach the session log.
 *
 * Lane 0 put both stamps on the child summary and proved it at that seam. What
 * no test covered was the step after: `buildLifecycle` rebuilds every child
 * from a named field list before the projection is emitted and persisted, and
 * it did not name them — so `Engine.recordChild` set the stamps and the
 * projection dropped them one call later. Measured on a scripted `task` run at
 * the time: 5 lifecycle rows, 3 child rows, and the string "integratedAt"
 * appearing ZERO times anywhere in the database (V-L0 #17). I4 produced nothing
 * on disk, which is the only place the question it answers gets asked from.
 *
 * So this test asks the database, not the builder. A real `rune-cli.ts` in its
 * own process delegates one `task` child to `tests/helpers/mock-model-server.ts`
 * and the assertions read the rows back with SQLite.
 *
 * **It needs the sandbox off** — `Bun.serve({port: 0})` fails with EADDRINUSE
 * under the repository's restricted profile — and it needs the native tools
 * binary, which it reports as a FAILURE rather than skipping.
 *
 * **It spends nothing.** The child's home has one configured route, the
 * loopback mock, and `assertNoLiveCredentials` runs before the process starts.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

/** Appears in the child's prompt and nowhere else, so the mock can tell them apart. */
const CHILD_MARKER = "I4-TASK-CONTRACT-19ab";

function tool(name: string, args: Record<string, unknown>): MockAction {
  return { kind: "tools", calls: [{ name, args }] };
}

const LEAD_SCRIPT: MockAction[] = [
  tool("task", {
    prompt: `${CHILD_MARKER} Find where VERSION is exported.`,
    label: "find version",
  }),
  { kind: "text", text: "The sub-agent reported back. Done." },
];

/**
 * The child takes a measurable moment, so `startedAt` and `integratedAt` cannot
 * both land on the same millisecond by accident and pass a monotonicity check
 * that means nothing.
 */
const CHILD_SCRIPT: MockAction[] = [
  {
    kind: "text",
    text: "VERSION lives in src/version.ts.",
    delayMs: 250,
    usage: { prompt: 900, completion: 20, cached: 700 },
  },
];

let dir = "";
let rig: { home: S.ScratchHome } | null = null;
let server: ReturnType<typeof startMockModelServer> | null = null;
let run: S.Run | null = null;

beforeAll(async () => {
  const toolsBin = S.requireNativeBinary();
  dir = mkdtempSync(join(tmpdir(), "rune-i4-child-stamps-"));
  const workdir = join(dir, "run");
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  server = startMockModelServer({
    script: { lead: LEAD_SCRIPT, child: CHILD_SCRIPT },
    childMarker: CHILD_MARKER,
    model: "fake-model",
  });
  const home = S.makeScratchHome(workdir, { baseUrl: server.baseUrl, model: "fake-model" });
  rig = { home };
  run = S.spawnRun({
    home,
    fixture,
    toolsBin,
    prompt: "Delegate a read-only investigation with the task tool, then report back.",
  });
  server.attach(run.proc);
  await run.wait(180_000);
}, 240_000);

afterAll(() => {
  try {
    run?.kill();
  } catch {
    /* already gone */
  }
  server?.stop();
  rmTemp(dir);
});

interface ChildRow {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  startedAt?: unknown;
  integratedAt?: unknown;
}

/** Every child row on every persisted lifecycle projection, in log order. */
function childRows(): ChildRow[] {
  const out: ChildRow[] = [];
  for (const row of S.readEvents(rig!.home.dbPath)) {
    if (row.type !== "run_trace") continue;
    const payload = row.payload as Record<string, any>;
    if (payload.type !== "lifecycle") continue;
    for (const child of payload.lifecycle?.children ?? []) out.push(child as ChildRow);
  }
  return out;
}

test("the scripted run delegated a child and wrote a session database", () => {
  expect(existsSync(rig!.home.dbPath)).toBe(true);
  expect(server!.requests.length).toBeGreaterThan(0);
  // The mock answered as the child at least once, so a child really ran.
  expect(server!.requests.some((r) => r.role === "child")).toBe(true);
  expect(childRows().length).toBeGreaterThan(0);
});

test("I4 — a finished child's stamps are on the persisted lifecycle row", () => {
  const integrated = childRows().filter((c) => typeof c.integratedAt === "string");
  // The assertion that was false end to end before the fix: zero rows carried
  // this field, on a run that dispatched and integrated a child.
  expect(integrated.length).toBeGreaterThan(0);
  for (const child of integrated) {
    expect(typeof child.startedAt).toBe("string");
    expect(String(child.startedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(child.integratedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }
});

test("I4 — the stamps are monotonic: start ≤ integrate ≤ the end of the run", () => {
  const rows = S.readEvents(rig!.home.dbPath);
  expect(rows.length).toBeGreaterThan(0);
  const runEnd = new Date(String(rows[rows.length - 1]!.createdAt)).getTime();
  expect(Number.isFinite(runEnd)).toBe(true);

  const integrated = childRows().filter((c) => typeof c.integratedAt === "string");
  expect(integrated.length).toBeGreaterThan(0);
  for (const child of integrated) {
    const startedAt = new Date(String(child.startedAt)).getTime();
    const integratedAt = new Date(String(child.integratedAt)).getTime();
    expect(startedAt).toBeLessThanOrEqual(integratedAt);
    expect(integratedAt).toBeLessThanOrEqual(runEnd);
  }
});

test("I4 — the interval is the child's own work, not the lead's dispatch-to-result", () => {
  // Why the stamps exist at all: the lead's clock cannot separate a child's
  // startup and the integration of its writes from the work in between. The
  // child's script sleeps 250 ms, so a reported interval shorter than that
  // would mean the stamps are not measuring the child.
  const integrated = childRows().filter((c) => typeof c.integratedAt === "string");
  const spans = integrated.map(
    (c) => new Date(String(c.integratedAt)).getTime() - new Date(String(c.startedAt)).getTime(),
  );
  expect(Math.max(...spans)).toBeGreaterThanOrEqual(250);
});
