/**
 * Inspecting a sub-agent, end to end: the real stream in, and the real log back.
 *
 * `ui-agent-inspect.test.ts` proves the keys and `ui-child-transcript.test.ts`
 * proves the rows, both from synthetic events -- which proves nothing about
 * whether those events ever arrive, or whether what is stored can be read. Two
 * links in this feature live in files a synthetic test cannot reach:
 *
 *   1. `agent-loop.ts` decides what a child's event stream is allowed to carry
 *      to its parent. A child's tool-call ARGUMENTS did not cross at all, so a
 *      pane could name a call only after it was over.
 *   2. `delegated-sessions.ts` writes a child's conversation into the parent's
 *      log -- and nothing but the child's own resume ever read it back.
 *
 * So this drives a real `Engine` over a scripted provider -- no network, no
 * credentials, no model -- with a child that STREAMS a tool call and runs a real
 * read-only tool against a real directory. Then it throws the surface's state
 * away and rebuilds it from the database file, through a second engine, the way
 * a session reopened tomorrow would.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ContentBlock,
  InferenceRequest,
  StreamEvent,
} from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { Engine } from "../../packages/orchestrator/src/engine";
import { CHILD_ARGS_FORWARD_BYTES } from "../../packages/orchestrator/src/subagent-events";
import { UsageProvider } from "../helpers/usage-provider";
import { TurnRenderer, type TurnSink } from "../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../packages/orchestrator/src/bin/ui/render";
import { fleetLedger } from "../../packages/orchestrator/src/bin/ui/agents-panel";
import { fillFromRecord } from "../../packages/orchestrator/src/bin/ui/child-transcript";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  fleetLedger.reset();
  setTermWidthOverride(null);
});

function scratch(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-inspect-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(dir, "notes", "beta.ts"), "export const beta = 2;\n");
  const home = mkdtempSync(join(tmpdir(), "agent-inspect-home-"));
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
    subagents: { mode: "mirror" },
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as never);
  cleanup.push(() => engine.close());
  return engine;
}

const isChild = (request: InferenceRequest): boolean =>
  !(request.tools ?? []).some((tool) => tool.name === "task");
const answered = (request: InferenceRequest): boolean =>
  request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));

/** A filler argument far larger than the ceiling, AFTER the field that names
 *  the call's target -- the shape of a `write_file` carrying a whole file. */
const FILLER_BYTES = 40_000;

/**
 * A child that streams its tool call a fragment at a time, the way a real
 * provider does, instead of delivering the input whole.
 */
class StreamingChildProvider extends UsageProvider {
  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    if (!isChild(request) || answered(request)) {
      yield* super.inferStream(request);
      return;
    }
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const toolInput = { pattern: "notes/*.ts", note: "z".repeat(FILLER_BYTES) };
    const json = JSON.stringify(toolInput);
    yield { type: "message_start", messageId: "child" };
    yield {
      type: "content_delta",
      contentIndex: 0,
      delta: { type: "text_delta", text: "Listing the notes first." },
    };
    yield { type: "tool_use_start", toolCallId: "g1", toolName: "glob" };
    for (let at = 0; at < json.length; at += 64) {
      yield { type: "tool_use_delta", toolCallId: "g1", partialJson: json.slice(at, at + 64) };
    }
    yield { type: "tool_use_stop", toolCallId: "g1", toolInput };
    yield { type: "message_stop", stopReason: "tool_use", usage: this.usage };
  }
}

