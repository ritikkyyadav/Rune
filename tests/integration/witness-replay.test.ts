/**
 * R1, end to end — a real Engine, the native tools, a real `bun test`.
 *
 * `parent-check.test.ts` holds the replay to real trees and
 * `witness-evidence.test.ts` holds the ladder to what it may make of the
 * answer. Neither shows the two joined: that the engine hands the replay the
 * tree the run STARTED from, that a test the run wrote reaches `verified`
 * through it, and that editing the test afterwards takes the rung back.
 *
 * A scripted model does what a careful one would: reads the request back, fixes
 * the bug, writes a regression test, runs it, and cites it. Then, in the second
 * case, it weakens the test it was credited for.
 *
 * Zero live model calls. Needs the native tools binary.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { BriefLedger } from "../../packages/orchestrator/src/brief";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { UsageProvider } from "../helpers/usage-provider";

const native = resolveRuneToolsBinary();

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const BROKEN = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n - 1);\n";
const FIXED = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n);\n";
const REGRESSION =
  'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
  'test("lastN takes the last n", () => {\n  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n});\n';
/** The same test with its one assertion made true of anything. */
const WEAKENED = REGRESSION.replace("toEqual([2, 3])", "toBeDefined()");

const REQUEST =
  "Fix the bug in window.ts: lastN returns one item too many. lastN([1, 2, 3], 2) gives [1, 2, 3].";
const CITED = "bun test window.regress.test.ts";
/** How the fix-verified gate announces that it refused a finish. */
const FIX_GATE = "Fix-verified gate:";

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.name=R1", "-c", "user.email=r1@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

