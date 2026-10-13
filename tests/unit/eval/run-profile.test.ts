/**
 * `tests/eval/parity/run-profile.ts` reads one run's database and says where
 * its time and money went. Every figure it reports is held here against a
 * database written by hand, event by event, so each one has a known answer:
 * nothing is compared with another reader's opinion of a recorded run.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findDatabase, formatProfile, profileRun } from "../../eval/parity/run-profile";

const dir = mkdtempSync(join(tmpdir(), "run-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Event = [seconds: number, type: string, payload: Record<string, unknown>];

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
let made = 0;

/** A database holding exactly these events, at these seconds from the first. */
function database(events: Event[], opts: { wrap?: boolean; path?: string } = {}): string {
  const path = opts.path ?? join(dir, `run-${made++}.db`);
  const db = new Database(path);
  db.run(
    "create table events (id integer primary key autoincrement, session_id text, seq integer, type text, payload_json text, created_at text)",
  );
  const insert = db.prepare(
    "insert into events (session_id, seq, type, payload_json, created_at) values ('s', ?, ?, ?, ?)",
  );
  events.forEach(([seconds, type, payload], seq) => {
    const body = opts.wrap === false ? payload : { type, payload };
    insert.run(seq, type, JSON.stringify(body), new Date(T0 + seconds * 1000).toISOString());
  });
  db.close();
  return path;
}

const cost = (
  role: string,
  latencyMs: number,
  listCostUsd: number,
  tokens: { in?: number; cached?: number; out?: number } = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  role,
  model: "m",
  latencyMs,
  listCostUsd,
  priced: true,
  inputTokens: tokens.in ?? 1000,
  cacheReadTokens: tokens.cached ?? 0,
  outputTokens: tokens.out ?? 100,
  ...extra,
});
const says = (...tools: string[]): Record<string, unknown> => ({
  content: "",
  toolUses: tools.map((toolName, i) => ({
    callId: `${toolName}-${made}-${i}-${Math.random()}`,
    toolName,
  })),
});

/**
 * One run, written so that every figure is different from every other:
 * read, plan alone, write, check + plan together, cite alone, finish; a
 * supervisor call alongside; a check that times out and one that passes.
 */
function aRun(wrap = true): string {
  const read = says("read_file");
  const plan = says("todo_write");
  const write = says("write_file");
  const checkAndPlan = says("bash", "todo_write");
  const cite = says("record_evidence");
  const id = (m: Record<string, unknown>, i = 0): string =>
    String((m.toolUses as Array<{ callId: string }>)[i]!.callId);
  return database(
    [
      [0, "user_msg", { content: "do it" }],
      [4, "cost", cost("primary", 4000, 0.04, { in: 1000, cached: 0 }, { effort: "high" })],
      [4, "assistant_msg", read],
      [5, "tool_result", { callId: id(read) }],
      [9, "cost", cost("primary", 3000, 0.01, { in: 2000, cached: 1500 }, { effort: "high" })],
      [9, "assistant_msg", plan],
      [9, "tool_result", { callId: id(plan) }],
      [15, "cost", cost("primary", 6000, 0.02, { in: 2000, cached: 1500 }, { effort: "high" })],
      [15, "assistant_msg", write],
      // Alongside the write, not after it.
      [16, "cost", cost("supervisor", 2500, 0.08, { in: 8000, cached: 0 })],
      [17, "tool_result", { callId: id(write) }],
      [22, "cost", cost("primary", 5000, 0.02, { in: 3000, cached: 3000 }, { effort: "max" })],
      [22, "assistant_msg", checkAndPlan],
      [30, "tool_result", { callId: id(checkAndPlan, 0) }],
      [30, "tool_result", { callId: id(checkAndPlan, 1) }],
      [33, "cost", cost("primary", 2000, 0.005, { in: 2000, cached: 2000 }, { effort: "max" })],
      [33, "assistant_msg", cite],
      [33, "tool_result", { callId: id(cite) }],
      [40, "cost", cost("primary", 7000, 0.03, { in: 2000, cached: 2000 }, { effort: "max" })],
      [40, "assistant_msg", { content: "done", toolUses: [] }],
      [40, "run_trace", { type: "verification_started", attempt: 1 }],
      [
        160,
        "run_trace",
        { type: "verification_completed", status: "inconclusive", reason: "timeout" },
      ],
      [170, "run_trace", { type: "verification_started", attempt: 2 }],
      [176, "run_trace", { type: "verification_completed", status: "passed" }],
      [177, "verdict", { kind: "met" }],
    ],
    { wrap },
  );
}

