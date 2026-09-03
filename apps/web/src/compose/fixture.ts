// ─── The API latency investigation ───
//
// The worked example from docs/program/11-intent-layer.md's three wireframes,
// as one Task State. It is the fixture the composer tests project from and the
// content the gallery renders, and it is one object rather than two so a
// primitive the founder judges in the gallery is the primitive a test pins.
//
// Everything in it is plausible in the way real work is: the two refuted
// branches carry the measurement that refuted them, the confirmed one carries
// the query plan, the decision names the index it restored, and the numbers on
// the metrics are the numbers in the narrative. A fixture of "Item 1 / Item 2"
// makes every layout look fine, which is the opposite of what a gallery is for.
//
// Deliberately frozen in time: the timestamps are literal strings, so a
// screenshot taken today and one taken next March are the same image.

import type { TaskStateView } from "./state";

const OLD_QUERY = `@@ -14,7 +14,7 @@ export async function recentOrders(customerId: string) {
   const since = new Date(Date.now() - 30 * DAY).toISOString();
   return db.query(
-    \`select id, total_cents, created_at from orders
-       where customer_id = $1 and created_at > $2
-       order by created_at desc limit 50\`,
+    \`select o.id, o.total_cents, o.created_at, c.tier from orders o
+       join customers c on c.id = o.customer_id
+       where o.customer_id = $1 and o.created_at > $2
+       order by o.created_at desc limit 50\`,
     [customerId, since],
   );
 }`;

const MIGRATION = `@@ -0,0 +1,6 @@
+-- Restore the index the v2.18.5 query rewrite stopped matching.
+-- (customer_id, created_at) covers the filter and the sort together;
+-- the planner fell back to a sequential scan without it.
+create index concurrently if not exists orders_customer_created_at_idx
+  on orders (customer_id, created_at desc);
+analyze orders;`;

const EXPLAIN = `Limit  (cost=184203.11..184203.24 rows=50 width=44) (actual time=471.882..471.901 rows=50 loops=1)
  ->  Sort  (cost=184203.11..184261.55 rows=23374 width=44) (actual time=471.880..471.889 rows=50 loops=1)
        Sort Key: o.created_at DESC
        Sort Method: top-N heapsort  Memory: 32kB
        ->  Hash Join  (cost=41.20..183426.90 rows=23374 width=44) (actual time=0.311..468.204 rows=21988 loops=1)
              ->  Seq Scan on orders o  (cost=0.00..182911.00 rows=23374 width=36) (actual time=0.028..441.117 rows=21988 loops=1)
                    Filter: ((customer_id = $1) AND (created_at > $2))
                    Rows Removed by Filter: 1178012
Planning Time: 0.402 ms
Execution Time: 471.996 ms`;

