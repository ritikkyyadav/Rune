/**
 * M3 — the controller OWNS the empty-completion decision, behind a switch.
 *
 * `agent-loop-empty-completion.test.ts` pins what the branch DOES; this file
 * pins who decided it. Every test here runs the real `AgentLoop` against a
 * scripted gateway, twice where it matters: with `[controller] authority`
 * holding "E4" and without it. The two must be indistinguishable from outside
 * — same events, same requests, same permission calls — because the arbiter's
 * rule and the guard's predicate are the same decision written twice, and M3
 * deletes one of the two copies.
 *
 * Exit tests, by the spec's numbers (`docs/program/m3-first-migration.md`):
 *
 *   B1  the previous regressions pass with authority on AND off
 *   B2  contradictory triggers: abort, halt report, turn ceiling
 *   B3  a restart does not reset the allowance (the counter half; the real
 *       SIGKILL is `tests/integration/controller-e4.test.ts`)
 *   B4  exactly one applied decision per event, and the shadow row agrees
 *   B5  rollback: identical event stream and request fingerprint
 *   B7  permissions, sandbox and safety untouched
 *
 * Plus the two mutations the spec names, each performed on the real loop.
 *
 * **Zero model calls.** The gateway is a script; no credential, no network.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { AppliedDecisionRow } from "../../../packages/orchestrator/src/arbiter";
import { emptyRunState } from "../../../packages/orchestrator/src/run-state";
import {
  ShadowArbiter,
  type ShadowDecisionRow,
  type ShadowRow,
} from "../../../packages/orchestrator/src/shadow-arbiter";

// ─── The rig ───

type Step =
  | { kind: "tool"; tool: string; args?: Record<string, unknown>; text?: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

interface Request {
  messages: number;
  lastRole: string | undefined;
}

function makeGateway(script: Step[], requests: Request[]) {
  let i = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inferStream: async function* (request: any) {
      const messages = (request?.messages ?? []) as Array<{ role: string }>;
      requests.push({ messages: messages.length, lastRole: messages[messages.length - 1]?.role });
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      switch (step.kind) {
        case "tool":
          if (step.text) {
            yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
          }
          yield { type: "tool_use_start", toolCallId: `c${i}`, toolName: step.tool };
          yield { type: "tool_use_stop", toolCallId: `c${i}`, toolInput: step.args ?? {} };
          yield { type: "message_stop", stopReason: "tool_use" };
          return;
        case "text":
          yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
          yield { type: "message_stop", stopReason: "end_turn" };
          return;
        case "empty":
          yield { type: "message_stop", stopReason: "end_turn" };
          return;
      }
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: () => [{ name: "bash", description: "", inputSchema: {} }],
    list: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface RunOptions {
  script: Step[];
  /** "E4" present means the controller owns the branch. */
  authority?: string[];
  inheritedEmptyCompletions?: number;
  hasTerminalRow?: boolean;
  /** Drop the row sink — the spec's first mutation. */
  dropRows?: boolean;
  aborted?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permission?: any;
  opts?: Record<string, unknown>;
  /** Force the controller's answer, whatever the arbiter says — mutation two. */
  forceTransition?: string;
}

interface Outcome {
  events: AgentTurnEvent[];
  decisions: AppliedDecisionRow[];
  shadow: ShadowDecisionRow[];
  requests: Request[];
  permissionCalls: string[];
  messages: ReturnType<AgentLoop["getMessages"]>;
  stopReason: string | undefined;
  loop: AgentLoop;
}

