// ─── T2 and T6: what a legitimate new feature is worth, and what a cut-off run is ───
//
// T2 is the defect §3 of the guarantees review names from the other side.
// `verified` means "this same check FAILED on the parent commit and passes
// now", and `computeVerdict` required every criterion at `verified` for `met`.
// A new feature has nothing to fail on a parent commit — the feature was not
// there — so a run that built exactly what was asked, wrote a test for it, ran
// it and cited it could not reach `met` by construction. The only way to a
// green verdict was to manufacture a failing parent, which is the harness
// teaching the model to fake a regression.
//
// M1 separates the facts: the rung still means what it meant, and ACCEPTANCE
// is derived from a bound, fresh, passing check. The attribution rides the
// outcome as `none` and gates nothing.
//
// T6 is the other half of honesty: a run cut off at its turn ceiling with one
// criterion satisfied is `partial` AND `budget`. The model's text survives in
// the envelope, because a partial result that is thrown away is worse than one
// that is labelled.
//
// Zero live model calls: an in-process scripted provider under a scratch
// RUNE_HOME.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { runHeadless } from "../../packages/orchestrator/src/headless";
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
 * A repository with NO defect in it — the ordinary green codebase a feature
 * lands in. Nothing here fails at HEAD, which is precisely why `verified` was
 * unreachable and why the old `met` rule could not describe this run.
 */
function greenRepo(prefix: string): string {
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
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "a green repository with no version endpoint yet"]);
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

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `m1n${++callSeq}`,
  toolName: name,
  toolInput: args,
});

function script(engine: Engine, turns: ContentBlock[][]): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
  return provider;
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

const FEATURE_REQUEST = "Add a version() endpoint to api.ts.";
// Deliberately names no file. `criterionScope` narrows relatedness to the
// files a criterion's own words identify, so a criterion that says "api.ts"
// is settled only by a check whose command names api.ts — and the check for a
// new feature is a NEW TEST FILE, which names itself. That gate is F-5B's and
// it is doing its job; this criterion is written the way a criterion about
// behaviour is written.
const CRITERION = "the version endpoint is exported";

/** The test the model writes for its own new feature. It reads the file. */
const NEW_TEST =
  "import { test, expect } from 'bun:test';\n" +
  "import { readFileSync } from 'node:fs';\n" +
  "test('api.ts exports version()', () => {\n" +
  "  expect(readFileSync(new URL('./api.ts', import.meta.url), 'utf8')).toContain('version');\n" +
  "});\n";

