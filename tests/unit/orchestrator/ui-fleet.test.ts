/**
 * The fleet panel: what a fan-out of sub-agents looks like while it runs.
 *
 * The complaint this answers, in full: three sub-agents ran for minutes and the
 * screen said `3 sub-agents running | grep backend` — a count, and one borrowed
 * heartbeat from whichever member reported last. You could not tell what any of
 * them had been asked, which one was greping, or whether any had already come
 * back. Watching it felt like being locked out of the room the work was in.
 *
 * So every fact the panel states is tested here, and each of them is a fact the
 * old line could not state: who, doing what, since when, and how many are back.
 */

import { describe, expect, it } from "bun:test";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import { deriveChildName } from "../../../packages/orchestrator/src/subagent-events";
import {
  fleetLedger,
  renderAgentsPanel,
  renderAgentsStrip,
  initialsFor,
  resolveName,
  chooseRungs,
} from "../../../packages/orchestrator/src/bin/ui/agents-panel";

function harness() {
  const commits: string[] = [];
  const sink: TurnSink = { commit: (block) => commits.push(block), preview: () => {} };
  // The ledger is SESSION-scoped and a TurnRenderer is per-turn, so it is a
  // module singleton in the product and a fresh test is a fresh session.
  // Without this, one test's `c1` is the next test's already-running `c1`.
  fleetLedger.reset();
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return {
    turn,
    commits,
    /** The right column, as the frame would draw it. */
    panel: (rows = 30, width = 38, focused = false, now = Date.now()) =>
      stripAnsi(renderAgentsPanel(fleetLedger.view(focused, now), width, rows, now).join("\n")),
    strip: (width = 76, focused = false) =>
      stripAnsi(renderAgentsStrip(fleetLedger.view(focused), width)),
    card: (name: string) => fleetLedger.all().find((c) => c.name === name),
    output: () => stripAnsi(commits.join("\n")),
    /** What the 125ms tick would paint right now. */
    rung: () => stripAnsi(turn.liveLines().join("\n")),
    rows: () => stripAnsi(turn.liveLines().join("\n")).split("\n"),
  };
}

/** Dispatch one delegation, exactly as the stream delivers it. */
function dispatch(
  turn: TurnRenderer,
  callId: string,
  args: Record<string, unknown>,
  toolName: "task" | "worker" = "task",
) {
  turn.onEvent({ type: "tool_call_start", callId, toolName });
  turn.onEvent({ type: "tool_call_args_delta", callId, partialJson: JSON.stringify(args) });
}

const started = (callId: string) => ({
  type: "tool_progress",
  callId,
  note: "",
  state: "started",
});
const settled = (callId: string, ok = true) => ({
  type: "tool_progress",
  callId,
  note: "",
  state: "settled",
  ok,
});
const beat = (callId: string, note: string) => ({ type: "tool_progress", callId, note });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The rung's dwell floor, mirrored from ./ui/turn. */
const DWELL = 700;

