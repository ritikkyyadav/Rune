// ─── What the gallery renders in each primitive's four states ───
//
// Every sample is drawn from the API latency investigation in
// `compose/fixture.ts` — the worked example in the Phase 11 wireframes. Not
// lorem, and not "Item 1 / Item 2": a vocabulary judged on placeholder content
// is a vocabulary judged on nothing, because placeholder content has no long
// paths, no 1.2-million-row query plans, no refuted branch that needs its reason
// on one line, and no sentence that has to wrap.
//
// Two samples per primitive and the other two are mechanical:
//   ready    the primitive doing its job
//   empty    the same primitive with nothing in it — the state a task three
//            seconds old is in, and the one nobody designs
//   loading  ready + { state: "loading" }
//   error    ready + { state: "error", error: … }
//
// `extra` carries the variants that are a different DESIGN rather than a
// different state: a refuted hypothesis, a bar chart, a danger warning.

import type { AnyProps, BlockType } from "../primitives";
import { API_LATENCY_TASK as T } from "../compose/fixture";

export interface Sample {
  ready: AnyProps;
  empty: AnyProps;
  extra?: Array<{ label: string; props: AnyProps }>;
}

const h = T.narrative!.hypotheses;
const decision = T.narrative!.decisions[0]!;

export const SAMPLES: Record<BlockType, Sample> = {
  text: {
    ready: { label: "What happened", body: T.prose! },
    empty: { label: "What happened", body: "" },
    extra: [
      {
        label: "muted",
        props: { body: "Sampled over 20 minutes on staging, 5-minute buckets.", muted: true },
      },
    ],
  },

  heading: {
    ready: {
      level: 1,
      eyebrow: "investigate",
      text: T.objective,
      meta: "investigating · 4m",
    },
    empty: { level: 1, eyebrow: "investigate", text: "" },
    extra: [
      { label: "level 2", props: { level: 2, text: "Hypotheses" } },
      { label: "level 3", props: { level: 3, text: "What changed", meta: "2 files" } },
    ],
  },

  metric: {
    ready: T.metrics![0] as unknown as AnyProps,
    empty: { name: "p95 latency", value: "" },
    extra: [
      { label: "no verdict", props: T.metrics![1] as unknown as AnyProps },
      {
        label: "improved",
        props: { name: "p95 after fix", value: 176, from: 487, unit: "ms", goodDirection: "down" },
      },
    ],
  },

  table: {
    ready: {
      label: "Checks",
      columns: [
        { key: "command", header: "Command", mono: true },
        { key: "summary", header: "Result" },
        { key: "durationMs", header: "ms", align: "right", muted: true },
      ],
      rows: T.checks!.map((c) => ({
        command: c.command,
        summary: c.summary ?? (c.passed ? "passed" : "failed"),
        durationMs: c.durationMs ?? null,
      })),
      keyColumn: "command",
      highlight: "bun run typecheck",
    },
    empty: {
      label: "Checks",
      columns: [
        { key: "command", header: "Command", mono: true },
        { key: "summary", header: "Result" },
      ],
      rows: [],
    },
  },

  chart: {
    ready: {
      label: "p95 latency, 10-minute buckets",
      form: "line",
      points: T.chartPoints!,
      unit: " ms",
      baseline: 182,
      baselineLabel: "before v2.18.5",
    },
    empty: { label: "p95 latency", form: "line", points: [] },
    extra: [
      {
        label: "bar, with a threshold",
        props: {
          label: "Time per endpoint",
          form: "bar",
          points: [
            { x: "recentOrders", y: 471 },
            { x: "customerTier", y: 12 },
            { x: "invoiceTotals", y: 4 },
            { x: "search", y: 31 },
          ],
          unit: " ms",
          threshold: 200,
        },
      },
    ],
  },

  timeline: {
    ready: { label: "Timeline", events: T.events!, live: true },
    empty: { label: "Timeline", events: [] },
  },

  diff: {
    ready: T.diffs![0] as unknown as AnyProps,
    empty: { path: "src/database/orders.ts", patch: "" },
    extra: [{ label: "a new file", props: T.diffs![1] as unknown as AnyProps }],
  },

  file: {
    ready: {
      path: "src/database/orders.ts",
      action: "read",
      line: 14,
      bytes: 2841,
      excerpt:
        "export async function recentOrders(customerId: string) {\n  const since = new Date(Date.now() - 30 * DAY).toISOString();\n  return db.query(\n    `select o.id, o.total_cents, o.created_at, c.tier from orders o\n       join customers c on c.id = o.customer_id`,\n    [customerId, since],\n  );\n}",
    },
    empty: { path: "" },
    extra: [
      {
        label: "created",
        props: { path: "migrations/0042_orders_index.sql", action: "created", bytes: 284 },
      },
    ],
  },

  tree: {
    ready: { label: "Outline", nodes: T.outline! },
    empty: { label: "Outline", nodes: [] },
  },

  terminal: {
    ready: T.terminals![0] as unknown as AnyProps,
    empty: { command: "" },
    extra: [
      {
        label: "a failure",
        props: {
          command: "psql -f migrations/0042_orders_index.sql",
          output:
            "ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block\nCONTEXT:  SQL statement in migration wrapper",
          exitCode: 1,
          durationMs: 88,
        },
      },
    ],
  },

  source: {
    ready: T.sources![0] as unknown as AnyProps,
    empty: { title: "", locator: { kind: "file", ref: "" } },
    extra: [{ label: "a web source", props: T.sources![1] as unknown as AnyProps }],
  },

  evidence: {
    ready: T.claims![0] as unknown as AnyProps,
    empty: { claim: "", sources: [] },
    extra: [
      { label: "single-sourced", props: T.claims![1] as unknown as AnyProps },
      {
        label: "unsupported",
        props: { claim: "The rewrite was probably done for the billing panel.", sources: [] },
      },
    ],
  },

  hypothesis: {
    ready: { ...(h[2] as unknown as AnyProps), index: 3 },
    empty: { text: "", status: "proposed" },
    extra: [
      { label: "refuted, folded", props: { ...(h[0] as unknown as AnyProps), index: 1 } },
      {
        label: "refuted, unfolded",
        props: { ...(h[1] as unknown as AnyProps), index: 2, folded: false },
      },
      {
        label: "testing",
        props: {
          index: 4,
          text: "The planner is choosing a hash join because the stats are stale",
          status: "testing",
          evidence: [],
        },
      },
      {
        label: "proposed",
        props: { index: 5, text: "The replica is lagging behind the primary", status: "proposed" },
      },
    ],
  },

  decision: {
    ready: { ...(decision as unknown as AnyProps), by: "Gear", at: "14:38" },
    empty: { text: "", basedOn: [] },
    extra: [
      {
        label: "ungrounded",
        props: { text: "Ship it and watch the dashboard.", basedOn: [], by: "Gear", at: "14:44" },
      },
    ],
  },

  checklist: {
    ready: { label: "Plan", items: T.todos! },
    empty: { label: "Plan", items: [] },
  },

  progress: {
    ready: { ...T.progress!, note: "1 step closed without a passing check" },
    empty: { done: 0, total: 0 },
    extra: [
      { label: "done", props: { done: 8, total: 8, runState: "done" } },
      {
        label: "failed",
        props: { done: 3, total: 8, runState: "failed", note: "typecheck failed" },
      },
    ],
  },

  approval: {
    ready: {
      action: "Run the index migration against the production replica",
      grant: "psql on replica-2.eu-west-1 — CREATE INDEX CONCURRENTLY on public.orders",
      alwaysScope: "any DDL on replica-2 for the rest of this session",
      reason: "The index cannot be created inside a transaction, so the step was held.",
      risk: "medium",
      deadline: "expires in 22 min",
    },
    empty: { action: "", grant: "" },
    extra: [
      {
        label: "answered",
        props: {
          action: "Run the index migration against the production replica",
          grant: "psql on replica-2.eu-west-1 — CREATE INDEX CONCURRENTLY on public.orders",
          outcome: "approved",
        },
      },
      {
        label: "answered, folded",
        props: {
          action: "Run the index migration against the production replica",
          grant: "psql on replica-2.eu-west-1 — CREATE INDEX CONCURRENTLY on public.orders",
          outcome: "approved",
          folded: true,
        },
      },
      {
        label: "high risk",
        props: {
          action: "Drop and rebuild orders_pkey",
          grant: "psql on primary.eu-west-1 — DROP INDEX public.orders_pkey",
          risk: "high",
          reason: "Rebuilding the primary key takes the table offline for ~40 s.",
        },
      },
    ],
  },

  choice: {
    ready: {
      question: "Backfill the replica now, or after the next maintenance window?",
      context: "The backfill holds a replication slot for about 14 minutes.",
      options: T.pendingDecisions![1]!.options!,
      other: true,
    },
    empty: { question: "", options: [] },
    extra: [
      {
        label: "answered",
        props: {
          question: "Backfill the replica now, or after the next maintenance window?",
          options: T.pendingDecisions![1]!.options!,
          answered: "now",
        },
      },
      {
        label: "answered, folded",
        props: {
          question: "Backfill the replica now, or after the next maintenance window?",
          options: T.pendingDecisions![1]!.options!,
          answered: "now",
          folded: true,
        },
      },
    ],
  },

  form: {
    ready: {
      title: "Schedule the backfill",
      fields: [
        {
          name: "window",
          label: "Window",
          kind: "select",
          options: [
            { value: "now", label: "Now" },
            { value: "sat", label: "Saturday 02:00 UTC" },
          ],
          value: "sat",
        },
        {
          name: "batch",
          label: "Batch size",
          kind: "number",
          value: 5000,
          help: "Rows per transaction. Larger batches hold the slot longer.",
          required: true,
        },
        { name: "notify", label: "Notify #ops when it finishes", kind: "toggle", value: true },
      ],
      submitLabel: "Schedule",
    },
    empty: { title: "Schedule the backfill", fields: [] },
  },

  comparison: {
    ready: { label: "The two ways out", ...T.comparison! },
    empty: {
      options: [
        { id: "a", name: "Restore the index" },
        { id: "b", name: "Revert the join" },
      ],
      rows: [],
    },
  },

  relationship: {
    ready: {
      label: "What calls the query",
      ...T.relationship!,
      caption: "orders.ts is on the path of both the API and the billing panel.",
    },
    empty: { nodes: [], edges: [] },
  },

  artifact: {
    ready: T.artifacts![0] as unknown as AnyProps,
    empty: { kind: "file", name: "", ref: "" },
    extra: [{ label: "a report", props: T.artifacts![1] as unknown as AnyProps }],
  },

  preview: {
    ready: {
      label: "The query plan, rendered",
      form: "html",
      height: 180,
      html: '<div style="font:12px/1.6 ui-monospace,monospace;padding:12px;color:#111318">Seq Scan on orders o<br>&nbsp;&nbsp;Filter: (customer_id = $1)<br>&nbsp;&nbsp;Rows Removed by Filter: <b>1,178,012</b></div>',
      caption: "Sandboxed: allow-scripts only, no same-origin, no network.",
    },
    empty: { form: "html", html: "" },
  },

  log: {
    ready: { title: "Migration output", lines: T.logs!, source: "psql" },
    empty: { title: "Migration output", lines: [] },
    extra: [{ label: "open", props: { title: "Migration output", lines: T.logs!, folded: false } }],
  },

  transcript: {
    ready: { turns: T.transcript! },
    empty: { turns: [] },
    extra: [{ label: "open", props: { turns: T.transcript!, folded: false } }],
  },

  agent: {
    ready: T.agents![0] as unknown as AnyProps,
    empty: { name: "", status: "queued" },
    extra: [
      { label: "done", props: T.agents![1] as unknown as AnyProps },
      {
        label: "failed",
        props: {
          name: "worker-3",
          status: "failed",
          activity: "psql migration — exit 1",
          elapsedMs: 12_000,
          usd: 0.01,
        },
      },
    ],
  },

  cost: {
    ready: { label: "Cost", ...T.cost! },
    empty: { label: "Cost", usd: null },
    extra: [
      {
        label: "no meter",
        props: { label: "Cost", usd: null, inputTokens: null, outputTokens: 9411 },
      },
    ],
  },

  warning: {
    ready: {
      text: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block.",
      severity: "caution",
      source: "migrations/0042_orders_index.sql",
    },
    empty: { text: "" },
    extra: [
      {
        label: "danger",
        props: {
          text: "This would rebuild the primary key on the production primary.",
          severity: "danger",
          source: "permission broker",
        },
      },
      {
        label: "note",
        props: { text: "Statistics were last refreshed 6 days ago.", severity: "note" },
      },
    ],
  },

  link: {
    ready: {
      text: "PostgreSQL — index-only scans and covering indexes",
      href: "https://www.postgresql.org/docs/16/indexes-index-only-scans.html",
      hint: "retrieved 14:35",
    },
    empty: { text: "—", href: "/" },
    extra: [{ label: "in-app", props: { text: "Open the decision record", href: "/" } }],
  },

  divider: {
    ready: { text: "what remains" },
    empty: {},
    extra: [{ label: "spacious", props: { spacious: true } }],
  },
};
