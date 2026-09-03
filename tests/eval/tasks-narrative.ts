/**
 * The narrative evals (P11.1): can a person read how the decision was reached?
 *
 * Everything else in this suite measures whether the artifact appeared. This
 * family measures whether the RECORD of getting there is true — which is a
 * different failure, and the one the intent layer is built on: a run that tried
 * three things and reports only the one that worked has hidden the two that
 * make the third believable.
 *
 * The bug hunt below is scripted to do what a real investigation does. Three
 * theories, named before they are tested. The first two die on REAL check
 * failures — `bun test` against files this task writes, exiting non-zero, read
 * by the harness from its own record of the command. The third survives a
 * passing check and becomes the decision. Nothing in the verify() trusts a
 * sentence the model wrote: the branches, their reasons, the evidence and the
 * progress number all come from the persisted spine and the Decision Record.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";

type Row = { seq: number; type: string; payload_json: string };

function readEvents(
  dbPath: string,
  sessionId: string,
): Array<{ seq: number; type: string; payload: any }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT seq, type, payload_json FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as Row[];
    return rows.map((r) => {
      const parsed = JSON.parse(r.payload_json);
      return { seq: r.seq, type: r.type, payload: parsed?.payload ?? parsed };
    });
  } finally {
    db.close();
  }
}

/** The latest task_state snapshot's state object, or null. */
function latestTaskState(dbPath: string, sessionId: string): any | null {
  const events = readEvents(dbPath, sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "task_state") return events[i].payload?.state ?? null;
  }
  return null;
}

/** The Decision Record the run persisted at task end, or null. */
function latestRecord(dbPath: string, sessionId: string): any | null {
  const events = readEvents(dbPath, sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "decision_record") return events[i].payload?.record ?? null;
  }
  return null;
}

// A probe that FAILS is how a theory dies here: the command runs, exits
// non-zero, and the harness reads the verdict from its own check log. The
// assertion messages are written as findings, because that is what the record
// will quote back.
const CACHE_PROBE = `import { expect, test } from "bun:test";

test("the cache TTL changed across the deploy", () => {
  const before = 300;
  const after = 300;
  // If eviction on deploy were the cause, these would differ.
  expect(after).not.toBe(before);
});
`;

const POOL_PROBE = `import { expect, test } from "bun:test";

test("the connection pool is exhausted", () => {
  const inUse = 40;
  const size = 200;
  // If exhaustion were the cause, the pool would be at its ceiling.
  expect(inUse).toBe(size);
});
`;

const ORDERS_TEST = `import { expect, test } from "bun:test";
import { ordersQueryPlan } from "./src/orders";

test("the orders query uses the composite index", () => {
  expect(ordersQueryPlan()).toContain("index scan");
});

test("the plan does not fall back to a sequential scan", () => {
  expect(ordersQueryPlan()).not.toContain("seq scan");
});
`;

const ORDERS_FIXED = `// Restored the (customer_id, created_at) index the v2.18.5 rewrite dropped.
export function ordersQueryPlan(): string {
  return "index scan on orders_customer_created";
}
`;

