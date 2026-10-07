/**
 * One small, well-specified fix, run through a real Engine by a scripted model
 * that does only the work: read the file, make the edit, run the test, say so.
 *
 * It calls NO bookkeeping tool — no plan, no read-back, no evidence citation,
 * no hypothesis, no decision. So whatever else happens in the run is the
 * HARNESS's doing: a gate that refuses the finish, a nudge that asks for a
 * list, a re-prompt of any kind. That makes it the instrument for one
 * question — does an easy task still cost only its own four completions? —
 * and it is asked before and after anything that touches the prompt or a gate.
 *
 * Zero live model calls: an in-process scripted provider under a scratch
 * RUNE_HOME.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock, InferenceRequest } from "../../packages/llm-gateway/src/types";
import { Engine, isHarnessAuthoredTurn } from "../../packages/orchestrator/src/engine";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type { SessionManager } from "../../packages/shared/src/session";
import { UsageProvider } from "./usage-provider";

export const EASY_REQUEST =
  "In window.ts, lastN returns one item too many: lastN([1, 2, 3], 2) gives [1, 2, 3]. Fix it so it returns the last n items.";

/** The tools that move the harness's own bookkeeping rather than the user's files. */
export const BOOKKEEPING_TOOLS = new Set([
  "todo_write",
  "read_back",
  "record_evidence",
  "record_decision",
  "note_hypothesis",
]);

export interface EasyTaskRun {
  /** Completions the model was asked for. The work itself is four. */
  requests: number;
  /** Per completion: the caller's role tag, as the gateway saw it. */
  roles: string[];
  /** Tool calls that executed, in order. */
  tools: string[];
  bookkeepingCalls: number;
  /** User-role rows the HARNESS wrote: gates, nudges, re-prompts — by origin. */
  harnessTurns: string[];
  /** Notices the run emitted. */
  notices: string[];
  /** What the end-of-turn checks said, when they ran. */
  verification: string[];
  stopReason: string | undefined;
  /** Whether the fix is actually in the tree and its test green. */
  testExit: number | null;
  /** Bytes of the first request's system prompt and of its tool schemas. */
  systemBytes: number;
  toolSchemaBytes: number;
  toolCount: number;
  /** The session database, for `scripts/overhead-report.ts --db`. */
  dbPath: string;
  dispose(): void;
}

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.name=E", "-c", "user.email=e@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

const BROKEN = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n - 1);\n";
const FIXED = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n);\n";

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `easy${++callSeq}`,
  toolName: name,
  toolInput: args,
});

/** Read, edit, test, report. Nothing else. */
const SCRIPT: ContentBlock[][] = [
  [call("read_file", { path: "window.ts" })],
  [call("write_file", { path: "window.ts", content: FIXED })],
  [call("bash", { command: "bun test" })],
  [
    {
      type: "text",
      text: "lastN sliced one item too far back; it now takes exactly the last n. `bun test` passes.",
    },
  ],
];

export async function runEasyTask(toolsBinaryPath: string): Promise<EasyTaskRun> {
  const dir = mkdtempSync(join(tmpdir(), "easy-ws-"));
  const home = mkdtempSync(join(tmpdir(), "easy-home-"));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  put(dir, {
    "package.json": JSON.stringify({ name: "window", scripts: { test: "bun test" } }),
    "bun.lock": "",
    "window.ts": BROKEN,
    "window.test.ts":
      'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
      'test("lastN takes the last n", () => { expect(lastN([1, 2, 3], 2)).toEqual([2, 3]); });\n',
  });
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  const dbPath = join(home, "rune.db");
  // The product's own defaults wherever they bear on the question: checks on,
  // the plan ledger on, the gates on. Only the things that need a network or a
  // person are off.
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath,
    toolsBinaryPath,
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
  const dispose = (): void => {
    try {
      engine.close();
    } catch {
      /* already closed */
    }
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const provider = new UsageProvider();
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
    const primary: InferenceRequest[] = [];
    provider.onRequest = (request) => {
      primary.push(request);
      return SCRIPT[primary.length - 1] ?? [{ type: "text", text: "Done." }];
    };

    const session = engine.createSession();
    const events: AgentTurnEvent[] = [];
    for await (const event of engine.chat(session, EASY_REQUEST)) events.push(event);

    const tools = events.flatMap((e) => (e.type === "tool_call_end" ? [e.output.toolName] : []));
    const sessions = (engine as unknown as { sessions: SessionManager }).sessions;
    const harnessTurns = sessions
      .getEvents(session, 0)
      .flatMap(({ event }) =>
        event.type === "user_msg" && isHarnessAuthoredTurn(event.payload)
          ? [String(event.payload.harness)]
          : [],
      );
    const first = primary[0];
    const test = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    return {
      requests: primary.length,
      roles: primary.map((r) => String(r.role ?? "primary")),
      tools,
      bookkeepingCalls: tools.filter((t) => BOOKKEEPING_TOOLS.has(t)).length,
      harnessTurns,
      notices: events.flatMap((e) => (e.type === "notice" ? [e.message] : [])),
      verification: events.flatMap((e) =>
        e.type === "verification_completed" ? [e.status ?? (e.passed ? "passed" : "failed")] : [],
      ),
      stopReason: events.flatMap((e) => (e.type === "turn_complete" ? [e.stopReason] : [])).at(-1),
      testExit: test.status,
      systemBytes: Buffer.byteLength(
        typeof first?.system === "string" ? first.system : JSON.stringify(first?.system ?? ""),
      ),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(first?.tools ?? [])),
      toolCount: first?.tools?.length ?? 0,
      dbPath,
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}
