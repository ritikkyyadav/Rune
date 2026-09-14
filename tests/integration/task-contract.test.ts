// ─── The contract at intake, and a verdict at every exit (Phase 5B) ───
//
// The audit's example, as a run: a fix-shaped task whose typecheck and tests
// are green and whose stated criteria are not all verified. Before this the
// run ended `end_turn`, `ok: true`, exit 0, and printed "not done — 0 of 6"
// underneath: `BriefLedger.complete` computed the completion question and NO
// terminal path consulted it.
//
// And the four exits that emitted no terminal event at all — the loop
// detector, the barren breaker, a budget refusal and a non-retryable provider
// failure. All four reached the record as `provider_lost`, so a killed loop
// and a dead network were the same row. Each one is a scenario here.
//
// Only the provider is scripted; the engine, the session log, the ledger and
// the checks are real. Nothing here spends anything.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { headlessEnvelope, runHeadless } from "../../packages/orchestrator/src/headless";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

/** The native tools binary, as a FAILURE rather than a skip — the green
 *  checks in the audit's example are real `bash` calls. */
function toolsBinary(): string {
  const bin = join(process.cwd(), "target", "debug", "rune-tools");
  const env = process.env.RUNE_TOOLS_BIN ?? process.env.RUNE_TOOLS_BINARY;
  if (env && existsSync(env)) return env;
  if (!existsSync(bin)) {
    throw new Error(
      `this scenario runs real checks and needs the native tools binary: ${bin} is missing. ` +
        "Build it (`cargo build -p rune-tools`) or set RUNE_TOOLS_BIN.",
    );
  }
  return bin;
}

function tempWorkspace(prefix: string): string {
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

/** Script the provider by turn, with a hook that runs BEFORE each completion —
 *  the seam where the test stands in for the runtime's parent-commit probe. */
function script(
  engine: Engine,
  turns: ContentBlock[][],
  before?: (index: number) => void,
): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) => {
    before?.(index);
    return turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
  };
  return provider;
}