function fixture(): { dir: string; engine: Engine } {
  const dir = mkdtempSync(join(tmpdir(), "r1-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "r1-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  for (const [name, text] of Object.entries({
    "package.json": JSON.stringify({
      name: "window",
      type: "module",
      scripts: { test: "bun test" },
    }),
    "bun.lock": "",
    "window.ts": BROKEN,
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: native.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return { dir, engine };
}

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `r1c${++callSeq}`,
  toolName: name,
  toolInput: args,
});
const say = (text: string): ContentBlock[] => [{ type: "text", text }];

/** The careful run: read back, fix, write the regression test, run it, cite it. */
const CAREFUL: ContentBlock[][] = [
  [
    call("read_back", {
      reading: "lastN in window.ts slices one item too far back; you want exactly the last n.",
      touch: ["window.ts"],
      leave: ["the function's signature"],
      done_when: ["window.ts lastN([1, 2, 3], 2) returns [2, 3]"],
    }),
  ],
  [call("write_file", { path: "window.ts", content: FIXED })],
  [call("write_file", { path: "window.regress.test.ts", content: REGRESSION })],
  [call("bash", { command: CITED })],
  [call("record_evidence", { criterion: 0, command: CITED })],
];

/**
 * One message per script, all in ONE session — a task carried over more than
 * one run. `between` is the person at the keyboard before each later message.
 */
async function driveEach(
  engine: Engine,
  scripts: ContentBlock[][][],
  between: () => void = () => {},
) {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  const session = engine.createSession();
  const runs = [];
  for (const [nth, script] of scripts.entries()) {
    if (nth > 0) between();
    const asked = provider.requests.length;
    provider.onRequest = (_request, index) => script[index - asked - 1] ?? say("Done.");
    const results: Array<{ tool: string; text: string }> = [];
    const notices: string[] = [];
    let verdict: Extract<AgentTurnEvent, { type: "turn_complete" }>["verdict"];
    for await (const event of engine.chat(session, REQUEST) as AsyncIterable<AgentTurnEvent>) {
      if (event.type === "tool_call_end")
        results.push({
          tool: event.output.toolName,
          text: `${event.output.result ?? ""}${event.output.error ?? ""}`,
        });
      if (event.type === "notice") notices.push(event.message);
      if (event.type === "turn_complete") verdict = event.verdict;
    }
    const ledger = (engine as unknown as { ledger?: BriefLedger }).ledger;
    runs.push({ results, notices, criterion: ledger?.criteria[0], verdict });
  }
  return runs;
}

const drive = async (engine: Engine, script: ContentBlock[][]) =>
  (await driveEach(engine, [script]))[0]!;

/** Trees and homes a replay lays out in the temp directory. */
const laidOut = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith("rune-baseline-") || name.startsWith("rune-replay-home-"))
    .sort();

describe.skipIf(!native.exists)("a regression test the run wrote", () => {
  test("is replayed on the tree the run started from, and verifies the fix", async () => {
    const before = laidOut();
    const { engine } = fixture();
    const { results, notices, criterion, verdict } = await drive(engine, [
      ...CAREFUL,
      say("lastN took one item too many; it now takes exactly the last n."),
    ]);
    const cited = results.find((r) => r.tool === "record_evidence")!;
    expect(cited.text).toContain("Recorded as verified");
    expect(cited.text).toContain(
      "this run wrote `window.regress.test.ts`; laid over the tree the run started from, the same test failed there and passes now",
    );
    expect(cited.text).toContain("1 assertion failed on the pre-task tree and pass now");
    expect(criterion).toMatchObject({
      rung: "verified",
      evidence: {
        verifier: "witness-replay@1",
        parentCommitFailed: true,
        witnessFiles: ["window.regress.test.ts"],
        source: CITED,
      },
    });
    expect(criterion!.evidence!.witness).toMatch(/^[0-9a-f]{64}$/);
    // What the rung buys: the gate that asks a fix for a check that failed
    // before it has its answer, and does not ask again.
    expect(notices.filter((notice) => notice.startsWith(FIX_GATE))).toEqual([]);
    // What it does not buy: the replay shows the change is WHY the test passes,
    // not that the test is the right test. The run wrote it, so whether it
    // settles the criterion is still a person's to say.
    expect(verdict?.criteria[0]).toMatchObject({
      rung: "verified",
      attribution: "regression",
      verifier: "witness-replay@1",
      status: "needs_review",
    });
    expect(verdict?.kind).toBe("partial");
    // The replay left nothing behind.
    expect(laidOut()).toEqual(before);
  }, 120_000);

  test("…and the rung is taken back when the test is edited after it earned it", async () => {
    const { engine } = fixture();
    const { results, criterion } = await drive(engine, [
      ...CAREFUL,
      // Credited, the run weakens the test it was credited for.
      [call("write_file", { path: "window.regress.test.ts", content: WEAKENED })],
      say("Done."),
      say("Done."),
    ]);
    expect(results.find((r) => r.tool === "record_evidence")!.text).toContain(
      "Recorded as verified",
    );
    expect(criterion).toMatchObject({
      rung: "observed",
      evidence: { verifier: "self-authored-check@1" },
    });
    expect(criterion!.evidence!.parentCommitFailed).toBeUndefined();
    expect(criterion!.evidence!.detail).toContain(
      "its test was edited after it was replayed, so that replay is not about the test in the tree now",
    );
  }, 120_000);

  test("cited again after the edit, it is the edited test that is replayed", async () => {
    const { engine } = fixture();
    const { results, criterion } = await drive(engine, [
      ...CAREFUL,
      [call("write_file", { path: "window.regress.test.ts", content: WEAKENED })],
      [call("bash", { command: CITED })],
      [call("record_evidence", { criterion: 0, command: CITED })],
      say("Done."),
      say("Done."),
    ]);
    const cited = results.filter((r) => r.tool === "record_evidence");
    expect(cited).toHaveLength(2);
    expect(cited[0]!.text).toContain("Recorded as verified");
    // The first answer was about the test as it was. This one is about the test as it is.
    expect(cited[1]!.text).not.toContain("Recorded as verified");
    expect(cited[1]!.text).toContain("the same test passes on the pre-task tree");
    expect(criterion!.rung).not.toBe("verified");
  }, 120_000);

  test("run as anything but a plain `bun test <files>`, it is told the shape that is replayed", async () => {
    const { engine } = fixture();
    const chained = `${CITED} && echo ok`;
    const script = CAREFUL.slice(0, 3).concat([
      [call("bash", { command: chained })],
      [call("record_evidence", { criterion: 0, command: chained })],
    ]);
    const { results, criterion } = await drive(engine, [...script, say("Done."), say("Done.")]);
    const cited = results.find((r) => r.tool === "record_evidence")!;
    // The model's command line is never replayed; it is told what would be.
    expect(cited.text).not.toContain("Recorded as verified");
    expect(cited.text).toContain(
      "Replay on the tree the run started from: none — the command uses shell syntax; only a plain `bun test <test files>` is replayed.",
    );
    expect(criterion?.rung).not.toBe("verified");
  }, 120_000);

  test("a test that passes on the starting tree too is told so, and verifies nothing", async () => {
    const { engine } = fixture();
    const script = CAREFUL.map((turn) =>
      turn.map((block) =>
        block.type === "tool_use" && block.toolInput?.path === "window.regress.test.ts"
          ? { ...block, toolInput: { ...block.toolInput, content: WEAKENED } }
          : block,
      ),
    );
    const { results, notices, criterion } = await drive(engine, [
      ...script,
      say("Done."),
      say("Done."),
    ]);
    const cited = results.find((r) => r.tool === "record_evidence")!;
    expect(cited.text).toContain("Recorded as observed");
    expect(cited.text).toContain(
      "Replay on the tree the run started from: the same test passes on the pre-task tree — this change is not why it passes.",
    );
    expect(criterion).toMatchObject({ rung: "observed" });
    // Nothing was shown to fail before the fix, so the fix is still asked for that.
    expect(notices.filter((notice) => notice.startsWith(FIX_GATE))).toHaveLength(1);
  }, 120_000);
});

describe.skipIf(!native.exists)("a check that existed before the run", () => {
  const EXISTING =
    'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
    'test("lastN takes the last n", () => {\n  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n});\n';
  const cited = "bun test window.test.ts";
  /** The run: read back, write a note beside the code, run the project's own test, cite it. */
  const script = (extra: ContentBlock[][] = []): ContentBlock[][] => [
    [
      call("read_back", {
        reading: "lastN in window.ts slices one item too far back; you want exactly the last n.",
        touch: ["window.ts"],
        leave: ["the function's signature"],
        done_when: ["window.ts lastN([1, 2, 3], 2) returns [2, 3]"],
      }),
    ],
    ...extra,
    [call("write_file", { path: "NOTES.md", content: "lastN: checked.\n" })],
    [call("bash", { command: cited })],
    [call("record_evidence", { criterion: 0, command: cited })],
    say("Done."),
    say("Done."),
  ];
  const withTest = () => {
    const made = fixture();
    writeFileSync(join(made.dir, "window.test.ts"), EXISTING);
    git(made.dir, ["add", "."]);
    git(made.dir, ["commit", "-m", "a test that is red at the commit"]);
    return made;
  };

  test("fixed by the run: it failed where the run started, and verifies", async () => {
    const { engine } = withTest();
    const { results, criterion } = await drive(
      engine,
      script([[call("write_file", { path: "window.ts", content: FIXED })]]),
    );
    expect(results.find((r) => r.tool === "record_evidence")!.text).toContain(
      "Recorded as verified",
    );
    expect(criterion).toMatchObject({ rung: "verified", evidence: { verifier: "parent-probe@1" } });
  }, 120_000);

  test("already fixed by the person, uncommitted: the run is not credited with it", async () => {
    const { dir, engine } = withTest();
    // Before the run begins, the person's working tree already has the fix.
    writeFileSync(join(dir, "window.ts"), FIXED);
    const { results, criterion } = await drive(engine, script());
    const text = results.find((r) => r.tool === "record_evidence")!.text;
    expect(text).not.toContain("Recorded as verified");
    expect(text).toContain("this change is not why it passes");
    expect(criterion?.rung).not.toBe("verified");
  }, 120_000);

  // A task is not always one run. The second run of one starts on a tree that
  // already holds the first run's fix, and "it already passed where this run
  // began" is then a fact about the task's own work, not about the person's.
  test("fixed by the task one run earlier: the next run is not held to a tree that already had the fix", async () => {
    const { engine } = withTest();
    const [, second] = await driveEach(engine, [
      [script()[0]!, [call("write_file", { path: "window.ts", content: FIXED })], say("Fixed.")],
      script(),
    ]);
    expect(second!.results.find((r) => r.tool === "record_evidence")!.text).toContain(
      "Recorded as verified",
    );
    expect(second!.criterion).toMatchObject({
      rung: "verified",
      evidence: { verifier: "parent-probe@1" },
    });
  }, 120_000);

  test("…and a fix the person made after a run that wrote nothing is still the person's", async () => {
    const { dir, engine } = withTest();
    const [first, second] = await driveEach(
      engine,
      [
        [[call("read_file", { path: "window.ts" })], say("lastN slices one too far back.")],
        script(),
      ],
      () => writeFileSync(join(dir, "window.ts"), FIXED),
    );
    // The first run looked and wrote nothing, so nothing in the tree is its work.
    expect(first!.results.map((r) => r.tool)).toEqual(["read_file"]);
    const text = second!.results.find((r) => r.tool === "record_evidence")!.text;
    expect(text).not.toContain("Recorded as verified");
    expect(text).toContain("this change is not why it passes");
    expect(second!.criterion?.rung).not.toBe("verified");
  }, 120_000);
});
