/**
 * Greenfield-build evals: the failure class observed live on 2026-08-24 —
 * "build me a clone of cluely" answered with a static HTML mock, zero
 * clarifying questions, silently-chosen stack, and a landing page presented as
 * an application. These tasks pin the machinery that now guards it:
 *
 *   1. The clarify-first tripwire fires when a new top-level project starts
 *      with no questions asked — and the run recovers by asking.
 *   2. The wanted end-to-end shape: ask FIRST, scaffold a real runnable
 *      project (manifest + test), execute it, finish with the spine clean —
 *      and the tripwire stays silent because the questions were asked.
 *
 * Mock mode drives the real engine through scripted turns (harness machinery
 * under test). Real mode hands a live model the same prompt and judges
 * artifacts only.
 */

import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";

const NUDGE_MARK = "starting a NEW project from scratch";

/** Latest task_state snapshot from the session log (envelope unwrapped). */
function latestTaskState(dbPath: string, sessionId: string): any | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload_json FROM events WHERE session_id = ? AND type = 'task_state' ORDER BY seq DESC LIMIT 1",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    if (rows.length === 0) return null;
    const parsed = JSON.parse(rows[0].payload_json);
    return (parsed?.payload ?? parsed)?.state ?? null;
  } finally {
    db.close();
  }
}

/** True when any persisted tool_result carries the greenfield harness note. */
function nudgeNotePresent(dbPath: string, sessionId: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload_json FROM events WHERE session_id = ? AND type = 'tool_result'")
      .all(sessionId) as Array<{ payload_json: string }>;
    return rows.some((r) => r.payload_json.includes(NUDGE_MARK));
  } finally {
    db.close();
  }
}

const PKG = JSON.stringify(
  { name: "copilot", version: "0.0.0", scripts: { test: "bun test" } },
  null,
  2,
);

const CORE = `export interface Note { at: number; text: string }
const notes: Note[] = [];
export function addNote(text: string): Note {
  const n = { at: notes.length + 1, text };
  notes.push(n);
  return n;
}
export function allNotes(): Note[] {
  return [...notes];
}
`;

const CORE_TEST = `import { test, expect } from "bun:test";
import { addNote, allNotes } from "./core";

test("the core loop holds state", () => {
  addNote("first");
  addNote("second");
  expect(allNotes()).toHaveLength(2);
  expect(allNotes()[1].text).toBe("second");
});
`;

// ─── 1. The tripwire fires, and the run recovers by asking ───

const greenfieldNudgeFires: EvalTask = {
  name: "greenfield_nudge_fires",
  category: "core",
  description:
    "New top-level project started with zero questions → harness note lands; run recovers via ask_user.",
  questionResponses: ["web app, working core loop", "yes — scaffold a real project"],
  script: [
    {
      // The observed anti-pattern, verbatim: first move is writing a static
      // file into a brand-new project directory with no questions asked.
      toolCalls: [
        {
          name: "write_file",
          args: { path: "copilot/index.html", content: "<!doctype html><h1>Copilot</h1>\n" },
        },
      ],
    },
    {
      // The note (prefixed to that write's result) is expected to trigger this.
      text: "The harness is right — platform and depth are my assumptions. Asking first.",
      toolCalls: [
        {
          name: "ask_user",
          args: {
            questions: [
              {
                question: "Platform and depth?",
                options: ["web app, working core loop", "static visual prototype"],
              },
              {
                question: "Scaffold a real runnable project?",
                options: ["yes — scaffold a real project", "no — keep static files"],
              },
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
              { content: "scaffold the runnable project", status: "in_progress" },
              { content: "implement and prove the core loop", status: "pending" },
            ],
          },
        },
        { name: "write_file", args: { path: "copilot/package.json", content: PKG } },
      ],
    },
    {
      toolCalls: [
        { name: "write_file", args: { path: "copilot/core.ts", content: CORE } },
        { name: "write_file", args: { path: "copilot/core.test.ts", content: CORE_TEST } },
      ],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "cd copilot && bun test" } }],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "scaffold the runnable project", status: "completed" },
              { content: "implement and prove the core loop", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "Asked first, scaffolded a runnable project, and proved the core loop." },
  ],
  prompts: ["build me a clone of cluely for interview meetings"],
  maxToolCalls: 30,
  verify: async ({ workspace, dbPath, sessionId, real }) => {
    if (!real && !nudgeNotePresent(dbPath, sessionId)) {
      return {
        pass: false,
        reason: "greenfield harness note never landed on the unasked first write",
      };
    }
    const state = latestTaskState(dbPath, sessionId);
    if (!state) return { pass: false, reason: "no task_state snapshot persisted" };
    if ((state.clarifications ?? []).length < 1) {
      return { pass: false, reason: "no clarification recorded in the spine" };
    }
    if (!(await Bun.file(join(workspace, "copilot/package.json")).exists())) {
      return { pass: false, reason: "no runnable project scaffolded (package.json missing)" };
    }
    return { pass: true };
  },
};

