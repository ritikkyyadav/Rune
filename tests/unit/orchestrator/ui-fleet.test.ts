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

function harness() {
  const commits: string[] = [];
  const sink: TurnSink = { commit: (block) => commits.push(block), preview: () => {} };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return {
    turn,
    commits,
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
