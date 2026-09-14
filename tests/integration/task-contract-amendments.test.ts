// ─── A model amendment keeps what the user and the evaluator stated (M1, T4) ───
//
// The failure this file measures: a model that cannot meet a requirement drops
// it from its next read-back, and the contract it is judged against quietly
// becomes the work it managed to do. Before M1 that was not even visible — the
// read-back's `done_when` list REPLACED the contract's criteria wholesale, and
// a criterion the person had stated on turn one was gone on turn four with
// nothing anywhere recording that it had ever existed.
//
// Two scenarios, both real:
//
//   1. In process: the person edits the read-back (so its criteria become
//      `user`-sourced), the model reads back again with one of them missing,
//      and the runtime puts it back — on the contract, on the brief the ledger
//      holds, and in the amendment record as `kept`.
//   2. Across a SIGKILL: a run is killed mid-turn by the loopback mock at a
//      request boundary, and a `--resume` continues it. The constraints the
//      first run recorded and the revision count both survive, because a
//      crash is exactly what those fields exist to survive.
//
// Zero live model calls. Scenario 1 uses the in-process scripted provider
// under a scratch RUNE_HOME; scenario 2 uses `tests/helpers/scenario.ts`,
// whose child's only configured route is a loopback mock and whose
// environment is built rather than inherited (`assertNoLiveCredentials` runs
// before the process starts).
//
// Scenario 2 needs the sandbox off — `Bun.serve({port: 0})` fails with
// EADDRINUSE under the repository's restricted profile — and it needs the
// native tools binary, which it reports as a FAILURE rather than skipping.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent, Brief } from "../../packages/protocol/src/index";
import type { TaskContract } from "../../packages/orchestrator/src/contract";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";
import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

function toolsBinary(): string {
  const env = process.env.RUNE_TOOLS_BIN ?? process.env.RUNE_TOOLS_BINARY;
  if (env && existsSync(env)) return env;
  const bin = join(process.cwd(), "target", "debug", "rune-tools");
  if (!existsSync(bin)) throw new Error(`needs the native tools binary: ${bin}`);
  return bin;
}

function workspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  });
  return dir;
}

function makeEngine(dir: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: toolsBinary(),
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `m1a${++callSeq}`,
  toolName: name,
  toolInput: args,
});

async function drain(engine: Engine, sessionId: string, message: string): Promise<void> {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
}

function contractRows(engine: Engine, sessionId: string): TaskContract[] {
  return (engine as unknown as Internals).sessions
    .getEvents(sessionId, 1)
    .filter((r) => r.event.type === "contract")
    .map((r) => (r.event.payload as { contract: TaskContract }).contract);
}

// ─── 1. In process: the person states it, the model omits it, the runtime keeps it ───

const REQUEST = "Fix the exporter — it drops the last row.";
const USER_CRITERION = "the CSV header is unchanged";
const MODEL_CRITERION = "the exporter writes every row";

