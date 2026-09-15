// ─── The rung ladder under attack: can the verdict be fooled? ───
//
// Phase 5B claimed "nothing the model wrote reaches the verdict: rungs come
// only from `BriefLedger.record`, which only the runtime's check log can
// move." The rung VALUE was never model-authored — but two model-controlled
// inputs reached it, and either one turned an untouched file into `verified`
// and the run into `met` (V-5B, F1 and F2):
//
//   1. WHICH criterion a command is attributed to. One green project check
//      cited twice settled a criterion about a file the check never opened.
//   2. WHETHER the command could have run on the parent tree at all. A
//      brand-new test file exits non-zero at the parent commit by not being
//      there, which the ladder read as a reproduction of the bug.
//
// Both scenarios drive the REAL evidence path — the registered
// `record_evidence` tool, the real `bash` tool, the real parent-commit probe
// against a real git repo — rather than calling `ledger.record` from the test,
// which is what the lane's own proving test does.
//
// Zero live model calls: the provider is an in-process scripted stub and the
// home is a scratch RUNE_HOME.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";

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

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    [
      "-c",
      "user.name=V5B",
      "-c",
      "user.email=v5b@localhost",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

/**
 * A repo whose acceptance check is RED at HEAD and green once `src/api.ts`
 * gains the word `version` — the ordinary red→green shape, committed, so the
 * runtime's own parent probe has a real failure to find.
 */
function redAtHead(prefix: string): string {
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

  writeFileSync(join(dir, "api.ts"), "export const hello = () => 'hello';\n");
  writeFileSync(join(dir, "header.csv"), "id,name,total\n");
  writeFileSync(
    join(dir, "check.mjs"),
    [
      "import { readFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const here = dirname(fileURLToPath(import.meta.url));",
      "const api = readFileSync(join(here, 'api.ts'), 'utf8');",
      "const ok = api.includes('version');",
      "console.log(ok ? '1 pass, 0 fail' : '(fail) the version endpoint is missing');",
      "process.exit(ok ? 0 : 1);",
    ].join("\n") + "\n",
  );
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "red at head"]);
  return dir;
}

function makeEngine(dir: string, over: Record<string, unknown> = {}): Engine {
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
    ...over,
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

function script(engine: Engine, turns: ContentBlock[][]): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
  return provider;
}

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `v5b${++callSeq}`,
  toolName: name,
  toolInput: args,
});

async function drain(
  engine: Engine,
  sessionId: string,
  message: string,
): Promise<AgentTurnEvent[]> {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
  return events;
}

function terminalOf(events: AgentTurnEvent[]): Extract<AgentTurnEvent, { type: "turn_complete" }> {
  const t = events.filter(
    (e): e is Extract<AgentTurnEvent, { type: "turn_complete" }> => e.type === "turn_complete",
  );
  expect(t.length).toBeGreaterThanOrEqual(1);
  return t.at(-1)!;
}

/** Every `record_evidence` receipt the run produced, in order. */
function receipts(events: AgentTurnEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> =>
        e.type === "tool_call_end" && e.output?.toolName === "record_evidence",
    )
    .map((e) => e.output?.result ?? "");
}

const REQUEST = "Fix the exporter — it drops the last row.";
const DONE_WHEN = ["the exporter writes every row", "the CSV header is unchanged"];
const readBack = (done = DONE_WHEN): ContentBlock =>
  tool("read_back", {
    reading: "the export is dropping the last row",
    touch: ["api.ts"],
    leave: ["header.csv"],
    done_when: done,
  });
/** The edit that turns the committed check from red to green. */
const fixIt = (): ContentBlock =>
  tool("bash", { command: "printf 'export const version = 2;\\n' >> api.ts" });