async function runLoop(options: RunOptions): Promise<Outcome> {
  const requests: Request[] = [];
  const rows: ShadowRow[] = [];
  const decisions: AppliedDecisionRow[] = [];
  const permissionCalls: string[] = [];
  const shadow = new ShadowArbiter({
    runId: "run#1",
    emit: (row) => rows.push(row),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  const permission =
    options.permission ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (call: any) => {
      permissionCalls.push(String(call?.toolName ?? call?.tool ?? "?"));
      return { allowed: true };
    });
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 8,
      systemPrompt: "s",
      shadow,
      controller: {
        runId: "run#1",
        authority: new Set(options.authority ?? []),
        ...(options.inheritedEmptyCompletions !== undefined
          ? { inheritedEmptyCompletions: options.inheritedEmptyCompletions }
          : {}),
        ...(options.dropRows ? {} : { record: (row: AppliedDecisionRow) => decisions.push(row) }),
        ...(options.hasTerminalRow !== undefined
          ? { hasTerminalRow: () => options.hasTerminalRow! }
          : {}),
      },
      ...(options.opts ?? {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(options.script, requests),
    makeRegistry(),
    permission,
  );
  if (options.forceTransition !== undefined) {
    // The real seam the site decides through, replaced. See the mutations.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loop as any).decideWithAuthority = () => options.forceTransition;
  }
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("do the thing", "s1", "/tmp", controller.signal)) events.push(e);
  shadow.finish();
  const terminal = events.find((e) => e.type === "turn_complete") as
    { stopReason: string } | undefined;
  return {
    events,
    decisions,
    shadow: rows.filter((r): r is ShadowDecisionRow => r.type === "shadow_decision"),
    requests,
    permissionCalls,
    messages: loop.getMessages(),
    stopReason: terminal?.stopReason,
    loop,
  };
}

/** The empty-completion nudge, and nothing else the harness ever appends. */
function isEmptyNudge(m: { content: Array<{ type: string }> }): boolean {
  return m.content.some(
    (b) => b.type === "text" && (b as { text: string }).text.includes("not provided an answer"),
  );
}

/** The three shapes of the branch, as the corpus produces them. */
const ACCEPT_ON_NARRATION: Step[] = [
  // Narration and the call in ONE turn: a turn that ENDS in text is an
  // ordinary finish, and this branch is about the run that stops speaking
  // after its tool results.
  { kind: "tool", tool: "read_file", args: { path: "a.txt" }, text: "reading the fixture now" },
  { kind: "empty" },
  { kind: "empty" },
];
const ACCEPT_ON_WRITE: Step[] = [
  { kind: "tool", tool: "write_file", args: { path: "a.txt", content: "x" } },
  { kind: "empty" },
  { kind: "empty" },
  { kind: "empty" },
];
const BAIL: Step[] = [{ kind: "empty" }];

const SHAPES: Array<[string, Step[]]> = [
  ["accept on the earlier narration", ACCEPT_ON_NARRATION],
  ["accept on the written work", ACCEPT_ON_WRITE],
  ["bail with nothing to stand on", BAIL],
];

// ─── B5 / B1 — the switch changes nothing anyone can see ───

describe("B5 — with the controller deciding, the run is indistinguishable from the guard's", () => {
  for (const [name, script] of SHAPES) {
    test(`${name}: identical events, requests and transcript on and off`, async () => {
      const off = await runLoop({ script });
      const on = await runLoop({ script, authority: ["E4"] });
      expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));
      // The spend fingerprint: one request per model call, each with the same
      // transcript length — a nudge appended twice would move it.
      expect(on.requests).toEqual(off.requests);
      expect(JSON.stringify(on.messages)).toBe(JSON.stringify(off.messages));
    });
  }

  test("B1 — the bail still ends provider_lost and the accepts still end end_turn", async () => {
    for (const authority of [[], ["E4"]]) {
      const bail = await runLoop({ script: BAIL, authority });
      expect(bail.stopReason).toBe("provider_lost");
      expect(bail.events.some((e) => e.type === "error")).toBe(true);
      for (const [, script] of SHAPES.slice(0, 2)) {
        const accepted = await runLoop({ script, authority });
        expect(accepted.stopReason).toBe("end_turn");
        expect(accepted.events.some((e) => e.type === "error")).toBe(false);
      }
    }
  });

  test("B1 — the one nudge is appended once, and only once, either way", async () => {
    for (const authority of [[], ["E4"]]) {
      const run = await runLoop({ script: ACCEPT_ON_NARRATION, authority });
      const nudges = run.messages.filter((m) => m.role === "user" && isEmptyNudge(m));
      expect(nudges.length).toBe(1);
      expect(run.loop.originOf(nudges[0]!)).toBe("nudge:empty-completion");
    }
  });
});

// ─── B7 — nothing about permissions or safety moves ───

describe("B7 — permissions and safety are untouched by the switch", () => {
  test("the permission checks are the same calls in the same order", async () => {
    for (const [, script] of SHAPES) {
      const off = await runLoop({ script });
      const on = await runLoop({ script, authority: ["E4"] });
      expect(on.permissionCalls).toEqual(off.permissionCalls);
    }
  });

  test("a denying check denies identically with the controller deciding", async () => {
    const deny = async () => ({ allowed: false, reason: "policy refuses this call" });
    const off = await runLoop({ script: ACCEPT_ON_WRITE, permission: deny });
    const on = await runLoop({ script: ACCEPT_ON_WRITE, authority: ["E4"], permission: deny });
    expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));
  });
});

// ─── B4 — one applied decision per event ───