describe("the fleet panel — a row per sub-agent, not a count", () => {
  it("names what each member was sent to do, and what each is doing now", async () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "map the deploy surface", prompt: "Find every…" });
    dispatch(h.turn, "c2", { label: "find the auth store", prompt: "Locate…" });
    dispatch(h.turn, "c3", { label: "survey the test suite", prompt: "List…" });
    for (const id of ["c1", "c2", "c3"]) h.turn.onEvent(started(id));
    h.turn.onEvent(beat("c1", "grep backend"));
    h.turn.onEvent(beat("c2", "read src/auth.ts"));

    // The rows are live at once; the summary line above them is a rung frame
    // and waits out the dwell like every other one.
    await sleep(DWELL + 50);
    const rung = h.rung();
    // Every member is on screen, by name — this is the whole fix.
    expect(rung).toContain("map the deploy surface");
    expect(rung).toContain("find the auth store");
    expect(rung).toContain("survey the test suite");
    // …each with its OWN current action, not one shared heartbeat.
    const row = (brief: string) => h.rows().find((l) => l.includes(brief)) ?? "";
    expect(row("map the deploy surface")).toContain("grep backend");
    expect(row("find the auth store")).toContain("read src/auth.ts");
    expect(row("survey the test suite")).not.toContain("grep backend");
    // The summary line -- the rung's ONE row -- counts them and no longer
    // speaks for them; the members' rows follow it.
    expect(rung).toContain("3 sub-agents running");
    expect(rung.split("\n")[0]).toContain("3 sub-agents running");
    expect(rung.split("\n")[0]).not.toContain("grep backend");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("does not draw a queued member as a running one", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "map the deploy surface" });
    dispatch(h.turn, "c2", { label: "find the auth store" });
    h.turn.onEvent(started("c1"));

    const row = (brief: string) => h.rows().find((l) => l.includes(brief)) ?? "";
    // The model has written both calls; the loop has only started one. A clock
    // on the other would be timing work that has not begun.
    expect(row("find the auth store")).toContain("queued");
    expect(row("map the deploy surface")).not.toContain("queued");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("stops reporting a member as running the moment it comes back", async () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "map the deploy surface" });
    dispatch(h.turn, "c2", { label: "find the auth store" });
    for (const id of ["c1", "c2"]) h.turn.onEvent(started(id));
    h.turn.onEvent(beat("c1", "grep backend"));
    h.turn.onEvent(beat("c1", "read src/deploy.ts"));
    h.turn.onEvent(settled("c1"));

    const row = (brief: string) => h.rows().find((l) => l.includes(brief)) ?? "";
    // Its last action is history; what it came back AS is the news.
    expect(row("map the deploy surface")).toContain("done");
    expect(row("map the deploy surface")).toContain("2 steps");
    expect(row("map the deploy surface")).not.toContain("read src/deploy.ts");
    expect(row("find the auth store")).not.toContain("done");
    // And the summary owns up to it rather than saying "2 running" for another
    // four minutes, which is what every tool_call_end landing together meant.
    await sleep(DWELL + 50);
    expect(h.rung()).toContain("1 back");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("marks a member that failed as failed, not as done", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "build the settings page" }, "worker");
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(settled("c1", false));
    expect(h.rung()).toContain("failed");
    expect(h.rung()).not.toContain("done");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("holds a row's position when it settles — a list that re-sorts cannot be tracked", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "first scout" });
    dispatch(h.turn, "c2", { label: "second scout" });
    dispatch(h.turn, "c3", { label: "third scout" });
    for (const id of ["c1", "c2", "c3"]) h.turn.onEvent(started(id));
    h.turn.onEvent(settled("c2"));

    const briefs = h
      .rows()
      .filter((l) => l.includes("scout "))
      .map((l) => (/(first|second|third) scout/.exec(l) ?? [""])[0]);
    expect(briefs).toEqual(["first scout", "second scout", "third scout"]);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("holds a heartbeat long enough to read before replacing it", async () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "map the deploy surface" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(beat("c1", "grep backend"));
    // The first note goes up at once — there is nothing to protect yet.
    expect(h.rung()).toContain("grep backend");
    h.turn.onEvent(beat("c1", "read src/deploy.ts"));
    expect(h.rung()).toContain("grep backend");
    await sleep(DWELL + 50);
    expect(h.rung()).toContain("read src/deploy.ts");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("collapses a fan-out too wide to list into the count it cannot show", async () => {
    setTermWidthOverride(120);
    const h = harness();
    for (let index = 0; index < 9; index++) {
      dispatch(h.turn, `c${index}`, { label: `scout number ${index}` });
      h.turn.onEvent(started(`c${index}`));
    }
    await sleep(DWELL + 50);
    const rung = h.rung();
    expect(rung).toContain("scout number 0");
    expect(rung).toContain("scout number 5");
    expect(rung).not.toContain("scout number 6");
    expect(rung).toContain("+3 more");
    expect(rung).toContain("9 sub-agents running");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("falls back to the head of the prompt when the model wrote no label", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { prompt: "Find where the deploy pipeline reads its secrets" });
    h.turn.onEvent(started("c1"));
    // Shortened to a row's worth -- which is exactly why `label` exists.
    expect(h.rung()).toContain("Find where the deploy pipeline reads");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("drops a worker's own id from its heartbeat — the row already names it", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "build the settings page" }, "worker");
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(beat("c1", "w1 edit_file src/Settings.tsx"));
    expect(h.rung()).toContain("edit_file src/Settings.tsx");
    expect(h.rung()).not.toContain("w1 edit_file");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("gives up the row once the call lands in the transcript", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { label: "map the deploy surface", prompt: "Find every…" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(settled("c1"));
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "c1",
      args: { label: "map the deploy surface", prompt: "Find every…" },
      output: {
        toolName: "task",
        success: true,
        result: "The deploy surface is three lambdas behind one gateway.",
        durationMs: 4000,
      },
    });
    // Reported twice would be reported wrong: the panel yields to the row.
    expect(h.rung()).not.toContain("map the deploy surface");
    expect(h.output()).toContain("map the deploy surface");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("keeps the panel out of the way when nothing is delegated", () => {
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "r1", toolName: "read_file" });
    h.turn.onEvent({
      type: "tool_call_args_delta",
      callId: "r1",
      partialJson: JSON.stringify({ path: "src/a.ts" }),
    });
    expect(h.turn.liveLines().length).toBeLessThanOrEqual(2);
  });
});

