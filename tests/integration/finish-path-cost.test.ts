/**
 * Phase 3B Lane A — what the finish path costs, counted on fixed scripts.
 *
 * `docs/program/phase-3-auto-efficiency.md` §5.2 names the instrument and its
 * boundary: a real `rune-cli.ts` in its own process against
 * `tests/helpers/mock-model-server.ts`, where a fixed `MockScript.lead` makes
 * `countOf("lead")` the step count — and where "a change that makes the MODEL
 * need fewer steps cannot be shown; only a change that makes the HARNESS spend
 * fewer" can. Every number below respects that line, including the one that
 * came out flat.
 *
 * Three scripts, one spawned run each:
 *
 *   A. three criteria, each check cited in the FOLLOWING completion (A2)
 *   B. a green check, a write that changed nothing, a finish (A3)
 *   C. the same, with a write that DID change a file (A3's control)
 *
 * **It needs the sandbox off** — `Bun.serve({port: 0})` fails with EADDRINUSE
 * under the repository's restricted profile — and the native binary, which it
 * reports as a FAILURE rather than skipping.
 *
 * **It spends nothing.** The child's home has one configured route, the
 * loopback mock, and `assertNoLiveCredentials` runs before the process starts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

function tools(...calls: Array<[string, Record<string, unknown>]>): MockAction {
  return { kind: "tools", calls: calls.map(([name, args]) => ({ name, args })) };
}
const say = (text: string): MockAction => ({ kind: "text", text });

/** `src/api.ts` and `src/client.ts` with the word the fixture's check looks for. */
const API_WITH_VERSION =
  "export interface Api {\n  hello(): string;\n  version(): string;\n}\n\n" +
  'export function makeApi(): Api {\n  return { hello: () => "hello", version: () => "1.0.0" };\n}\n';
const CLIENT_WITH_VERSION =
  'import { makeApi } from "./api";\n\nexport function run(): string {\n' +
  "  return makeApi().version();\n}\n";

/**
 * The edit that changes nothing, and is a real tool call rather than a mocked
 * result: `multi_edit` replaces a unique line with itself, so it names the file
 * (the write predicate sees a path) and emits an EMPTY unified diff from the
 * two texts it had in hand. That empty diff is the evidence A3 reads.
 */
const NO_OP_EDIT: [string, Record<string, unknown>] = [
  "multi_edit",
  {
    path: "src/client.ts",
    edits: [
      { old_text: "  return makeApi().version();", new_text: "  return makeApi().version();" },
    ],
  },
];

const STEP = { content: "wire the version endpoint", kind: "change" as const };

/** Write both files, check them, close the plan — then `tail`, then finish. */
function settledThen(tail: MockAction[]): MockAction[] {
  return [
    tools(["todo_write", { items: [{ ...STEP, status: "in_progress" }] }]),
    tools(
      ["write_file", { path: "src/api.ts", content: API_WITH_VERSION }],
      ["write_file", { path: "src/client.ts", content: CLIENT_WITH_VERSION }],
    ),
    tools(["bash", { command: "node check.mjs" }]),
    tools(["todo_write", { items: [{ ...STEP, status: "completed" }] }]),
    ...tail,
    say("Wired the version endpoint; `node check.mjs` exits 0."),
  ];
}

/**
 * Three criteria, each check cited in the completion AFTER it — the shape
 * pilot J spent 21.3% of its list cost on.
 */
const A2_SCRIPT: MockAction[] = [
  tools([
    "read_back",
    {
      reading: "You want the version endpoint wired and each part proved separately.",
      done_when: ["the api exports version", "the client calls it", "the check exits 0"],
    },
  ]),
  tools(
    ["write_file", { path: "src/api.ts", content: API_WITH_VERSION }],
    ["write_file", { path: "src/client.ts", content: CLIENT_WITH_VERSION }],
  ),
  // Three DISTINCT invocations of the fixture's check. The same command run
  // three times with no write between is a rut by the loop's own definition and
  // the third call is refused before it runs — which would be the loop doing
  // its job, and would measure the rut breaker instead of A2. The fixture's
  // `check.mjs` ignores its argv, so all three do the same work and pass.
  tools(["bash", { command: "node check.mjs" }]),
  tools(["record_evidence", { criterion: 0, command: "node check.mjs" }]),
  tools(["bash", { command: "node check.mjs --client" }]),
  tools(["record_evidence", { criterion: 1, command: "node check.mjs --client" }]),
  tools(["bash", { command: "node check.mjs --exit-code" }]),
  tools(["record_evidence", { criterion: 2, command: "node check.mjs --exit-code" }]),
  say("All three criteria are cited against the fixture's check."),
];