describe("B4 — every empty completion has exactly one applied decision", () => {
  test("the rows are one per event, unique, applied, and classed", async () => {
    const run = await runLoop({ script: ACCEPT_ON_WRITE, authority: ["E4"] });
    // Three empty completions: the nudged retry, the accept, and one more
    // after the execution-evidence gate sends the finish back.
    expect(run.decisions.length).toBe(3);
    expect(new Set(run.decisions.map((d) => d.eventId)).size).toBe(3);
    expect(new Set(run.decisions.map((d) => d.decisionId)).size).toBe(3);
    for (const d of run.decisions) {
      expect(d.applied).toBe(true);
      expect(d.class).toBe(3);
      expect(d.guard).toBe("E4");
      expect(d.type).toBe("decision");
      expect(d.version).toBe(1);
      expect(d.runId).toBe("run#1");
      expect(d.decisionId).toBe(`d:${d.eventId}`);
      expect(d.reason.length).toBeGreaterThan(0);
    }
    expect(run.decisions.map((d) => d.transition)).toEqual(["working", "verifying", "verifying"]);
  });

  test("the shadow rows for the same events still exist and agree", async () => {
    const run = await runLoop({ script: ACCEPT_ON_WRITE, authority: ["E4"] });
    // The branch observes under two labels — E4 while it retries or abandons,
    // G9 at the accept — so the three events are three rows across the two.
    const branch = run.shadow.filter((r) => r.guard === "E4" || r.guard === "G9");
    expect(branch.length).toBe(3);
    expect(branch.map((r) => r.decision)).toEqual(run.decisions.map((d) => d.transition));
    for (const row of branch) {
      expect(row.agree).toBe(true);
      // The shadow lane applied nothing even while the controller acted.
      expect(row.applied).toBe(false);
    }
  });

  test("the bail writes exactly one abandoning decision", async () => {
    const run = await runLoop({ script: BAIL, authority: ["E4"] });
    expect(run.decisions.length).toBe(3);
    expect(run.decisions.map((d) => d.transition)).toEqual([
      "working",
      "working",
      "abandoned(environment)",
    ]);
    expect(run.stopReason).toBe("provider_lost");
  });

  test("with authority off not one applied row is written", async () => {
    for (const [, script] of SHAPES) {
      const run = await runLoop({ script });
      expect(run.decisions).toEqual([]);
      // …and the shadow lane still watched.
      expect(run.shadow.length).toBeGreaterThan(0);
    }
  });

  test("no row carries anything but booleans, numbers and enum words", async () => {
    const run = await runLoop({ script: ACCEPT_ON_WRITE, authority: ["E4"] });
    for (const d of run.decisions) {
      for (const value of Object.values(d.inputs)) {
        expect(["boolean", "number"].includes(typeof value) || value === null).toBe(true);
      }
    }
  });
});

// ─── B2 — contradictory triggers ───

describe("B2 — a lower class wins, and the branch does not run at all", () => {
  test("an abort on the same turn ends aborted, with no nudge and no decision", async () => {
    const run = await runLoop({ script: BAIL, authority: ["E4"], aborted: true });
    expect(run.stopReason).toBe("aborted");
    expect(run.decisions).toEqual([]);
    expect(run.messages.some(isEmptyNudge)).toBe(false);
  });

  test("a halt latched on the same turn takes the halt path, with no decision", async () => {
    const halting = async () => ({
      allowed: false,
      halt: { reason: "the broker halted this run" },
      reason: "Auto mode halted this run",
    });
    const run = await runLoop({
      script: [
        { kind: "tool", tool: "bash", args: { command: "curl example.com" } },
        { kind: "empty" },
      ],
      authority: ["E4"],
      permission: halting,
    });
    expect(run.stopReason).toBe("halted");
    expect(run.decisions).toEqual([]);
  });

  test("the turn ceiling on the same turn is budget, not an empty completion", async () => {
    const run = await runLoop({
      script: [{ kind: "tool", tool: "bash", args: { command: "echo 1" } }],
      authority: ["E4"],
      opts: { maxTurns: 2 },
    });
    expect(run.stopReason).toBe("max_turns");
    expect(run.decisions).toEqual([]);
  });
});

// ─── B3 — the allowance is not reset by a restart (the counter) ───