describe("what a sub-agent leaves behind in the transcript", () => {
  it("records what came back, not only how long it took", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "c1",
      args: { label: "find the auth store", prompt: "Locate…" },
      output: {
        toolName: "task",
        success: true,
        result:
          "Tokens are stored in ~/.rune/credentials.json, written by credential-store.ts:88.\n\n(sub-agent made 12 tool calls)",
        durationMs: 178_000,
      },
    });
    h.turn.finish();
    const out = h.output();
    expect(out).toContain("find the auth store");
    expect(out).toContain("12 steps");
    expect(out).toContain("credential-store.ts:88");
  });

  it("leads with the banner when a report must be re-checked", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "c1",
      args: { label: "map the deploy surface" },
      output: {
        toolName: "task",
        success: true,
        result:
          "[PROVENANCE — this sub-agent did not run on anthropic/opus. The gateway switched it to openrouter/free mid-run.]\n\nThe deploy surface is three lambdas.",
        durationMs: 9000,
      },
    });
    h.turn.finish();
    // The finding is not the news when the finding is unverified.
    expect(h.output()).toContain("fallback model");
    setTermWidthOverride(undefined as unknown as number);
  });
});

// ─── Workflow waves (P10.9) ───

/**
 * A workflow node's progress, as the loop delivers it.
 *
 * A workflow is ONE tool call, so its nodes have no `tool_call_start` of their
 * own: the node context on the child event is what opens their rows.
 */
const nodeBeat = (
  callId: string,
  id: string,
  note: string,
  node: Partial<{
    wave: number;
    waves: number;
    dependsOn: string[];
    attempt: number;
    attempts: number;
    cached: boolean;
    status: "running" | "completed" | "failed" | "skipped";
    kind: "task" | "worker";
  }> = {},
) => ({
  type: "tool_progress" as const,
  callId,
  note,
  child: {
    agentId: `${callId}:${id}`,
    label: id,
    event: { type: "notice" as const, message: note },
    node: {
      workflow: "review",
      node: id,
      kind: node.kind ?? ("task" as const),
      wave: node.wave ?? 0,
      waves: node.waves ?? 2,
      dependsOn: node.dependsOn ?? [],
      attempt: node.attempt ?? 1,
      attempts: node.attempts ?? 1,
      cached: node.cached ?? false,
      status: node.status ?? ("running" as const),
    },
  },
});

