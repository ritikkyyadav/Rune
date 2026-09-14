// ─── T1: a known omitted feature fails acceptance despite green tests ───
//
// The first question the guarantees review asks, and the one the harness could
// not answer before M1: every criterion on a run came from the model's own
// read-back, so the account of what "done" meant was written by the thing
// being measured. A model that builds one of two features and reads back one
// criterion ends `met` with its own tests green, and nothing anywhere
// disagrees.
//
// `--acceptance` is the independent oracle. Two criteria stated OUTSIDE the
// run, each with its own command; the model is told nothing about them, cannot
// cite them, and never sees their text. The runtime runs both itself at the
// finish gate.
//
// Also here, because they are the same machinery under attack from the other
// side (`m1-acceptance-semantics.md`, FP and FN):
//
//   FP  an acceptance command that exits 0 without running anything derives
//       `needs_review`, never `satisfied`.
//   FN  an acceptance command whose runner is missing derives `needs_review`,
//       the gap says why, and the verdict is `partial` — not `unmet`.
//
// Zero live model calls: an in-process scripted provider under a scratch
// RUNE_HOME. `~/.rune/rune.db` is never opened.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type { AcceptanceSpec } from "../../packages/orchestrator/src/contract";
import { Engine } from "../../packages/orchestrator/src/engine";
import { verdictLine } from "../../packages/orchestrator/src/contract";
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
    ["-c", "user.name=M1", "-c", "user.email=m1@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

/**
 * A repository asked for TWO features, with an independent check for each.
 *
 * `check-version.mjs` and `check-header.mjs` are the acceptance file's
 * commands. Neither is mentioned to the model, and the model's own test file
 * (`mine.test.ts`) is green from the moment it is written — which is exactly
 * the shape the review names: green existing tests over an omitted feature.
 */
function twoFeatureRepo(prefix: string): string {
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
  writeFileSync(join(dir, "header.csv"), "id,name\n");
  const checker = (file: string, needle: string, name: string) =>
    [
      "import { readFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const here = dirname(fileURLToPath(import.meta.url));",
      `const text = readFileSync(join(here, '${file}'), 'utf8');`,
      `const ok = text.includes('${needle}');`,
      `console.log(ok ? '1 pass, 0 fail' : '(fail) ${name}');`,
      "process.exit(ok ? 0 : 1);",
    ].join("\n") + "\n";
  writeFileSync(join(dir, "check-version.mjs"), checker("api.ts", "version", "version() missing"));
  writeFileSync(join(dir, "check-header.mjs"), checker("header.csv", "total", "total column missing"));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "two features asked for, neither built"]);
  return dir;
}

function makeEngine(dir: string, acceptance: AcceptanceSpec[]): Engine {
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
    acceptance,
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `m1c${++callSeq}`,
  toolName: name,
  toolInput: args,
});

/** The scripted provider, and every request body it was sent. */
function script(engine: Engine, turns: ContentBlock[][]): { bodies: string[] } {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  const bodies: string[] = [];
  provider.onRequest = (request, index) => {
    bodies.push(JSON.stringify(request));
    return turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
  };
  return { bodies };
}

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

const REQUEST = "Add a version() endpoint and a total column to the CSV header.";
const VERSION_TEXT = "api.ts exports version()";
const HEADER_TEXT = "header.csv has a total column";
const ACCEPTANCE: AcceptanceSpec[] = [
  { id: "a1", text: VERSION_TEXT, command: "node check-version.mjs" },
  { id: "a2", text: HEADER_TEXT, command: "node check-header.mjs" },
];