const narrativeBugHunt: EvalTask = {
  name: "narrative_three_hypothesis_bug_hunt",
  category: "core",
  description:
    "A three-theory bug hunt: two branches refuted by real failing checks, one confirmed, " +
    "and a Decision Record that carries all three with their evidence.",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "findings"), { recursive: true });
    await writeFile(join(workspace, "cache-ttl.test.ts"), CACHE_PROBE);
    await writeFile(join(workspace, "pool.test.ts"), POOL_PROBE);
    await writeFile(join(workspace, "orders.test.ts"), ORDERS_TEST);
    // The regression as shipped: the rewrite that lost the index.
    await writeFile(
      join(workspace, "src", "orders.ts"),
      `// v2.18.5 rewrote this query and lost its index.
export function ordersQueryPlan(): string {
  return "seq scan on orders";
}
`,
    );
  },
  script: [
    // ── The plan: one step per theory, so each verdict has a boundary ──
    {
      text: "Three things could have done this. Naming them before I test them.",
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "rule out cache eviction on deploy", status: "in_progress" },
              { content: "rule out connection pool exhaustion", status: "pending" },
              { content: "fix the orders query regression", status: "pending" },
            ],
          },
        },
      ],
    },

    // ── Theory 1: cache eviction ──
    {
      text: "My first suspicion is the deploy evicting the cache.",
      toolCalls: [{ name: "note_hypothesis", args: { text: "cache eviction on deploy" } }],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "bun test cache-ttl.test.ts" } }],
    },
    {
      text: "Not the cache — the TTL is identical either side of the deploy. Writing that down.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "findings/cache.md",
            content: "# Cache eviction — ruled out\n\nTTL is 300s before and after the deploy.\n",
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "rule out cache eviction on deploy", status: "completed" },
              { content: "rule out connection pool exhaustion", status: "in_progress" },
              { content: "fix the orders query regression", status: "pending" },
            ],
          },
        },
      ],
    },

    // ── Theory 2: pool exhaustion ──
    {
      text: "Next: the pool. If it were saturated the latency would look exactly like this.",
      toolCalls: [
        { name: "note_hypothesis", args: { text: "connection pool exhaustion under load" } },
      ],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "bun test pool.test.ts" } }],
    },
    {
      text: "Also not it: 40 of 200 in use. Two theories down.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "findings/pool.md",
            content: "# Pool exhaustion — ruled out\n\n40 of 200 connections in use at peak.\n",
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "rule out cache eviction on deploy", status: "completed" },
              { content: "rule out connection pool exhaustion", status: "completed" },
              { content: "fix the orders query regression", status: "in_progress" },
            ],
          },
        },
      ],
    },

    // ── Theory 3: the query. This one survives. ──
    {
      text: "That leaves the query the v2.18.5 rewrite touched.",
      toolCalls: [
        {
          name: "note_hypothesis",
          args: { text: "the v2.18.5 orders rewrite lost its composite index" },
        },
      ],
    },
    {
      toolCalls: [{ name: "write_file", args: { path: "src/orders.ts", content: ORDERS_FIXED } }],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "bun test orders.test.ts" } }],
    },
    {
      text: "Confirmed: the plan is an index scan again.",
      toolCalls: [
        {
          name: "note_hypothesis",
          args: {
            id: "h3",
            status: "testing",
            evidence: [
              {
                kind: "check",
                ref: "bun test orders.test.ts",
                detail: "2 pass — index scan on orders_customer_created",
              },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "record_decision",
          args: {
            text: "Restore the (customer_id, created_at) index the v2.18.5 rewrite dropped.",
            based_on: [
              {
                kind: "check",
                ref: "bun test orders.test.ts",
                detail: "2 pass — index scan on orders_customer_created",
              },
              { kind: "file", ref: "src/orders.ts", detail: "the restored query plan" },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "rule out cache eviction on deploy", status: "completed" },
              { content: "rule out connection pool exhaustion", status: "completed" },
              { content: "fix the orders query regression", status: "completed" },
            ],
          },
        },
      ],
    },
    {
      text:
        "It was the orders query: the v2.18.5 rewrite dropped its composite index, so the plan " +
        "fell back to a sequential scan. Restored it; the tests pass and the plan is an index " +
        "scan again. Cache eviction and pool exhaustion are ruled out, with the probes in findings/.",
    },
  ],
  prompts: ["the API got much slower after v2.18.5 — find out why and fix it"],
  verify: async ({ dbPath, sessionId, real }) => {
    const fail = (reason: string) => ({ pass: false, reason });
    const state = latestTaskState(dbPath, sessionId);
    if (!state) return fail("no task_state snapshot — the spine never persisted");

    const hypotheses: any[] = state.narrative?.hypotheses ?? [];
    const decisions: any[] = state.narrative?.decisions ?? [];
    const checks: any[] = state.checks ?? [];

    // ── The record itself ──
    const record = latestRecord(dbPath, sessionId);
    if (!record) return fail("no decision_record event — the task ended without a record");

    // ── Two refuted branches, each with a reason ──
    const refuted = (record.hypotheses ?? []).filter((h: any) => h.status === "refuted");
    if (refuted.length < 2) {
      return fail(
        `the record lists ${refuted.length} refuted branch(es), expected 2 — ` +
          `statuses: ${(record.hypotheses ?? []).map((h: any) => `${h.id}:${h.status}`).join(", ") || "none"}`,
      );
    }
    for (const h of refuted) {
      if (!h.reason || String(h.reason).trim().length === 0) {
        return fail(`refuted branch ${h.id} carries no reason — a fold with no reason is a hole`);
      }
    }

    // ── One confirmed branch, carrying evidence ──
    const confirmed = (record.hypotheses ?? []).filter((h: any) => h.status === "confirmed");
    if (confirmed.length !== 1) {
      return fail(`the record lists ${confirmed.length} confirmed branch(es), expected exactly 1`);
    }
    if (!Array.isArray(confirmed[0].evidence) || confirmed[0].evidence.length === 0) {
      return fail("the confirmed branch carries no evidence — that is an unbacked conclusion");
    }

    // ── A decision, linked to that evidence ──
    const decision = record.decision;
    if (!decision) return fail("the record carries no decision");
    if (!Array.isArray(decision.basedOn) || decision.basedOn.length === 0) {
      return fail("the decision cites no evidence");
    }
    const confirmedRefs = new Set((confirmed[0].evidence as any[]).map((e) => String(e.ref)));
    const linked = (decision.basedOn as any[]).some((e) => confirmedRefs.has(String(e.ref)));
    if (!linked) {
      return fail(
        `the decision's evidence (${(decision.basedOn as any[]).map((e) => e.ref).join(", ")}) ` +
          `does not overlap the confirmed branch's (${[...confirmedRefs].join(", ")})`,
      );
    }

    // ── No orphan claim: every cited check really ran ──
    const ranCommands = new Set(checks.map((c: any) => String(c.command)));
    const cited: any[] = [
      ...(decision.basedOn ?? []),
      ...(record.hypotheses ?? []).flatMap((h: any) => h.evidence ?? []),
    ];
    for (const ref of cited) {
      if (ref.kind !== "check") continue;
      if (!ranCommands.has(String(ref.ref))) {
        return fail(
          `orphan claim: the record cites the check \`${ref.ref}\`, which is not in the check ` +
            `ledger (${[...ranCommands].join(", ") || "empty"})`,
        );
      }
    }

    // ── The checks that killed the two branches really failed ──
    if (!real) {
      const failedChecks = checks.filter((c: any) => c.passed === false);
      if (failedChecks.length < 2) {
        return fail(
          `${failedChecks.length} failing check(s) on record, expected 2 — the branches were ` +
            "refuted by something other than a check",
        );
      }
      // …and the harness, not the model, wrote the verdicts on them.
      const harnessSettled = refuted.filter((h: any) => /failed/i.test(String(h.reason ?? "")));
      if (harnessSettled.length < 2) {
        return fail(
          "the refutations do not name the check that produced them — " +
            refuted.map((h: any) => `${h.id}: ${h.reason}`).join(" | "),
        );
      }
    }

    // ── Progress: every planned step closed on evidence ──
    if (state.progress !== 1) {
      const marks = (state.todos ?? [])
        .map((t: any) => `${t.status}${t.unproven ? `(${t.unproven})` : ""}`)
        .join(", ");
      return fail(`progress is ${state.progress}, expected 1 — steps: ${marks}`);
    }

    // ── The spine and the record agree ──
    if (hypotheses.length !== (record.hypotheses ?? []).length) {
      return fail("the record and the spine disagree about how many branches there were");
    }
    if (decisions.length === 0) return fail("the spine recorded no decision");

    return { pass: true };
  },
};

export const NARRATIVE_TASKS: EvalTask[] = [narrativeBugHunt];
