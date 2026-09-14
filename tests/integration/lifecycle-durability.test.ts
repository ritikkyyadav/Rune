/**
 * The scenario `docs/program/phase-2-lifecycle.md` §5 specifies, as processes.
 *
 * §2.8 of that survey is the reason this file exists: **no test in this
 * repository SIGKILLs a Rune engine mid-turn and then re-reads the database.**
 * The nearest two kill an idle host (`engine-host-tcp.test.ts:223`) and pass a
 * cooperative `--stop-after` flag (`workflow-examples.test.ts:130`), so every
 * durability claim in the handoff — constraints survive, no duplicated side
 * effects, no lost edits, no orphans, a usable partial result — was until now
 * asserted only against in-process fakes, or not at all.
 *
 * Everything here is real except the model: a real `rune-cli.ts` in its own
 * process, a real git repository with the user's uncommitted work in it, a real
 * `rune.db`, real `rune-tools` for the acceptance check, and a scripted
 * loopback server (`tests/helpers/mock-model-server.ts`) that decides both what
 * the model says and when the child dies.
 *
 * **This suite spends nothing, and proves it.** The child's environment is
 * built rather than inherited, its only configured route is the loopback mock,
 * and the first and last tests here fingerprint the `cost` rows of the
 * founder's own `~/.rune/rune.db` and assert they did not move.
 *
 * **It needs the sandbox off.** `Bun.serve({port: 0})` fails with EADDRINUSE
 * under the repository's restricted profile (§7, measured 2026-09-10), so this
 * file is run on its own with sandboxing disabled. It also needs the native
 * binary, and per §7 says so as a FAILURE rather than vanishing as a skip.
 *
 * **Where an assertion had nothing to read yet it was a `test.todo` naming the
 * gap**, so the build lanes had an executable definition of done. All of them
 * are real assertions now: the seven §6 predicted, and the two this rig found
 * itself (S-1, orphaned tool children; S-2, a rescued compaction that could
 * not say its summarizer failed), both closed on 2026-09-11. Nothing here is
 * weakened to make it green.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startMockModelServer,
  type MockAction,
  type MockModelServer,
  type RecordedRequest,
} from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";
import { DelegatedSessions } from "../../packages/orchestrator/src/delegated-sessions";
import { SessionManager } from "../../packages/shared/src/session";

// ─── Fixed vocabulary ───

/** Present in the worker's contract and nowhere else: the child-request tell. */
const WORKER_MARKER = "SCENARIO-WORKER-CONTRACT-7f2a";
/** The command that is still running when the kill lands. */
const LONG_RUNNING = "SCENARIO-LONG-RUNNING-9c1d";
/** A `task` child's contract, for the two §5.5 cases. */
const TASK_MARKER = "SCENARIO-TASK-CONTRACT-4b8e";

const PROMPT =
  "Add a version() endpoint to src/api.ts, wire it through src/client.ts with a worker, " +
  "then run node check.mjs. Leave src/notes.md alone.";

/**
 * The steering message, deliberately longer than 200 characters.
 *
 * §5.6 asks for the FULL steering text on the recovered spine, "not the first
 * 200 chars" — G9. `DIRECTIVE_CAP` was that 200 (`task-state.ts:598`); this
 * sentence is the measurement of whether it still is.
 */
const STEER =
  "Now that you are back: finish the verification step and nothing else. Do not touch " +
  "src/notes.md, do not re-run the worker, and do not start any new work — the api and the " +
  "client are already wired, so all that is left is running the acceptance check and citing " +
  "it as evidence for the first criterion you read back to me at the start.";

/** How many times the script tells the model to run the acceptance check. */
const CHECK_CALLS = 2;

/** 1-based index of the lead entry the RECOVERY process starts from. */
const RECOVERY_ENTRY = 19;
/** The last entry of scenario A's lead script: a plain answer, and the tail clamp. */
const FINAL_ENTRY = 21;

const DONE_WHEN = [
  "node check.mjs exits 0",
  "src/api.ts exports version()",
  "src/client.ts calls version()",
];

// ─── Script helpers ───

function tool(name: string, args: Record<string, unknown>): MockAction {
  return { kind: "tools", calls: [{ name, args }] };
}

function tools(...calls: Array<{ name: string; args: Record<string, unknown> }>): MockAction {
  return { kind: "tools", calls };
}

function todoList(...statuses: string[]): Record<string, unknown> {
  const contents = [
    ["read src/api.ts", "inspect"],
    ["add version() to src/api.ts", "change"],
    ["wire version() through src/client.ts", "change"],
    ["run node check.mjs", "verify"],
  ];
  return {
    items: contents.map(([content, kind], i) => ({ content, kind, status: statuses[i] })),
  };
}

const READ_API = tool("read_file", { path: "src/api.ts" });
const EDIT_API = tool("edit_file", {
  path: "src/api.ts",
  old_text: '    hello: () => "hello",',
  new_text: '    hello: () => "hello",\n    version: () => "1.0.0",',
});
const WORKER_CALL = tool("worker", {
  files: ["src/client.ts"],
  label: "wire the client",
  prompt: `${WORKER_MARKER}: add a version() passthrough to src/client.ts that calls makeApi().version().`,
});
const CHILD_EDIT_CLIENT = tool("edit_file", {
  path: "src/client.ts",
  old_text: "  return makeApi().hello();",
  new_text:
    "  return makeApi().hello();\n}\n\nexport function version(): string {\n  return makeApi().version();",
});

/** The child a worker runs: read what it owns, write it, report. */
const WORKER_CHILD_SCRIPT: MockAction[] = [
  tool("read_file", { path: "src/client.ts" }),
  CHILD_EDIT_CLIENT,
  { kind: "text", text: "Added version() to src/client.ts as contracted." },
];

// ─── One rig per case ───

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

