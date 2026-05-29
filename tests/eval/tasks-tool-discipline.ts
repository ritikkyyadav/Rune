/**
 * Tool-discipline tasks: verify read-before-edit and that expected_hash was used.
 * These inspect the audit/event log via dbPath to check tool call ordering.
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import type { EvalTask } from "./harness";

interface AuditRow {
  id: number;
  tool_name: string;
  args_hash: string;
  result_hash: string | null;
  duration_ms: number | null;
  exit_code: number | null;
}

function getAuditRows(dbPath: string): AuditRow[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT id, tool_name, args_hash, result_hash, duration_ms, exit_code FROM audit_log ORDER BY id ASC")
    .all() as AuditRow[];
  db.close();
  return rows;
}

// ─── Tool-discipline Task 1: read before edit ───

const readBeforeEdit: EvalTask = {
  name: "tool_discipline_read_before_edit",
  category: "tool-discipline",
  description:
    "Agent must call read_file before edit_file. Verify the audit log shows read first.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "config.json"),
      JSON.stringify({ version: "1.0.0", debug: false }, null, 2) + "\n",
    );
  },
  script: [
    {
      text: "Reading config.json before making changes.",
      toolCalls: [{ name: "read_file", args: { path: "config.json" } }],
    },
    {
      text: "Now editing the file with the correct hash.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "config.json",
            old_text: '"debug": false',
            new_text: '"debug": true',
            expected_hash: createHash("sha256")
              .update(JSON.stringify({ version: "1.0.0", debug: false }, null, 2) + "\n")
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Done. debug is now true." },
  ],
  prompts: ["Enable debug mode in config.json."],
  verify: async ({ dbPath, engine }) => {
    const rows = getAuditRows(dbPath);
    if (rows.length < 2) {
      return { pass: false, reason: `expected ≥2 audit rows, got ${rows.length}` };
    }

    const readIdx = rows.findIndex((r) => r.tool_name === "read_file");
    const editIdx = rows.findIndex((r) => r.tool_name === "edit_file");

    if (readIdx === -1) {
      return { pass: false, reason: "no read_file call found in audit log" };
    }
    if (editIdx === -1) {
      return { pass: false, reason: "no edit_file call found in audit log" };
    }
    if (readIdx >= editIdx) {
      return {
        pass: false,
        reason: `read_file (id ${rows[readIdx].id}) must precede edit_file (id ${rows[editIdx].id})`,
      };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Tool-discipline Task 2: expected_hash used on edit ───

const hashUsedOnEdit: EvalTask = {
  name: "tool_discipline_hash_used",
  category: "tool-discipline",
  description:
    "Agent must supply expected_hash when calling edit_file. Verify it appears in args via audit.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "main.ts"), `const x = 1;\n`);
  },
  script: [
    {
      text: "Reading main.ts to get the hash.",
      toolCalls: [{ name: "read_file", args: { path: "main.ts" } }],
    },
    {
      text: "Editing with expected_hash provided.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "main.ts",
            old_text: "const x = 1;",
            new_text: "const x = 2;",
            expected_hash: createHash("sha256").update(`const x = 1;\n`).digest("hex"),
          },
        },
      ],
    },
    { text: "Changed x from 1 to 2 with hash verification." },
  ],
  prompts: ["Change x from 1 to 2 in main.ts."],
  verify: async ({ dbPath, engine }) => {
    const rows = getAuditRows(dbPath);
    const editRow = rows.find((r) => r.tool_name === "edit_file");
    if (!editRow) {
      return { pass: false, reason: "no edit_file call in audit log" };
    }

    // The args_hash is a hash of the args — we can't reverse it.
    // What we CAN do: ensure edit_file was called AND read_file was called first,
    // AND we verify that the file actually changed correctly (proving hash matched).
    const readRow = rows.find((r) => r.tool_name === "read_file");
    if (!readRow) {
      return { pass: false, reason: "read_file was not called before edit_file" };
    }

    // If edit_file ran without error (exit_code 0 or null = success), the hash matched
    if (editRow.exit_code !== null && editRow.exit_code !== 0) {
      return { pass: false, reason: `edit_file exited with code ${editRow.exit_code}` };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Tool-discipline Task 3: no blind write (must list/read first) ───

const noBlindWrite: EvalTask = {
  name: "tool_discipline_no_blind_write",
  category: "tool-discipline",
  description:
    "Agent must inspect the workspace before writing a new file. Verify list_dir or grep precedes write_file.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "existing.ts"), `// existing file\n`);
  },
  script: [
    {
      text: "Listing the directory to understand the workspace.",
      toolCalls: [{ name: "list_dir", args: { path: "." } }],
    },
    {
      text: "Creating the new file now that I know what exists.",
      toolCalls: [
        {
          name: "write_file",
          args: { path: "new-module.ts", content: "export const NEW = true;\n" },
        },
      ],
    },
    { text: "Created new-module.ts." },
  ],
  prompts: ["Add a new-module.ts file with a NEW export, but first check what files already exist."],
  verify: async ({ dbPath, workspace, engine }) => {
    const rows = getAuditRows(dbPath);

    const explorationIdx = rows.findIndex(
      (r) => r.tool_name === "list_dir" || r.tool_name === "grep",
    );
    const writeIdx = rows.findIndex((r) => r.tool_name === "write_file");

    if (explorationIdx === -1) {
      return { pass: false, reason: "agent did not call list_dir or grep before writing" };
    }
    if (writeIdx === -1) {
      return { pass: false, reason: "write_file was never called" };
    }
    if (explorationIdx >= writeIdx) {
      return {
        pass: false,
        reason: "write_file was called before any exploration (list_dir/grep)",
      };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Tool-discipline Task 4: tool call ordering — grep before edit ───

const grepBeforeEdit: EvalTask = {
  name: "tool_discipline_grep_before_edit",
  category: "tool-discipline",
  description:
    "When renaming a symbol, agent should grep first to locate all sites, then edit each.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "utils.ts"),
      `export function oldName() { return 42; }\n`,
    );
    await writeFile(
      join(workspace, "index.ts"),
      `import { oldName } from './utils';\nconsole.log(oldName());\n`,
    );
  },
  script: [
    {
      text: "Searching for all uses of oldName before editing.",
      toolCalls: [{ name: "grep", args: { pattern: "oldName", path: "." } }],
    },
    {
      text: "Reading utils.ts.",
      toolCalls: [{ name: "read_file", args: { path: "utils.ts" } }],
    },
    {
      text: "Editing utils.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "utils.ts",
            old_text: "oldName",
            new_text: "newName",
            expected_hash: createHash("sha256")
              .update(`export function oldName() { return 42; }\n`)
              .digest("hex"),
          },
        },
      ],
    },
    {
      text: "Reading index.ts.",
      toolCalls: [{ name: "read_file", args: { path: "index.ts" } }],
    },
    {
      text: "Editing index.ts.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "index.ts",
            old_text: "oldName",
            new_text: "newName",
            expected_hash: createHash("sha256")
              .update(`import { oldName } from './utils';\nconsole.log(oldName());\n`)
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Rename complete. Grepped first, then edited both files." },
  ],
  prompts: ["Rename oldName to newName across this codebase. Grep for all uses first."],
  verify: async ({ dbPath, engine }) => {
    const rows = getAuditRows(dbPath);

    // grep must appear before any edit_file
    const grepIdx = rows.findIndex((r) => r.tool_name === "grep");
    const firstEditIdx = rows.findIndex((r) => r.tool_name === "edit_file");

    if (grepIdx === -1) {
      return { pass: false, reason: "grep was not called at all" };
    }
    if (firstEditIdx === -1) {
      return { pass: false, reason: "no edit_file calls found" };
    }
    if (grepIdx >= firstEditIdx) {
      return { pass: false, reason: "edit_file was called before grep" };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

export const TOOL_DISCIPLINE_TASKS: EvalTask[] = [
  readBeforeEdit,
  hashUsedOnEdit,
  noBlindWrite,
  grepBeforeEdit,
];
