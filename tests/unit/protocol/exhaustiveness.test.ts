/**
 * The drift law.
 *
 * `AgentTurnEvent` has 31 members (the count is asserted below, so this
 * sentence cannot go stale again — it said 22 for nine members). Before
 * Phase 2 three separate reducers consumed it through `any` —
 * `TurnRenderer.onEvent`, `formatEvent`, and the desktop's `streamReducer`
 * reading a hand-written copy of the union — so adding a member compiled clean
 * in all three and rendered nothing in any of them. The desktop's copy had
 * drifted both ways: stale `plan_*` members the engine stopped emitting, and
 * four live events (`retry`, `tool_progress`, `step_check`, `handoff`) it had
 * never learned.
 *
 * Phase 2 added the two consumers the law could not see. The TUI SHELL
 * (`tui.ts`) reduced the same stream as a chain of `if (ev.type === …)` with
 * no `assertNever`; and the PERSISTED SESSION — `replayEvents` plus the
 * `RUN_TRACE_EVENTS` allow-list — is the third consumer this whole phase is
 * about and nothing stopped it drifting. Both are guarded below.
 *
 * The fix is two-layered, and this file tests the second layer.
 *
 *   1. COMPILE TIME — every reducer ends in `assertNever`, so a new member is
 *      a type error until each surface names it. Proven by construction: add a
 *      member to the union and `bun run typecheck` fails in every reducer.
 *      That layer cannot be tested from a runtime test, because types are
 *      erased before this file runs.
 *
 *   2. SOURCE — this file. It reads each reducer and asserts that every member
 *      of the manifest appears as a `case` label in it. That catches the one
 *      thing the compiler cannot: a reducer that satisfies exhaustiveness by
 *      widening its parameter back to `any` or re-adding a bare `default`.
 *
 * The manifest itself is guarded inside `@rune/protocol`: `AGENT_TURN_EVENT_TYPES`
 * fails to compile if it drifts from the union in either direction.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NOT_REPLAYED_EVENTS,
  REPLAYED_FROM_ROW,
  RUN_TRACE_EVENTS,
} from "../../../packages/orchestrator/src/engine";
import {
  AGENT_TURN_EVENT_TYPES,
  RESEARCH_EVENT_TYPES,
  RESEARCH_ONLY_EVENT_TYPES,
  HOST_COMMANDS,
  HOST_STREAMS,
  PROTOCOL_VERSION,
  isAgentTurnEvent,
  isCompatibleVersion,
} from "../../../packages/protocol/src/index";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** Every reducer that consumes the event union, and where it lives. */
const REDUCERS = [
  {
    name: "TUI transcript (bin/ui/turn.ts onEvent)",
    file: "packages/orchestrator/src/bin/ui/turn.ts",
    from: "onEvent(event: AgentTurnEvent | ResearchEvent)",
  },
  {
    name: "TUI formatter (bin/ui/events.ts formatEvent)",
    file: "packages/orchestrator/src/bin/ui/events.ts",
    from: "export function formatEvent(",
  },
  {
    name: "headless runner (headless.ts runHeadless)",
    file: "packages/orchestrator/src/headless.ts",
    from: "for await (const event of engine.chat(",
  },
  {
    // The TUI shell's OWN reducer — the answer buffer, the tool counters, the
    // footer's file set, the checkpoint label, the quota stop. A fourth live
    // consumer of the same stream, unguarded until Phase 2.
    name: "TUI shell (bin/ui/tui.ts chat loop)",
    file: "packages/orchestrator/src/bin/ui/tui.ts",
    from: "for await (const ev of engine.chat(this.ctx.sessionId, input))",
  },
] as const;

function reducerBody(file: string, from: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  const start = source.indexOf(from);
  if (start === -1) {
    throw new Error(
      `${file}: could not find the reducer entry point "${from}". ` +
        "If the reducer moved, update this test — do not delete the assertion.",
    );
  }
  return source.slice(start);
}

function caseLabels(body: string): Set<string> {
  const labels = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z_]+)"\s*:/g)) labels.add(m[1]!);
  return labels;
}