// ─── 2. The wanted shape: ask first, scaffold, execute — tripwire silent ───

const greenfieldClarifyFirst: EvalTask = {
  name: "greenfield_clarify_first",
  category: "core",
  description:
    "Application-class ask → one batched ask_user round BEFORE any file, then a runnable scaffold, executed.",
  questionResponses: ["working core features", "web app"],
  script: [
    {
      text: "An application-class request — platform and depth are product decisions. Asking first.",
      toolCalls: [
        {
          name: "ask_user",
          args: {
            questions: [
              {
                question: "Depth: working core features or a visual prototype?",
                options: ["working core features", "visual prototype"],
              },
              { question: "Platform?", options: ["web app", "native desktop", "CLI"] },
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
              { content: "scaffold the runnable project", status: "in_progress" },
              { content: "implement the core loop", status: "pending" },
              { content: "prove it by executing", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "write_file", args: { path: "copilot/package.json", content: PKG } },
        { name: "write_file", args: { path: "copilot/core.ts", content: CORE } },
      ],
    },
    {
      toolCalls: [
        { name: "write_file", args: { path: "copilot/core.test.ts", content: CORE_TEST } },
        {
          name: "todo_write",
          args: {
            items: [
              { content: "scaffold the runnable project", status: "completed" },
              { content: "implement the core loop", status: "in_progress" },
              { content: "prove it by executing", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [{ name: "bash", args: { command: "cd copilot && bun test" } }],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "scaffold the runnable project", status: "completed" },
              { content: "implement the core loop", status: "completed" },
              { content: "prove it by executing", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "Clarified first; the scaffolded project's core loop passes its test." },
  ],
  prompts: ["build me a clone of cluely for interview meetings"],
  maxToolCalls: 30,
  verify: async ({ workspace, dbPath, sessionId, real }) => {
    const state = latestTaskState(dbPath, sessionId);
    if (!state) return { pass: false, reason: "no task_state snapshot persisted" };
    if ((state.clarifications ?? []).length < 1) {
      return { pass: false, reason: "no clarification recorded before building" };
    }
    if (!real && nudgeNotePresent(dbPath, sessionId)) {
      return {
        pass: false,
        reason: "tripwire fired even though the clarifying round happened first",
      };
    }
    if (!(await Bun.file(join(workspace, "copilot/package.json")).exists())) {
      return { pass: false, reason: "no runnable project scaffolded" };
    }
    const open = (state.todos ?? []).filter((t: any) => t.status !== "completed");
    if ((state.todos ?? []).length > 0 && open.length > 0) {
      return { pass: false, reason: "run ended with open todos" };
    }
    return { pass: true };
  },
};

export const GREENFIELD_TASKS: EvalTask[] = [greenfieldNudgeFires, greenfieldClarifyFirst];