describe("T1: the independent oracle catches what the model left out", () => {
  test("one feature built, its own tests green — and the run is `partial`", async () => {
    const dir = twoFeatureRepo("m1-omission-");
    const engine = makeEngine(dir, ACCEPTANCE);
    // The model reads back ONE criterion — its own account of the task, which
    // is the half it intends to do — builds it, writes a test that passes,
    // runs it, cites it, and declares itself finished.
    const { bodies } = script(engine, [
      [
        tool("read_back", {
          reading: "add a version endpoint",
          touch: ["api.ts"],
          leave: [],
          done_when: ["the version endpoint exists"],
        }),
      ],
      [tool("bash", { command: "printf 'export const version = 2;\\n' >> api.ts" })],
      [
        tool("write_file", {
          path: "mine.test.ts",
          content:
            "import { test, expect } from 'bun:test';\n" +
            "test('version is exported', () => { expect(1).toBe(1); });\n",
        }),
      ],
      [tool("bash", { command: "bun test mine.test.ts" })],
      [tool("record_evidence", { criterion: 0, command: "bun test mine.test.ts" })],
      [{ type: "text", text: "The version endpoint is in and the tests are green." }],
    ]);

    const session = engine.createSession();
    const events = await drain(engine, session, REQUEST);
    const terminal = terminalOf(events);
    const outcomes = terminal.verdict?.criteria ?? [];

    const version = outcomes.find((c) => c.text === VERSION_TEXT);
    const header = outcomes.find((c) => c.text === HEADER_TEXT);

    // The feature the model DID build passes its independent check; the one it
    // never mentioned fails, with a receipt, and the run is honest about it.
    expect({
      verdict: terminal.verdict?.kind,
      version: version?.status,
      header: header?.status,
      versionVerifier: version?.verifier,
      headerCsv: readFileSync(join(dir, "header.csv"), "utf8"),
    }).toEqual({
      verdict: "partial",
      version: "satisfied",
      header: "failed",
      versionVerifier: "acceptance-command@1",
      headerCsv: "id,name\n",
    });

    // How the RUN ended is reported separately from what it achieved.
    expect(terminal.verdict?.execution).toEqual({ stopReason: "end_turn", status: "end_turn" });

    // The gap names the criterion and what was seen.
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps.some((g) => g.criterion === HEADER_TEXT && g.why.startsWith("failed:"))).toBe(true);

    // ── The property that makes this an ORACLE ──
    //
    // If the acceptance text reached a prompt, a model could read the task off
    // its own context and the check would measure nothing but its compliance.
    // Every outgoing request body, searched for both criteria and both
    // commands.
    for (const needle of [VERSION_TEXT, HEADER_TEXT, "check-version.mjs", "check-header.mjs"]) {
      expect(bodies.some((b) => b.includes(needle))).toBe(false);
    }
    expect(bodies.length).toBeGreaterThan(0);
  }, 90_000);

  test("both features built: the oracle agrees, and the verdict is `met`", async () => {
    const dir = twoFeatureRepo("m1-omission-met-");
    const engine = makeEngine(dir, ACCEPTANCE);
    script(engine, [
      [
        tool("read_back", {
          reading: "add both",
          touch: ["api.ts", "header.csv"],
          leave: [],
          done_when: ["both features are in"],
        }),
      ],
      [
        tool("bash", {
          command:
            "printf 'export const version = 2;\\n' >> api.ts && printf 'id,name,total\\n' > header.csv",
        }),
      ],
      [tool("bash", { command: "node check-version.mjs" })],
      [tool("record_evidence", { criterion: 0, command: "node check-version.mjs" })],
      [{ type: "text", text: "Both are in." }],
    ]);
    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, REQUEST));
    const outcomes = terminal.verdict?.criteria ?? [];
    expect(outcomes.map((c) => c.status)).toEqual(["satisfied", "satisfied", "satisfied"]);
    expect(terminal.verdict?.kind).toBe("met");
    // Neither ACCEPTANCE criterion was attributed to a regression — the
    // runtime ran their commands here and nowhere else, and neither needed a
    // failing parent to be accepted. The model's own criterion did earn one
    // (it cited a check that really was red at HEAD), and the line says so
    // beside the count instead of in place of it.
    expect(outcomes.filter((c) => c.attribution === "regression").map((c) => c.text)).toEqual([
      "both features are in",
    ]);
    expect(verdictLine(terminal.verdict!)).toBe(
      "[verdict] met — 3 of 3 accepted (1 regression-attributed)",
    );
  }, 90_000);
});

describe("an acceptance command that could not measure anything", () => {
  test("FP: it exits 0 having run nothing — `needs_review`, never `satisfied`", async () => {
    const dir = twoFeatureRepo("m1-fp-");
    // The classic false positive: a green exit that asserted nothing. `bun
    // test` on a file with no tests in it exits 0 and prints `0 pass 0 fail`.
    writeFileSync(join(dir, "nothing.test.ts"), "// deliberately empty\n");
    const engine = makeEngine(dir, [
      { id: "a1", text: "the exporter is covered", command: "bun test nothing.test.ts" },
    ]);
    script(engine, [[{ type: "text", text: "Nothing to do." }]]);
    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, REQUEST));
    const outcome = terminal.verdict?.criteria[0];
    expect(outcome?.status).toBe("needs_review");
    expect(outcome?.verifier).toBe("acceptance-command@1");
    expect(terminal.verdict?.kind).toBe("partial");
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps[0]!.why).toContain("did not run here");
  }, 90_000);

  test("FN: the runner is missing — `needs_review` and `partial`, not `unmet`", async () => {
    const dir = twoFeatureRepo("m1-fn-");
    const engine = makeEngine(dir, [
      {
        id: "a1",
        text: "the python suite is green",
        command: "rune-no-such-runner-9c1d check .",
      },
    ]);
    script(engine, [[{ type: "text", text: "Nothing to do." }]]);
    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, REQUEST));
    const outcome = terminal.verdict?.criteria[0];
    // A broken toolchain is not broken work: `failed` here would report the
    // machine's missing python as the change's fault.
    expect(outcome?.status).toBe("needs_review");
    expect(terminal.verdict?.kind).toBe("partial");
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps[0]!.why).toContain("needs_review");
    expect(gaps[0]!.why).toContain("did not run here");
  }, 90_000);

  test("a `review` criterion is never settled by the runtime at all", async () => {
    const dir = twoFeatureRepo("m1-review-");
    const engine = makeEngine(dir, [{ id: "a1", text: "the error copy reads well" }]);
    script(engine, [[{ type: "text", text: "Nothing to do." }]]);
    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, REQUEST));
    expect(terminal.verdict?.criteria[0]?.status).toBe("needs_review");
    // No command, so nothing ran and nothing pretended to.
    expect(terminal.verdict?.criteria[0]?.verifier).toBeUndefined();
  }, 90_000);
});