describe("T2: a legitimate new feature passes without a failing parent", () => {
  test("cited once, parent probe not applicable → `satisfied`, attribution `none`, verdict `met`", async () => {
    const dir = greenRepo("m1-new-feature-");
    const engine = makeEngine(dir);
    script(engine, [
      [
        tool("read_back", {
          reading: "add a version endpoint",
          touch: ["api.ts"],
          leave: [],
          done_when: [CRITERION],
        }),
      ],
      [tool("bash", { command: "printf 'export const version = 2;\\n' >> api.ts" })],
      [tool("write_file", { path: "version.test.ts", content: NEW_TEST })],
      [tool("bash", { command: "bun test version.test.ts" })],
      // Cited ONCE. The parent probe answers `not-applicable-on-parent` —
      // `version.test.ts` did not exist at the parent commit — so the rung
      // stays `observed` and no regression was ever measured.
      [tool("record_evidence", { criterion: 0, command: "bun test version.test.ts" })],
      [{ type: "text", text: "version() is in and its test passes." }],
    ]);

    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, FEATURE_REQUEST));
    const outcome = terminal.verdict?.criteria[0];

    // ── This read `met` / `satisfied` until V8 critical 4 ──
    //
    // The run writes `version.test.ts` and cites `bun test version.test.ts`:
    // the measured thing grading itself with an oracle it authored, which is
    // V7 finding 8's own shape. The defence for it was built and never
    // reached, because `commandProgramPaths` returned `[]` for every test
    // runner — so `authoredThisTask` returned immediately, `authoredBy` was
    // never set, and this scenario passed the gate that exists to refuse it.
    //
    // The rung is unchanged in meaning and still tells the reader how strong
    // the receipt is: `observed`, not `verified`, because nothing failed on
    // the parent. That is a fact ABOUT the receipt, not the refusal — the
    // refusal is the verifier, and it is not a rung question.
    expect({
      verdict: terminal.verdict?.kind,
      status: outcome?.status,
      attribution: outcome?.attribution,
      rung: outcome?.rung,
      verifier: outcome?.verifier,
      source: outcome?.source,
    }).toEqual({
      verdict: "partial",
      status: "needs_review",
      attribution: "none",
      rung: "observed",
      verifier: "self-authored-check@1",
      source: "inferred",
    });
    expect(outcome?.executionId).toMatch(/^chk-\d+$/);
    // A person is told which file, so they can look at it and decide.
    expect(JSON.stringify(terminal.verdict)).toContain("version.test.ts");
  }, 90_000);

  test("T5: an edit AFTER the evidence makes the claim stale, and the run `partial`", async () => {
    // The same run, plus one more write. The receipt was taken against a tree
    // that no longer exists, so the criterion is `stale` rather than
    // `satisfied` — which is the difference between a claim and a memory.
    const dir = greenRepo("m1-stale-");
    const engine = makeEngine(dir);
    script(engine, [
      [
        tool("read_back", {
          reading: "add a version endpoint",
          touch: ["api.ts"],
          leave: [],
          done_when: [CRITERION],
        }),
      ],
      [tool("bash", { command: "printf 'export const version = 2;\\n' >> api.ts" })],
      [tool("write_file", { path: "version.test.ts", content: NEW_TEST })],
      [tool("bash", { command: "bun test version.test.ts" })],
      [tool("record_evidence", { criterion: 0, command: "bun test version.test.ts" })],
      // …and then it keeps editing the very file the claim is about, without
      // re-running anything.
      [tool("bash", { command: "printf 'export const extra = 3;\\n' >> api.ts" })],
      [{ type: "text", text: "All done." }],
    ]);
    const session = engine.createSession();
    const terminal = terminalOf(await drain(engine, session, FEATURE_REQUEST));
    // Both refusals are true of this receipt — the run authored the oracle AND
    // then edited the file the claim is about. The stronger fact wins: a claim
    // taken with a self-authored check is not a claim that going stale would
    // have made weaker. The verdict is `partial` either way, which is the
    // property this test was written for.
    expect(terminal.verdict?.criteria[0]?.status).toBe("needs_review");
    expect(terminal.verdict?.criteria[0]?.verifier).toBe("self-authored-check@1");
    expect(terminal.verdict?.kind).toBe("partial");
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps.length).toBeGreaterThan(0);
  }, 90_000);
});

describe("T6: a run cut off keeps its output and its honest status", () => {
  test("the turn ceiling ends it `partial` + `max_turns`, with the model's text intact", async () => {
    const dir = greenRepo("m1-budget-");
    // A four-turn ceiling and a model that never stops calling tools: the run
    // is CUT OFF with one criterion settled and one never addressed, which is
    // the shape a benchmark scores and a person has to read.
    const engine = makeEngine(dir, { reliability: { maxTurns: 4, secondWinds: 0 } });
    script(engine, [
      [
        tool("read_back", {
          reading: "add a version endpoint and document it",
          touch: ["api.ts"],
          leave: [],
          done_when: [CRITERION, "the change is written up in NOTES.md"],
        }),
      ],
      [
        { type: "text", text: "I added version() to api.ts; the write-up is still to do." },
        tool("bash", { command: "printf 'export const version = 2;\n' >> api.ts" }),
      ],
      [
        tool("write_file", { path: "version.test.ts", content: NEW_TEST }),
        tool("bash", { command: "bun test version.test.ts" }),
      ],
      [
        tool("record_evidence", { criterion: 0, command: "bun test version.test.ts" }),
        tool("bash", { command: "echo still working on the write-up" }),
      ],
      [tool("bash", { command: "echo still working on the write-up" })],
      [tool("bash", { command: "echo still working on the write-up" })],
    ]);
    const session = engine.createSession();
    const result = await runHeadless(engine, session, FEATURE_REQUEST);

    // The status the run ended at is reported as itself, not folded into the
    // verdict: a stopped run must not enter a success metric because it
    // emitted a final answer.
    expect(result.verdict?.execution?.status).toBe("max_turns");
    expect(result.verdict?.execution?.stopReason).toBe(result.stopReason);
    expect(result.verdict?.kind).toBe("partial");
    // One criterion cited on a check the run wrote — `needs_review` since V8
    // critical 4, and `satisfied` before it — and one never measured. The
    // property this test holds is that the verdict says BOTH rather than
    // collapsing them into a single number, and it still does.
    expect(result.verdict?.criteria.map((c) => c.status)).toEqual(["needs_review", "unassessed"]);
    // The useful half of a partial result is the half that is kept.
    expect(result.text).toContain("version()");
    expect(result.text.trimEnd().split("\n").at(-1)).toStartWith("[verdict]");
  }, 90_000);
});