describe("a model amendment cannot drop what the person stated", () => {
  test("an omitted `user` criterion is kept, recorded, and still on the ledger", async () => {
    const dir = workspace("rune-m1-amend-");
    const engine = makeEngine(dir);

    // The person edits the read-back — which is what makes its criteria
    // theirs. Every criterion in an edited brief counts: leaving one standing
    // in a brief you are editing is stating it.
    let edits = 0;
    engine.setBriefHandler(async (brief: Brief) => {
      edits++;
      if (edits > 1) return { accepted: true };
      return {
        accepted: true,
        edited: {
          ...brief,
          criteria: [
            { text: MODEL_CRITERION, rung: null },
            { text: USER_CRITERION, rung: null },
          ],
        },
      };
    });

    const provider = new UsageProvider();
    (engine as unknown as Internals).gateway.registerProvider(provider);
    const turns: ContentBlock[][] = [
      [
        tool("read_back", {
          reading: "the export is dropping the last row",
          touch: ["export.ts"],
          leave: ["import.ts"],
          done_when: [MODEL_CRITERION],
        }),
      ],
      // The second read-back, in the SAME run, states only the criterion the
      // model can meet. This is the whole attack: a shorter contract, stated
      // confidently, on a turn nobody is watching as closely as the first.
      [
        tool("read_back", {
          reading: "the export is dropping the last row — narrowing",
          touch: ["export.ts"],
          leave: ["import.ts"],
          done_when: [MODEL_CRITERION],
        }),
      ],
      [{ type: "text", text: "Done." }],
    ];
    provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done." }];

    const session = engine.createSession();
    await drain(engine, session, REQUEST);

    const rows = contractRows(engine, session);
    const last = rows.at(-1)!;

    // The requirement is still in force, and it is still the person's.
    const kept = last.criteria.find((c) => c.text === USER_CRITERION);
    expect(kept).toBeDefined();
    expect(kept!.source).toBe("user");
    expect(kept!.id).toBeTruthy();
    // …and the model's own criterion kept its identity across the reword.
    expect(last.criteria.find((c) => c.text === MODEL_CRITERION)?.source).toBe("user");

    // The omission is a RECORDED fact, not a missing line.
    const amendment = last.amendments.filter((a) => a.kept.includes(USER_CRITERION)).at(-1);
    expect(amendment).toBeDefined();
    expect(amendment!.origin).toBe("model");

    // Constraints hold the `leave` list and everything the person stated.
    expect(last.constraints).toContain("import.ts");
    expect(last.constraints).toContain(USER_CRITERION);

    // The revision counts the amendments that changed something.
    expect(last.revision).toBeGreaterThan(1);

    // And the LEDGER holds it too — the contract and the thing
    // `record_evidence` indexes into must be the same list, or a criterion is
    // protected on the record and invisible to the run.
    expect(engine.currentLedger()?.criteria.map((c) => c.text)).toContain(USER_CRITERION);
  }, 60_000);

  test("the evaluator's own criteria are not the model's to cite", async () => {
    // The independent oracle: `record_evidence` refuses to move it, so the one
    // measurement the model cannot influence stays outside its reach.
    const dir = workspace("rune-m1-evaluator-cite-");
    const engine = makeEngine(dir);
    const provider = new UsageProvider();
    (engine as unknown as Internals).gateway.registerProvider(provider);
    const turns: ContentBlock[][] = [
      [
        tool("read_back", {
          reading: "the export is dropping the last row",
          touch: ["export.ts"],
          leave: ["import.ts"],
          done_when: [MODEL_CRITERION],
        }),
      ],
      [tool("bash", { command: "true # bun test" })],
      [tool("record_evidence", { criterion: 1, command: "true # bun test" })],
      [{ type: "text", text: "Done." }],
    ];
    provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done." }];

    const session = engine.createSession();
    // An evaluator criterion, planted the way `--acceptance` plants one: on
    // the ledger's own list, never rendered into a prompt.
    engine.setBriefHandler(async (brief: Brief) => ({
      accepted: true,
      edited: {
        ...brief,
        criteria: [
          ...brief.criteria,
          {
            text: "the exported CSV still has three columns",
            rung: null,
            source: "evaluator" as const,
            method: { kind: "command" as const, command: "true # acceptance" },
          },
        ],
      },
    }));

    const events: AgentTurnEvent[] = [];
    for await (const event of engine.chat(session, REQUEST)) events.push(event);

    const receipt = events
      .filter(
        (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> =>
          e.type === "tool_call_end" && e.output?.toolName === "record_evidence",
      )
      .map((e) => e.output?.result ?? "")
      .at(-1);
    expect(receipt).toContain("settled by the runtime's own run");
    // Nothing moved: the criterion is exactly where the model found it.
    const evaluator = engine.currentLedger()?.criteria.at(-1);
    expect(evaluator?.rung).toBeNull();
    expect(evaluator?.evidence).toBeUndefined();
  }, 60_000);
});

// ─── 2. Across a SIGKILL: constraints and revision survive a crash ───

const KILL_PROMPT =
  "Add a version() endpoint to src/api.ts and run node check.mjs. Leave src/notes.md alone.";

const LEAD_SCRIPT: MockAction[] = [
  // Turn 1: the read-back, which amends the contract and persists it.
  {
    kind: "tools",
    calls: [
      {
        name: "read_back",
        args: {
          reading: "src/api.ts has no version() endpoint",
          touch: ["src/api.ts"],
          leave: ["src/notes.md"],
          done_when: ["node check.mjs exits 0", "src/api.ts exports version()"],
        },
      },
    ],
  },
  // Turn 2: the child asks for its next step and is SIGKILLed instead. The
  // request is recorded before the signal, so "the kill landed after the
  // contract was written and before the run could finish" is a fact rather
  // than a sleep.
  { kind: "kill", signal: "SIGKILL" },
  // The resumed run: one plain answer, and the tail clamps on it.
  { kind: "text", text: "Picking up where the killed run left off. Nothing further to do." },
];

let dir = "";
let home: S.ScratchHome | null = null;
let server: ReturnType<typeof startMockModelServer> | null = null;
let first: S.Run | null = null;
let second: S.Run | null = null;
/** The crash signature, read BEFORE the resume writes its own markers. */
let diedWithoutClosing = false;
/** Contract rows as the killed run left them. */
let beforeResume: TaskContract[] = [];

beforeAll(async () => {
  const toolsBin = S.requireNativeBinary();
  dir = mkdtempSync(join(tmpdir(), "rune-m1-contract-restart-"));
  const workdir = join(dir, "run");
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  server = startMockModelServer({ script: { lead: LEAD_SCRIPT }, model: "fake-model" });
  home = S.makeScratchHome(workdir, { baseUrl: server.baseUrl, model: "fake-model" });

  first = S.spawnRun({ home, fixture, toolsBin, prompt: KILL_PROMPT });
  server.attach(first.proc);
  await server.waitForRole("lead", 2, 120_000);
  await first.wait(60_000);

  // A clean end appends `checkpoint: session_ended`; a SIGKILL runs no
  // `finally` at all, so an unmatched `session_started` IS the crash. Read it
  // here, before the resume writes markers of its own.
  const afterKill = S.readEvents(home.dbPath);
  const marks = afterKill.filter((r) => r.type === "checkpoint");
  diedWithoutClosing =
    marks.filter((r) => r.payload.summary === "session_started").length >
    marks.filter((r) => r.payload.summary === "session_ended").length;
  beforeResume = afterKill
    .filter((r) => r.type === "contract")
    .map((r) => (r.payload as { contract: TaskContract }).contract);

  const sessions = S.listSessions(home.dbPath);
  const sessionId = sessions.at(-1)?.id;
  if (!sessionId) throw new Error("the killed run wrote no session to resume");

  second = S.spawnRun({
    home,
    fixture,
    toolsBin,
    prompt: "Carry on — same task.",
    resume: sessionId,
  });
  server.attach(second.proc);
  await second.wait(180_000);
}, 420_000);

afterAll(() => {
  try {
    first?.kill();
    second?.kill();
  } catch {
    /* already gone */
  }
  server?.stop();
  rmTemp(dir);
});

/** Every persisted contract row in the scratch database, in log order. */
function persistedContracts(): TaskContract[] {
  return S.readEvents(home!.dbPath)
    .filter((r) => r.type === "contract")
    .map((r) => (r.payload as { contract: TaskContract }).contract);
}

describe("T4: constraints and revision survive a SIGKILL and a resume", () => {
  test("the killed run wrote a contract with the person's constraint on it", () => {
    expect(beforeResume.length).toBeGreaterThan(0);
    // The read-back landed before the kill, so the `leave` list is on the
    // record. This is the fact the resume has to carry.
    const beforeKill = beforeResume.find((c) => c.constraints?.includes("src/notes.md"));
    expect(beforeKill).toBeDefined();
    expect(beforeKill!.revision).toBeGreaterThan(1);
    // …and the run really died rather than finishing: no `session_ended`.
    expect(diedWithoutClosing).toBe(true);
  });

  test("the resumed run inherits them rather than starting from a clean slate", () => {
    const rows = persistedContracts();
    const last = rows.at(-1)!;
    // A NEW contract — its intent is the resume message, verbatim, and the
    // runtime never rewrites that — carrying the earlier run's record.
    expect(last.intent).toBe("Carry on — same task.");
    expect(last.constraints).toContain("src/notes.md");
    expect(last.revision).toBeGreaterThan(1);
    // The criteria came back too, through the restored brief.
    expect(last.criteria.map((c) => c.text)).toContain("node check.mjs exits 0");
  });

  test("it spent nothing: every model call went to the loopback mock", () => {
    expect(server!.requests.length).toBeGreaterThan(0);
    expect(server!.requests.every((r) => r.model === "fake-model")).toBe(true);
  });
});
