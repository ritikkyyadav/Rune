// ─── Intent, verbatim — and what a request with no deliverable gets ───
//
// `TaskContract.intent` is claimed to be "the user's message, verbatim. Never
// rewritten, never summarised", and `drift` is claimed to be the check against
// what the model read back. Both are measured here against the real engine
// intake, with an in-process scripted provider and a scratch RUNE_HOME.
//
// Two facts are pinned (V-5B, F3 and F4): a request longer than the task
// store's goal cap records NO drift, because `Brief.request` is that store's
// own truncated copy and the user's words are never the model's misreading;
// and a question that states no criteria and writes no file ends `none`, not
// `unmet` — the verdict vocabulary says there was nothing to verify rather
// than reporting a shortfall on a run that did exactly what was asked.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
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

function script(engine: Engine, turns: ContentBlock[][]): void {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done." }];
}

let callSeq = 0;
const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `v5bi${++callSeq}`,
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

function contracts(engine: Engine, sessionId: string): Array<Record<string, any>> {
  return (engine as unknown as Internals).sessions
    .getEvents(sessionId, 1)
    .filter((r) => r.event.type === "contract")
    .map((r) => (r.event.payload as any).contract as Record<string, any>);
}

function terminalOf(events: AgentTurnEvent[]): Extract<AgentTurnEvent, { type: "turn_complete" }> {
  return events
    .filter(
      (e): e is Extract<AgentTurnEvent, { type: "turn_complete" }> => e.type === "turn_complete",
    )
    .at(-1)!;
}

describe("intent, verbatim", () => {
  test("a request longer than the task-state goal cap records no `drift`", async () => {
    const dir = workspace("v5b-intent-100k-");
    const engine = makeEngine(dir);
    script(engine, [
      [
        tool("read_back", {
          reading: "the long one",
          touch: ["a.ts"],
          leave: ["b.ts"],
          done_when: ["it works"],
        }),
      ],
      [{ type: "text", text: "Done." }],
    ]);
    // ~100 KB, one line, so nothing else reshapes it.
    const message = `Fix the exporter. ${"x".repeat(100_000)}`;
    const session = engine.createSession();
    await drain(engine, session, message);

    const rows = contracts(engine, session);
    // The intent itself is verbatim — that half of the claim holds.
    expect(rows[0]!.intent).toBe(message);
    const amended = rows.at(-1)!;
    expect(amended.intent).toBe(message);

    // `drift` is documented as "what the brief read the request back AS, when
    // that is not what was asked". Here the model read back nothing of the
    // kind: `Brief.request` is `taskState.currentRequest()`, the same message
    // truncated at `GOAL_CAP` (24,000 chars). `briefDrift` compares like with
    // like, so the harness's own cap is not recorded as the model's
    // misreading, and no ~24 KB copy of the user's text reaches the contract
    // row or its digest.
    expect({
      drift: amended.drift === undefined ? "none" : `${String(amended.drift).length} chars`,
    }).toEqual({ drift: "none" });
  });
});

describe("the shape classifier and the question with nothing to verify", () => {
  test("a plain question the model answers ends `none`, not `unmet`", async () => {
    const dir = workspace("v5b-intent-question-");
    const engine = makeEngine(dir);
    script(engine, [[{ type: "text", text: "It parses the CSV header and returns the rows." }]]);
    const session = engine.createSession();
    const events = await drain(engine, session, "what does the exporter do?");
    const row = contracts(engine, session)[0]!;
    const terminal = terminalOf(events);

    expect(row.shape).toBe("question");
    // The run did exactly what was asked — it answered a question — and the
    // verdict says so. `shape` is computed at intake, persisted, and now read
    // by the one branch that needs it: zero criteria, nothing written, and a
    // request that had no deliverable to hold a criterion. `none` carries its
    // reason, and it is not reachable for a run that wrote a file.
    expect({
      shape: row.shape,
      verdict: terminal.verdict?.kind,
      missing: terminal.verdict?.kind === "unmet" ? terminal.verdict.missing : [],
    }).toEqual({ shape: "question", verdict: "none", missing: [] });
    if (terminal.verdict?.kind === "none") {
      expect(terminal.verdict.reason).toContain("no file was written");
      expect(verdictLine(terminal.verdict)).toBe(`[verdict] none — ${terminal.verdict.reason}`);
    }
  });
});