let callSeq = 0;
function tool(name: string, args: Record<string, unknown>): ContentBlock {
  return { type: "tool_use", toolCallId: `c${++callSeq}`, toolName: name, toolInput: args };
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

function rows(
  engine: Engine,
  sessionId: string,
): Array<{ type: string; payload: Record<string, unknown> }> {
  return (engine as unknown as Internals).sessions
    .getEvents(sessionId, 1)
    .map((r) => ({ type: r.event.type, payload: r.event.payload as Record<string, unknown> }));
}

function lastRow(engine: Engine, sessionId: string, type: string): Record<string, unknown> | null {
  return (
    rows(engine, sessionId)
      .filter((r) => r.type === type)
      .at(-1)?.payload ?? null
  );
}

function terminalOf(events: AgentTurnEvent[]): Extract<AgentTurnEvent, { type: "turn_complete" }> {
  const terminal = events.filter(
    (e): e is Extract<AgentTurnEvent, { type: "turn_complete" }> => e.type === "turn_complete",
  );
  expect(terminal.length).toBeGreaterThanOrEqual(1);
  return terminal.at(-1)!;
}

function lifecycleStatus(engine: Engine, sessionId: string): string {
  const traces = rows(engine, sessionId).filter(
    (r) => r.type === "run_trace" && (r.payload as { type?: string }).type === "lifecycle",
  );
  const last = traces.at(-1)!.payload as { lifecycle: { status: string } };
  return last.lifecycle.status;
}

const FIX_REQUEST = "Fix the exporter — it drops the last row.";
const DONE_WHEN = ["the exporter writes every row", "the CSV header is unchanged"];

/** The read-back that states the two criteria the verdict is about. */
const readBack = (): ContentBlock =>
  tool("read_back", {
    reading: "the export is dropping the last row",
    touch: ["export.ts"],
    leave: ["import.ts"],
    done_when: DONE_WHEN,
  });

/** A real check the runtime runs and reads the exit code of. */
const check = (command: string): ContentBlock => tool("bash", { command });

describe("the audit's example: green checks, a criterion never verified", () => {
  test("the verdict is `partial`, names the gap, is persisted, and prints last", async () => {
    const dir = tempWorkspace("rune-contract-partial-");
    writeFileSync(join(dir, "export.ts"), "export const rows = () => [1, 2, 3];\n");
    const engine = makeEngine(dir);
    script(
      engine,
      [
        [readBack()],
        [check("true # typecheck"), check("true # bun test")],
        [{ type: "text", text: "The exporter writes every row now." }],
      ],
      (index) => {
        // Turn 3: the first criterion earned its rung from a check that failed
        // on the parent commit and passes now. Set through `BriefLedger.record`
        // — the ONLY thing that can move a rung — exactly as `record_evidence`
        // does after the runtime's own parent probe. The second criterion is
        // never cited, which is the audit's silent case.
        if (index !== 3) return;
        engine.currentLedger()?.record(0, "verified", {
          source: "true # bun test",
          parentCommitFailed: true,
          parentCommit: "4a91c2e",
        });
      },
    );
    const session = engine.createSession();
    const events = await drain(engine, session, FIX_REQUEST);

    // ── on the wire ──
    const terminal = terminalOf(events);
    expect(terminal.stopReason).toBe("end_turn");
    expect(terminal.verdict?.kind).toBe("partial");
    const gaps = terminal.verdict?.kind === "partial" ? terminal.verdict.gaps : [];
    expect(gaps).toEqual([
      { criterion: "the CSV header is unchanged", why: "no evidence recorded" },
    ]);
    // The green checks are NOT a gap — that is the half the run got right.
    expect(gaps.some((g) => g.criterion === "the checks")).toBe(false);

    // ── persisted ──
    const contract = lastRow(engine, session, "contract") as {
      version: number;
      contract: { intent: string; shape: string; criteria: Array<{ text: string; rung: unknown }> };
    } | null;
    expect(contract?.version).toBe(1);
    expect(contract?.contract.intent).toBe(FIX_REQUEST);
    expect(contract?.contract.shape).toBe("fix");
    expect(contract?.contract.criteria.map((c) => c.text)).toEqual(DONE_WHEN);
    expect(contract?.contract.criteria[0]!.rung).toBe("verified");

    const verdict = lastRow(engine, session, "verdict") as {
      verdict: { kind: string; gaps: Array<{ criterion: string }> };
      contractDigest: string;
    } | null;
    expect(verdict?.verdict.kind).toBe("partial");
    expect(verdict?.verdict.gaps[0]!.criterion).toBe("the CSV header is unchanged");
    expect(verdict?.contractDigest.length).toBeGreaterThan(0);
  });

  test("in `-P` mode the verdict is the last line, and rides the envelope", async () => {
    const dir = tempWorkspace("rune-contract-headless-");
    const engine = makeEngine(dir);
    script(engine, [[readBack()], [{ type: "text", text: "Done." }]], (index) => {
      if (index !== 2) return;
      engine.currentLedger()?.record(0, "verified", {
        source: "bun test export.test.ts",
        parentCommitFailed: true,
      });
    });
    const session = engine.createSession();
    const result = await runHeadless(engine, session, FIX_REQUEST);

    // `rune -P "…"` writes `result.text` verbatim to stdout.
    const lines = result.text.trimEnd().split("\n");
    expect(lines.at(-1)).toStartWith("[verdict] partial — 1 of 2 criteria verified");
    expect(lines.at(-1)).toContain("the CSV header is unchanged");
    expect(result.verdict?.kind).toBe("partial");
    // `--json` / `--stream-json`: the envelope is the last line and carries it.
    const envelope = JSON.parse(headlessEnvelope(result)) as {
      stopReason?: string;
      verdict?: { kind: string };
    };
    expect(envelope.verdict?.kind).toBe("partial");
    expect(envelope.stopReason).toBe("end_turn");
  });

  test("the control: every criterion verified → `met`", async () => {
    const dir = tempWorkspace("rune-contract-met-");
    const engine = makeEngine(dir);
    script(
      engine,
      [[readBack()], [check("true # bun test")], [{ type: "text", text: "Both criteria hold." }]],
      (index) => {
        if (index !== 3) return;
        const ledger = engine.currentLedger();
        for (const i of [0, 1]) {
          ledger?.record(i, "verified", {
            source: "true # bun test",
            parentCommitFailed: true,
            parentCommit: "4a91c2e",
          });
        }
      },
    );
    const session = engine.createSession();
    const events = await drain(engine, session, FIX_REQUEST);
    const terminal = terminalOf(events);
    expect(terminal.verdict?.kind).toBe("met");
    expect(
      (lastRow(engine, session, "verdict") as { verdict: { kind: string } }).verdict.kind,
    ).toBe("met");
  });

  test("a run the model never reads back still has a contract, and it is `unmet`", async () => {
    const dir = tempWorkspace("rune-contract-none-");
    const engine = makeEngine(dir);
    script(engine, [[{ type: "text", text: "Nothing to do." }]]);
    const session = engine.createSession();
    const events = await drain(engine, session, "Tidy up whatever needs tidying.");
    const terminal = terminalOf(events);
    expect(terminal.verdict?.kind).toBe("unmet");
    expect(terminal.verdict?.kind === "unmet" && terminal.verdict.missing).toEqual([
      "no criteria stated",
    ]);
    // The contract exists from INTAKE — before the first model call — which is
    // what makes it the one row a run that dies on turn one still has.
    const contract = lastRow(engine, session, "contract") as {
      contract: { intent: string; criteria: unknown[] };
    } | null;
    expect(contract?.contract.intent).toBe("Tidy up whatever needs tidying.");
    expect(contract?.contract.criteria).toEqual([]);
  });
});

describe("every exit says why it ended", () => {
  test("the loop detector: `loop_detected`, and NOT a lost provider", async () => {
    const dir = tempWorkspace("rune-exit-loop-");
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
    const engine = makeEngine(dir);
    // The same batch, with the same answer, over and over: one nudge, then
    // the bail. `read_file` is deterministic, so the result signature holds.
    const same = (): ContentBlock[] => [tool("read_file", { path: "a.ts" })];
    script(engine, [same(), same(), same(), same(), same(), same(), same(), same()]);
    const session = engine.createSession();
    const events = await drain(engine, session, "Read a.ts until you understand it.");

    expect(terminalOf(events).stopReason).toBe("loop_detected");
    expect(lifecycleStatus(engine, session)).toBe("loop_detected");
    expect(lifecycleStatus(engine, session)).not.toBe("provider_lost");
    // The error it explains comes FIRST; the terminal event is last.
    const iError = events.findIndex((e) => e.type === "error" && !e.recoverable);
    const iTerminal = events.findIndex((e) => e.type === "turn_complete");
    expect(iError).toBeGreaterThanOrEqual(0);
    expect(iError).toBeLessThan(iTerminal);
    // And the verdict is there too: a killed loop still owes one.
    expect(terminalOf(events).verdict?.kind).toBe("unmet");
  });

  test("the barren breaker: `barren`, and NOT a lost provider", async () => {
    const dir = tempWorkspace("rune-exit-barren-");
    const engine = makeEngine(dir);
    // Different arguments every turn (so the batch detector stays quiet) and
    // the same failure shape every time (so the shape breaker starts refusing
    // before they run). Once it does, nothing executes: three such turns and
    // the barren breaker stops the run.
    script(
      engine,
      Array.from({ length: 14 }, (_, i) => [tool("read_file", { path: `missing-${i + 1}.ts` })]),
    );
    const session = engine.createSession();
    const events = await drain(engine, session, "Read every file you can find.");

    expect(terminalOf(events).stopReason).toBe("barren");
    expect(lifecycleStatus(engine, session)).toBe("barren");
    expect(lifecycleStatus(engine, session)).not.toBe("provider_lost");
    const iError = events.findIndex((e) => e.type === "error" && !e.recoverable);
    expect(iError).toBeGreaterThanOrEqual(0);
    expect(iError).toBeLessThan(events.findIndex((e) => e.type === "turn_complete"));
  });

  test("a budget refusal: `budget`, and NOT a lost provider", async () => {
    const dir = tempWorkspace("rune-exit-budget-");
    const engine = makeEngine(dir, { maxSessionCostUsd: 0.000001 });
    // Turn 1 is admitted and billed; the cap is crossed, so the request guard
    // refuses turn 2 BEFORE it is sent.
    script(engine, [
      [tool("read_file", { path: "nothing.ts" })],
      [{ type: "text", text: "unreachable" }],
    ]);
    const session = engine.createSession();
    const events = await drain(engine, session, "Read every file in the repository.");

    expect(terminalOf(events).stopReason).toBe("budget");
    expect(lifecycleStatus(engine, session)).not.toBe("provider_lost");
    expect(lifecycleStatus(engine, session)).toBe("budget");
  });

  test("a non-retryable provider failure stays `provider_lost` — it really is one", async () => {
    const dir = tempWorkspace("rune-exit-provider-");
    const engine = makeEngine(dir);
    const provider = new UsageProvider();
    (engine as unknown as Internals).gateway.registerProvider(provider);
    // 402: no credits. The gateway marks it non-retryable and the loop ends on
    // the FIRST one rather than burning its consecutive-error budget.
    provider.onRequest = () => {
      const err = new Error("No credits remaining on this account") as Error & { status: number };
      err.status = 402;
      throw err;
    };
    const session = engine.createSession();
    const events = await drain(engine, session, "Do the extensive thing.");

    const terminal = terminalOf(events);
    expect(terminal.stopReason).toBe("provider_lost");
    expect(lifecycleStatus(engine, session)).toBe("provider_lost");
    const iError = events.findIndex((e) => e.type === "error" && !e.recoverable);
    expect(iError).toBeGreaterThanOrEqual(0);
    expect(iError).toBeLessThan(events.findIndex((e) => e.type === "turn_complete"));
    // The verdict is still written: an exit with no answer is the defect.
    expect(lastRow(engine, session, "verdict")).not.toBeNull();
  });
});
