/**
 * Task-spine behavior evals — the behaviors the 2026-08 root-cause audit found
 * UNMEASURED (and therefore never pulled toward working): plan-before-write,
 * clarify-first on ambiguity, todo survival across compaction, and an honest
 * handoff when a run dies. All verification is artifact-based per the suite's
 * rules: session-DB rows, request introspection, produced files — never prose.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";

type Row = { seq: number; type: string; payload_json: string };

/** All events for the session, in order, straight from the artifact (SQLite). */
function readEvents(
  dbPath: string,
  sessionId: string,
): Array<{ seq: number; type: string; payload: any }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT seq, type, payload_json FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as Row[];
    // payload_json stores the whole event envelope ({type, payload}) — unwrap.
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

// ─── 1. Plan before write ───
// A multi-file build records its todo list BEFORE the first file edit, and the
// spine snapshot lands in the session log.

const planBeforeWrite: EvalTask = {
  name: "spine_plan_before_write",
  category: "core",
  description: "Multi-file build records a todo plan before the first write; spine persisted.",
  script: [
    {
      text: "Two modules, so I'll record the plan first.",
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "write math.ts", status: "in_progress" },
              { content: "write cli.ts", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "math.ts",
            content: "export const add = (a: number, b: number) => a + b;\n",
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
              { content: "write math.ts", status: "completed" },
              { content: "write cli.ts", status: "in_progress" },
            ],
          },
        },
        {
          name: "write_file",
          args: {
            path: "cli.ts",
            content: "import { add } from './math';\nconsole.log(add(2, 3));\n",
          },
        },
      ],
    },
    {
      text: "Proving it runs before claiming done.",
      toolCalls: [{ name: "bash", args: { command: "bun cli.ts" } }],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "write math.ts", status: "completed" },
              { content: "write cli.ts", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "Built both modules per the plan; cli.ts printed 5." },
  ],
  prompts: ["build a small calculator: math.ts with add, and cli.ts that prints add(2,3)"],
  verify: async ({ workspace, dbPath, sessionId }) => {
    const mathTs = await Bun.file(join(workspace, "math.ts")).exists();
    const cliTs = await Bun.file(join(workspace, "cli.ts")).exists();
    if (!mathTs || !cliTs) return { pass: false, reason: "expected files missing" };

    // Ordering from the artifact: the first task_state snapshot (todo_write)
    // must precede the first written-file tool result in the event log.
    const events = readEvents(dbPath, sessionId);
    const firstPlan = events.find((e) => e.type === "task_state")?.seq ?? Infinity;
    const firstWrite =
      events.find((e) => e.type === "tool_result" && /math\.ts/.test(e.payload?.content ?? ""))
        ?.seq ?? -1;
    if (!(firstPlan < firstWrite || firstWrite === -1)) {
      return { pass: false, reason: `plan (seq ${firstPlan}) did not precede first write` };
    }
    const state = latestTaskState(dbPath, sessionId);
    if (!state || state.todos?.length !== 2) {
      return { pass: false, reason: "task_state snapshot missing or todo count wrong" };
    }
    if (!state.filesWritten?.includes("math.ts")) {
      return { pass: false, reason: "spine file ledger missing math.ts" };
    }
    return { pass: true };
  },
};

// ─── 2. Clarify-first on an ambiguous ask ───
// One batched ask_user round up front; the answers land in the spine and shape
// the artifact.

const askOnAmbiguous: EvalTask = {
  name: "spine_ask_on_ambiguous",
  category: "core",
  description: "Ambiguous request → one batched ask_user round; answers recorded and used.",
  questionResponses: ["JSON", "no comments"],
  script: [
    {
      text: "The format is genuinely ambiguous — asking before building.",
      toolCalls: [
        {
          name: "ask_user",
          args: {
            questions: [
              { question: "Which config format?", options: ["JSON", "YAML", "TOML"] },
              { question: "Support comments?", options: ["with comments", "no comments"] },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "write_file", args: { path: "config.json", content: '{"format":"json"}\n' } },
      ],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "cat config.json" } }],
    },
    { text: "Wrote and checked the JSON config per your answers." },
  ],
  prompts: ["create a config file for the app"],
  verify: async ({ workspace, dbPath, sessionId }) => {
    if (!(await Bun.file(join(workspace, "config.json")).exists())) {
      return { pass: false, reason: "config.json not produced" };
    }
    const state = latestTaskState(dbPath, sessionId);
    const clar = state?.clarifications ?? [];
    if (clar.length < 1) return { pass: false, reason: "no clarification recorded in the spine" };
    const joined = JSON.stringify(clar);
    if (!/JSON/.test(joined)) {
      return { pass: false, reason: "recorded clarification does not carry the user's answer" };
    }
    return { pass: true };
  },
};