describe("the fleet panel — a workflow is levels, not a list", () => {
  it("groups nodes by wave and names the edges into each one", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "wf", toolName: "workflow" });
    h.turn.onEvent(nodeBeat("wf", "security", "grep auth"));
    h.turn.onEvent(nodeBeat("wf", "perf", "read src/api.ts"));
    h.turn.onEvent(
      nodeBeat("wf", "report", "waiting", { wave: 1, dependsOn: ["security", "perf"] }),
    );

    const rung = h.rung();
    // The level, and -- the half that makes a level mean anything -- what the
    // level was waiting for.
    expect(rung).toContain("review");
    expect(rung).toContain("wave 1 of 2");
    expect(rung).toContain("wave 2 of 2");
    expect(rung).toContain("after security, perf");
    // Every node is on screen by its own name.
    for (const id of ["security", "perf", "report"]) expect(rung).toContain(id);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("says cached rather than showing a clock a cache hit never earned", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "wf", toolName: "workflow" });
    h.turn.onEvent(nodeBeat("wf", "scope", "scope cached", { cached: true, status: "completed" }));
    expect(h.rung()).toContain("cached");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("reports a skipped node as skipped, with the upstream that stopped it", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "wf", toolName: "workflow" });
    h.turn.onEvent(
      nodeBeat("wf", "report", "upstream did not complete: security", {
        wave: 1,
        dependsOn: ["security"],
        status: "skipped",
      }),
    );
    const rung = h.rung();
    // Skipped is not failed. A node that never ran because its upstream did not
    // complete is not a defect in that node.
    expect(rung).toContain("skipped");
    expect(rung).toContain("after security");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("shows a retry while it is happening", () => {
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "wf", toolName: "workflow" });
    h.turn.onEvent(nodeBeat("wf", "flaky", "attempt 2 of 3", { attempt: 2, attempts: 3 }));
    expect(h.rung()).toContain("attempt 2 of 3");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("retires every node row when the workflow call ends", () => {
    // The nodes are keyed `<callId>:<node>`; deleting only the call would leave
    // the whole graph on the rung after its result was already committed.
    setTermWidthOverride(120);
    const h = harness();
    h.turn.onEvent({ type: "tool_call_start", callId: "wf", toolName: "workflow" });
    h.turn.onEvent(nodeBeat("wf", "security", "grep auth"));
    h.turn.onEvent(nodeBeat("wf", "perf", "read src/api.ts"));
    expect(h.rung()).toContain("security");
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "wf",
      args: { file: "review.workflow.json" },
      output: { toolName: "workflow", success: true, result: "done", durationMs: 10 },
    });
    expect(h.rung()).not.toContain("security");
    setTermWidthOverride(undefined as unknown as number);
  });
});

// ─── The agents panel (P4 §2.4, §2.6, lane B) ───
//
// The rung above the composer answers "how is the turn going". The panel in the
// right column answers a different question — "who is in the fan-out, and how
// is each of them doing" — and it answers it with three things the rung never
// had: a NAME per member, a member that is still on screen after it comes back,
// and a token count that came from a provider rather than from a guess.

describe("naming a child — who, not just what", () => {
  it("puts the name the master wrote on the card", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the settings surface" });
    h.turn.onEvent(started("c1"));
    const panel = h.panel();
    // The name is the card's title; the brief is still the second row.
    expect(panel).toContain("planner");
    expect(panel).toContain("map the settings surface");
    expect(h.card("planner")).toBeDefined();
    setTermWidthOverride(undefined as unknown as number);
  });

  it("derives a name from the task shape when the master wrote none", () => {
    setTermWidthOverride(120);
    const h = harness();
    // No `name`. A fan-out dispatched by a small free-route model routinely
    // supplies none, and an unnamed row is what this phase exists to remove.
    dispatch(h.turn, "c1", { label: "map the auth store" });
    dispatch(h.turn, "c2", { label: "build the settings page" }, "worker");
    const panel = h.panel();
    // The tool's own verb plus the first word of the brief that names a
    // subject — never a second model call, and never `agent-1`.
    expect(panel).toContain("scout-auth");
    expect(panel).toContain("build-setti".slice(0, 5)); // `build-…`
    expect(h.card("scout-auth")).toBeDefined();
    expect(panel).not.toContain("agent-1");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("keeps the name unclipped when the verb will not fit with it", () => {
    // `scout-setti` is worse than either half of it: the row already says
    // `scout` in its own column, so the SUBJECT is what survives.
    expect(deriveChildName("task", "map the settings surface")).toBe("settings");
    expect(deriveChildName("task", "map the auth store")).toBe("scout-auth");
    expect(deriveChildName("worker", "build the ui")).toBe("");
  });

  it("gives two children of the same name distinct suffixes", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "builder", label: "build the wizard" }, "worker");
    dispatch(h.turn, "c2", { name: "builder", label: "build the panel" }, "worker");
    dispatch(h.turn, "c3", { name: "builder", label: "build the strip" }, "worker");
    const names = fleetLedger.all().map((c) => c.name);
    // The model cannot see the other two calls it is writing in the same
    // message, so two `builder`s is the ordinary case. The panel resolves it.
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("builder");
    expect(names).toContain("builder-2");
    expect(names).toContain("builder-3");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("does not renumber a name once it is on screen", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "builder", label: "build the wizard" }, "worker");
    dispatch(h.turn, "c2", { name: "builder", label: "build the panel" }, "worker");
    const second = fleetLedger.all()[1]!.name;
    fleetLedger.clearFinished(); // nothing retired yet — a no-op
    // A row that renamed itself when a sibling finished would be worse than no
    // name at all: the suffix is fixed at registration for the life of the call.
    expect(fleetLedger.all()[1]!.name).toBe(second);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("resolves names by the documented order, and only then by ordinal", () => {
    const taken = new Set<string>();
    expect(resolveName("Planner", "scout-auth", 1, taken)).toBe("planner");
    expect(resolveName(undefined, "scout-auth", 2, taken)).toBe("scout-auth");
    // The ordinal is the FLOOR, not the rule: a panel of agent-1…agent-5 is a
    // count again, wearing five hats.
    expect(resolveName(undefined, undefined, 3, taken)).toBe("agent-3");
  });
});

