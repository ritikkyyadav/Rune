/**
 * Long-horizon evals (METR-style): tasks that take MANY tool calls across many
 * turns, where the failure mode being measured is not "wrong answer" but
 * "fell apart mid-task" — the exact class the task spine exists to fix.
 *
 * Mock mode drives the real engine through a long scripted run (harness
 * endurance: spine bookkeeping, verification, persistence over many turns).
 * Real mode gives a live model the same fixtures and judges ARTIFACTS ONLY:
 * the feature's test must actually pass, the refactor must actually hold.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";

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

/** Count executed tool results in the session log. */
function toolResultCount(dbPath: string, sessionId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE session_id = ? AND type = 'tool_result'")
      .get(sessionId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

async function runWorkspaceTests(workspace: string): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["bun", "test"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: `${out}${err}` };
}

// ─── 1. Long-horizon feature: make the red test green across modules ───

const FEATURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "notes", version: "0.0.0" }),
  "store.ts": `export interface Note { id: number; text: string; tags: string[] }
const notes: Note[] = [];
let nextId = 1;
export function addNote(text: string, tags: string[] = []): Note {
  const n = { id: nextId++, text, tags };
  notes.push(n);
  return n;
}
export function allNotes(): Note[] {
  return [...notes];
}
export function resetStore(): void {
  notes.length = 0;
  nextId = 1;
}
`,
  "search.ts": `import { allNotes, type Note } from "./store";
export function byText(q: string): Note[] {
  return allNotes().filter((n) => n.text.includes(q));
}
// TODO(feature): byTag(tag) — find notes carrying a tag, case-insensitive.
`,
  "notes.test.ts": `import { describe, test, expect, beforeEach } from "bun:test";
import { addNote, resetStore } from "./store";
import { byText, byTag } from "./search";

beforeEach(() => resetStore());

describe("notes", () => {
  test("byText finds matches", () => {
    addNote("buy milk");
    expect(byText("milk")).toHaveLength(1);
  });
  test("byTag finds notes by tag, case-insensitive", () => {
    addNote("standup notes", ["Work"]);
    addNote("groceries", ["home"]);
    expect(byTag("work")).toHaveLength(1);
    expect(byTag("HOME")).toHaveLength(1);
    expect(byTag("nope")).toHaveLength(0);
  });
});
`,
};

const FEATURE_IMPL = `import { allNotes, type Note } from "./store";
export function byText(q: string): Note[] {
  return allNotes().filter((n) => n.text.includes(q));
}
export function byTag(tag: string): Note[] {
  const want = tag.toLowerCase();
  return allNotes().filter((n) => n.tags.some((t) => t.toLowerCase() === want));
}
`;

const longHorizonFeature: EvalTask = {
  name: "long_horizon_feature",
  category: "core",
  description: "Multi-turn feature across modules: plan, read, implement, run tests, finish clean.",
  setup: async ({ workspace }) => {
    for (const [name, content] of Object.entries(FEATURE_FILES)) {
      await writeFile(join(workspace, name), content);
    }
  },
  script: [
    {
      text: "A cross-module feature — planning first.",
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "read store and search modules", status: "in_progress" },
              { content: "implement byTag", status: "pending" },
              { content: "run the tests", status: "pending" },
            ],
          },
        },
      ],
    },
    { toolCalls: [{ name: "read_file", args: { path: "store.ts" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "search.ts" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "notes.test.ts" } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "read store and search modules", status: "completed" },
              { content: "implement byTag", status: "in_progress" },
              { content: "run the tests", status: "pending" },
            ],
          },
        },
        { name: "write_file", args: { path: "search.ts", content: FEATURE_IMPL } },
      ],
    },
    {
      text: "Running the suite to prove it.",
      toolCalls: [{ name: "bash", args: { command: "bun test" } }],
    },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "read store and search modules", status: "completed" },
              { content: "implement byTag", status: "completed" },
              { content: "run the tests", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "byTag implemented; the full suite passes." },
  ],
  prompts: [
    "implement the byTag(tag) feature the tests expect (see notes.test.ts) — case-insensitive tag search — and prove the suite passes",
  ],
  maxToolCalls: 40,
  verify: async ({ workspace, dbPath, sessionId, real }) => {
    const tests = await runWorkspaceTests(workspace);
    if (!tests.ok) {
      return { pass: false, reason: `workspace tests fail:\n${tests.out.slice(-400)}` };
    }
    const state = latestTaskState(dbPath, sessionId);
    if (!state) return { pass: false, reason: "no task_state snapshot persisted" };
    const open = (state.todos ?? []).filter((t: any) => t.status !== "completed");
    if ((state.todos ?? []).length > 0 && open.length > 0) {
      return {
        pass: false,
        reason: `run ended with open todos: ${open.map((t: any) => t.content).join("; ")}`,
      };
    }
    if (!real && toolResultCount(dbPath, sessionId) < 7) {
      return { pass: false, reason: "long-horizon script did not exercise a long run" };
    }
    return { pass: true };
  },
};

