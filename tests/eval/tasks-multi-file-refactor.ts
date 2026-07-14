/**
 * Multi-file refactor tasks: rename a symbol across files,
 * verify all sites changed and none of the old name remains.
 *
 * NOTE: Files often have the old name in multiple positions (import + call site),
 * so edit_file must use replace_all: true when the old_text appears more than once.
 */
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import type { EvalTask } from "./harness";

// ─── Refactor Task 1: rename function across 3 files ───

const renameFunction: EvalTask = {
  name: "refactor_rename_function",
  category: "multi-file-refactor",
  description: "Rename getUserById to findUserById across multiple files.",
  setup: async ({ workspace }) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "user-service.ts"),
      `export async function getUserById(id: string) {
  return { id, name: 'Alice' };
}
`,
    );
    await writeFile(
      join(workspace, "src", "api-handler.ts"),
      `import { getUserById } from './user-service';
export async function handleGetUser(req: { params: { id: string } }) {
  const user = await getUserById(req.params.id);
  return user;
}
`,
    );
    await writeFile(
      join(workspace, "src", "auth-middleware.ts"),
      `import { getUserById } from './user-service';
export async function validateUser(id: string): Promise<boolean> {
  const user = await getUserById(id);
  return !!user;
}
`,
    );
  },
  script: [
    {
      text: "Searching for all uses of getUserById.",
      toolCalls: [{ name: "grep", args: { pattern: "getUserById", path: "." } }],
    },
    {
      text: "Found 3 files. Renaming in user-service.ts first.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "src/user-service.ts",
            old_text: "getUserById",
            new_text: "findUserById",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                `export async function getUserById(id: string) {\n  return { id, name: 'Alice' };\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating api-handler.ts (has getUserById in import and call — use replace_all).",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "src/api-handler.ts",
            old_text: "getUserById",
            new_text: "findUserById",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                `import { getUserById } from './user-service';\nexport async function handleGetUser(req: { params: { id: string } }) {\n  const user = await getUserById(req.params.id);\n  return user;\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating auth-middleware.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "src/auth-middleware.ts",
            old_text: "getUserById",
            new_text: "findUserById",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                `import { getUserById } from './user-service';\nexport async function validateUser(id: string): Promise<boolean> {\n  const user = await getUserById(id);\n  return !!user;\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "All 3 files updated. getUserById is now findUserById everywhere." },
  ],
  prompts: ["Rename getUserById to findUserById across all files."],
  verify: async ({ workspace, engine }) => {
    const files = [
      join(workspace, "src", "user-service.ts"),
      join(workspace, "src", "api-handler.ts"),
      join(workspace, "src", "auth-middleware.ts"),
    ];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      if (content.includes("getUserById")) {
        return { pass: false, reason: `old name still present in ${f}` };
      }
      if (!content.includes("findUserById")) {
        return { pass: false, reason: `new name not found in ${f}` };
      }
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Refactor Task 2: rename class and update all import sites ───

const renameClass: EvalTask = {
  name: "refactor_rename_class",
  category: "multi-file-refactor",
  description: "Rename RequestLogger to AuditLogger in class definition and all usages.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "logger.ts"),
      `export class RequestLogger {
  log(msg: string) { console.log(msg); }
}
`,
    );
    await writeFile(
      join(workspace, "server.ts"),
      `import { RequestLogger } from './logger';
const logger = new RequestLogger();
logger.log('server started');
`,
    );
    await writeFile(
      join(workspace, "middleware.ts"),
      `import { RequestLogger } from './logger';
export function setupLogging() {
  return new RequestLogger();
}
`,
    );
  },
  script: [
    {
      text: "Finding all usages of RequestLogger.",
      toolCalls: [{ name: "grep", args: { pattern: "RequestLogger", path: "." } }],
    },
    {
      text: "Updating logger.ts — the class definition.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "logger.ts",
            old_text: "RequestLogger",
            new_text: "AuditLogger",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(`export class RequestLogger {\n  log(msg: string) { console.log(msg); }\n}\n`)
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating server.ts (import + instantiation — replace_all).",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "server.ts",
            old_text: "RequestLogger",
            new_text: "AuditLogger",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                `import { RequestLogger } from './logger';\nconst logger = new RequestLogger();\nlogger.log('server started');\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating middleware.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "middleware.ts",
            old_text: "RequestLogger",
            new_text: "AuditLogger",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                `import { RequestLogger } from './logger';\nexport function setupLogging() {\n  return new RequestLogger();\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Rename complete. RequestLogger is now AuditLogger everywhere." },
  ],
  prompts: ["Rename the RequestLogger class to AuditLogger across all files."],
  verify: async ({ workspace, engine }) => {
    const files = [
      join(workspace, "logger.ts"),
      join(workspace, "server.ts"),
      join(workspace, "middleware.ts"),
    ];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      if (content.includes("RequestLogger")) {
        return { pass: false, reason: `old name still present in ${f}` };
      }
      if (!content.includes("AuditLogger")) {
        return { pass: false, reason: `new name missing in ${f}` };
      }
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Refactor Task 3: rename constant and update all uses ───

const renameConstant: EvalTask = {
  name: "refactor_rename_constant",
  category: "multi-file-refactor",
  description: "Rename API_BASE_URL to SERVICE_ENDPOINT across config and consumers.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "constants.ts"),
      `export const API_BASE_URL = 'https://api.example.com/v1';
`,
    );
    await writeFile(
      join(workspace, "client.ts"),
      "import { API_BASE_URL } from './constants';\nexport async function fetchData(path: string) {\n  return fetch(`${API_BASE_URL}${path}`);\n}\n",
    );
    await writeFile(
      join(workspace, "health.ts"),
      "import { API_BASE_URL } from './constants';\nexport async function checkHealth() {\n  return fetch(`${API_BASE_URL}/health`);\n}\n",
    );
  },
  script: [
    {
      text: "Finding all references to API_BASE_URL.",
      toolCalls: [{ name: "grep", args: { pattern: "API_BASE_URL", path: "." } }],
    },
    {
      text: "Renaming in constants.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "constants.ts",
            old_text: "API_BASE_URL",
            new_text: "SERVICE_ENDPOINT",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(`export const API_BASE_URL = 'https://api.example.com/v1';\n`)
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating client.ts (import + template literal — replace_all).",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "client.ts",
            old_text: "API_BASE_URL",
            new_text: "SERVICE_ENDPOINT",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                "import { API_BASE_URL } from './constants';\nexport async function fetchData(path: string) {\n  return fetch(`${API_BASE_URL}${path}`);\n}\n",
              )
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Updating health.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "health.ts",
            old_text: "API_BASE_URL",
            new_text: "SERVICE_ENDPOINT",
            replace_all: true,
            expected_hash: createHash("sha256")
              .update(
                "import { API_BASE_URL } from './constants';\nexport async function checkHealth() {\n  return fetch(`${API_BASE_URL}/health`);\n}\n",
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Done. API_BASE_URL is now SERVICE_ENDPOINT in all 3 files." },
  ],
  prompts: ["Rename API_BASE_URL to SERVICE_ENDPOINT everywhere in this codebase."],
  verify: async ({ workspace, engine }) => {
    const files = [
      join(workspace, "constants.ts"),
      join(workspace, "client.ts"),
      join(workspace, "health.ts"),
    ];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      if (content.includes("API_BASE_URL")) {
        return { pass: false, reason: `old constant name still in ${f}` };
      }
      if (!content.includes("SERVICE_ENDPOINT")) {
        return { pass: false, reason: `new constant name missing in ${f}` };
      }
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Refactor Task 4: extract a duplicated magic number into a shared constant ───

const extractSharedConstant: EvalTask = {
  name: "refactor_extract_constant",
  category: "multi-file-refactor",
  description:
    "Agent extracts a magic number duplicated across two files into a new constants module.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "retry.ts"),
      `export function shouldRetry(attempt: number): boolean {
  return attempt < 5;
}
`,
    );
    await writeFile(
      join(workspace, "backoff.ts"),
      `export function backoffMs(attempt: number): number {
  return attempt >= 5 ? 0 : 100 * 2 ** attempt;
}
`,
    );
  },
  script: [
    {
      text: "Finding every site using the magic retry limit.",
      toolCalls: [{ name: "grep", args: { pattern: "5", path: "." } }],
    },
    {
      text: "Creating the shared constant.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "constants.ts",
            content: "export const MAX_ATTEMPTS = 5;\n",
          },
        },
      ],
    },
    {
      text: "Rewriting retry.ts to use it.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "retry.ts",
            content: `import { MAX_ATTEMPTS } from './constants';\nexport function shouldRetry(attempt: number): boolean {\n  return attempt < MAX_ATTEMPTS;\n}\n`,
          },
        },
      ],
    },
    {
      text: "Rewriting backoff.ts to use it.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "backoff.ts",
            content: `import { MAX_ATTEMPTS } from './constants';\nexport function backoffMs(attempt: number): number {\n  return attempt >= MAX_ATTEMPTS ? 0 : 100 * 2 ** attempt;\n}\n`,
          },
        },
      ],
    },
    { text: "Extracted MAX_ATTEMPTS = 5 into constants.ts and updated both call sites." },
  ],
  prompts: [
    "The retry limit 5 is duplicated in retry.ts and backoff.ts. Extract it into a MAX_ATTEMPTS constant in a new constants.ts and use it in both files.",
  ],
  verify: async ({ workspace }) => {
    const constants = await readFile(join(workspace, "constants.ts"), "utf8").catch(() => null);
    if (!constants || !/MAX_ATTEMPTS\s*=\s*5/.test(constants)) {
      return { pass: false, reason: "constants.ts with MAX_ATTEMPTS = 5 not created" };
    }
    for (const f of ["retry.ts", "backoff.ts"]) {
      const content = await readFile(join(workspace, f), "utf8");
      if (!content.includes("MAX_ATTEMPTS")) {
        return { pass: false, reason: `${f} does not use MAX_ATTEMPTS` };
      }
      if (!/from ['"]\.\/constants['"]/.test(content)) {
        return { pass: false, reason: `${f} does not import from ./constants` };
      }
      // The magic literal must be gone from comparison sites (the constant file
      // is the one place the 5 may remain).
      if (/[<>=]\s*5\b/.test(content)) {
        return { pass: false, reason: `${f} still compares against the literal 5` };
      }
    }
    return { pass: true };
  },
};

export const MULTI_FILE_REFACTOR_TASKS: EvalTask[] = [
  renameFunction,
  renameClass,
  renameConstant,
  extractSharedConstant,
];