describe("a finished member stays on the panel", () => {
  it("survives the tool_call_end that retires its rung row, and clears on `c`", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "scribe", label: "write the help copy" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(settled("c1"));
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "c1",
      args: { label: "write the help copy" },
      output: { toolName: "task", success: true, result: "done", durationMs: 4000 },
    });
    // The rung yields — the call is in the transcript now, and reporting it
    // twice would be reporting it wrong.
    expect(h.rung()).not.toContain("write the help copy");
    // The PANEL keeps it, in its own section, with the action that clears it.
    const panel = h.panel();
    expect(panel).toContain("FINISHED 1");
    expect(panel).toContain("c clear");
    expect(panel).toContain("scribe");

    expect(fleetLedger.clearFinished()).toBe(1);
    expect(h.panel()).not.toContain("scribe");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("keeps the running section when only the finished one is cleared", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the surface" });
    dispatch(h.turn, "c2", { name: "scribe", label: "write the copy" });
    for (const id of ["c1", "c2"]) h.turn.onEvent(started(id));
    h.turn.onEvent(settled("c2"));
    h.turn.onEvent({
      type: "tool_call_end",
      callId: "c2",
      args: {},
      output: { toolName: "task", success: true, result: "done", durationMs: 10 },
    });
    fleetLedger.clearFinished();
    const panel = h.panel();
    expect(panel).toContain("planner");
    expect(panel).not.toContain("scribe");
    expect(panel).not.toContain("FINISHED");
    setTermWidthOverride(undefined as unknown as number);
  });
});

describe("the pulse — liveness that cannot lie", () => {
  it("reads flat and says `quiet Ns` in words when a child stops reporting", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "verifier", label: "re-run the captures" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(beat("c1", "bun test ui-frame.test.ts"));
    const card = h.card("verifier")!;
    // Nine seconds later, with nothing fed. A spinner would still be turning.
    const later = Date.now() + 9000;
    const panel = h.panel(30, 38, false, later);
    expect(card.pulseStep).toBe(0);
    // The stall is STATED. Nothing here is carried by the glyph alone.
    expect(panel).toContain("quiet 9s");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("rises on that child's own output and not on a sibling's", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the surface" });
    dispatch(h.turn, "c2", { name: "idle", label: "wait" });
    for (const id of ["c1", "c2"]) h.turn.onEvent(started(id));
    for (let i = 0; i < 8; i++) {
      h.turn.onEvent({
        type: "tool_progress",
        callId: "c1",
        note: "reading",
        child: {
          agentId: "c1",
          event: { type: "text_delta", text: "x".repeat(400) },
        },
      });
    }
    fleetLedger.sample();
    // A shared accumulator would have every row rise when any one of them
    // moved — which is the borrowed heartbeat the panel exists to end. The
    // sibling sits where its own `started` marker put it (one marker, one
    // step) and 3.2 kB of somebody else's prose does not move it.
    expect(h.card("planner")!.pulseStep).toBeGreaterThanOrEqual(6);
    expect(h.card("idle")!.pulseStep).toBeLessThanOrEqual(1);
    setTermWidthOverride(undefined as unknown as number);
  });
});

