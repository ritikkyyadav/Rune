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
        return { pass: false, reason: `answer did not reference auth.ts: ${finalText.slice(0, 200)}` };
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
        return { pass: false, reason: `answer missing config.ts and/or value 3: ${finalText.slice(0, 200)}` };
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
      JSON.stringify({ name: "my-app", main: "src/index.ts", scripts: { start: "bun src/index.ts" } }, null, 2),
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
        return { pass: false, reason: `answer did not reference index.ts: ${finalText.slice(0, 200)}` };
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
        return { pass: false, reason: `answer missing auth.ts and/or middleware.ts: ${finalText.slice(0, 200)}` };
      }
    }
    return { pass: true };
  },
};

export const COMPREHENSION_TASKS: EvalTask[] = [
  findAuthFunction,
  findConfigConstant,
  findEntryPoint,
  findTypeUsage,
];