// ─── 3. Todos survive compaction ───
// After an explicit compaction squashes the transcript, the NEXT model request
// still carries the [Task state] block with the todo list.
//
// The script does the reads BEFORE the plan claims a step done. Since b150dd2
// ("the plan is a ledger") todo_write is no longer a pure echo: a completion
// with no effect behind it is refused and the WHOLE list is dropped
// (docs/plan-ledger.md, "A step is completed by evidence"). The old script
// opened with `survey the notes: completed` before anything had run, so the
// plan never landed, `renderBlock()` had no substance to inject, and this task
// was asserting on a spine that was empty for reasons unrelated to compaction.

const todosSurviveCompaction: EvalTask = {
  name: "spine_todos_survive_compaction",
  category: "core",
  description: "The todo list reaches the model after compaction rewrote the transcript.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "notes.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(join(workspace, "notes-2.txt"), "delta\nepsilon\n");
    await writeFile(join(workspace, "notes-3.txt"), "zeta\neta\ntheta\n");
  },
  script: [
    // Survey first — the evidence the ledger now requires before a completion.
    { toolCalls: [{ name: "read_file", args: { path: "notes.txt" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "notes-2.txt" } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "survey the notes", status: "completed" },
              { content: "summarize them", status: "in_progress" },
            ],
          },
        },
      ],
    },
    { toolCalls: [{ name: "compact_context", args: {} }] },
    // Post-compaction work: also the evidence that closes the second step.
    { toolCalls: [{ name: "read_file", args: { path: "notes-3.txt" } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "survey the notes", status: "completed" },
              { content: "summarize them", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "Summary: eight Greek letters across three files." },
  ],
  prompts: ["survey notes.txt and summarize it (long-session drill)"],
  verify: async ({ mock }) => {
    if (!mock) return { pass: true }; // real mode: covered by the unit/integration layer
    // The request AFTER compaction must still carry the injected spine block.
    const last = mock.requestHistory.at(-1) ?? [];
    const text = last
      .flatMap((m) => m.content)
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("\n");
    // Guard the guard: without a transcript that actually got squashed, the two
    // assertions below pass without testing compaction at all.
    if (!text.includes("[Earlier conversation summary]")) {
      return { pass: false, reason: "transcript was never compacted — nothing was tested" };
    }
    if (!text.includes("[Task state — maintained by the harness")) {
      return { pass: false, reason: "final request lost the [Task state] block" };
    }
    if (!text.includes("summarize them")) {
      return { pass: false, reason: "todo list content missing after compaction" };
    }
    return { pass: true };
  },
};

// ─── 4. Honest handoff when a run dies ───
// A run that errors out with open todos persists a handoff (reason + state of
// work) so resume knows exactly where it stood. The mock script exhausting is
// the deterministic stand-in for a provider hard-failing mid-task.
//
// The inventory is done by reading before the plan claims it done. Since
// b150dd2 ("the plan is a ledger") an evidence-free completion is refused and
// the whole list is dropped (docs/plan-ledger.md, "A step is completed by
// evidence"). The old script's opening list claimed `inventory call sites:
// completed` with nothing behind it, so no plan landed, `hasOpenTodos()` was
// false, and the handoff safety net in engine.ts never fired — the task failed
// on its premise, not on the handoff it exists to guard.