/**
 * Every line the run wrote to its own step log, once each.
 *
 * A `task_state` row is a full snapshot, so a line appears in every snapshot
 * after it was written — and the LAST snapshot is not necessarily the newest
 * log, since the state is persisted when it changes and the log keeps a
 * bounded tail. Union the rows and de-duplicate on the timestamp the entry
 * carries, which is unique per event.
 */
function stepLog(rows: S.SessionEventRow[]): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== "task_state") continue;
    const log =
      (row.payload as { state?: { log?: Array<{ at?: string; text?: string }> } }).state?.log ?? [];
    for (const entry of log) seen.set(`${entry.at}|${entry.text}`, String(entry.text ?? ""));
  }
  return [...seen.values()];
}

interface Measured {
  /** `countOf("lead")` — every completion the harness asked the model for. */
  completions: number;
  /** `user_msg.harness` origins, which Lane 0 made a property of every gate. */
  origins: string[];
  /** Turns the run was charged, and the ceiling it ended with. */
  turnsUsed: number;
  maxTurns: number;
  /**
   * Carried-forward citations, off the run's own step log.
   *
   * NOT off the lifecycle budget: a refund moves the LOOP's ceiling
   * (`AgentLoop.config.maxTurns`), while `lifecycle.budget.turnsMax` is the
   * ENGINE's snapshot of the ceiling the message started with
   * (`engine.ts` `liveBudget`), so no refund of any kind — gate refunds
   * included — is visible there. Measured where the run writes it down.
   */
  carriedForward: number;
  stopReason: string | undefined;
}

let dir = "";
let toolsBin = "";
const runs = new Map<string, Measured>();
const logs = new Map<string, string[]>();
const stepLogOf = (name: string): string[] => logs.get(name) ?? [];

async function measure(name: string, script: MockAction[], maxTurns: number): Promise<Measured> {
  const workdir = join(dir, name);
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  const server = startMockModelServer({ script: { lead: script }, model: "fake-model" });
  try {
    const home = S.makeScratchHome(workdir, {
      baseUrl: server.baseUrl,
      model: "fake-model",
      maxTurns,
    });
    const run = S.spawnRun({
      home,
      fixture,
      toolsBin,
      prompt: "Wire a version endpoint through the api and the client, and prove it.",
    });
    server.attach(run.proc);
    await run.wait(180_000);
    const envelope = run.envelope();
    const rows = S.readEvents(home.dbPath);
    // The turn ledger rides the lifecycle projection's `budget` block, written
    // at every moment and last at `terminal` — it is the only place the run
    // records the ceiling it ENDED with, which is what a refund moves.
    const budgets = rows
      .filter((r) => r.type === "run_trace" && r.payload.type === "lifecycle")
      .map(
        (r) =>
          (
            r.payload.lifecycle as
              { budget?: { turnsUsed?: number; turnsMax?: number } } | undefined
          )?.budget,
      )
      .filter((b): b is { turnsUsed?: number; turnsMax?: number } => !!b);
    const budget = budgets[budgets.length - 1] ?? {};
    const measured: Measured = {
      completions: server.countOf("lead"),
      origins: rows
        .filter((r) => r.type === "user_msg" && typeof r.payload.harness === "string")
        .map((r) => String(r.payload.harness)),
      turnsUsed: Number(budget.turnsUsed ?? 0),
      maxTurns: Number(budget.turnsMax ?? maxTurns),
      carriedForward: stepLog(rows).filter((e) => e.includes("carried forward")).length,
      stopReason: envelope?.stopReason,
    };
    runs.set(name, measured);
    logs.set(name, stepLog(rows));
    return measured;
  } finally {
    server.stop();
  }
}

