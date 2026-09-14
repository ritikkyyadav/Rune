/**
 * The wiring: a real Engine, a scripted provider, and the rows that land.
 *
 * `shadow-report.test.ts` proves what the arbiter decides; this proves the
 * Engine actually builds one, hands it to the LEAD loop, persists its rows and
 * closes them with a summary — and that `[controller] shadow = false` writes
 * nothing at all.
 *
 * The rows are rows of their OWN type, exactly like `contract` and `verdict`:
 * they are not `AgentTurnEvent`s, so `replayEvents` must not hand them back as
 * events (`tests/unit/protocol/exhaustiveness.test.ts` — "the three
 * persistence sets name nothing that is not an event").
 *
 * Only the provider is scripted; no credential and no network are in scope.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine, replayEvents } from "../../packages/orchestrator/src/engine";
import type { SessionManager } from "../../packages/shared/src/session";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type { ShadowSummaryRow } from "../../packages/orchestrator/src/shadow-arbiter";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Internals {
  gateway: LlmGateway;
  sessions: SessionManager;
}

/** A canary in the user's own words: no row may carry it. */
const CANARY = "CANARY-PROMPT-5e3f";

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-shadow-engine-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "rune-shadow-engine-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  });
  return dir;
}

function makeEngine(dir: string, controller?: { shadow?: boolean }): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: "rune-tools",
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
    ...(controller ? { controller } : {}),
  });
  cleanup.push(() => engine.close());
  return engine;
}

function script(engine: Engine, turns: ContentBlock[][]): void {
  const provider = new UsageProvider();
  (engine as unknown as Internals).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) =>
    turns[index - 1] ?? [{ type: "text", text: "Done for now." }];
}

let callSeq = 0;
function tool(name: string, args: Record<string, unknown>): ContentBlock {
  return { type: "tool_use", toolCallId: `sc${++callSeq}`, toolName: name, toolInput: args };
}

async function run(controller?: { shadow?: boolean }): Promise<{
  rows: Array<{ seq: number; event: { type: string; payload: Record<string, unknown> } }>;
  events: AgentTurnEvent[];
}> {
  const dir = tempWorkspace();
  const engine = makeEngine(dir, controller);
  script(engine, [
    [
      tool("todo_write", {
        items: [{ content: "Read the config", kind: "read", status: "in_progress" }],
      }),
    ],
    [{ type: "text", text: "Read it." }],
  ]);
  const session = engine.createSession();
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(session, `${CANARY} — read the config and summarise it`)) {
    events.push(event);
  }
  const rows = (engine as unknown as Internals).sessions.getEvents(session, 1);
  return { rows, events };
}

describe("the Engine wires the shadow controller into the lead loop", () => {
  test("a run leaves a summary row, and its decision rows, in the session log", async () => {
    const { rows } = await run();
    const summaries = rows.filter((r) => r.event.type === "shadow_summary");
    expect(summaries.length).toBe(1);

    const summary = summaries[0]!.event.payload as unknown as ShadowSummaryRow;
    expect(summary.version).toBe(1);
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.runId.length).toBeGreaterThan(0);
    expect(summary.overheadUs.total).toBeGreaterThanOrEqual(0);

    const decisions = rows.filter((r) => r.event.type === "shadow_decision");
    expect(decisions.length).toBeGreaterThan(0);
    for (const row of decisions) expect(row.event.payload.applied).toBe(false);

    // The run itself still ended with its own record — the shadow lane did not
    // replace anything.
    const types = new Set(rows.map((r) => r.event.type));
    expect(types.has("contract")).toBe(true);
    expect(types.has("verdict")).toBe(true);
  });

  test("the rows are rows, not events: replay hands back none of them", async () => {
    const { rows } = await run();
    const replayed = replayEvents(rows).frames.map((f) => f.event.type);
    expect(replayed.filter((t) => t.startsWith("shadow_"))).toEqual([]);
  });

  test("nothing in the rows carries what the user typed", async () => {
    const { rows } = await run();
    const shadowRows = rows.filter((r) => r.event.type.startsWith("shadow_"));
    expect(shadowRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(shadowRows)).not.toContain(CANARY);
  });

  test("[controller] shadow = false writes not one row", async () => {
    const { rows, events } = await run({ shadow: false });
    expect(rows.filter((r) => r.event.type.startsWith("shadow_"))).toEqual([]);
    // …and the run still finished normally.
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });
});
