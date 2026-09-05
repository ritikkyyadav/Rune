/**
 * Comprehension tasks: "where is X" — verify the answer references the correct path.
 * These use a scripted mock that mimics what a real model would do (grep/list then answer).
 */
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { EvalTask } from "./harness";

// ─── Comprehension Task 1: find function location ───

const findAuthFunction: EvalTask = {
  name: "comprehension_find_auth",
  category: "comprehension",
  description: "Agent locates where the authenticateUser function is defined.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "auth.ts"),
      `export function authenticateUser(token: string): boolean {
  return token === process.env.SECRET;
}
`,
    );
    await writeFile(
      join(workspace, "api.ts"),
      `import { authenticateUser } from './auth';
export function handleRequest(token: string) {
  if (!authenticateUser(token)) throw new Error('Unauthorized');
}
`,
    );
  },
  script: [
    {
      text: "Let me search for the authenticateUser function.",
      toolCalls: [{ name: "grep", args: { pattern: "authenticateUser", path: "." } }],
    },
    {
      text: "The authenticateUser function is defined in auth.ts at line 1.",
    },
  ],
  prompts: ["Where is the authenticateUser function defined?"],
  verify: async ({ mock, real, finalText }) => {
    if (real) {
      // Live model: judge by the answer's content — it must name auth.ts.
      if (!/auth\.ts/i.test(finalText)) {
        return {
          pass: false,
          reason: `answer did not reference auth.ts: ${finalText.slice(0, 200)}`,
        };
      }
      return { pass: true };
    }
    // Mock: confirm the scripted run reached the model at least once.
    const lastReq = mock?.requestHistory[mock.requestHistory.length - 1];
    if (!lastReq) return { pass: false, reason: "no inference requests recorded" };
    return { pass: true };
  },
};

// ─── Comprehension Task 2: find config constant ───

const findConfigConstant: EvalTask = {
  name: "comprehension_find_constant",
  category: "comprehension",
  description: "Agent locates the MAX_RETRIES constant.",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "config.ts"),
      `export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 5000;
export const BASE_URL = 'https://api.example.com';
`,
    );
    await writeFile(
      join(workspace, "src", "client.ts"),
      `import { MAX_RETRIES, TIMEOUT_MS } from './config';
export async function fetchWithRetry(url: string) {
  for (let i = 0; i < MAX_RETRIES; i++) { /* ... */ }
}
`,
    );
  },
  script: [
    {
      text: "Searching for MAX_RETRIES.",
      toolCalls: [{ name: "grep", args: { pattern: "MAX_RETRIES", path: "." } }],
    },
    {
      text: "MAX_RETRIES is defined in src/config.ts and equals 3.",
    },
  ],
  prompts: ["Where is MAX_RETRIES defined and what is its value?"],
  verify: async ({ engine, real, finalText }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: `audit chain broken at id ${audit.firstBadId}` };
    if (real) {
      // Live model: answer must cite config.ts and the value 3.
      if (!/config\.ts/i.test(finalText) || !/\b3\b/.test(finalText)) {
        return {
          pass: false,
          reason: `answer missing config.ts and/or value 3: ${finalText.slice(0, 200)}`,
        };
      }
    }
    return { pass: true };
  },
};

// ─── Comprehension Task 3: identify entry point ───

const findEntryPoint: EvalTask = {
  name: "comprehension_find_entry",
  category: "comprehension",
  description: "Agent identifies the main entry point of the project.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify(
        { name: "my-app", main: "src/index.ts", scripts: { start: "bun src/index.ts" } },
        null,
        2,
      ),
    );
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "index.ts"),
      `import { createServer } from './server';
const server = createServer();
server.listen(3000, () => console.log('ready'));
`,
    );
    await writeFile(
      join(workspace, "src", "server.ts"),
      `export function createServer() { return { listen: (_p: number, cb: () => void) => cb() }; }
`,
    );
  },
  script: [
    {
      text: "Reading package.json to find the entry point.",
      toolCalls: [{ name: "read_file", args: { path: "package.json" } }],
    },
    {
      text: "The main entry point is src/index.ts, as specified in package.json.",
    },
  ],
  prompts: ["What is the main entry point of this project?"],
  verify: async ({ engine, mock, real, finalText }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    if (real) {
      // Live model: the answer must identify src/index.ts as the entry point.
      if (!/index\.ts/i.test(finalText)) {
        return {
          pass: false,
          reason: `answer did not reference index.ts: ${finalText.slice(0, 200)}`,
        };
      }
      return { pass: true };
    }
    // Mock: confirm the scripted run reached the model at least once.
    const firstReq = mock?.requestHistory[0];
    if (!firstReq) return { pass: false, reason: "no inference requests" };
    return { pass: true };
  },
};

// ─── Comprehension Task 4: cross-file type usage ───

const findTypeUsage: EvalTask = {
  name: "comprehension_find_type",
  category: "comprehension",
  description: "Agent locates all files that import the UserRole type.",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "types.ts"),
      `export type UserRole = 'admin' | 'editor' | 'viewer';
`,
    );
    await writeFile(
      join(workspace, "src", "auth.ts"),
      `import type { UserRole } from './types';
export function hasPermission(role: UserRole, action: string): boolean { return role === 'admin'; }
`,
    );
    await writeFile(
      join(workspace, "src", "middleware.ts"),
      `import type { UserRole } from './types';
export function requireRole(role: UserRole) { return (_req: unknown, _res: unknown, next: () => void) => next(); }
`,
    );
  },
  script: [
    {
      text: "Searching for UserRole imports across the codebase.",
      toolCalls: [{ name: "grep", args: { pattern: "UserRole", path: "." } }],
    },
    {
      text: "UserRole is defined in src/types.ts and imported in src/auth.ts and src/middleware.ts.",
    },
  ],
  prompts: ["Which files use the UserRole type?"],
  verify: async ({ engine, real, finalText }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    if (real) {
      // Live model: answer must name both importing files.
      if (!/auth\.ts/i.test(finalText) || !/middleware\.ts/i.test(finalText)) {
        return {
          pass: false,
          reason: `answer missing auth.ts and/or middleware.ts: ${finalText.slice(0, 200)}`,
        };
      }
    }
    return { pass: true };
  },
};