function makeRig(
  name: string,
  script: Parameters<typeof startMockModelServer>[0]["script"],
  opts: {
    childMarker?: string;
    /**
     * The model id the child is configured with. Not cosmetic: the static
     * family table gives a window by NAME (`tokenizer.ts:175-212`), and that
     * is the only lever a SPAWNED child has for a small context window —
     * `registerContextLimit` is in-process, and a `/v1/models` answer is
     * dropped by the adapter. Anything matching `llama3` is 8 192 tokens.
     */
    model?: string;
    homeOptions?: Partial<S.ScratchHomeOptions>;
    onRequest?: (req: RecordedRequest, rig: Rig) => void;
  } = {},
): Rig {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fixture = S.makeFixture(dir);
  const rig = { dir, fixture } as Rig;
  const model = opts.model ?? "fake-model";
  const server = startMockModelServer({
    script,
    model,
    childMarker: opts.childMarker ?? WORKER_MARKER,
    onRequest: opts.onRequest ? (req) => opts.onRequest!(req, rig) : undefined,
  });
  rig.server = server;
  rig.home = S.makeScratchHome(dir, {
    baseUrl: server.baseUrl,
    model,
    ...opts.homeOptions,
  });
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

/**
 * Move HEAD, which is what makes a proven claim stale.
 *
 * `commit -a` on purpose: it stages TRACKED modifications only, so the
 * untracked file the read-back promised to leave alone stays untracked and the
 * "no lost edits" assertion keeps measuring what it was written to measure.
 */
function commitTracked(root: string, message: string): void {
  Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-a",
      "-m",
      message,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}

/** Read an artifact a driver test was supposed to produce, or say which one didn't. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing — the driver test above did not complete`);
  }
  return value;
}

// ─── Ledger fingerprint ───

let ledgerBefore: S.LedgerFingerprint | null = null;
/** When this suite started, so a row written before it cannot be attributed to it. */
let startedAt = "";

beforeAll(() => {
  startedAt = new Date().toISOString();
  ledgerBefore = S.ledgerFingerprint();
  toolsBin = S.requireNativeBinary();
  root = mkdtempSync(join(tmpdir(), "rune-lifecycle-"));
});

afterAll(() => {
  for (const run of runs) run.kill("SIGKILL");
  for (const rig of rigs) rig.server.stop();
  // Anything the scenario deliberately left running mid-tool.
  S.killMatching(LONG_RUNNING);
  if (root) rmTemp(root);
});

// ══════════════════════════════════════════════════════════════════════════
// A — the dependent change: worker, compaction, a kill at a tool boundary,
//     a restart, and recovery. §5.2 through §5.4.
// ══════════════════════════════════════════════════════════════════════════

describe("a dependent multi-step change, killed inside a tool and resumed", () => {
  let rig: Rig;
  let runA: S.Run | null = null;
  let runB: S.Run | null = null;
  let runC: S.Run | null = null;
  let sessionId: string | null = null;
  let killedTool: string[] = [];
  let orphans: string[] = [];
  let rowsAfterKill: S.SessionEventRow[] = [];
  let rowsAfterRecovery: S.SessionEventRow[] = [];
  let servedAfterRecovery: ReturnType<MockModelServer["usageTotals"]> | null = null;

  test("the scenario runs: the plan, the worker, two compactions, a SIGKILL inside `bash`, then a resume", async () => {
    rig = makeRig(
      "scenario-a",
      {
        lead: [
          // 1 — the constraints, read back before any file is touched.
          tool("read_back", {
            reading: "You want a version() endpoint on the api and the client wired to it.",
            touch: ["src/api.ts", "src/client.ts"],
            leave: ["src/notes.md — your untracked notes"],
            done_when: DONE_WHEN,
          }),
          // 2 — the dependent plan: step 3 cannot start before step 2 lands.
          tool("todo_write", todoList("in_progress", "pending", "pending", "pending")),
          // 3-4 — the lead's own edit, on top of the user's uncommitted one.
          READ_API,
          EDIT_API,
          tool("todo_write", todoList("completed", "completed", "in_progress", "pending")),
          // 6 — the worker, which owns a file the lead does not touch.
          WORKER_CALL,
          tool("todo_write", todoList("completed", "completed", "completed", "in_progress")),
          // 8-16 — bulk, then the provider rejects the prompt as over-limit,
          // twice. The rejection is the lever rather than a `compact_context`
          // call because it is the path a long run actually takes: the loop
          // force-compacts and retries the turn (`agent-loop.ts:1811-1839`),
          // under pressure it did not choose. (`compact_context` compacts too,
          // when there is a foldable head; on a short transcript it correctly
          // declines with "not worth a summarizer round trip".)
          tool("read_file", { path: "docs/note-1.md" }),
          tool("read_file", { path: "docs/note-2.md" }),
          tool("read_file", { path: "docs/note-3.md" }),
          { kind: "context_length", limit: 100_000 },
          // Never the same path twice: a repeated call is refused by the
          // loop's repeat detector, which costs an extra request and shifts
          // every later entry.
          tool("read_file", { path: "docs/note-4.md" }),
          tool("read_file", { path: "docs/note-5.md" }),
          tool("read_file", { path: "docs/note-6.md" }),
          tool("read_file", { path: "docs/note-7.md" }),
          { kind: "context_length", limit: 100_000 },
          // 17 — the acceptance check, which appends one line to runs.log.
          tool("bash", { command: "node check.mjs" }),
          // 18 — a command that is STILL RUNNING when the kill lands.
          tool("bash", { command: `node long.mjs ${LONG_RUNNING} 20` }),
          // ── the recovery process picks up here (see RECOVERY_ENTRY) ──
          tools(
            { name: "bash", args: { command: "node check.mjs" } },
            { name: "record_evidence", args: { criterion: 0, command: "node check.mjs" } },
          ),
          tool("todo_write", todoList("completed", "completed", "completed", "completed")),
          {
            kind: "text",
            text: "Recovered: version() is on the api, the client is wired, and node check.mjs passes.",
          },
        ],
        child: WORKER_CHILD_SCRIPT,
        summarizer: [
          {
            kind: "text",
            text:
              "SUMMARY: the run read back three criteria, added version() to src/api.ts over " +
              "the user's uncommitted edit, delegated src/client.ts to a worker which wired " +
              "it, and still has the acceptance check to run.",
          },
        ],
        utility: [{ kind: "text", text: "ok" }],
      },
      // §5.1 sets `maxTurns = 12`. It has to be higher HERE because the
      // budget is now inherited across a restart (G6): the recovery process
      // starts at the killed run's turn count, and a ceiling of 12 ends it
      // before it can close the step the kill interrupted. Which is correct
      // behaviour and the reason the scenario has to allow for it.
      { homeOptions: { maxTurns: 60 } },
    );

    runA = start(rig, PROMPT);

    // The kill is timed on the PROCESS TABLE, not on the request: the model
    // asking for a command and the native executor actually running it are
    // different moments, and only the second one is a tool boundary.
    await runA.waitForEvent((e) => JSON.stringify(e).includes(LONG_RUNNING), {
      timeoutMs: 120_000,
      label: "the long-running bash call",
    });
    killedTool = await S.waitForProcess(LONG_RUNNING, { attempts: 80, delayMs: 100 });
    expect(killedTool.length).toBeGreaterThan(0);

    runA.kill("SIGKILL");
    const codeA = await runA.wait(30_000);
    // 128 + SIGKILL(9). The child died where it stood: no envelope, no
    // handoff row, none of the `finally` block that a cancel would run.
    expect(codeA).toBe(137);
    expect(runA.envelope()).toBeNull();

    // The settle §7 asks for — 24 attempts at 250 ms — and the measurement
    // behind S-1 below. Printed rather than asserted: asserting the defect
    // would turn its fix into a failure.
    orphans = await S.waitForNoProcess(LONG_RUNNING, { attempts: 24, delayMs: 250 });
    if (orphans.length > 0) {
      console.log(`S-1: ${orphans.length} process(es) outlived the killed engine:`);
      for (const line of orphans) console.log(`      ${line}`);
    }

    const sessions = S.listSessions(rig.home.dbPath);
    expect(sessions).toHaveLength(1);
    sessionId = sessions[0]!.id;
    rowsAfterKill = S.readEvents(rig.home.dbPath, sessionId);

    // ── the restart ──
    // The recovery process talks to the same server; rebase its script so
    // the entries below are the ones it gets, whatever the killed run spent.
    rig.server.scriptFrom("lead", RECOVERY_ENTRY);
    runB = start(rig, STEER, sessionId);
    const codeB = await runB.wait(120_000);
    expect([0, 1]).toContain(codeB);
    rowsAfterRecovery = S.readEvents(rig.home.dbPath, sessionId);
    // Both sides of the spend comparison, read at the same instant: run C
    // below adds requests these rows would not yet carry.
    servedAfterRecovery = rig.server.usageTotals();

    // ── the tree moves under the proven claim ──
    // The recovery run cited `node check.mjs` for the first criterion and
    // earned `verified`. Committing moves HEAD, which is the one thing that
    // makes that verdict stale (`lifecycle.ts:163-182`); a third process
    // then has to report the weaker rung rather than the one it inherited.
    commitTracked(rig.fixture.root, "scenario: commit the work the run did");
    rig.server.scriptFrom("lead", FINAL_ENTRY);
    runC = start(rig, "Anything else outstanding? Just answer, do not start work.", sessionId);
    await runC.wait(120_000);
  }, 240_000);

  // ── §5.6, one test per acceptance criterion ──

  test("user constraints survive: the read-back criteria are on the log with their rungs", () => {
    const rows = must(rowsAfterRecovery, "the recovered session log");
    const briefRows = rows.filter((r) => r.type === "brief");
    expect(briefRows.length).toBeGreaterThan(0);
    const criteria = briefRows
      .map((r) => (r.payload.brief ?? {}) as { criteria?: unknown })
      .flatMap((b) => (Array.isArray(b.criteria) ? b.criteria : []))
      .map((c) => (c as { text?: string }).text ?? "");
    for (const want of DONE_WHEN) expect(criteria).toContain(want);
  });

  test("the contract survives the kill: it is written before the first model call", () => {
    // Phase 5B. The brief is the MODEL's account of the request and exists
    // only if it chose to read back; the contract is the RUNTIME's and is
    // written at intake, so it is the one row a run that died on its opening
    // turn still has. This asserts it against the log as the SIGKILL left it,
    // not the recovered one.
    const rows = must(rowsAfterKill, "the session log as the kill left it");
    const contracts = rows.filter((r) => r.type === "contract");
    expect(contracts.length).toBeGreaterThan(0);
    const first = contracts[0]!.payload as {
      version?: number;
      contract?: { intent?: string; criteria?: unknown[] };
    };
    expect(first.version).toBe(1);
    // Verbatim, and not the model's reading of it.
    expect(first.contract?.intent).toBe(PROMPT);
    // It precedes every assistant message: it cannot have come from a model call.
    const firstAssistant = rows.find((r) => r.type === "assistant_msg");
    expect(contracts[0]!.seq).toBeLessThan(firstAssistant?.seq ?? Number.MAX_SAFE_INTEGER);
    // …and by the end of the recovered run it carries the read-back's criteria.
    const recovered = must(rowsAfterRecovery, "the recovered session log")
      .filter((r) => r.type === "contract")
      .at(-1)!.payload as { contract?: { criteria?: Array<{ text?: string }> } };
    for (const want of DONE_WHEN) {
      expect((recovered.contract?.criteria ?? []).map((c) => c.text)).toContain(want);
    }
  });

  test("the run's verdict is on the log, beside the terminal row", () => {
    const rows = must(rowsAfterRecovery, "the recovered session log");
    const verdicts = rows.filter((r) => r.type === "verdict");
    expect(verdicts.length).toBeGreaterThan(0);
    const last = verdicts.at(-1)!.payload as {
      version?: number;
      verdict?: { kind?: string; criteria?: unknown[] };
      contractDigest?: string;
    };
    expect(last.version).toBe(1);
    expect(["met", "partial", "unmet"]).toContain(String(last.verdict?.kind));
    expect(String(last.contractDigest ?? "").length).toBeGreaterThan(0);
  });

  test("unfinished dependencies survive: the plan the kill interrupted is still on the spine", () => {
    const state = must(S.latestTaskState(rowsAfterKill), "the spine as the kill left it");
    const todos = S.todosOf(state);
    expect(todos).toHaveLength(4);
    // The dependent pair: step 3 could only close because step 2 wrote first,
    // and the runtime — not the model — recorded that write.
    expect(todos[1]!.status).toBe("completed");
    expect(Number((todos[1]!.evidence as { writes?: number })?.writes ?? 0)).toBeGreaterThanOrEqual(
      1,
    );
    expect(todos[2]!.status).toBe("completed");
    expect(
      Number((todos[2]!.evidence as { delegations?: number })?.delegations ?? 0),
    ).toBeGreaterThanOrEqual(1);
    // And the step the kill landed on is still open, which is what a recovering
    // process has to be told.
    expect(todos[3]!.status).not.toBe("completed");
    expect(String(state.goal ?? "")).toContain("version() endpoint");
  });

  test("the dispatched child left a lease and a checkpoint the resumed process can read", () => {
    // The row this asserts on is the one `08d99f8` promised and did not
    // deliver: `Engine`'s constructor registered the delegation tools 281 lines
    // BEFORE it built the `DelegatedSessions` they close over, so every real
    // dispatch fell back to a store with no `SessionManager` — checkpoints in a
    // per-process Map, leases never written at all. The unit tests all passed
    // because each of them constructs `new DelegatedSessions(manager)` by hand,
    // which is the one thing the engine did not do. This assertion is on a real
    // run's database, so it can only pass if the seam is actually wired.
    const rows = must(rowsAfterKill, "the session log as the kill left it");
    const leases = rows.filter((r) => r.type === "delegation_lease");
    const checkpoints = rows.filter((r) => r.type === "delegation_checkpoint");
    expect(leases.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    const taskId = String((checkpoints.at(-1)!.payload as { id?: unknown }).id ?? "");
    expect(taskId).toMatch(/^task_/);
    expect(String((leases.at(-1)!.payload as { id?: unknown }).id ?? "")).toMatch(/^task_/);

    // "The resumed process knows the task_id": a DIFFERENT process, reading the
    // same database through the product's own loader, resolves it to the
    // child's transcript rather than to "Unknown task_id in this parent
    // session."
    const manager = new SessionManager(rig.home.dbPath);
    try {
      const loaded = new DelegatedSessions(manager).load(must(sessionId, "the session id"), taskId);
      expect(loaded?.id).toBe(taskId);
      expect(loaded?.parentId).toBe(must(sessionId, "the session id"));
      expect(Array.isArray(loaded?.messages)).toBe(true);
    } finally {
      manager.close();
    }
  });

  test("steering survives: the recovered spine carries the whole steering message", () => {
    const state = must(S.latestTaskState(rowsAfterRecovery), "the recovered spine");
    // Not `toContain`: the criterion is that it was not TRUNCATED (G9), so the
    // assertion has to be on the whole string.
    expect(state.directive).toBe(STEER);
    expect(STEER.length).toBeGreaterThan(200);
  });

  test("no duplicated side effects on replay: one line in runs.log per check that ran", () => {
    // `check.mjs` appends one line per invocation, so the file IS the count of
    // times the world was touched. The expectation is the number of check
    // calls the harness actually OBSERVED across all three processes — not a
    // hand-count a script change would silently invalidate — and the point of
    // the criterion is that resuming a killed run does not re-run what already
    // ran: run A's check must not be replayed by run B.
    const observed = [runA, runB, runC]
      .flatMap((run) => run?.events ?? [])
      .filter((e) => {
        if (e.type !== "tool_call_end") return false;
        const output = (e.output ?? {}) as { toolName?: string };
        return output.toolName === "bash" && JSON.stringify(e).includes("node check.mjs");
      }).length;
    expect(observed).toBe(CHECK_CALLS);
    expect(S.countLines(rig.fixture.runsLog)).toBe(observed);
  });

  test("no duplicated spend on replay: one cost row per answered request, and the tokens agree", () => {
    const rows = S.costRows(rowsAfterRecovery);
    const served = must(servedAfterRecovery, "the served-usage snapshot");
    expect(rows.length).toBe(served.requests);
    expect(rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens, 0)).toBe(served.prompt);
    expect(rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(served.completion);
    // A resumed session rebuilds its ledger by replaying `cost` rows
    // (`engine.ts:5709-5741`); a row replayed as a new row would show here as a
    // duplicate seq for one request.
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  });

  test("no lost edits: the user's line, the lead's edit and the worker's edit all stand", () => {
    const api = readFileSync(join(rig.fixture.root, "src", "api.ts"), "utf8");
    expect(api).toContain(rig.fixture.userEdit.trim());
    expect(api).toContain('version: () => "1.0.0"');
    const client = readFileSync(join(rig.fixture.root, "src", "client.ts"), "utf8");
    expect(client).toContain("makeApi().version()");
    // The untracked file the read-back promised to leave alone: same bytes,
    // still untracked.
    expect(readFileSync(join(rig.fixture.root, "src", "notes.md"), "utf8")).toBe(
      rig.fixture.untracked,
    );
    expect(S.gitStatus(rig.fixture.root)).toContain("?? src/notes.md");
  });

  test("the kill really landed inside a tool call", () => {
    // The precondition every orphan claim depends on, asserted rather than
    // assumed: a native tool child was running at the moment of the SIGKILL.
    expect(killedTool.length).toBeGreaterThan(0);
    expect(killedTool.join(" ")).toContain("long.mjs");
  });

  test(
    "S-1: no orphan processes. MEASURED as broken on 2026-09-10 — after `SIGKILL` of the engine " +
      "both the `rune-tools` child running the in-flight `bash` and ITS own grandchild survived, " +
      "still there 6 s later and only reaped by this suite's own cleanup, because " +
      "`rust-bridge.ts` sends SIGTERM/SIGKILL only on the tool's abort signal and a SIGKILLed " +
      "parent never delivers one. Closed 2026-09-11 by a parent-death watchdog in `rune-tools` " +
      "(`crates/rune-sandbox/src/parent_death.rs`, `getppid()` polled every 250 ms) which kills " +
      "the command's process group and exits, plus process groups on the two sandbox backends " +
      "that lacked them and a pid ledger a restarting engine reaps.",
    () => {
      expect(orphans).toEqual([]);
      expect(S.matchingProcesses(`rune-tools --workspace ${rig.fixture.root}`)).toEqual([]);
    },
  );

  test("no orphan leases: the bus really ran, holds no claim, and lists no dead instance", () => {
    // Not vacuous: `teamClaims` returns [] both for "no claims" and for "no
    // such table", so the file has to be there first. `[team] enabled = true`
    // is set on every scratch home (§5.1) precisely to exercise this path.
    expect(existsSync(rig.home.teamDbPath)).toBe(true);
    expect(S.teamClaims(rig.home.teamDbPath)).toEqual([]);
    // A SIGKILLed instance cannot deregister itself; what must not survive is
    // a row still claiming to be a live process.
    const dead = S.teamInstances(rig.home.teamDbPath).filter((row) => {
      const pid = Number(row.pid ?? 0);
      if (!Number.isFinite(pid) || pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(dead).toEqual([]);
  });

  test("no orphan worktrees: git names none, and no checkout is left behind", () => {
    // §5.6's own artifact: `git worktree list`. The directory itself may
    // remain as an empty parent — that is bookkeeping, not a stranded
    // checkout, so the assertion is on what git still tracks and on whether
    // anything is actually inside.
    const listed = S.gitWorktrees(rig.fixture.root);
    expect(listed.filter((l) => l.includes(".rune/worktrees"))).toEqual([]);
    // `.workers` is the durable id ledger, not a checkout: a worker's own
    // directory is `w<session>-<n>`, and that is what must not survive.
    const dir = join(rig.fixture.root, ".rune", "worktrees");
    const left = (existsSync(dir) ? readdirSync(dir) : []).filter((e) => e !== ".workers");
    expect(left).toEqual([]);
  });

  test("a usable partial result: the recovery process reports a terminal verdict and the work", () => {
    const envelope = must(runB?.envelope(), "the recovery envelope");
    expect(typeof envelope.stopReason).toBe("string");
    expect(envelope.text.length).toBeGreaterThan(0);
    // The recovery run finished the one step the kill left open, and the
    // acceptance check it ran is the evidence.
    const state = must(S.latestTaskState(rowsAfterRecovery), "the recovered spine");
    expect(S.todosOf(state).every((t) => t.status === "completed")).toBe(true);
  });

  test("compaction happened more than once, and each one is on the log", () => {
    const compactions = rowsAfterRecovery.filter((r) => r.type === "auto_compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(2);
    // At least one of them was a real summarizer round trip rather than the
    // free tool-result eviction tier: the server saw the non-streamed call.
    expect(rig.server.countOf("summarizer")).toBeGreaterThanOrEqual(1);
    for (const row of compactions) {
      expect(Number(row.payload.afterTokens ?? 0)).toBeLessThanOrEqual(
        Number(row.payload.beforeTokens ?? 0),
      );
    }
  });

  test("the terminal result is durable: how run A ended can be read back without re-running it", () => {
    const traces = rowsAfterRecovery.filter(
      (r) => r.type === "run_trace" && r.payload.type === "turn_complete",
    );
    expect(traces.length).toBeGreaterThanOrEqual(1);
    // Not merely present: it says HOW, which is the whole content of a
    // terminal verdict. `turn_complete` used to be absent from
    // `RUN_TRACE_EVENTS`, so a run that ended with a full plan left no record
    // of how it ended at all.
    for (const trace of traces) expect(typeof trace.payload.stopReason).toBe("string");
  });

  test("no verified status for stale evidence: the rung drops when the tree moves under it", () => {
    const proven = must(runB?.envelope()?.lifecycle, "the recovery run's lifecycle") as {
      constraints?: Array<{ text: string; rung: string | null; evidence?: { head?: string } }>;
    };
    const before = (proven.constraints ?? []).find((c) => c.text === DONE_WHEN[0]);
    // Earned the hard way: the check failed on the parent commit and passes now.
    expect(before?.rung).toBe("verified");
    expect(typeof before?.evidence?.head).toBe("string");

    // Then HEAD moved. The same criterion, read by the next process:
    const after = must(runC?.envelope()?.lifecycle, "the post-commit lifecycle") as {
      constraints?: Array<{ text: string; rung: string | null }>;
    };
    const now = (after.constraints ?? []).find((c) => c.text === DONE_WHEN[0]);
    expect(now?.rung).toBe("reproduced");
  });

  test("the lifecycle projection reaches a headless caller, for the resumed run", () => {
    const lifecycle = must(runB?.envelope()?.lifecycle, "the recovery envelope's lifecycle") as {
      id?: string;
      kind?: string;
      objective?: string;
      constraints?: unknown[];
      workspace?: { head?: string | null; dirty?: boolean };
      status?: string;
      budget?: { turnsUsed?: number; turnsMax?: number };
      evidence?: { todos?: unknown[]; checks?: unknown[] };
    };
    expect(lifecycle.id).toBe(must(sessionId, "the session id"));
    expect(lifecycle.kind).toBe("lead");
    // The objective is the FIRST message's, not the steering message's: a
    // resumed run that renamed its own mission would have lost the task.
    expect(lifecycle.objective).toContain("version() endpoint");
    expect(lifecycle.constraints).toHaveLength(DONE_WHEN.length);
    expect(typeof lifecycle.workspace?.head).toBe("string");
    expect(lifecycle.workspace?.dirty).toBe(true);
    expect(typeof lifecycle.status).toBe("string");
    // The budget the run actually spent, which is the field a caller needs to
    // know a resumed run does not start over.
    expect(Number(lifecycle.budget?.turnsUsed ?? 0)).toBeGreaterThan(0);
    expect((lifecycle.evidence?.todos ?? []).length).toBe(4);
    expect((lifecycle.evidence?.checks ?? []).length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B — the same fixture, killed at a WORKER boundary. §5.3.
// ══════════════════════════════════════════════════════════════════════════

describe("a worker killed between its last write and its integration", () => {
  let rig: Rig;
  let runA: S.Run | null = null;
  let runB: S.Run | null = null;
  let sessionId: string | null = null;
  let worktreesAfterKill: string[] = [];
  let branchesAfterKill: string[] = [];
  let clientAfterKill = "";
  let secondWorker: Record<string, unknown> | null = null;

  test("the scenario runs: the worker writes, the process dies before integration, then resumes", async () => {
    rig = makeRig("scenario-b", {
      lead: [
        tool("todo_write", todoList("completed", "completed", "in_progress", "pending")),
        WORKER_CALL,
        // ── the recovery process picks up here ──
        WORKER_CALL,
        { kind: "text", text: "Recovered: re-dispatched the worker and wired the client." },
      ],
      child: [
        tool("read_file", { path: "src/client.ts" }),
        CHILD_EDIT_CLIENT,
        // The kill lands HERE: after the worker wrote the file it owns,
        // inside `.rune/worktrees/w1`, and before `saveWorkerChanges` /
        // `mergeWorkerWorktree` run in the `finally` (`worker.ts:908-946`).
        { kind: "kill" },
        { kind: "text", text: "Added version() to src/client.ts as contracted." },
      ],
      summarizer: [{ kind: "text", text: "SUMMARY: a worker is wiring the client." }],
      utility: [{ kind: "text", text: "ok" }],
    });

    runA = start(rig, PROMPT);
    await rig.server.waitFor((r) => r.action === "kill", {
      timeoutMs: 120_000,
      label: "the request the server kills on",
    });
    const codeA = await runA.wait(30_000);
    expect(codeA).toBe(137);

    worktreesAfterKill = S.gitWorktrees(rig.fixture.root);
    branchesAfterKill = S.gitBranches(rig.fixture.root);
    const wt = worktreesAfterKill
      .map((l) => l.split(/\s+/)[0]!)
      .find((p) => p.includes(".rune/worktrees"));
    clientAfterKill = wt ? S.readFileOr(join(wt, "src", "client.ts")) : "";

    const sessions = S.listSessions(rig.home.dbPath);
    sessionId = sessions[0]!.id;

    runB = start(rig, "Pick this up and finish wiring the client.", sessionId);
    await runB.wait(120_000);
    const end = runB.events.find(
      (e) => e.type === "tool_call_end" && JSON.stringify(e).includes("wire the client"),
    );
    secondWorker = (end?.output ?? null) as Record<string, unknown> | null;
  }, 240_000);

  test("the killed worker's writes are not lost: they are on disk in its own checkout", () => {
    must(runA, "the killed run");
    // The worker's edit lives in its worktree until integration. A kill before
    // `mergeWorkerWorktree` must not be the same thing as losing it.
    expect(clientAfterKill).toContain("makeApi().version()");
  });

  test("the worker's branch is retained so the work has a durable name", () => {
    expect(branchesAfterKill.some((b) => b.startsWith("rune/worker-"))).toBe(true);
  });

  test("no orphan worktrees after the crash: the checkout is pruned, the branch is kept", () => {
    // G13's reaper, measured across a real crash: the killed worker's
    // checkout WAS registered with git immediately after the kill (the test
    // above reads its file out of it), and the next process removed it.
    expect(worktreesAfterKill.some((l) => l.includes(".rune/worktrees"))).toBe(true);
    const listed = S.gitWorktrees(rig.fixture.root);
    expect(listed.filter((l) => l.includes(".rune/worktrees"))).toEqual([]);
    // The branch is the only copy of a failed worker's work, so it must stay.
    expect(S.gitBranches(rig.fixture.root).some((b) => b.startsWith("rune/worker-"))).toBe(true);
  });

  test("a second worker dispatch after the crash is not refused (G13)", () => {
    // The defect this replaces: `workerSeq` was a module counter that reset to
    // 0 on process start, so the next dispatch was `w1` again, its branch and
    // directory both already existed, `createWorkerWorktree` threw
    // `WorkerIsolationError`, and the worker degraded to a shell-less
    // shared-tree run — permanently, for every later worker in that repository.
    // Ids are session-derived now: the crash's branch is `rune/worker-w<sid>-1`
    // and the next dispatch does not collide with it.
    const output = must(secondWorker, "the re-dispatched worker's tool result");
    const text = `${String(output.result ?? "")}${JSON.stringify(output.structured ?? {})}`;
    expect(text).not.toContain("WorkerIsolationError");
    expect(text.toLowerCase()).not.toContain("already exists");
    // It got its OWN checkout: the provisioning receipt only exists for a
    // worker that was really isolated.
    const structured = (output.structured ?? {}) as { provisioning?: Record<string, unknown> };
    expect(typeof structured.provisioning?.snapshotMs).toBe("number");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C — an ownership conflict: the lead's tree moves under a live worker. §5.6.
// ══════════════════════════════════════════════════════════════════════════

describe("a worker whose owned file changed under it", () => {
  let rig: Rig;
  let run: S.Run | null = null;
  let conflictResult: Record<string, unknown> | null = null;

  test("the scenario runs: the file the worker owns is edited in the lead's tree while it works", async () => {
    rig = makeRig(
      "scenario-c",
      {
        lead: [
          WORKER_CALL,
          { kind: "text", text: "The worker came back; reporting what happened." },
        ],
        child: WORKER_CHILD_SCRIPT,
        summarizer: [{ kind: "text", text: "SUMMARY: a worker is wiring the client." }],
        utility: [{ kind: "text", text: "ok" }],
      },
      {
        onRequest: (req, r) => {
          // The concurrent edit, made at a known point in the child's own
          // loop: after it has read the file it owns and before it reports.
          // This is the user typing into the file a worker holds.
          if (req.role !== "child" || req.roleIndex !== 2) return;
          const path = join(r.fixture.root, "src", "client.ts");
          writeFileSync(path, `${S.readFileOr(path)}\n// LEAD-EDIT while the worker ran\n`);
        },
      },
    );

    run = start(rig, PROMPT);
    await run.wait(120_000);
    const end = run.events.find(
      (e) =>
        e.type === "tool_call_end" &&
        JSON.stringify((e as { output?: unknown }).output ?? {}).includes("worker"),
    );
    conflictResult = (end?.output as Record<string, unknown>) ?? null;
  }, 180_000);

  test("the conflict is reported rather than silently dropped", () => {
    const output = must(conflictResult, "the worker tool result");
    const text = JSON.stringify(output);
    // Either the merge refused and said so, or it merged and the lead's line
    // survived: what must never happen is a silent loss of one of the two.
    const client = readFileSync(join(rig.fixture.root, "src", "client.ts"), "utf8");
    expect(text.length).toBeGreaterThan(0);
    expect(client).toContain("LEAD-EDIT while the worker ran");
  });

  test("a conflicted merge is a typed fact, not prose (G24)", () => {
    // The conflict used to exist only as `[MERGE CONFLICTS — …]` inside the
    // tool result's text, with `output.success` true, so no machine consumer
    // could tell a clean integration from a refused one.
    const output = must(conflictResult, "the worker tool result");
    const structured = (output.structured ?? {}) as Record<string, unknown>;
    expect(typeof structured.integration).toBe("string");
    expect(Array.isArray(structured.conflicts)).toBe(true);
    expect((structured.conflicts as string[]).length).toBeGreaterThan(0);
    // And it reaches a headless caller through the lifecycle's children.
    const lifecycle = (must(run?.envelope(), "the envelope").lifecycle ?? {}) as {
      children?: Array<{ conflicts?: string[]; integration?: string }>;
    };
    expect((lifecycle.children ?? []).some((c) => (c.conflicts ?? []).length > 0)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D — the two child-result cases. §5.5.
// ══════════════════════════════════════════════════════════════════════════

describe("a delegated child that runs out of turns", () => {
  let rig: Rig;
  let result = "";
  let structured: Record<string, unknown> | null = null;

  test("the scenario runs: a `task` child reads a different file every turn until its ceiling", async () => {
    const reads: MockAction[] = [];
    for (let i = 0; i < 14; i++) {
      reads.push(tool("read_file", { path: `docs/note-${(i % 4) + 1}.md` }));
    }
    rig = makeRig(
      "scenario-d1",
      {
        lead: [
          tool("task", {
            prompt: `${TASK_MARKER}: survey every note under docs/ and report what they say.`,
            label: "survey the notes",
            effort: "quick",
          }),
          { kind: "text", text: "The scout came back." },
        ],
        child: reads,
        summarizer: [{ kind: "text", text: "SUMMARY: a scout is surveying the notes." }],
        utility: [{ kind: "text", text: "ok" }],
      },
      { childMarker: TASK_MARKER },
    );
    const run = start(rig, "Survey the notes under docs/ with a sub-agent and report back.");
    await run.wait(180_000);
    const end = run.events.find(
      (e) => e.type === "tool_call_end" && JSON.stringify(e).includes("survey"),
    );
    const output = (end?.output ?? {}) as Record<string, unknown>;
    result = String(output.result ?? "");
    structured = (output.structured as Record<string, unknown>) ?? null;
  }, 240_000);

  test("no summary never erases the work: the partial report names the cause and the ground", () => {
    expect(result.length).toBeGreaterThan(0);
    expect(result.toUpperCase()).toContain("INCOMPLETE");
    expect(result.toLowerCase()).toMatch(/turn/);
    const s = must(structured, "the child's structured result");
    expect(s.stopReason).toBe("max_turns");
    expect(
      Array.isArray(s.filesExamined) ? (s.filesExamined as string[]).length : 0,
    ).toBeGreaterThan(0);
  });
});

describe("a delegated child that writes and then says nothing", () => {
  let rig: Rig;
  let structured: Record<string, unknown> | null = null;
  let envelope: S.HeadlessEnvelope | null = null;
  let result = "";

  test("the scenario runs: a worker makes two edits and returns an empty final completion", async () => {
    rig = makeRig("scenario-d2", {
      lead: [
        tool("worker", {
          files: ["src/client.ts", "src/extra.ts"],
          label: "wire the client",
          prompt: `${WORKER_MARKER}: wire version() into src/client.ts and add src/extra.ts.`,
        }),
        { kind: "text", text: "The worker came back." },
      ],
      child: [
        tool("read_file", { path: "src/client.ts" }),
        CHILD_EDIT_CLIENT,
        tool("write_file", {
          path: "src/extra.ts",
          content: "export const extra = true;\n",
        }),
        { kind: "empty" },
      ],
      summarizer: [{ kind: "text", text: "SUMMARY: a worker is wiring the client." }],
      utility: [{ kind: "text", text: "ok" }],
    });
    const run = start(rig, PROMPT);
    await run.wait(180_000);
    const end = run.events.find(
      (e) => e.type === "tool_call_end" && JSON.stringify(e).includes("wire the client"),
    );
    const output = (end?.output ?? {}) as Record<string, unknown>;
    result = String(output.result ?? "");
    structured = (output.structured as Record<string, unknown>) ?? null;
    envelope = run.envelope();
  }, 240_000);

  test("the run reports the edits it made, including the ones a worker authored", () => {
    // G23's acceptance criterion, measured on a run that completed: the
    // envelope's `filesChanged` counted `write_file|edit_file|multi_edit` only
    // (`headless.ts:166-173`), so a change made by a worker — the whole point
    // of dispatching one — reported as no change at all.
    const changed = new Set(must(envelope, "the envelope").filesChanged);
    expect(changed).toEqual(new Set(["src/client.ts", "src/extra.ts"]));
  });

  test("the harness's own record of the writes beats the model's silence", () => {
    const s = must(structured, "the child's structured result");
    const changed = (s.filesChanged as string[]) ?? [];
    expect(new Set(changed)).toEqual(new Set(["src/client.ts", "src/extra.ts"]));
    expect(s.confidence).toBe("low");
    const unresolved = (s.unresolved as string[]) ?? [];
    expect(unresolved.join(" ").toLowerCase()).toMatch(/summar|report/);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// E — bounded, observable failure. §3.4, §3.5 and the open-steps gate.
// ══════════════════════════════════════════════════════════════════════════

describe("a summarizer that fails every time", () => {
  let rig: Rig;
  let envelope: S.HeadlessEnvelope | null = null;
  let summarizerCalls = 0;
  let compactionEvents: Array<Record<string, unknown>> = [];

  test("the scenario runs: every non-streamed request is a 500 while the run keeps compacting", async () => {
    rig = makeRig("scenario-e1", {
      lead: [
        // Enough history for a fold to be possible, then the provider
        // rejects the prompt as over-limit — the one path that makes the
        // loop compact under real pressure rather than on request.
        tool("read_file", { path: "docs/note-1.md" }),
        tool("read_file", { path: "docs/note-2.md" }),
        tool("read_file", { path: "docs/note-3.md" }),
        tool("read_file", { path: "docs/note-4.md" }),
        { kind: "context_length", limit: 100_000 },
        { kind: "context_length", limit: 100_000 },
        { kind: "context_length", limit: 100_000 },
        { kind: "context_length", limit: 100_000 },
        { kind: "text", text: "Read the notes." },
      ],
      // §3.4's lever 1: the fake server 500s the `stream:false` request. It
      // is the only one that works across a process boundary.
      summarizer: [{ kind: "status", status: 500, message: "the summarizer is down" }],
      utility: [{ kind: "text", text: "ok" }],
    });
    const run = start(rig, "Read every note under docs/ and summarise what they say.");
    await run.wait(180_000);
    envelope = run.envelope();
    summarizerCalls = rig.server.countOf("summarizer");
    compactionEvents = run.events.filter((e) => e.type === "compaction") as Array<
      Record<string, unknown>
    >;
  }, 240_000);

  test("the failure is bounded and the run still ends with a verdict", () => {
    const env = must(envelope, "the envelope of the summarizer-failure run");
    expect(typeof env.stopReason).toBe("string");
    // Bounded: the recovery ladder tries a handful of candidates per
    // compaction (`context-engine.ts:1023-1026`), not an unbounded loop.
    expect(summarizerCalls).toBeGreaterThan(0);
    expect(summarizerCalls).toBeLessThan(60);
  });

  test("the compaction that had to proceed without a summary says how it coped", () => {
    // Bounded by `maxOverflowCompactions` (2), and each one is a typed event
    // rather than prose: the tier that actually did the work, the trigger that
    // asked for it, and a summarizedCount of zero because no summary arrived.
    expect(compactionEvents.length).toBeGreaterThan(0);
    expect(compactionEvents.length).toBeLessThanOrEqual(2);
    for (const event of compactionEvents) {
      expect(event.trigger).toBe("overflow");
      expect(event.forced).toBe(true);
      expect(event.tier).toBe("tool_results");
      expect(event.summarizedCount ?? 0).toBe(0);
    }
  });

  test(
    "S-2: a compaction whose summarizer FAILED but whose deterministic tier rescued it says so. " +
      "It used to be indistinguishable from a healthy eviction: G16 put `failed`/`failureReason` " +
      'on the event, but `evictInstead("summarizer failed")` returned a plain success, so ' +
      "`lastSummaryFailure` — which the engine already knew — reached no consumer, and three " +
      "summarizer 500s produced three clean `tier: tool_results` rows. Closed 2026-09-11: the " +
      "rescue carries `failureReason` (and NOT `failed`, which would route it to a " +
      "`compaction_failed` row that does not replace the replayed transcript).",
    () => {
      const attributed = compactionEvents.filter(
        (e) => e.failed === true || String(e.failureReason ?? "") !== "",
      );
      expect(attributed.length).toBeGreaterThan(0);
    },
  );
});

describe("a model that rejects the prompt as too long", () => {
  let rig: Rig;
  let coldRig: Rig;
  let envelope: S.HeadlessEnvelope | null = null;
  let coldEnvelope: S.HeadlessEnvelope | null = null;
  let leadCalls = 0;

  test("the scenario runs: every streamed request is refused for context length", async () => {
    rig = makeRig(
      "scenario-e2",
      {
        lead: [
          // One answered request first, and one that reports a real prompt
          // size. The preflight compares the FIXED prompt against the window
          // it knows, and it only knows the session model's window once a
          // response has reported usage — see the todo below.
          {
            kind: "tools",
            calls: [{ name: "read_file", args: { path: "src/api.ts" } }],
            usage: { prompt: 30_000, completion: 20 },
          },
          { kind: "context_length", limit: 8192 },
        ],
        utility: [{ kind: "text", text: "ok" }],
      },
      // An 8 192-token window, from the static family table. The system prompt
      // plus the tool schemas alone are several times that, so this IS the
      // overlarge-fixed-prompt case: nothing the loop is allowed to compact is
      // in the part that does not fit.
      { model: "llama3-fake-tiny" },
    );
    const run = start(rig, "Add a version() endpoint to src/api.ts.");
    await run.wait(180_000);
    envelope = run.envelope();
    leadCalls = rig.server.countOf("lead");

    // The same rejection, but on the very FIRST request of a fresh process —
    // which is when a fixed prompt that does not fit is most likely to be met.
    coldRig = makeRig(
      "scenario-e2-cold",
      {
        lead: [{ kind: "context_length", limit: 8192 }],
        utility: [{ kind: "text", text: "ok" }],
      },
      { model: "llama3-fake-tiny" },
    );
    const cold = start(coldRig, "Add a version() endpoint to src/api.ts.");
    await cold.wait(180_000);
    coldEnvelope = cold.envelope();
  }, 240_000);

  test("the run stops instead of retrying forever", () => {
    must(envelope, "the envelope of the context-length run");
    // The bound is what matters here: a handful of attempts, not a loop that
    // pays for a compaction per retry.
    expect(leadCalls).toBeGreaterThan(0);
    expect(leadCalls).toBeLessThan(30);
  });

  test("the overlarge fixed prompt is named, not reported as three generic errors (G15)", () => {
    const env = must(envelope, "the envelope of the context-length run");
    // The defect this replaces: three generic stream errors and then "Too many
    // consecutive errors (3)", naming neither the window nor the thing that
    // filled it, while the compaction machinery burned summarizer calls trying.
    expect(String(env.error ?? "")).toMatch(/window/i);
    expect(String(env.error ?? "")).not.toMatch(/too many consecutive errors/i);
    expect(env.ok).toBe(false);
  });

  test("the same rejection on a process's very first request is named too", () => {
    // Worth its own case: the preflight sizes the fixed prompt against
    // `contextSnapshot().limit`, and before any response has reported usage
    // that comes from `getContextLimit(summarizerModel || …)`
    // (`context-engine.ts:1146-1152`) rather than from a measurement. A cold
    // start is exactly when a prompt floor that does not fit is met, so the
    // fallback has to be the session model's own window — and it is.
    const cold = must(coldEnvelope, "the cold-start envelope");
    expect(String(cold.error ?? "")).toMatch(/window/i);
    expect(String(cold.error ?? "")).not.toMatch(/too many consecutive errors/i);
  });
});

describe("a run that ends with planned steps still open", () => {
  let rig: Rig;
  let envelope: S.HeadlessEnvelope | null = null;
  let exitCode = -1;

  test("the scenario runs: the model writes a four-step plan, closes one, and stops", async () => {
    rig = makeRig("scenario-e3", {
      lead: [
        tool("todo_write", todoList("in_progress", "pending", "pending", "pending")),
        READ_API,
        tool("todo_write", todoList("completed", "in_progress", "pending", "pending")),
        { kind: "text", text: "I have read the api. Stopping here." },
      ],
      summarizer: [{ kind: "text", text: "SUMMARY: one step of four is closed." }],
      utility: [{ kind: "text", text: "ok" }],
    });
    const run = start(rig, PROMPT);
    exitCode = await run.wait(180_000);
    envelope = run.envelope();
  }, 240_000);

  test("the open steps are on the durable spine", () => {
    const rows = S.readEvents(rig.home.dbPath);
    const state = must(S.latestTaskState(rows), "the spine of the open-steps run");
    expect(S.todosOf(state).some((t) => t.status !== "completed")).toBe(true);
  });

  test("a run with open steps is not reported as done (G21)", () => {
    // The defect this replaces: the finish path emitted `handoff("open_steps")`
    // and then fell through to `turn_complete{end_turn}`, and `UNFINISHED_STOP`
    // did not know the reason — so `rune -P --json` said ok:true and exited 0
    // for a run that stopped with planned steps open.
    const env = must(envelope, "the envelope of the open-steps run");
    expect(typeof env.stopReason).toBe("string");
    expect(env.stopReason).not.toBe("end_turn");
    expect(env.ok).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The proof that none of this COULD have spent anything.
//
// It used to be an arithmetic one: fingerprint the `cost` rows of the founder's
// own `~/.rune/rune.db` before and after, and assert the count did not move.
// That assertion is gone, because it was never a measurement of this process.
// The database is written and WAL-checkpointed by whatever else the founder is
// running — an `engine-host` alive for days, in the verification that caught
// this — so the count moved during two of three runs that spent nothing, and
// stood still during a third for reasons it had not earned.
//
// What is asserted instead is impossibility, in three layers: the scratch home
// has no route but the loopback mock, the child is launched holding no
// credential, and a real child asked from INSIDE a run reports the same of its
// own environment. The founder's ledger is still read, and still printed — as
// a diagnostic, plus the one thing about it this suite can honestly claim:
// nothing in it names this suite's model or its sessions.
// ══════════════════════════════════════════════════════════════════════════

describe("this suite could not have spent anything", () => {
  test("the scratch home's only configured route is the loopback mock", () => {
    for (const rig of rigs) {
      const secrets = JSON.parse(
        readFileSync(join(rig.home.path, "secrets.json"), "utf8"),
      ) as Record<string, { baseUrl?: string }>;
      expect(Object.keys(secrets)).toEqual(["custom"]);
      // Not "contains 127.0.0.1" — the whole endpoint, so a second route
      // alongside it could not pass.
      expect(secrets.custom?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      expect(secrets.custom?.baseUrl).toBe(rig.server.baseUrl);
      const model = JSON.parse(readFileSync(join(rig.home.path, "model.json"), "utf8")) as {
        provider?: string;
      };
      expect(model.provider).toBe("custom");
    }
  });

  test("every child was spawned with no provider credential in its environment", () => {
    // `spawnRun` calls this on every launch; this repeats it on the shape a
    // launch actually used.
    const rig = rigs[0]!;
    const env = S.curatedEnv(rig.home, rig.fixture, toolsBin);
    S.assertNoLiveCredentials(env);
    for (const name of S.CREDENTIAL_VARS) expect(env[name]).toBeUndefined();
    expect(env.RUNE_HOME).toBe(rig.home.path);
    expect(env.HOME).toBe(rig.home.osHome);
  });

  test("a real child, asked from inside a run, reports no provider key of its own", async () => {
    // Built rather than argued: the environment is read by a process the
    // engine spawned, through a tool call the model asked for, in a run this
    // suite drove end to end.
    const rig = makeRig("env-probe", {
      lead: [
        tool("bash", { command: "node env-probe.mjs" }),
        { kind: "text", text: "The environment is on disk." },
      ],
      summarizer: [{ kind: "text", text: "SUMMARY: probed the environment." }],
      utility: [{ kind: "text", text: "ok" }],
    });
    const probe = S.installEnvProbe(rig.fixture);
    const run = start(rig, `Run ${probe.command} and then stop.`);
    await run.wait(120_000);

    const seen = JSON.parse(readFileSync(probe.resultPath, "utf8")) as {
      names: string[];
      home: string;
      runeHome: string;
    };
    expect(seen.names.length).toBeGreaterThan(0);
    for (const name of S.CREDENTIAL_VARS) expect(seen.names).not.toContain(name);
    expect(seen.names.filter((n) => /_API_KEY$|_TOKEN$|_SECRET$/.test(n))).toEqual([]);
    // And it was reading the scratch home, not the founder's.
    expect(seen.runeHome).toBe(rig.home.path);
    expect(seen.home).toBe(rig.home.osHome);
    expect(seen.home).not.toBe(process.env.HOME);
  }, 180_000);

  test("the founder's own ledger names nothing this suite ran", () => {
    if (ledgerBefore === null) {
      // Stated, never silent: on a machine with no ~/.rune/rune.db there is
      // nothing to read, and the three assertions above still hold.
      console.log("~/.rune/rune.db is absent on this machine — nothing to read");
      expect(S.ledgerFingerprint()).toBeNull();
      return;
    }
    const after = must(S.ledgerFingerprint(), "the ledger after the suite");
    // The diagnostic. A difference here is other processes on this machine,
    // which is why it is printed and not asserted on.
    console.log(
      `~/.rune/rune.db cost rows ${ledgerBefore.rows} → ${after.rows}; ` +
        `newest ${ledgerBefore.newest ?? "none"} → ${after.newest ?? "none"}`,
    );
    // The claim that IS this suite's to make, by identity: no row written since
    // it started names its model or its provider, and no row anywhere belongs
    // to a session it created.
    const sessionIds = rigs.flatMap((rig) =>
      existsSync(rig.home.dbPath) ? S.listSessions(rig.home.dbPath).map((s) => s.id) : [],
    );
    expect(sessionIds.length).toBeGreaterThan(0);
    const mine = must(
      S.ledgerRowsAttributable({
        since: startedAt,
        // This suite's own model ids, which nothing else on the machine uses.
        // Not `"provider":"custom"`: a founder who configures a custom route
        // for their own work would fail this suite for using their machine.
        needles: ["fake-model", "llama3-fake-tiny"],
        sessionIds,
      }),
      "the attributable-row probe",
    );
    expect(mine).toEqual({ naming: 0, sessions: 0 });
  });
});
