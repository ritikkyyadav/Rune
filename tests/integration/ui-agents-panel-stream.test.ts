/**
 * P4 lane B — the agents panel, fed by the REAL stream.
 *
 * Every other test of this panel hands `TurnRenderer` synthetic events, which
 * proves the rendering and proves nothing about the wiring. Three things had to
 * be true at once for a fan-out to become watchable, and each of them lives in
 * a different file:
 *
 *   1. `subagent.ts` must destructure the `name` the master wrote and put it on
 *      `ChildAgentEvent` (it declared `label` on its schema and read neither).
 *   2. `agent-loop.ts` must stop dropping child events whose one-line
 *      projection is null — `usage` among them — or no token count exists to
 *      report.
 *   3. `turn.ts` must fold them into a card that outlives the call.
 *
 * So this drives a real `Engine` over a scripted provider — no network, no
 * credentials, no model — dispatches two NAMED children in one message, and
 * asserts what the right column ends up saying.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ContentBlock,
  InferenceRequest,
  StreamOpts,
  StreamEvent,
} from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";
import { TurnRenderer, type TurnSink } from "../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../packages/orchestrator/src/bin/ui/render";
import {
  fleetLedger,
  renderAgentsPanel,
} from "../../packages/orchestrator/src/bin/ui/agents-panel";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function scratch(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ui-agents-panel-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "ui-agents-panel-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  return { dir, dbPath: join(home, "rune.db") };
}

function makeEngine(dir: string, dbPath: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath,
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    // The children run on the session's own model, so the scripted provider is
    // the only thing any of the three agents can reach.
    subagents: { mode: "mirror" },
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as never);
  cleanup.push(() => engine.close());
  return engine;
}

const taskCall = (callId: string, name: string, label: string, prompt: string): ContentBlock => ({
  type: "tool_use",
  toolCallId: callId,
  toolName: "task",
  toolInput: { name, label, prompt },
});

class ChunkedChildProvider extends UsageProvider {
  blockChildren = false;
  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    const isChild = !(request.tools ?? []).some((tool) => tool.name === "task");
    if (!isChild) {
      yield* super.inferStream(request);
      return;
    }
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    yield { type: "message_start", messageId: "child" };
    if (this.blockChildren) {
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: "waiting" },
      };
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    // This runs in the tool-execution promise while the parent generator is
    // suspended. Without queue-side coalescing, all 2,000 token fragments sit
    // in memory before the surface can consume the next parent event.
    for (let i = 0; i < 80_000; i++) {
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: i === 0 ? "Found it. " : "x" },
      };
    }
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: this.usage,
    };
  }
}

describe("two named children, through the real stream", () => {
  test("each one reaches the panel by name, with the tokens its own provider reported", async () => {
    setTermWidthOverride(120);
    const { dir, dbPath } = scratch();
    const engine = makeEngine(dir, dbPath);
    const session = engine.createSession();

    const provider = new ChunkedChildProvider();
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
    let lead = 0;
    const leadTurns: ContentBlock[][] = [
      [
        taskCall("c1", "planner", "map the settings surface", "Where do settings live?"),
        taskCall("c2", "mapper", "map the deploy surface", "Where does deploy live?"),
      ],
      [{ type: "text", text: "Both scouts are back." }],
    ];
    provider.onRequest = (request) => {
      // A scout cannot recurse, so its tool list never carries `task` — which
      // is how lead and child are told apart when they share one provider.
      const isChild = !(request.tools ?? []).some((t) => t.name === "task");
      if (isChild) return [{ type: "text", text: "Found it: everything is in src/config.ts." }];
      return leadTurns[lead++] ?? [{ type: "text", text: "Done." }];
    };

    fleetLedger.reset();
    const commits: string[] = [];
    const sink: TurnSink = { commit: (block) => commits.push(block), preview: () => {} };
    const turn = new TurnRenderer(sink, { getCost: () => 0 });

    const events: AgentTurnEvent[] = [];
    for await (const event of engine.chat(session, "Send two scouts.")) {
      events.push(event);
      turn.onEvent(event);
      // Model a terminal repaint briefly holding the consumer. Child execution
      // continues during this pause, exercising the unread-queue bound.
      if (event.type === "tool_progress") await Bun.sleep(2);
    }

    // The wiring, stated as the thing it enables: child events whose one-line
    // projection is null now cross the boundary. Before this they did not, and
    // everything below was unreachable.
    const childEvents = events.filter(
      (e) => e.type === "tool_progress" && (e as { child?: unknown }).child != null,
    ) as Array<{ child: { name?: string; label?: string; event: { type: string } } }>;
    expect(childEvents.length).toBeGreaterThan(0);
    expect(childEvents.some((e) => e.child.event.type === "usage")).toBe(true);
    const textEvents = childEvents.filter((e) => e.child.event.type === "text_delta") as Array<{
      child: { event: { type: "text_delta"; text: string } };
    }>;
    expect(textEvents.length).toBeLessThan(20);
    expect(Math.max(...textEvents.map((e) => e.child.event.text.length))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(
      textEvents.some((e) => e.child.event.text.startsWith("[earlier live output omitted]")),
    ).toBe(true);

    // The master's own `name` argument reached the wire — it was declared on
    // the schema and read by nobody before this lane.
    expect(childEvents.some((e) => e.child.name === "planner")).toBe(true);
    expect(childEvents.some((e) => e.child.name === "mapper")).toBe(true);
    // …and so did its `label`, which used to be replaced by the prompt head.
    expect(childEvents.some((e) => e.child.label === "map the settings surface")).toBe(true);

    const cards = fleetLedger.all();
    expect(cards.map((c) => c.name).sort()).toEqual(["mapper", "planner"]);

    for (const card of cards) {
      // A number a provider sent, not a guess. Both were computed inside the
      // child, converted to dollars and discarded before this.
      expect(card.tokens).toBeGreaterThan(0);
      // Both calls landed in the transcript, so both gave up their rung slot…
      expect(card.retired).toBe(true);
      expect(card.state).toBe("done");
    }
    // …and the rung says nothing about either of them.
    expect(stripAnsi(turn.liveLines().join("\n"))).not.toContain("planner");

    // The panel keeps them, in its own section, with the action that clears it.
    const panel = stripAnsi(renderAgentsPanel(fleetLedger.view(false), 38, 30).join("\n"));
    expect(panel).toContain("FINISHED 2");
    expect(panel).toContain("c clear");
    expect(panel).toContain("planner");
    expect(panel).toContain("mapper");
    expect(panel).toContain("map the settings surface");

    expect(fleetLedger.clearFinished()).toBe(2);
    expect(stripAnsi(renderAgentsPanel(fleetLedger.view(false), 38, 30).join("\n"))).toContain(
      "no agents this session",
    );

    setTermWidthOverride(undefined as unknown as number);
  }, 60_000);
});

test("cancelling a pending child preserves its identity and emits honest terminal state", async () => {
  const { dir, dbPath } = scratch();
  const engine = makeEngine(dir, dbPath);
  const session = engine.createSession();
  const provider = new ChunkedChildProvider();
  provider.blockChildren = true;
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  let lead = 0;
  provider.onRequest = (request) => {
    const isChild = !(request.tools ?? []).some((tool) => tool.name === "task");
    if (isChild) return [];
    return lead++ === 0
      ? [taskCall("cancel-call", "watcher", "watch cancellation", "Wait for cancellation.")]
      : [{ type: "text", text: "done" }];
  };

  const events: AgentTurnEvent[] = [];
  const run = engine.chat(session, "Start a cancellable scout.");
  for (;;) {
    const next = await run.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "tool_progress" && next.value.child?.agentId === "cancel-call") {
      engine.abort();
    }
  }

  const child = events
    .filter((event) => event.type === "tool_progress" && event.child?.agentId === "cancel-call")
    .map((event) => (event.type === "tool_progress" ? event.child : undefined))
    .filter((event): event is NonNullable<typeof event> => event != null);
  expect(child.every((event) => event.name === "watcher")).toBe(true);
  expect(
    child.map((event) =>
      event.event.type === "turn_complete"
        ? `${event.event.type}:${event.event.stopReason}`
        : event.event.type,
    ),
  ).toContain("turn_complete:aborted");
  expect(
    events.some(
      (event) =>
        event.type === "tool_progress" &&
        event.callId === "cancel-call" &&
        event.state === "settled",
    ),
  ).toBe(true);
  // The parent's own terminal event says the same word its child's did. It is
  // not the LAST event of the run: `engine.ts` yields the terminal `lifecycle`
  // projection after it on purpose, so a reader following the log in order sees
  // how the run ended and only then that it is over. So this pins the pair --
  // the turn's stop reason, and the lifecycle behind it reconciled to the same
  // status -- rather than the position, which is the engine's to choose.
  const terminal = events.filter((event) => event.type === "turn_complete");
  expect(terminal.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "aborted" });
  expect(events.indexOf(terminal.at(-1)!)).toBeGreaterThan(
    events.findIndex((event) => event.type === "tool_progress" && event.callId === "cancel-call"),
  );
  const lifecycle = events.filter((event) => event.type === "lifecycle").at(-1) as
    { moment: string; lifecycle: { status: string } } | undefined;
  expect(lifecycle?.moment).toBe("terminal");
  expect(lifecycle?.lifecycle.status).toBe("aborted");
}, 30_000);