describe("B3 — a resumed run carries the empty completions it already spent", () => {
  test("two inherited plus one more abandons on the first empty completion", async () => {
    const run = await runLoop({
      script: BAIL,
      authority: ["E4"],
      inheritedEmptyCompletions: 2,
    });
    expect(run.decisions.length).toBe(1);
    expect(run.decisions[0]!.transition).toBe("abandoned(environment)");
    expect(run.decisions[0]!.inputs.emptyCompletions).toBe(3);
    expect(run.stopReason).toBe("provider_lost");
    // One request: it did not buy a fresh allowance.
    expect(run.requests.length).toBe(1);
  });

  test("the same inheritance with authority off buys a fresh three", async () => {
    const run = await runLoop({ script: BAIL, inheritedEmptyCompletions: 2 });
    expect(run.requests.length).toBe(3);
    expect(run.stopReason).toBe("provider_lost");
  });

  test("the resumed run is not nudged for an allowance it already spent", async () => {
    const run = await runLoop({
      script: BAIL,
      authority: ["E4"],
      inheritedEmptyCompletions: 2,
    });
    // The nudge belongs to the FIRST empty completion, which happened in the
    // run that died. The resumed one abandons on its first.
    expect(run.messages.some(isEmptyNudge)).toBe(false);
  });

  test("usable output clears the inherited count: a recovered run is not on probation", async () => {
    const run = await runLoop({
      script: [
        { kind: "tool", tool: "read_file", args: { path: "a.txt" } },
        { kind: "empty" },
        { kind: "empty" },
        { kind: "empty" },
      ],
      authority: ["E4"],
      inheritedEmptyCompletions: 2,
    });
    // The tool call is real output, so the counter resets exactly as it does
    // mid-run — the rule is "empty completions IN A ROW", and a restart does
    // not make a working run suspect. Deliberate, and the reason B3 asserts
    // the SIGKILL case on a resumed run whose first call is also empty.
    expect(run.decisions.map((d) => d.transition)).toEqual([
      "working",
      "working",
      "abandoned(environment)",
    ]);
    expect(run.messages.some(isEmptyNudge)).toBe(true);
  });
});

// ─── The idempotent act ───

describe("the act is idempotent, because a crash can land between the row and it", () => {
  test("the site can see that the transcript already ends with its nudge", async () => {
    const run = await runLoop({ script: BAIL, authority: ["E4"] });
    const note = "[Harness note] the same note";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loop = run.loop as any;
    expect(loop.endsWithHarnessNote(note)).toBe(false);
    loop.appendMessage({ role: "user", content: [{ type: "text", text: note }] }, "nudge:test");
    // The guard the retry branch reads before it appends: a resumed run whose
    // transcript already carries the note does not ask for it twice.
    expect(loop.endsWithHarnessNote(note)).toBe(true);
    loop.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    expect(loop.endsWithHarnessNote(note)).toBe(false);
  });

  test("a terminal is not re-emitted when the run already has one", async () => {
    const withRow = await runLoop({ script: BAIL, authority: ["E4"], hasTerminalRow: true });
    expect(withRow.events.some((e) => e.type === "turn_complete")).toBe(false);
    // The decision was still applied and the error still told the user.
    expect(withRow.decisions.at(-1)!.transition).toBe("abandoned(environment)");
    expect(withRow.events.some((e) => e.type === "error")).toBe(true);

    const withoutRow = await runLoop({ script: BAIL, authority: ["E4"], hasTerminalRow: false });
    expect(withoutRow.events.filter((e) => e.type === "turn_complete").length).toBe(1);
  });
});

// ─── The mutations the spec names ───

describe("the exit tests can fail", () => {
  test("mutation 1: drop the applied row write and B4 goes red", async () => {
    const run = await runLoop({ script: ACCEPT_ON_WRITE, authority: ["E4"], dropRows: true });
    // The run is unchanged — which is the point: the row is the RECORD, and
    // without it nothing reconciles a crash between the decision and the act.
    expect(run.stopReason).toBe("end_turn");
    expect(run.decisions).toEqual([]);
    // B4's assertion, run against the mutant: it fails.
    let b4 = true;
    try {
      expect(run.decisions.length).toBe(3);
    } catch {
      b4 = false;
    }
    expect(b4).toBe(false);
  });

  test("mutation 2: a controller that always answers working never ends the run", async () => {
    const run = await runLoop({ script: BAIL, authority: ["E4"], forceTransition: "working" });
    // B1's bail assertion, against the mutant: the run does not end
    // provider_lost, it runs out of turns.
    expect(run.stopReason).not.toBe("provider_lost");
    expect(run.stopReason).toBe("max_turns");
    expect(run.requests.length).toBeGreaterThan(3);
  });

  test("a transition the branch cannot act on is refused, and the row says so", async () => {
    // The vocabulary guard, tested on the seam itself: an arbiter that answers
    // `unknown` — a missing input, an already-terminal phase — does not get to
    // decide this branch, and the run is never left undecided.
    const run = await runLoop({ script: BAIL, authority: ["E4"] });
    const rows: AppliedDecisionRow[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (run.loop as any).config.controller.record = (row: AppliedDecisionRow) => rows.push(row);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transition = (run.loop as any).decideWithAuthority(
      "E4",
      "E4",
      {},
      ["working", "verifying"],
      () => "verifying",
      () => emptyRunState("run#1"),
    );
    expect(transition).toBe("verifying");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applied).toBe(true);
    expect(rows[0]!.transition).toBe("verifying");
    expect(rows[0]!.reason).toContain("cannot act on");
  });
});