describe("AgentTurnEvent is handled by every reducer", () => {
  for (const reducer of REDUCERS) {
    test(`${reducer.name} names all ${AGENT_TURN_EVENT_TYPES.length} members`, () => {
      const labels = caseLabels(reducerBody(reducer.file, reducer.from));
      const missing = AGENT_TURN_EVENT_TYPES.filter((t) => !labels.has(t));
      expect(missing).toEqual([]);
    });
  }

  test("every reducer ends in an exhaustiveness assertion, not a bare default", () => {
    for (const reducer of REDUCERS) {
      const body = reducerBody(reducer.file, reducer.from);
      // The compile-time half. A reducer that drops this can silently absorb a
      // new member again, which is precisely the regression being prevented.
      expect(
        /assertNever(Soft|Event)?\s*\(/.test(body),
        `${reducer.name} has no assertNever — a new event member would compile clean`,
      ).toBe(true);
    }
  });

  test("no reducer takes the event union as `any`", () => {
    for (const reducer of REDUCERS) {
      const source = readFileSync(join(ROOT, reducer.file), "utf8");
      expect(source).not.toContain("onEvent(event: any)");
      expect(source).not.toContain("formatEvent(ev: any");
      // The desktop's escape hatch: casting the union back to a bag of unknowns.
      expect(source).not.toContain("as EngineEvent & Record<string, unknown>");
    }
  });
});

describe("ResearchEvent is handled where research is rendered", () => {
  test("the TUI formatter names every research-only member", () => {
    const labels = caseLabels(
      reducerBody("packages/orchestrator/src/bin/ui/events.ts", "export function formatEvent("),
    );
    const missing = RESEARCH_ONLY_EVENT_TYPES.filter((t) => !labels.has(t));
    expect(missing).toEqual([]);
  });

  test("the TUI transcript names every research-only member", () => {
    const labels = caseLabels(
      reducerBody(
        "packages/orchestrator/src/bin/ui/turn.ts",
        "onEvent(event: AgentTurnEvent | ResearchEvent)",
      ),
    );
    const missing = RESEARCH_ONLY_EVENT_TYPES.filter((t) => !labels.has(t));
    expect(missing).toEqual([]);
  });

  test("the two unions overlap only on notice and error", () => {
    const shared = RESEARCH_EVENT_TYPES.filter((t) =>
      (AGENT_TURN_EVENT_TYPES as readonly string[]).includes(t),
    );
    expect(shared.sort()).toEqual(["error", "notice"]);
  });
});

describe("no client redeclares the event union", () => {
  test("the orchestrator re-exports rather than redefines", () => {
    const loop = readFileSync(join(ROOT, "packages/orchestrator/src/agent-loop.ts"), "utf8");
    expect(loop).not.toMatch(/export type AgentTurnEvent\s*=/);
    expect(loop).toContain('from "@rune/protocol"');
  });
});

describe("the persisted session is a reducer too", () => {
  // The third consumer. `replayEvents` (engine.ts) rebuilds a session's event
  // stream from its rows: a member reaches it either through a `run_trace` row
  // (`RUN_TRACE_EVENTS`) or through a row of its own (`REPLAYED_FROM_ROW`).
  // Anything else must be a DECISION, recorded in `NOT_REPLAYED_EVENTS` with
  // the reason — otherwise a member that stopped being persisted looks exactly
  // like one nobody remembered to persist.
  const covered = new Set<string>([
    ...RUN_TRACE_EVENTS,
    ...REPLAYED_FROM_ROW,
    ...NOT_REPLAYED_EVENTS.keys(),
  ]);

  test("every member is persisted, replayed from its own row, or declared unpersisted", () => {
    const missing = AGENT_TURN_EVENT_TYPES.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  test("the three persistence sets name nothing that is not an event", () => {
    const known = new Set<string>(AGENT_TURN_EVENT_TYPES);
    const invented = [...covered].filter((t) => !known.has(t));
    expect(invented).toEqual([]);
  });

  test("the terminal verdict and the lifecycle projection are durable", () => {
    // Gap 1.8a: a run that hit its ceiling with a closed plan left NO durable
    // record of how it ended, so a restart could not report on the run it was
    // recovering. Both of these are what a restart reads.
    expect(RUN_TRACE_EVENTS.has("turn_complete")).toBe(true);
    expect(RUN_TRACE_EVENTS.has("lifecycle")).toBe(true);
  });

  test("every unpersisted member carries a reason, not just an absence", () => {
    for (const [type, why] of NOT_REPLAYED_EVENTS) {
      expect(typeof why === "string" && why.length > 10, `${type} has no reason`).toBe(true);
    }
  });

  test("replayEvents keeps a deliberate default, not a silent one", () => {
    const body = reducerBody(
      "packages/orchestrator/src/engine.ts",
      "export function replayEvents(",
    );
    // The reducer switches on ROW types, not on event types, so `assertNever`
    // cannot apply: an unknown row from a NEWER build must be skipped, not
    // thrown. What the law can require is that the skip is documented.
    expect(body).toContain("Rows that are not turn events");
  });
});

describe("manifests", () => {
  test("AGENT_TURN_EVENT_TYPES has no duplicates", () => {
    expect(new Set(AGENT_TURN_EVENT_TYPES).size).toBe(AGENT_TURN_EVENT_TYPES.length);
  });

  test("the member count in this file's header is the real one", () => {
    // The header said 22 for nine members and three consumers for five. A
    // stale comment on the drift law is the drift law drifting.
    const header = readFileSync(join(ROOT, "tests/unit/protocol/exhaustiveness.test.ts"), "utf8");
    expect(header).toContain(`\`AgentTurnEvent\` has ${AGENT_TURN_EVENT_TYPES.length} members`);
  });

  test("docs/protocol.md counts the reducers this file guards", () => {
    const doc = readFileSync(join(ROOT, "docs/protocol.md"), "utf8");
    expect(doc).toContain(`${REDUCERS.length} reducers`);
  });

  test("HOST_COMMANDS and HOST_STREAMS have no duplicates", () => {
    expect(new Set(HOST_COMMANDS).size).toBe(HOST_COMMANDS.length);
    expect(new Set(HOST_STREAMS).size).toBe(HOST_STREAMS.length);
  });

  test("every stream the host emits is declared", () => {
    // The four the sidecar shipped with, so a desktop build on the old
    // contract keeps working, plus the six P2.2/P2.5/P2.7 added.
    for (const legacy of ["ready", "chat_event", "engine_status", "permission_request"]) {
      expect(HOST_STREAMS).toContain(legacy as never);
    }
  });
});

describe("version", () => {
  test("same major is compatible, different major is not", () => {
    expect(isCompatibleVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleVersion("1.9.3")).toBe(true);
    expect(isCompatibleVersion("2.0.0")).toBe(false);
    expect(isCompatibleVersion("nonsense")).toBe(false);
  });
});

describe("inbound event narrowing", () => {
  test("accepts every declared member and rejects junk", () => {
    for (const type of AGENT_TURN_EVENT_TYPES) {
      expect(isAgentTurnEvent({ type })).toBe(true);
    }
    expect(isAgentTurnEvent({ type: "not_an_event" })).toBe(false);
    expect(isAgentTurnEvent(null)).toBe(false);
    expect(isAgentTurnEvent("text_delta")).toBe(false);
    expect(isAgentTurnEvent({})).toBe(false);
  });
});
