/**
 * `done` on a project whose test suite outlasts the end-of-turn limit, through
 * the real Engine, the real verifier and the native tools (2026-10-22).
 *
 * The dogfood run: on Rune's own source the suite takes about 222 s, the check
 * stopped it at 120 s, and the run ended `unmet` although its work was right
 * and the test files it touched passed in the suite's place. The founder's
 * choice: wait longer, then let `done` rest on that stand-in, named on the line.
 *
 * What only this level shows: the verifier marks the stand-in, the loop reads
 * the mark, the request check is asked, and the verdict line says which suite
 * did not finish.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
} from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import { verdictLine } from "../../packages/orchestrator/src/contract";
import { UsageProvider } from "../helpers/usage-provider";
import { resolveRuneToolsBinary } from "../helpers/native-binary";

const nativeBinary = resolveRuneToolsBinary();
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const PROMPT = "Add a sum function in src/sum.ts, with a test.";
const FOUND = JSON.stringify({
  asks: [
    { ask: "a sum function in src/sum.ts", done: true, evidence: "src/sum.ts" },
    { ask: "a test", done: true, evidence: "tests/sum.test.ts" },
  ],
});
/** Sleeps past the limit, then would run the suite: it never gets that far. */
const SLOW_SUITE = "sleep 8 && bun test";
const LIMIT_MS = 3_000;

/** The scripted model, plus the request check's own answer. */
class Scripted extends UsageProvider {
  requestChecks = 0;
  override async infer(request: InferenceRequest): Promise<InferenceResponse> {
    if (request.role !== "request_check") return super.infer(request);
    this.requestChecks++;
    return {
      id: "request-check",
      model: request.model,
      content: [{ type: "text", text: FOUND }],
      stopReason: "end_turn",
      usage: this.usage,
    };
  }
}

const write = (id: string, path: string, content: string): ContentBlock => ({
  type: "tool_use",
  toolCallId: id,
  toolName: "write_file",
  toolInput: { path, content },
});
const say = (text: string): ContentBlock[] => [{ type: "text", text }];
const SUM = write("w1", "src/sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
const testOf = (expected: number): ContentBlock =>
  write(
    "w2",
    "tests/sum.test.ts",
    'import { expect, test } from "bun:test";\n' +
      'import { sum } from "../src/sum";\n' +
      `test("sum", () => {\n  expect(sum(2, 3)).toBe(${expected});\n});\n`,
  );

async function run(turns: ContentBlock[][]) {
  const base = mkdtempSync(join(tmpdir(), "rune-done-long-suite-"));
  scratch.push(base);
  const root = join(base, "ws");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...args: string[]) =>
    spawnSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { encoding: "utf8" },
    );
  git("init", "-q");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: SLOW_SUITE } }, null, 2),
  );
  writeFileSync(join(root, "bun.lock"), "");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");

  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: root,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: nativeBinary.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: true,
    verifyTimeoutMs: LIMIT_MS,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  const provider = new Scripted();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  let turn = 0;
  provider.onRequest = () => turns[turn++] ?? say("Done.");
  const events: AgentTurnEvent[] = [];
  try {
    for await (const event of engine.chat(engine.createSession(), PROMPT)) events.push(event);
  } finally {
    engine.close();
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  }
  const complete = events.filter((e) => e.type === "turn_complete").at(-1) as
    { verdict?: Parameters<typeof verdictLine>[0] } | undefined;
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e as { message: string }).message);
  return { verdict: complete?.verdict, notices, requestChecks: provider.requestChecks };
}

describe.skipIf(!nativeBinary.exists)("a suite that outlasts the check's limit", () => {
  test("the test files the change touched stand in for it, green: done, and the line says so", async () => {
    const r = await run([[SUM, testOf(5)], say("Added sum with a test.")]);
    expect(r.verdict?.kind).toBe("done");
    if (r.verdict?.kind !== "done") throw new Error("unreachable");
    expect(r.verdict.standIns).toEqual([
      { unfinished: "bun run test", ranInstead: "bun test './tests/sum.test.ts'" },
    ]);
    expect(r.requestChecks).toBe(1);
    expect(verdictLine(r.verdict)).toContain(
      "`bun run test` did not finish, and the test files the change touched passed in its place",
    );
    expect(r.notices.some((n) => n.includes("run in its place, and pass"))).toBe(true);
  }, 90_000);

  test("a change that touched no test file has nothing to stand in: not done", async () => {
    const r = await run([[SUM], say("Added sum."), say("Added sum.")]);
    expect(r.verdict?.kind).not.toBe("done");
    expect(r.requestChecks).toBe(0);
  }, 90_000);

  test("the stand-in went red: a red check, not done", async () => {
    const r = await run([[SUM, testOf(6)], say("Added sum with a test.")]);
    expect(r.verdict?.kind).not.toBe("done");
    expect(r.requestChecks).toBe(0);
  }, 120_000);
});