// ─── 2. Long-horizon refactor: extract shared logic without breaking tests ───

const DUP = `export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`;

const REFACTOR_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "cms", version: "0.0.0" }),
  "posts.ts": `${DUP}export function postUrl(title: string): string {
  return "/posts/" + slugify(title);
}
`,
  "pages.ts": `${DUP}export function pageUrl(title: string): string {
  return "/pages/" + slugify(title);
}
`,
  "urls.test.ts": `import { test, expect } from "bun:test";
import { postUrl } from "./posts";
import { pageUrl } from "./pages";

test("post urls", () => expect(postUrl("Hello, World!")).toBe("/posts/hello-world"));
test("page urls", () => expect(pageUrl("  About Us ")).toBe("/pages/about-us"));
`,
};

const REFACTOR_SLUG = `export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`;

const longHorizonRefactor: EvalTask = {
  name: "long_horizon_refactor",
  category: "core",
  description: "Extract duplicated logic into a shared module across files; tests still pass.",
  setup: async ({ workspace }) => {
    for (const [name, content] of Object.entries(REFACTOR_FILES)) {
      await writeFile(join(workspace, name), content);
    }
  },
  script: [
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "map the duplication", status: "in_progress" },
              { content: "extract slug.ts", status: "pending" },
              { content: "repoint both call sites", status: "pending" },
              { content: "run the tests", status: "pending" },
            ],
          },
        },
      ],
    },
    { toolCalls: [{ name: "read_file", args: { path: "posts.ts" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "pages.ts" } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "map the duplication", status: "completed" },
              { content: "extract slug.ts", status: "in_progress" },
              { content: "repoint both call sites", status: "pending" },
              { content: "run the tests", status: "pending" },
            ],
          },
        },
        { name: "write_file", args: { path: "slug.ts", content: REFACTOR_SLUG } },
      ],
    },
    {
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "posts.ts",
            content: `import { slugify } from "./slug";
export function postUrl(title: string): string {
  return "/posts/" + slugify(title);
}
`,
          },
        },
        {
          name: "write_file",
          args: {
            path: "pages.ts",
            content: `import { slugify } from "./slug";
export function pageUrl(title: string): string {
  return "/pages/" + slugify(title);
}
`,
          },
        },
      ],
    },
    { toolCalls: [{ name: "bash", args: { command: "bun test" } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          args: {
            items: [
              { content: "map the duplication", status: "completed" },
              { content: "extract slug.ts", status: "completed" },
              { content: "repoint both call sites", status: "completed" },
              { content: "run the tests", status: "completed" },
            ],
          },
        },
      ],
    },
    { text: "slugify extracted to slug.ts; both modules import it; suite passes." },
  ],
  prompts: [
    "posts.ts and pages.ts duplicate slugify — extract it into slug.ts, repoint both, and prove the tests still pass",
  ],
  maxToolCalls: 40,
  verify: async ({ workspace, dbPath, sessionId }) => {
    if (!(await Bun.file(join(workspace, "slug.ts")).exists())) {
      return { pass: false, reason: "slug.ts not created" };
    }
    const posts = await Bun.file(join(workspace, "posts.ts")).text();
    const pages = await Bun.file(join(workspace, "pages.ts")).text();
    if (/replace\(\/\[\^a-z0-9\]/.test(posts) || /replace\(\/\[\^a-z0-9\]/.test(pages)) {
      return { pass: false, reason: "duplicated slugify body still present in a call site" };
    }
    const tests = await runWorkspaceTests(workspace);
    if (!tests.ok) return { pass: false, reason: `tests fail:\n${tests.out.slice(-400)}` };
    const state = latestTaskState(dbPath, sessionId);
    const open = (state?.todos ?? []).filter((t: any) => t.status !== "completed");
    if ((state?.todos ?? []).length > 0 && open.length > 0) {
      return { pass: false, reason: "run ended with open todos" };
    }
    return { pass: true };
  },
};

export const LONG_HORIZON_TASKS: EvalTask[] = [longHorizonFeature, longHorizonRefactor];