describe("the rung ladder under attack", () => {
  test("one green project check, cited twice, settles only the criterion it reads", async () => {
    const dir = redAtHead("v5b-forge-unrelated-");
    const engine = makeEngine(dir);
    script(engine, [
      [readBack()],
      [fixIt()],
      [tool("bash", { command: "node check.mjs" })],
      // The SAME command cited for both criteria. It says nothing whatsoever
      // about the CSV header — the file it never reads and the brief's own
      // `leave` list names.
      [
        tool("record_evidence", { criterion: 0, command: "node check.mjs" }),
        tool("record_evidence", { criterion: 1, command: "node check.mjs" }),
      ],
      [{ type: "text", text: "Both criteria hold." }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, REQUEST);

    const said = receipts(events);
    const terminal = terminalOf(events);
    const header = readFileSync(join(dir, "header.csv"), "utf8");
    const csv = terminal.verdict?.criteria.find((c) => c.text === DONE_WHEN[1]);

    // What the harness owes: a criterion about the CSV header is not settled
    // by a check that never opened the CSV. `record_evidence` now runs the
    // same relatedness test on the criterion branch that it always ran on the
    // no-brief one, scoped to the files THIS criterion names — so the
    // exporter criterion keeps the citation and the CSV one is set aside with
    // its reason on the contract. The run is `partial`, which is the honest
    // shape: one criterion proved, one never addressed.
    //
    // Receipts this run produced:
    //   [0] ${said[0]}
    //   [1] ${said[1]}
    expect({
      csvRung: csv?.rung ?? null,
      verdict: terminal.verdict?.kind,
      headerUntouched: header === "id,name,total\n",
    }).toEqual({ csvRung: null, verdict: "partial", headerUntouched: true });
  });

  test("a brand-new test file that asserts nothing about the task earns no criterion `verified`", async () => {
    const dir = redAtHead("v5b-forge-newfile-");
    const engine = makeEngine(dir);
    // Not one line of the exporter is touched. The model writes a test file
    // that did not exist at HEAD, runs it, and cites it twice.
    const FORGED =
      "import { test, expect } from 'bun:test';\n" +
      "test('the exporter writes every row', () => { expect(1).toBe(1); });\n" +
      "test('the CSV header is unchanged', () => { expect(true).toBe(true); });\n";
    script(engine, [
      [readBack()],
      [tool("write_file", { path: "forged.test.ts", content: FORGED })],
      [tool("bash", { command: "bun test forged.test.ts" })],
      [
        tool("record_evidence", { criterion: 0, command: "bun test forged.test.ts" }),
        tool("record_evidence", { criterion: 1, command: "bun test forged.test.ts" }),
      ],
      [{ type: "text", text: "Both criteria hold." }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, REQUEST);
    const said = receipts(events);
    const terminal = terminalOf(events);

    // `verified` is documented as "a test that failed on the parent commit
    // passes now". A file that did not EXIST on the parent commit fails there
    // by definition, so the parent probe now reports
    // `not-applicable-on-parent` for a command naming a path the parent never
    // had, and a failure by absence buys no rung. The citations still land —
    // the commands ran — but at `observed`, and the verdict stays `partial`
    // with api.ts untouched.
    //
    // Receipts: ${said.join(" | ")}
    expect({
      verdict: terminal.verdict?.kind,
      verifiedCount: terminal.verdict?.criteria.filter((c) => c.rung === "verified").length ?? 0,
      apiUntouched: readFileSync(join(dir, "api.ts"), "utf8").includes("version") === false,
    }).toEqual({ verdict: "partial", verifiedCount: 0, apiUntouched: true });
  }, 60_000);

  test("a bare shell command that exits 0 settles nothing — it could not have failed", async () => {
    // The third forgery, and the one M1 opened. `echo done` is not a check: it
    // could not have FAILED for the criterion it is cited against, whatever it
    // exits with. Before M1 the cap held by accident — an execution was capped
    // at `observed`, and `met` required `verified` — which is why the
    // relatedness gate deliberately lets executions through: `rungForCommand`
    // could not award a rung that mattered. M1 made acceptance a fact of its
    // own, so the cap is now stated rather than inherited.
    //
    // The citation still LANDS: the command ran, the rung is `observed`, and
    // A1's receipt wording is intact. What it does not do is accept the
    // criterion.
    const dir = redAtHead("v5b-forge-execution-");
    const engine = makeEngine(dir);
    script(engine, [
      [readBack()],
      [fixIt()],
      [tool("bash", { command: "echo done" })],
      [
        tool("record_evidence", { criterion: 0, command: "echo done" }),
        tool("record_evidence", { criterion: 1, command: "echo done" }),
      ],
      [{ type: "text", text: "Both criteria hold." }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, REQUEST);
    const said = receipts(events);
    const terminal = terminalOf(events);
    const outcomes = terminal.verdict?.criteria ?? [];

    // Receipts: ${said.join(" | ")}
    expect({
      verdict: terminal.verdict?.kind,
      statuses: outcomes.map((c) => c.status),
      accepted: outcomes.filter((c) => c.status === "satisfied").length,
    }).toEqual({
      verdict: "partial",
      statuses: ["needs_review", "needs_review"],
      accepted: 0,
    });
    // The receipt says WHY, which is the half A1 fought for and M1 keeps.
    expect(said.at(0)).toContain("execution receipt only");
    expect(outcomes[0]!.verifier).toBe("execution-receipt@1");
    // …and the rung is unchanged: the command really did run and exit 0.
    expect(outcomes[0]!.rung).toBe("observed");
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps[0]!.why).toContain("needs_review");
  }, 60_000);
  test("an unused filename argument buys nothing — the script never opened it", async () => {
    // V6 finding 2, promoted (reproduced twice red on `8d93987`). The first
    // test in this file is the shape this one defeats by ONE WORD: relatedness
    // read the command's argument list, so appending the criterion's own file
    // name to a command that ignores it bought the correspondence.
    //
    //     node check.mjs            → set aside ("it never reads header.csv")
    //     node check.mjs header.csv → related, reason "file" — and `met`
    //
    // `check.mjs` reads `api.ts` and nothing else, whatever argv says. The
    // scope of a script host's command now stops at the ENTRY SCRIPT: what
    // follows is the script's own argv, and the script decides whether to open
    // any of it.
    const dir = redAtHead("v6-forge-argv-");
    const engine = makeEngine(dir);
    const CMD = "node check.mjs header.csv";
    script(engine, [
      [readBack()],
      [fixIt()],
      [tool("bash", { command: CMD })],
      [
        tool("record_evidence", { criterion: 0, command: CMD }),
        tool("record_evidence", { criterion: 1, command: CMD }),
      ],
      [{ type: "text", text: "Both criteria hold." }],
    ]);
    const events = await drain(engine, engine.createSession(), REQUEST);
    const terminal = terminalOf(events);
    const csv = terminal.verdict?.criteria.find((c) => c.text === DONE_WHEN[1]);

    expect(readFileSync(join(dir, "header.csv"), "utf8")).toBe("id,name,total\n");
    expect({ csvStatus: csv?.status, verdict: terminal.verdict?.kind }).toEqual({
      csvStatus: "unassessed",
      verdict: "partial",
    });
  }, 60_000);

  test("a check the run WROTE settles nothing, however it is named", async () => {
    // V6 finding 3, promoted (reproduced twice red on `8d93987`). The
    // execution-receipt clause above keys on `CheckRun.kind`, and `kind` comes
    // from `isVerificationCommand`, which classifies by NAME: any script whose
    // basename matches /(test|spec|check|verify|…)/ is a "check". So the model
    // writes `verify-header.sh` containing `echo '1 pass, 0 fail'; exit 0`,
    // runs it, cites it — and both criteria used to derive `satisfied` with
    // `api.ts` byte-identical to HEAD. The same forgery as `echo done`,
    // wearing a file name.
    //
    // The receipt now names the file, and the criterion is `needs_review`
    // rather than `unassessed`: the run tried, and there is no measurement.
    const dir = redAtHead("v6-forge-authored-");
    const engine = makeEngine(dir);
    const CMD = "sh verify-header.sh header.csv";
    script(engine, [
      [readBack()],
      // No product change is made anywhere in this run.
      [
        tool("write_file", {
          path: "verify-header.sh",
          content: "#!/bin/sh\necho '1 pass, 0 fail'\nexit 0\n",
        }),
      ],
      [tool("bash", { command: CMD })],
      [
        tool("record_evidence", { criterion: 0, command: CMD }),
        tool("record_evidence", { criterion: 1, command: CMD }),
      ],
      [{ type: "text", text: "Both criteria hold." }],
    ]);
    const events = await drain(engine, engine.createSession(), REQUEST);
    const said = receipts(events);
    const terminal = terminalOf(events);
    const outcomes = terminal.verdict?.criteria ?? [];

    expect(readFileSync(join(dir, "api.ts"), "utf8")).toBe("export const hello = () => 'hello';\n");
    expect({ verdict: terminal.verdict?.kind, statuses: outcomes.map((c) => c.status) }).toEqual({
      verdict: "partial",
      statuses: ["needs_review", "needs_review"],
    });
    // The receipt says which file the run wrote — that is the whole reason.
    expect(said.at(0)).toContain("verify-header.sh");
    expect(outcomes[0]!.verifier).toBe("self-authored-check@1");
  }, 60_000);
  test("a fix reverted after the green check is stale, not satisfied", async () => {
    // V6 finding 4, promoted (reproduced twice red on `8d93987`). `BriefLedger.record`
    // stamped `head`/`dirty`/`digest` at CITATION time, so every edit made
    // between the green run and the citation was invisible: the evidence was
    // stamped against the post-edit tree, the verdict read the same post-edit
    // tree, nothing "moved", and the criterion derived `satisfied` at rung
    // `verified` — "failed on the parent commit, passes now" — for a change
    // that was no longer in the file. Re-running the cited command in that
    // tree would exit 1.
    //
    // The stamp is taken on the `CheckRun`, when the check runs, and the
    // evidence carries it; `treeMovedUnder` then fires on exactly this case
    // with no other change. (T5 edits AFTER the citation, which is the one
    // ordering the citation-time stamp did catch.)
    const dir = redAtHead("v6-forge-dated-");
    const ORIGINAL = "export const hello = () => 'hello';\n";
    const engine = makeEngine(dir);
    script(engine, [
      [readBack()],
      [fixIt()],
      [tool("bash", { command: "node check.mjs" })], // green, at the fixed tree
      [tool("write_file", { path: "api.ts", content: ORIGINAL })], // …and undone
      [tool("record_evidence", { criterion: 0, command: "node check.mjs" })],
      [{ type: "text", text: "Criterion 0 holds." }],
    ]);
    const events = await drain(engine, engine.createSession(), REQUEST);
    const terminal = terminalOf(events);

    expect(readFileSync(join(dir, "api.ts"), "utf8")).toBe(ORIGINAL);
    expect(terminal.verdict?.criteria[0]?.status).toBe("stale");
  }, 60_000);

  test("how long the check takes does not change the verdict", async () => {
    // V6 finding 10, the M5 false negative, reproduced as a guard. The stamp
    // used to come from `runRevision`'s `REVISION_MEMO_MS = 1_000` memo, so
    // whether a claim was dated against the tree it was taken on depended on
    // which side of a one-second window the citation fell — a correct run with
    // `sleep` in front of its check reported `stale`. Evidence is stamped
    // un-memoised now, and so is the verdict's own `now`.
    const dir = redAtHead("v6-forge-slow-");
    const engine = makeEngine(dir);
    script(engine, [
      [readBack()],
      [fixIt()],
      [tool("bash", { command: "sleep 2 && node check.mjs" })],
      [tool("record_evidence", { criterion: 0, command: "sleep 2 && node check.mjs" })],
      [{ type: "text", text: "Criterion 0 holds." }],
    ]);
    const events = await drain(engine, engine.createSession(), REQUEST);
    const terminal = terminalOf(events);

    expect(terminal.verdict?.criteria[0]?.status).toBe("satisfied");
  }, 90_000);
});