const handoffOnError: EvalTask = {
  name: "spine_handoff_on_error",
  category: "core",
  description: "A run dying mid-task persists a state-of-work handoff with open todos.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "db.ts"), "export const query = (sql: string) => sql;\n");
  },
  script: [
    {
      text: "Starting the long migration.",
      toolCalls: [{ name: "read_file", args: { path: "db.ts" } }],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "inventory call sites", status: "completed" },
              { content: "port the client", status: "in_progress" },
            ],
          },
        },
      ],
    },
    // Script ends here: the next model call errors ("script exhausted") until
    // the loop's provider breaker gives up — an honest stand-in for a dead
    // provider mid-task.
  ],
  prompts: ["migrate the db layer"],
  verify: async ({ dbPath, sessionId }) => {
    const state = latestTaskState(dbPath, sessionId);
    if (!state?.handoff) return { pass: false, reason: "no handoff recorded for the dead run" };
    // `provider_lost`, not the plain `error` this asserted before b150dd2. A
    // run whose provider stops answering with steps still open now hands off
    // under that specific reason so the record, the scorecard and `gear
    // resume` know the network failed rather than the model
    // (agent-loop.ts `providerLostEnd`; the reason is listed in
    // docs/self-evolution.md, and docs/plan-ledger.md requires the handoff to
    // say why). The mock's exhausted script is exactly that scenario.
    if (state.handoff.reason !== "provider_lost") {
      return {
        pass: false,
        reason: `handoff reason ${state.handoff.reason}, expected provider_lost`,
      };
    }
    if (!/port the client/.test(state.handoff.state)) {
      return { pass: false, reason: "handoff state-of-work does not name the remaining step" };
    }
    return { pass: true };
  },
};

// ─── 5. Design floor for written pages ───
// Deterministic anti-slop lint on a produced HTML page. In mock mode the
// script trivially satisfies it (plumbing); in --real mode it lints what a
// LIVE model actually wrote — the honest measure of the design doctrine.

const GOOD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uptime</title><style>
:root { --accent: #c8f169; --ground: #0b0c0e; }
body { background: var(--ground); color: #e8e8e4; font: 16px/1.6 system-ui, sans-serif; margin: 0; }
main { max-width: 68rem; margin: 0 auto; padding: 64px 24px; }
h1 { font-size: clamp(2.5rem, 6vw, 4rem); margin: 0 0 8px; }
.label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #9a9a92; }
.num { font-variant-numeric: tabular-nums; }
</style></head>
<body><main><p class="label">Service health</p><h1>99.98% uptime</h1>
<p class="num">42 incidents · 3.1s median recovery</p></main></body></html>
`;

const designFloor: EvalTask = {
  name: "design_floor_written_page",
  category: "core",
  description: "A written HTML page passes the deterministic anti-slop lint.",
  script: [
    {
      toolCalls: [{ name: "write_file", args: { path: "index.html", content: GOOD_PAGE } }],
    },
    {
      toolCalls: [
        { name: "bash", args: { command: "cat index.html >/dev/null && echo rendered" } },
      ],
    },
    { text: "Page written and checked against the design charter." },
  ],
  prompts: [
    "build a small single-page uptime status site (index.html, self-contained, dark instrument-panel style)",
  ],
  verify: async ({ workspace }) => {
    const file = Bun.file(join(workspace, "index.html"));
    if (!(await file.exists())) return { pass: false, reason: "index.html not produced" };
    const html = await file.text();
    const fail = (reason: string) => ({ pass: false, reason });
    if (!/viewport/i.test(html)) return fail("no viewport meta");
    if (/lorem ipsum/i.test(html)) return fail("lorem ipsum shipped");
    if (/<h[12][^>]*>[^<]*[\u{1F300}-\u{1FAFF}]/u.test(html)) return fail("emoji in a heading");
    if (/(https?:)?\/\/(cdn\.|unpkg\.|cdnjs\.|fonts\.googleapis)/.test(html))
      return fail("external CDN/web-font dependency");
    if (/linear-gradient\([^)]*(purple|#7c3aed|#8b5cf6)[^)]*(blue|#3b82f6|#2563eb)/i.test(html))
      return fail("purple-blue gradient wash");
    const styles = html.match(/font-size|clamp\(/g) ?? [];
    if (styles.length < 2) return fail("no evidence of a type scale");
    return { pass: true };
  },
};

export const TASK_SPINE_TASKS: EvalTask[] = [
  designFloor,
  planBeforeWrite,
  askOnAmbiguous,
  todosSurviveCompaction,
  handoffOnError,
];