describe("a sub-agent, watched and then read back", () => {
  test("its call is named while it runs, drawn when it lands, and stored under its name", async () => {
    setTermWidthOverride(120);
    const { dir, dbPath } = scratch();
    const engine = makeEngine(dir, dbPath);
    const session = engine.createSession();

    const provider = new StreamingChildProvider();
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
    let lead = 0;
    const leadTurns: ContentBlock[][] = [
      [
        {
          type: "tool_use",
          toolCallId: "c1",
          toolName: "task",
          toolInput: {
            name: "planner",
            label: "map the notes",
            prompt: "List the files under notes/ and say what each exports.",
          },
        },
      ],
      [{ type: "text", text: "The scout is back." }],
    ];
    provider.onRequest = (request) => {
      if (isChild(request)) {
        return [{ type: "text", text: "Two files: alpha.ts and beta.ts, one export each." }];
      }
      return leadTurns[lead++] ?? [{ type: "text", text: "Done." }];
    };

    fleetLedger.reset();
    const sink: TurnSink = { commit: () => {}, preview: () => {} };
    const turn = new TurnRenderer(sink, { getCost: () => 0 });

    const events: AgentTurnEvent[] = [];
    /** What the pane showed at the moment the child's call was still open. */
    let whileRunning: string[] | null = null;
    for await (const event of engine.chat(session, "Send a scout.")) {
      events.push(event);
      turn.onEvent(event);
      if (
        whileRunning === null &&
        event.type === "tool_progress" &&
        event.child?.event.type === "tool_call_args_delta"
      ) {
        whileRunning = fleetLedger.buffer("c1").map(stripAnsi);
      }
      // A terminal repaint briefly holding the consumer, so the child's stream
      // runs ahead of it and the unread queue has to coalesce.
      if (event.type === "tool_progress") await Bun.sleep(1);
    }

    // ── 1. The arguments crossed, and only the head of them ──
    const argDeltas = events.filter(
      (e) => e.type === "tool_progress" && e.child?.event.type === "tool_call_args_delta",
    ) as Array<{ child: { event: { partialJson: string } } }>;
    expect(argDeltas.length).toBeGreaterThan(0);
    const forwarded = argDeltas.reduce((n, e) => n + e.child.event.partialJson.length, 0);
    // The child streamed ~40 KB of arguments. What reached the parent is the
    // ceiling's worth, give or take the one fragment that crossed it.
    expect(forwarded).toBeGreaterThan(0);
    expect(forwarded).toBeLessThanOrEqual(CHILD_ARGS_FORWARD_BYTES + 64);
    expect(forwarded).toBeLessThan(FILLER_BYTES / 4);
    // And a slow consumer did not find one event per fragment waiting for it.
    expect(argDeltas.length).toBeLessThan(CHILD_ARGS_FORWARD_BYTES / 64);

    // ── 2. While it was running, the pane already named what it was running ──
    expect(whileRunning).not.toBeNull();
    const running = whileRunning!.join("\n");
    expect(running).toContain("notes/*.ts");
    // The running mark: the call had not come back yet.
    expect(running).toMatch(/› glob/);

    // ── 3. The finished transcript: the brief, the prose, the call, the answer ──
    const card = fleetLedger.get("c1")!;
    expect(card.name).toBe("planner");
    expect(card.retired).toBe(true);
    const rows = fleetLedger.buffer("c1").map(stripAnsi);
    const text = rows.join("\n");
    expect(text).toContain("List the files under notes/ and say what each exports.");
    expect(text).toContain("Listing the notes first.");
    expect(text).toContain("notes/*.ts");
    expect(text).toContain("Two files: alpha.ts and beta.ts");
    // The call came back: nothing in the transcript is still marked in flight.
    expect(text).not.toMatch(/› glob/);
    // The brief stands first.
    expect(rows.find((r) => r.trim() !== "")).toContain("List the files under notes/");

    // ── 4. It was stored, under the name it ran as ──
    expect(card.taskId).toMatch(/^task_[a-f0-9-]{36}$/);
    const stored = engine.listDelegations(session);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: card.taskId,
      kind: "task",
      callId: "c1",
      name: "planner",
      label: "map the notes",
      status: "end_turn",
    });
    expect(stored[0]!.startedAt).toBeDefined();

    const entries = engine.getDelegationTranscript(session, card.taskId!)!;
    expect(entries[0]).toEqual({
      kind: "prompt",
      text: "List the files under notes/ and say what each exports.",
    });
    const call = entries.find((e) => e.kind === "tool") as Extract<
      (typeof entries)[number],
      { kind: "tool" }
    >;
    expect(call.toolName).toBe("glob");
    expect(call.args.pattern).toBe("notes/*.ts");
    expect(call.unanswered).toBeUndefined();
    // The real tool ran against the real directory.
    expect(call.result).toContain("alpha.ts");
    expect(entries.at(-1)).toEqual({
      kind: "text",
      text: "Two files: alpha.ts and beta.ts, one export each.",
    });
    expect(
      engine.getDelegationTranscript(session, "task_00000000-0000-0000-0000-000000000000"),
    ).toBeNull();

    // ── 5. Reopened: nothing in memory, a second engine on the same file ──
    fleetLedger.reset();
    expect(fleetLedger.all()).toHaveLength(0);
    const reopened = makeEngine(dir, dbPath);
    expect(fleetLedger.restore(reopened.listDelegations(session))).toBe(1);
    const back = fleetLedger.get("c1")!;
    expect(back.name).toBe("planner");
    expect(back.brief).toBe("map the notes");
    expect(back.state).toBe("done");
    expect(back.retired).toBe(true);
    expect(back.restored).toBe(true);
    expect(back.taskId).toBe(card.taskId);
    // Its transcript was not loaded to list it...
    expect(fleetLedger.log("c1").empty).toBe(true);
    // ...and reads back from the log when it is opened.
    fillFromRecord(fleetLedger.log("c1"), reopened.getDelegationTranscript(session, back.taskId!)!);
    const again = fleetLedger.buffer("c1").map(stripAnsi).join("\n");
    expect(again).toContain("List the files under notes/ and say what each exports.");
    expect(again).toContain("Listing the notes first.");
    expect(again).toContain("notes/*.ts");
    expect(again).toContain("Two files: alpha.ts and beta.ts");
  }, 60_000);

  test("a session with no delegations lists none, and an unknown session does not throw", () => {
    const { dir, dbPath } = scratch();
    const engine = makeEngine(dir, dbPath);
    const session = engine.createSession();
    expect(engine.listDelegations(session)).toEqual([]);
    expect(engine.listDelegations("not-a-session")).toEqual([]);
    expect(engine.getDelegationTranscript("not-a-session", "task_x")).toBeNull();
  });
});