// ─── Comprehension Task 5: identify dead code ───

const findDeadCode: EvalTask = {
  name: "comprehension_find_dead_code",
  category: "comprehension",
  description: "Agent identifies which exported function is never imported anywhere.",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "helpers.ts"),
      `export function formatDate(d: Date): string { return d.toISOString(); }
export function legacyFormatter(d: Date): string { return d.toUTCString(); }
`,
    );
    await writeFile(
      join(workspace, "src", "report.ts"),
      `import { formatDate } from './helpers';
export function renderReport(ts: Date) { return \`Report at \${formatDate(ts)}\`; }
`,
    );
  },
  script: [
    {
      text: "Checking which helpers are actually imported.",
      toolCalls: [{ name: "grep", args: { pattern: "legacyFormatter", path: "." } }],
    },
    {
      text: "legacyFormatter is defined in src/helpers.ts but never imported — it is dead code.",
    },
  ],
  prompts: ["One exported function in this repo is never used. Which one?"],
  verify: async ({ engine, real, finalText }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    if (real) {
      if (!/legacyFormatter/.test(finalText)) {
        return {
          pass: false,
          reason: `answer did not name legacyFormatter: ${finalText.slice(0, 200)}`,
        };
      }
      // Naming the live function as dead is a wrong answer even if the dead one
      // is also mentioned in passing — require it NOT be the verdict.
      if (/formatDate[^\w]*(is|as)[^\w]*(dead|unused)/i.test(finalText)) {
        return { pass: false, reason: "answer called the live function dead" };
      }
    }
    return { pass: true };
  },
};

// ─── Comprehension Task 6: trace a side effect to its writer ───

const traceCacheWriter: EvalTask = {
  name: "comprehension_trace_writer",
  category: "comprehension",
  description: "Agent identifies which module actually writes the cache file (two candidates).",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "cache-reader.ts"),
      `import { readFileSync } from 'fs';
export function loadCache(): unknown { return JSON.parse(readFileSync('.cache.json', 'utf8')); }
`,
    );
    await writeFile(
      join(workspace, "src", "sync.ts"),
      `import { writeFileSync } from 'fs';
export function persist(state: unknown) { writeFileSync('.cache.json', JSON.stringify(state)); }
`,
    );
  },
  script: [
    {
      text: "Searching for writers of .cache.json.",
      toolCalls: [{ name: "grep", args: { pattern: "cache.json", path: "." } }],
    },
    {
      text: "The cache file is WRITTEN by src/sync.ts (persist); cache-reader.ts only reads it.",
    },
  ],
  prompts: ["Which module writes .cache.json to disk?"],
  verify: async ({ engine, real, finalText }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    if (real) {
      if (!/sync\.ts/i.test(finalText)) {
        return { pass: false, reason: `answer did not name sync.ts: ${finalText.slice(0, 200)}` };
      }
    }
    return { pass: true };
  },
};

// ─── Comprehension Task 7: concept query through ranked code search ───
// Pins the search_code wiring end to end: TS schema → rust-bridge →
// rune-tools search-code → FTS5 index built inside the eval workspace.

const conceptSearch: EvalTask = {
  name: "comprehension_search_code",
  category: "comprehension",
  description: "Agent answers a concept question using ranked full-text search (search_code).",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "notifications.ts"),
      `export async function retryFailedEmailDelivery(msg: Email): Promise<void> {
  // exponential backoff for messages the provider bounced
  await schedule(msg, backoff(msg.attempts));
}
`,
    );
    await writeFile(
      join(workspace, "src", "render.ts"),
      `export function renderTemplate(tpl: string): string { return tpl.trim(); }
`,
    );
  },
  script: [
    {
      text: "Asking the ranked index where failed deliveries are retried.",
      toolCalls: [
        { name: "search_code", args: { query: "where are failed email deliveries retried" } },
      ],
    },
    {
      text: "Failed email deliveries are retried in src/notifications.ts (retryFailedEmailDelivery).",
    },
  ],
  prompts: ["Where do we retry failed email deliveries?"],
  verify: async ({ dbPath, engine, real, finalText }) => {
    interface Row {
      tool_name: string;
      exit_code: number | null;
    }
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT tool_name, exit_code FROM audit_log ORDER BY id ASC")
      .all() as Row[];
    db.close();
    const searchRow = rows.find((r) => r.tool_name === "search_code");
    if (!real) {
      if (!searchRow) return { pass: false, reason: "search_code was never executed" };
      if (searchRow.exit_code !== null && searchRow.exit_code !== 0) {
        return { pass: false, reason: `search_code failed with exit ${searchRow.exit_code}` };
      }
    }
    if (real && !/notifications\.ts/i.test(finalText)) {
      return {
        pass: false,
        reason: `answer did not name notifications.ts: ${finalText.slice(0, 200)}`,
      };
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

export const COMPREHENSION_TASKS: EvalTask[] = [
  findAuthFunction,
  findConfigConstant,
  findEntryPoint,
  findTypeUsage,
  findDeadCode,
  traceCacheWriter,
  conceptSearch,
];