describe("one run's profile", () => {
  const p = profileRun(aRun());

  test("the clock: start to last event, first tool, first and last write", () => {
    expect(p.wallMs).toBe(177_000);
    expect(p.firstActionMs).toBe(5_000);
    // The read at 5 s and the plan at 9 s wrote nothing.
    expect(p.firstWriteMs).toBe(17_000);
    expect(p.lastWriteMs).toBe(17_000);
  });

  test("the checks: each one, how long it held the finish, and what it said", () => {
    expect(p.checks).toEqual([
      { startedMs: 40_000, ms: 120_000, status: "inconclusive", reason: "timeout" },
      { startedMs: 170_000, ms: 6_000, status: "passed" },
    ]);
    expect(p.checkMs).toBe(126_000);
  });

  test("the work and the reviewer are counted apart", () => {
    expect(p.roles.primary).toEqual({
      calls: 6,
      latencyMs: 27_000,
      listUsd: expect.closeTo(0.125, 6),
      inputTokens: 12_000,
      cachedTokens: 10_000,
      outputTokens: 600,
    });
    expect(p.roles.supervisor).toMatchObject({ calls: 1, latencyMs: 2_500, cachedTokens: 0 });
    expect(p.roles.supervisor!.listUsd).toBeCloseTo(0.08, 6);
    expect(p.listUsd).toBeCloseTo(0.205, 6);
    expect(p.unpricedCalls).toBe(0);
    // 12,000 paid for in full and 10,000 read from the cache: the cached
    // tokens are beside the input on a cost row, not inside it.
    expect(p.primaryCachedShare).toBeCloseTo(10_000 / 22_000, 6);
  });

  test("a completion that only kept the ledger is counted, with the completion it cost", () => {
    expect(p.turns).toBe(6);
    // The plan alone and the citation alone. The check sent WITH a plan update is work.
    expect(p.ledgerOnlyTurns).toBe(2);
    expect(p.ledgerOnlyMs).toBe(3_000 + 2_000);
    expect(p.ledgerOnlyUsd).toBeCloseTo(0.01 + 0.005, 6);
    expect(p.tools).toEqual({
      read_file: 1,
      todo_write: 2,
      write_file: 1,
      bash: 1,
      record_evidence: 1,
    });
  });

  test("the effort each call asked for, and how often it changed", () => {
    expect(p.efforts).toEqual({ high: 3, max: 3 });
    expect(p.effortChanges).toBe(1);
  });

  test("a database written without the event envelope reads the same", () => {
    expect(profileRun(aRun(false))).toEqual(p);
  });
});

describe("what a database does not hold is not zero", () => {
  test("a call with no known price leaves the cost unknown, for its role and for the run", () => {
    const p = profileRun(
      database([
        [1, "cost", cost("primary", 1000, 0.02)],
        [1, "assistant_msg", says("todo_write")],
        // `priced: false` with a zero beside it: the gateway did not know.
        [2, "cost", cost("primary", 1000, 0, {}, { priced: false })],
        [2, "assistant_msg", says("todo_write")],
        [3, "cost", cost("supervisor", 500, 0.01)],
      ]),
    );
    expect(p.unpricedCalls).toBe(1);
    expect(p.listUsd).toBeNull();
    expect(p.roles.primary!.listUsd).toBeNull();
    // The role that was priced still has its price.
    expect(p.roles.supervisor!.listUsd).toBeCloseTo(0.01, 6);
    expect(p.ledgerOnlyUsd).toBeNull();
    expect(formatProfile("run", p)).toContain("cost price unknown (1 call(s) with no known price)");
  });

  test("a build that recorded no effort says so, and claims no count of changes", () => {
    const p = profileRun(
      database([
        [1, "cost", cost("primary", 1000, 0.02)],
        [1, "assistant_msg", { content: "hello", toolUses: [] }],
      ]),
    );
    expect(p.efforts).toEqual({});
    expect(p.effortChanges).toBeNull();
    const text = formatProfile("run", p);
    expect(text).toContain("effort: not recorded by this build");
    // Nothing ran, nothing was written, nothing was checked.
    expect(p.firstActionMs).toBeNull();
    expect(p.firstWriteMs).toBeNull();
    expect(text).toContain("first tool — · first write — · last write —");
    expect(text).toContain("checks held the finish 0s (none ran)");
  });

  test("an effort that never changed is zero changes, which is a measurement", () => {
    const p = profileRun(
      database([
        [1, "cost", cost("primary", 1000, 0.02, {}, { effort: "medium" })],
        [2, "cost", cost("primary", 1000, 0.02, {}, { effort: "medium" })],
      ]),
    );
    expect(p.efforts).toEqual({ medium: 2 });
    expect(p.effortChanges).toBe(0);
  });

  test("a run with no input tokens has no cached share, not a share of zero", () => {
    const p = profileRun(
      database([[1, "cost", cost("primary", 1000, 0.02, { in: 0, cached: 0 })]]),
    );
    expect(p.primaryCachedShare).toBeNull();
  });

  test("a check that started and never finished is not given a length", () => {
    const p = profileRun(
      database([
        [1, "run_trace", { type: "verification_started" }],
        [9, "verdict", {}],
      ]),
    );
    expect(p.checks).toEqual([]);
    expect(p.checkMs).toBe(0);
  });

  test("a database with no events is an error, not an empty profile", () => {
    expect(() => profileRun(database([]))).toThrow("no events");
  });
});

describe("the report a person reads", () => {
  test("says each thing once, and says that a reviewer's seconds are not wall time", () => {
    const text = formatProfile("serious/startup-selection", profileRun(aRun()));
    expect(text.split("\n")).toEqual([
      "serious/startup-selection",
      "  wall 177s · cost $0.205",
      "  first tool 5s · first write 17s · last write 17s",
      "  checks held the finish 126s: inconclusive/timeout 120s, passed 6s",
      "  work: 6 calls, 27s of model time, $0.125, 45% of input from cache",
      "  ledger-only completions: 2 of 6 (5s, $0.015)",
      "  supervisor: 1 calls, $0.080 (alongside the work — 3s summed, not wall time)",
      "  effort: high ×3, max ×3; changed 1 time(s)",
    ]);
  });
});

describe("where a run's database is", () => {
  test("the file itself, or the usual places under a run directory", () => {
    const direct = database([[0, "user_msg", {}]]);
    expect(findDatabase(direct)).toBe(direct);
    for (const rel of ["rune.db", "profile/rune.db", "rune/profile/rune.db"]) {
      const root = mkdtempSync(join(dir, "layout-"));
      const path = join(root, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      database([[0, "user_msg", {}]], { path });
      expect(findDatabase(root)).toBe(path);
    }
    expect(findDatabase(join(dir, "nothing-here"))).toBeNull();
    expect(findDatabase(mkdtempSync(join(dir, "empty-")))).toBeNull();
  });
});