export const API_LATENCY_TASK: TaskStateView = {
  taskId: "task_2f9c41",
  objective: "Why did API latency rise after v2.18.5?",
  kind: "investigate",
  phase: "investigating",
  elapsedMs: 4 * 60_000 + 12_000,

  progress: { done: 5, total: 8, unproven: 1, runState: "working" },

  narrative: {
    hypotheses: [
      {
        id: "h1",
        text: "Cache eviction on deploy is cold-starting every request",
        status: "refuted",
        reason: "TTL unchanged at 3600 s across both deploys; hit rate 94% → 93%",
        evidence: [
          {
            kind: "file",
            ref: "src/cache/policy.ts",
            line: 22,
            endLine: 31,
            excerpt: "ttlSeconds: 3600 — identical in v2.18.4 and v2.18.5",
          },
          {
            kind: "command",
            ref: "redis-cli info stats | grep keyspace",
            excerpt: "keyspace_hits 1841203 · keyspace_misses 129884",
          },
        ],
      },
      {
        id: "h2",
        text: "Connection pool exhaustion under the new fan-out",
        status: "refuted",
        reason: "Pool peaked at 40 of 200; wait time never left single-digit ms",
        evidence: [
          {
            kind: "check",
            ref: "pgbouncer pool stats, 14:02–14:22",
            excerpt: "cl_active 40 · cl_waiting 0 · maxwait 0.004s",
          },
        ],
      },
      {
        id: "h3",
        text: "The rewritten orders query lost its index",
        status: "confirmed",
        reason: "Sequential scan on orders, 1.2M rows removed by filter",
        evidence: [
          {
            kind: "file",
            ref: "src/database/orders.ts",
            line: 14,
            endLine: 24,
            excerpt: "join customers c on c.id = o.customer_id — added in v2.18.5",
          },
          {
            kind: "command",
            ref: "explain analyze select … from orders o join customers c …",
            excerpt: "Seq Scan on orders o (actual time=0.028..441.117 rows=21988)",
          },
        ],
      },
    ],
    decisions: [
      {
        id: "d1",
        text: "Restore the (customer_id, created_at) index rather than reverting the join. The tier column the join adds is used by the new billing panel; the index covers the filter and the sort together and costs one write-path entry.",
        basedOn: [
          { kind: "command", ref: "explain analyze on orders", excerpt: "Seq Scan, 471 ms" },
          { kind: "file", ref: "migrations/0042_orders_index.sql", line: 4 },
          { kind: "check", ref: "p95 after deploy", excerpt: "176 ms over 20 minutes" },
        ],
        at: "2026-09-02T14:38:00Z",
        alternatives: [
          "Revert the join — would break the billing panel shipped in the same release",
          "Add a covering index including total_cents — 2.1× the index size for 4 ms",
        ],
      },
    ],
  },

  metrics: [
    {
      name: "p95 latency",
      value: 487,
      from: 182,
      unit: "ms",
      goodDirection: "down",
      note: "since v2.18.5, 14:02 UTC",
    },
    { name: "Deployment", value: "v2.18.5", from: "v2.18.4" },
    { name: "Error rate", value: 0.4, from: 0.4, unit: "%", goodDirection: "down" },
  ],

  chartPoints: [
    { x: "13:40", y: 181 },
    { x: "13:50", y: 179 },
    { x: "14:00", y: 184 },
    { x: "14:10", y: 468 },
    { x: "14:20", y: 491 },
    { x: "14:30", y: 487 },
  ],

  table: [
    { name: "recentOrders", value: 471, unit: "ms" },
    { name: "customerTier", value: 12, unit: "ms" },
    { name: "invoiceTotals", value: 4, unit: "ms" },
  ],

  comparison: {
    options: [
      { id: "index", name: "Restore the index" },
      { id: "revert", name: "Revert the join" },
    ],
    rows: [
      {
        criterion: "p95 after change",
        values: { index: "176 ms", revert: "181 ms" },
        better: "index",
      },
      {
        criterion: "Billing panel",
        values: { index: "keeps working", revert: "breaks" },
        better: "index",
      },
      {
        criterion: "Write-path cost",
        values: { index: "+1 index", revert: "none" },
        better: "revert",
      },
      { criterion: "Rollout", values: { index: "concurrent, online", revert: "redeploy" } },
    ],
    recommend: "index",
    because: "The tier column is load-bearing for a panel shipped in the same release.",
  },

  relationship: {
    nodes: [
      { id: "orders", name: "orders.ts", ring: 0, focus: true },
      { id: "api", name: "GET /orders", ring: 1 },
      { id: "billing", name: "billing panel", ring: 1 },
      { id: "db", name: "orders table", ring: 1, tone: "danger" },
      { id: "cache", name: "cache/policy", ring: 2 },
    ],
    edges: [
      { from: "api", to: "orders", label: "calls" },
      { from: "billing", to: "orders", label: "calls" },
      { from: "orders", to: "db", label: "seq scan" },
      { from: "orders", to: "cache", label: "reads" },
    ],
  },

  todos: [
    { content: "Reproduce the latency rise on staging", status: "completed", verified: true },
    { content: "Rule out cache eviction", status: "completed", verified: true },
    { content: "Rule out pool exhaustion", status: "completed", verified: true },
    {
      content: "Read the v2.18.5 diff of src/database/orders.ts",
      status: "completed",
      verified: true,
    },
    {
      content: "Explain-analyze the rewritten query",
      status: "completed",
      unproven: "no_evidence",
      owner: "worker-2",
    },
    { content: "Write the index migration", status: "in_progress", owner: "worker-1" },
    { content: "Verify p95 on staging after the migration", status: "pending" },
    { content: "Backfill the replica", status: "pending" },
  ],

  checks: [
    {
      at: "2026-09-02T14:31:00Z",
      command: "bun test tests/unit/database",
      passed: true,
      source: "harness",
      exitCode: 0,
      durationMs: 4120,
      summary: "12 pass, 0 fail",
    },
    {
      at: "2026-09-02T14:33:00Z",
      command: "bun run typecheck",
      passed: true,
      source: "harness",
      exitCode: 0,
      durationMs: 9840,
      summary: "clean",
    },
    {
      at: "2026-09-02T14:36:00Z",
      command: "psql -f migrations/0042_orders_index.sql --dry-run",
      passed: false,
      source: "model",
      summary: "cannot run CREATE INDEX CONCURRENTLY in a transaction block",
    },
  ],

  outline: [
    { id: "o1", name: "What happened", depth: 0, kind: "dir" },
    { id: "o2", name: "The two branches we closed", depth: 1, kind: "symbol" },
    { id: "o3", name: "The query plan", depth: 1, kind: "symbol", current: true },
    { id: "o4", name: "The fix", depth: 0, kind: "dir" },
    { id: "o5", name: "migrations/0042_orders_index.sql", depth: 1, kind: "file", meta: "6 lines" },
    { id: "o6", name: "What remains", depth: 0, kind: "dir" },
  ],

  events: [
    { at: "2026-09-02T14:24:00Z", text: "Reproduced on staging: p95 486 ms", tone: "caution" },
    { at: "2026-09-02T14:27:00Z", text: "Cache eviction refuted", detail: "TTL unchanged" },
    { at: "2026-09-02T14:29:00Z", text: "Pool exhaustion refuted", detail: "40 of 200 at peak" },
    {
      at: "2026-09-02T14:33:00Z",
      text: "Sequential scan found on orders",
      tone: "danger",
      detail: "1,178,012 rows removed by filter",
    },
    { at: "2026-09-02T14:38:00Z", text: "Index migration written", tone: "accent" },
  ],

  diffs: [
    {
      path: "src/database/orders.ts",
      patch: OLD_QUERY,
      added: 4,
      removed: 3,
    },
    {
      path: "migrations/0042_orders_index.sql",
      patch: MIGRATION,
      added: 6,
      removed: 0,
    },
  ],

  terminals: [
    {
      command: "psql $DATABASE_URL -c 'explain analyze select … from orders o join customers c …'",
      output: EXPLAIN,
      exitCode: 0,
      durationMs: 512,
      cwd: "~/work/api",
    },
  ],

  claims: [
    {
      id: "c1",
      claim: "The regression is entirely in recentOrders; no other endpoint moved.",
      sources: [
        { kind: "command", ref: "p95 by route, 14:00–14:30" },
        { kind: "file", ref: "src/database/orders.ts", line: 14, endLine: 24 },
      ],
      reading: "471 ms of the 487 ms p95 is one query.",
      verified: true,
    },
    {
      id: "c2",
      claim: "Restoring the index returns p95 to 176 ms.",
      sources: [{ kind: "check", ref: "staging p95 after 0042", excerpt: "176 ms over 20 min" }],
    },
  ],

  sources: [
    {
      id: "s1",
      title: "The rewritten query",
      locator: {
        kind: "file",
        ref: "src/database/orders.ts",
        line: 14,
        endLine: 24,
        excerpt: "join customers c on c.id = o.customer_id",
      },
      via: "read_file",
    },
    {
      id: "s2",
      title: "PostgreSQL — index-only scans and covering indexes",
      locator: {
        kind: "url",
        ref: "https://www.postgresql.org/docs/16/indexes-index-only-scans.html",
      },
      retrievedAt: "14:35",
      via: "web_search",
    },
  ],

  artifacts: [
    {
      id: "a1",
      kind: "diff",
      ref: "migrations/0042_orders_index.sql",
      name: "Index migration",
      bytes: 284,
      at: "14:38",
    },
    {
      id: "a2",
      kind: "report",
      ref: "docs/incidents/2026-09-02-orders-latency.md",
      name: "Decision record",
      bytes: 4812,
      at: "14:41",
    },
  ],

  agents: [
    {
      id: "worker-1",
      name: "worker-1",
      status: "working",
      activity: "writing migrations/0042_orders_index.sql",
      elapsedMs: 96_000,
      model: "claude-opus-5",
      usd: 0.09,
    },
    {
      id: "worker-2",
      name: "worker-2",
      status: "done",
      activity: "explain analyze on orders",
      elapsedMs: 141_000,
      model: "gpt-5-codex",
      usd: 0.05,
    },
  ],

  pendingDecisions: [
    {
      id: "p1",
      kind: "held_step",
      text: "Run the index migration against the production replica",
      grant: "psql on replica-2.eu-west-1 — CREATE INDEX CONCURRENTLY on public.orders",
      alwaysScope: "any DDL on replica-2 for the rest of this session",
      reason: "The index cannot be created inside a transaction, so the step was held.",
      risk: "medium",
      deadline: "expires in 22 min",
      resolution: null,
    },
    {
      id: "p2",
      kind: "question",
      text: "Backfill the replica now, or after the next maintenance window?",
      options: [
        {
          id: "now",
          label: "Now",
          consequence: "≈14 min of elevated replica lag",
          recommended: true,
        },
        {
          id: "window",
          label: "Saturday 02:00 UTC",
          consequence: "latency stays at 487 ms until then",
        },
      ],
      resolution: null,
    },
  ],

  logs: [
    "==> psql migrations/0042_orders_index.sql",
    'NOTICE:  relation "orders_customer_created_at_idx" does not exist, skipping',
    "ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block",
    "==> retrying outside the migration wrapper",
    "CREATE INDEX",
    "ANALYZE",
    "==> p95 sampled over 20 minutes: 176 ms",
  ],

  transcript: [
    {
      role: "user",
      text: "API latency doubled after last night's deploy. Find out why.",
      at: "14:22",
    },
    {
      role: "agent",
      text: "Reproducing on staging first, then I will bisect the deploy.",
      at: "14:23",
    },
    { role: "tool", text: "read · bash · explain", count: 34, at: "14:24" },
    {
      role: "agent",
      text: "Two branches closed. The orders query lost its index in the rewrite.",
      at: "14:34",
    },
  ],

  prose:
    "The p95 for GET /orders went from 182 ms to 487 ms at 14:02 UTC, which is the minute v2.18.5 finished rolling out.\n\nTwo obvious explanations did not survive contact with the numbers. Cache TTLs are unchanged and the hit rate moved by one point. The connection pool peaked at 40 of 200 with no measurable wait.\n\nWhat did change is the shape of one query. v2.18.5 added a join to customers so the billing panel could read a tier, and the planner stopped matching (customer_id, created_at) — a sequential scan over 1.2 million rows for fifty of them.",

  cost: {
    usd: 0.14,
    inputTokens: 184_220,
    outputTokens: 9_411,
    cachedTokens: 151_008,
    model: "claude-opus-5",
    budgetUsd: 2,
  },
};