beforeAll(async () => {
  toolsBin = S.requireNativeBinary();
  dir = mkdtempSync(join(tmpdir(), "rune-finish-cost-"));
  await measure("a2", A2_SCRIPT, 12);
  await measure("b-noop", settledThen([tools(NO_OP_EDIT)]), 12);
  await measure(
    "c-real",
    settledThen([
      tools(["write_file", { path: "src/extra.ts", content: "export const x = 1;\n" }]),
    ]),
    12,
  );
}, 600_000);

afterAll(() => rmTemp(dir));

describe("A2 — a citation that arrived one completion late", () => {
  /**
   * Measured on this script, both ways, on this machine:
   *
   * | | completions | charged turns | gates | carried forward |
   * | --------------- | ---: | ---: | ---: | ---: |
   * | pre-change (`730fd97`) | **9** | 9 | 0 | 0 |
   * | post-change | **9** | 9 | 0 | **3** |
   *
   * **The completion count is FLAT, and that is the honest result.** The
   * script decides when the model cites, so the three bookkeeping completions
   * are the script's and not the harness's — §5.2 says in advance that this
   * rig can only show a change in what the HARNESS spends, never a change in
   * what the model needs. The design's "−1 completion per criterion" is a
   * claim about a model that batches its citation once the runtime stops
   * making it expensive, and no fixed script can show that.
   *
   * What A2 does change is what those completions COST: three turns of the
   * run's budget, given back through the same `TurnRefunds` cap every gate
   * refund uses. On a run where the ceiling binds — and pilot J's did, with
   * the model still rewording a citation when the limit hit — three turns is
   * the difference between finishing and stopping at `max_turns`.
   *
   * The refund itself is asserted in-process by
   * `tests/unit/orchestrator/agent-loop-citation-carry-forward.test.ts`: the
   * ceiling a refund moves is the LOOP's, and the lifecycle projection carries
   * the ENGINE's snapshot of it, so `maxTurns` here reads 12 either way.
   */
  test("all three late citations are recognised and carried forward", () => {
    const m = runs.get("a2")!;
    expect(m.carriedForward).toBe(3);
    // Pre-change: 0. The run is otherwise identical — same script, same count.
    expect(m.completions).toBe(A2_SCRIPT.length);
  });

  test("no gate fired, and the run did not loop", () => {
    // Bounded, as the finish and loop-detector tests require: the harness asked
    // for exactly the scripted completions and no more.
    const m = runs.get("a2")!;
    expect(m.completions).toBeLessThanOrEqual(A2_SCRIPT.length);
    expect(m.origins.filter((o) => o.startsWith("gate:"))).toEqual([]);
    expect(m.turnsUsed).toBeLessThanOrEqual(m.maxTurns);
  });
});

describe("A3 — a write that changed nothing", () => {
  /**
   * Measured on these two scripts, both ways, on this machine:
   *
   * | | completions | gates |
   * | ---------------------------------- | ---: | ---: |
   * | B, pre-change (`730fd97`) | **7** | `gate:execution-evidence` |
   * | B, post-change | **6** | none |
   * | C (control), pre-change | 7 | `gate:execution-evidence` |
   * | C (control), post-change | 7 | `gate:execution-evidence` |
   *
   * One fewer completion on B, and it is the harness's own: the script is
   * byte-identical on both sides and the difference is a refused finish that
   * no longer happens. C is the control — the same run with a write that DID
   * change a file — and it is unmoved, which is what keeps the gate meaning
   * what it meant.
   */
  test("a green check, a no-op edit, a finish — zero gate re-prompts", () => {
    const m = runs.get("b-noop")!;
    expect(m.origins.filter((o) => o.startsWith("gate:"))).toEqual([]);
    expect(m.completions).toBe(6);
    // The run said why, on its own audit trail.
    expect(stepLogOf("b-noop").some((l) => /changed no file/.test(l))).toBe(true);
  });

  test("the control: a write that DID change a file still re-arms the gates", () => {
    const m = runs.get("c-real")!;
    expect(m.origins).toContain("gate:execution-evidence");
    expect(m.completions).toBe(7);
    expect(m.completions).toBe(runs.get("b-noop")!.completions + 1);
  });
});