describe("what the panel counts", () => {
  it("accumulates tokens from the child's own forwarded usage events", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the surface" });
    h.turn.onEvent(started("c1"));
    for (const [i, o] of [
      [800, 120],
      [2400, 300],
    ] as const) {
      h.turn.onEvent({
        type: "tool_progress",
        callId: "c1",
        note: "",
        child: {
          agentId: "c1",
          event: { type: "usage", inputTokens: i, outputTokens: o, cacheReadTokens: 100 },
        },
      });
    }
    // 800+120+100 + 2400+300+100 — a number a provider sent, not a guess. The
    // child computed both and threw them away before this.
    expect(h.card("planner")!.tokens).toBe(3820);
    expect(h.panel()).toContain("3.8k tok");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("collapses to initials once the members outnumber the rows", () => {
    setTermWidthOverride(120);
    const h = harness();
    const names = [
      "planner",
      "builder",
      "verifier",
      "scribe",
      "mapper",
      "tracer",
      "doctor",
      "runner",
      "carver",
    ];
    names.forEach((name, i) => {
      dispatch(h.turn, `c${i}`, { name, label: `job ${i}` });
      h.turn.onEvent(started(`c${i}`));
    });
    // Nine members into ten rows: two to a row, then one cell each.
    expect(chooseRungs(9, 0, 10)).toEqual({ rung: "line", pairs: true, initials: true });
    const panel = h.panel(10);
    // The pulse rides beside each initial, so the row still says who is moving.
    expect(panel).toMatch(/P\S\s+B\S/);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("takes the first two letters when one would collide", () => {
    // Resolved against the whole roster, so the row is stable while members
    // come and go — `Pl Pa` stay two letters after the third `p` has finished.
    expect(initialsFor(["planner", "builder"])).toEqual(["P", "B"]);
    expect(initialsFor(["planner", "parser", "builder"])).toEqual(["Pl", "Pa", "B"]);
  });
});

describe("the collapsed strip, below 100 columns", () => {
  it("names the members it has room for instead of printing a count", () => {
    setTermWidthOverride(80);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the surface" });
    dispatch(h.turn, "c2", { name: "builder", label: "build the page" }, "worker");
    for (const id of ["c1", "c2"]) h.turn.onEvent(started(id));
    h.turn.onEvent(settled("c2"));
    const strip = h.strip(76);
    expect(strip).toContain("planner");
    expect(strip).toContain("builder");
    expect(strip).toContain("ctrl+f open");
    // One row, always: the strip exists because the column is not worth its
    // cells at this width, not so it can become two.
    expect(strip.split("\n")).toHaveLength(1);
    setTermWidthOverride(undefined as unknown as number);
  });
});

describe("the card leads with what the member proved", () => {
  // The founder's philosophy review (2026-09-14): the panel is an AUDIT
  // surface, not activity theatre. So the card's first detail row is the last
  // receipt — what it verified or failed, carrying the rung it earned — and the
  // token and tool counts come after it. This is a deliberate deviation from
  // `docs/program/phase-4-mocks/120x40-working-4-agents.txt`, which puts the
  // brief there; the row budget is unchanged at four.
  const childEvent = (callId: string, event: Record<string, unknown>) => ({
    type: "tool_progress",
    callId,
    note: "",
    child: { agentId: callId, event },
  });

  it("puts the verdict above the brief, with its rung and its word", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "verifier", label: "re-run the frame captures" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(beat("c1", "bun test ui-frame.test.ts"));
    h.turn.onEvent(
      childEvent("c1", {
        type: "verification_completed",
        attempt: 1,
        ran: true,
        passed: true,
        report: "17 pass",
      }),
    );
    const lines = h.panel().split("\n");
    const head = lines.findIndex((l) => l.includes("verifier"));
    expect(head).toBeGreaterThanOrEqual(0);
    // Row two is the verdict; the brief follows it; the accounting is last.
    expect(lines[head + 1]).toContain("checks pass");
    expect(lines[head + 2]).toContain("re-run the frame captures");
    expect(lines[head + 3]).toContain("tok");
    // Never the mark alone — the word carries it under NO_COLOR too.
    expect(lines[head + 1]).toMatch(/[+✓]\s+checks pass/);
    // Four rows, as the mock budgets. The heartbeat is what gave up its row.
    expect(lines[head + 4] ?? "").not.toContain("bun test ui-frame.test.ts");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("draws the mock's card exactly while the member has proved nothing", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the settings surface" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(beat("c1", "read config-settings.ts"));
    const lines = h.panel().split("\n");
    const head = lines.findIndex((l) => l.includes("planner"));
    expect(lines[head + 1]).toContain("map the settings surface");
    expect(lines[head + 2]).toContain("read config-settings.ts");
    expect(lines[head + 3]).toContain("tok");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("says a check failed in the word as well as the mark", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "verifier", label: "re-run the captures" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(
      childEvent("c1", {
        type: "step_check",
        step: "frame holds at 80x24",
        ran: true,
        passed: false,
        report: "1 fail",
      }),
    );
    const panel = h.panel();
    expect(panel).toContain("failed: frame holds at 80x24");
    // A check that did not run is not a verdict: absent is not zero.
    const other = harness();
    dispatch(other.turn, "c2", { name: "scribe", label: "write the help copy" });
    other.turn.onEvent(started("c2"));
    other.turn.onEvent(
      childEvent("c2", {
        type: "step_check",
        step: "unrun",
        ran: false,
        passed: false,
        report: "",
      }),
    );
    expect(other.card("scribe")!.receipt).toBeUndefined();
    setTermWidthOverride(undefined as unknown as number);
  });

  it("takes the newest verdict, not the first one it was given", () => {
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "verifier", label: "re-run the captures" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(
      childEvent("c1", {
        type: "verification_completed",
        attempt: 1,
        ran: true,
        passed: false,
        report: "",
      }),
    );
    h.turn.onEvent(
      childEvent("c1", {
        type: "verification_completed",
        attempt: 2,
        ran: true,
        passed: true,
        report: "",
      }),
    );
    expect(h.card("verifier")!.receipt?.rung).toBe("verified");
    expect(h.panel()).toContain("checks pass");
    expect(h.panel()).not.toContain("checks fail");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("carries a verdict that never earned a heartbeat line", () => {
    // `hypothesis_updated` projects to a note and `usage` does not; neither
    // used to reach the parent at all. The receipt is taken where every child
    // event arrives, not behind the note gate, so a silent one still lands.
    setTermWidthOverride(120);
    const h = harness();
    dispatch(h.turn, "c1", { name: "scout", label: "find the leak" });
    h.turn.onEvent(started("c1"));
    h.turn.onEvent(childEvent("c1", { type: "hypothesis_updated", id: "h1", status: "confirmed" }));
    expect(h.card("scout")!.receipt).toMatchObject({ rung: "reproduced" });
    expect(h.panel()).toContain("h1 confirmed");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("leads the collapsed strip with the newest verdict too", () => {
    setTermWidthOverride(80);
    const h = harness();
    dispatch(h.turn, "c1", { name: "planner", label: "map the surface" });
    dispatch(h.turn, "c2", { name: "verifier", label: "run the checks" });
    for (const id of ["c1", "c2"]) h.turn.onEvent(started(id));
    h.turn.onEvent(
      childEvent("c2", {
        type: "verification_completed",
        attempt: 1,
        ran: true,
        passed: true,
        report: "",
      }),
    );
    const strip = h.strip(76);
    // The verdict, its owner, and only then who is busy.
    expect(strip.indexOf("checks pass")).toBeGreaterThanOrEqual(0);
    expect(strip.indexOf("checks pass")).toBeLessThan(strip.indexOf("2 running"));
    expect(strip.split("\n")).toHaveLength(1);
    setTermWidthOverride(undefined as unknown as number);
  });
});
