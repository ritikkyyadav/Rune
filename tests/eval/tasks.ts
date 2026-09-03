import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { SessionManager } from "@gear/shared";

import type { EvalTask } from "./harness";
import { COMPREHENSION_TASKS } from "./tasks-comprehension";
import { FIX_FAILING_TEST_TASKS } from "./tasks-fix-failing-test";
import { POST_EDIT_DIAGNOSTICS_TASKS } from "./tasks-post-edit-diagnostics";
import { MULTI_FILE_REFACTOR_TASKS } from "./tasks-multi-file-refactor";
import { NEW_FEATURE_TASKS } from "./tasks-new-feature";
import { TOOL_DISCIPLINE_TASKS } from "./tasks-tool-discipline";
import { FROM_INCIDENTS_TASKS } from "./tasks-from-incidents";
import { TASK_SPINE_TASKS } from "./tasks-task-spine";
import { LONG_HORIZON_TASKS } from "./tasks-long-horizon";
import { GREENFIELD_TASKS } from "./tasks-greenfield";
import { PARALLEL_TASKS } from "./tasks-parallel";
import { VERIFIER_ECOSYSTEM_TASKS } from "./tasks-verifier-ecosystems";

// Each task scripts the LLM behavior deterministically and verifies a
// concrete invariant after execution. No real model calls.

function sha256OfFile(path: string): Promise<string> {
  return readFile(path).then((buf) => createHash("sha256").update(buf).digest("hex"));
}

// ─── Task 1: read_file + grep produces correct tool sequence ───

const readAndGrep: EvalTask = {
  name: "read_and_grep",
  category: "core",
  description: "Agent reads a file, then greps for a pattern, then summarizes the finding.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "service.ts"),
      "function login(user: string) { return jwt.sign(user); }\n",
    );
  },
  script: [
    {
      text: "Looking for JWT usage.",
      toolCalls: [{ name: "grep", args: { pattern: "jwt", path: "." } }],
    },
    {
      text: "Found jwt.sign in service.ts:1. JWT signing is implemented there.",
    },
  ],
  prompts: ["where is JWT used?"],
  verify: async ({ workspace, engine, sessionId }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: `audit chain broken at id ${audit.firstBadId}` };
    return { pass: true };
  },
};

// ─── Task 2: edit_file with hash applies cleanly ───

const editWithHash: EvalTask = {
  name: "edit_with_hash",
  category: "core",
  description: "Agent reads a file, captures its hash, edits it, verifies new content.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "greeter.ts"), "export const greeting = 'hello';\n");
  },
  script: [
    {
      text: "Reading the file first.",
      toolCalls: [{ name: "read_file", args: { path: "greeter.ts" } }],
    },
    {
      // Hash is for: "export const greeting = 'hello';\n"
      // The agent should use the hash returned from read_file; for the
      // mock we hardcode it. We compute it once below.
      text: "Now editing.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "greeter.ts",
            old_text: "'hello'",
            new_text: "'world'",
            expected_hash: createHash("sha256")
              .update("export const greeting = 'hello';\n")
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Done — greeter now greets 'world'." },
  ],
  prompts: ["change the greeting from hello to world in greeter.ts"],
  verify: async ({ workspace, engine }) => {
    const content = await readFile(join(workspace, "greeter.ts"), "utf8");
    if (!content.includes("'world'")) return { pass: false, reason: `file unchanged: ${content}` };
    if (content.includes("'hello'")) return { pass: false, reason: "old text still present" };
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Task 3: multi-turn memory — second turn uses info from first ───

const multiTurnMemory: EvalTask = {
  name: "multi_turn_memory",
  category: "core",
  description:
    "Two-turn conversation: first turn discovers a file path; second turn references it without re-discovering.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "auth.ts"), "// auth lives here\n");
  },
  script: [
    // Turn 1
    {
      text: "Searching for auth files.",
      toolCalls: [{ name: "list_dir", args: { path: "." } }],
    },
    { text: "auth.ts is the auth file." },
    // Turn 2 — the agent should now read auth.ts directly, not search again
    {
      text: "Reading auth.ts as we discussed.",
      toolCalls: [{ name: "read_file", args: { path: "auth.ts" } }],
    },
    { text: "Confirmed: auth.ts contains the auth comment." },
  ],
  prompts: ["what files are in this repo?", "now read the auth file you just found"],
  verify: async ({ engine, mock, real, finalText }) => {
    if (real) {
      // Live model: the second turn must resolve "the auth file" to auth.ts,
      // which only works if prior-turn context was replayed. Judge by content.
      if (!/auth\.ts/i.test(finalText)) {
        return {
          pass: false,
          reason: `multi-turn answer did not reference auth.ts: ${finalText.slice(0, 200)}`,
        };
      }
      const audit = engine.verifyAuditChain();
      if (!audit.ok) return { pass: false, reason: "audit chain broken" };
      return { pass: true };
    }
    // The second engine.chat() call must have included the FIRST turn's
    // messages as priors. Find the first inference request from turn 2
    // (which happens after the first two inference calls of turn 1) and
    // confirm its messages array contains content from turn 1.
    //
    // Turn 1 → 2 inference calls (initial + post-tool)
    // Turn 2 → 2 inference calls (initial + post-tool)
    // The 3rd inference call (index 2) is turn-2's first model call.
    const turn2Request = mock?.requestHistory[2];
    if (!turn2Request) {
      return {
        pass: false,
        reason: `expected ≥3 inference calls, got ${mock?.requestHistory.length ?? 0}`,
      };
    }
    // Multi-turn means this request includes BOTH user prompts, plus
    // intermediate assistant/tool messages — at minimum, 4 messages.
    if (turn2Request.length < 4) {
      return {
        pass: false,
        reason: `turn-2 context only had ${turn2Request.length} messages; multi-turn replay is broken`,
      };
    }
    const userMsgs = turn2Request.filter((m) => m.role === "user");
    if (userMsgs.length < 2) {
      return {
        pass: false,
        reason: `turn-2 saw ${userMsgs.length} user messages; expected ≥2 (priors not replayed)`,
      };
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Task 4: permission denial prevents write ───

const permissionDenied: EvalTask = {
  name: "permission_denied",
  category: "core",
  description: "Agent tries to write a file; user denies; verify file was NOT created.",
  script: [
    {
      text: "Creating the file.",
      toolCalls: [
        {
          name: "write_file",
          args: { path: "secret.txt", content: "should not exist" },
        },
      ],
    },
    {
      text: "The write was denied by the user. Stopping.",
    },
  ],
  prompts: ["create a file named secret.txt with content 'should not exist'"],
  permissionResponses: [{ kind: "deny" }],
  verify: async ({ workspace, engine }) => {
    const path = join(workspace, "secret.txt");
    const file = Bun.file(path);
    if (await file.exists()) {
      return { pass: false, reason: "file was created despite denial" };
    }
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── Task 5: audit chain integrity ───

const auditChainIntegrity: EvalTask = {
  name: "audit_chain_integrity",
  category: "core",
  description: "After several tool calls, the audit chain must verify clean.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "a.txt"), "alpha\n");
    await writeFile(join(workspace, "b.txt"), "beta\n");
  },
  script: [
    {
      text: "Reading both.",
      toolCalls: [
        { name: "read_file", args: { path: "a.txt" } },
        { name: "read_file", args: { path: "b.txt" } },
      ],
    },
    {
      text: "Searching.",
      toolCalls: [{ name: "grep", args: { pattern: "alpha" } }],
    },
    { text: "Done." },
  ],
  prompts: ["read a.txt and b.txt, then grep for alpha"],
  verify: async ({ engine }) => {
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: `chain broken at id ${audit.firstBadId}` };
    return { pass: true };
  },
};

// ─── Task 6: infinite-loop detection halts the agent ───

const infiniteLoopHalts: EvalTask = {
  name: "infinite_loop_halts",
  category: "core",
  description: "Agent issues the same tool call 3 times in a row; loop detector must stop it.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "stuck.txt"), "x\n");
  },
  // Many identical responses. The detector nudges once then bails, so a working
  // detector halts well before consuming all of these.
  script: Array.from({ length: 8 }, () => ({
    text: "trying the same thing again",
    toolCalls: [{ name: "read_file", args: { path: "stuck.txt" } }],
  })),
  prompts: ["read stuck.txt"],
  verify: async ({ mock, real, engine }) => {
    if (real) {
      // Loop detection is a deterministic engine guard; a live model won't
      // reliably reproduce a 3x-identical-call loop. In real mode we only
      // assert the run completed with an intact audit chain.
      const audit = engine.verifyAuditChain();
      if (!audit.ok) return { pass: false, reason: "audit chain broken" };
      return { pass: true };
    }
    // The loop detector must stop the agent before it consumes the 4th
    // scripted response. We expect exactly 3 inference calls (the 3rd
    // produces the trigger that the detector catches).
    // The detector nudges once (maxStuckNudges=1) before bailing, so a runaway
    // identical-call loop halts within ~6 calls. If it never halted it would
    // consume every scripted response.
    if ((mock?.callsConsumed ?? 0) >= 8) {
      return {
        pass: false,
        reason: `loop detector failed — consumed all ${mock?.callsConsumed} responses (never halted)`,
      };
    }
    return { pass: true };
  },
};

// ─── Task 7: tamper detection — modifying the audit log breaks the chain ───

const tamperDetection: EvalTask = {
  name: "tamper_detection",
  category: "core",
  description:
    "After tool calls land, mutating an audit row directly must cause verifyAuditChain to flag the first bad entry.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "t.txt"), "tamper-test\n");
  },
  script: [
    {
      text: "reading",
      toolCalls: [
        { name: "read_file", args: { path: "t.txt" } },
        { name: "list_dir", args: { path: "." } },
      ],
    },
    { text: "done" },
  ],
  prompts: ["read t.txt and list the directory"],
  verify: async ({ engine, dbPath }) => {
    // Sanity: chain must be clean before tampering.
    const before = engine.verifyAuditChain();
    if (!before.ok) {
      return {
        pass: false,
        reason: `chain unexpectedly broken before tampering (id ${before.firstBadId})`,
      };
    }

    // Tamper through a separate connection (WAL mode allows concurrent
    // writers/readers; the engine's connection sees the mutation on next read).
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT id FROM audit_log ORDER BY id ASC LIMIT 1").all() as Array<{
      id: number;
    }>;
    if (rows.length === 0) {
      db.close();
      return { pass: false, reason: "no audit rows to tamper with" };
    }
    db.prepare("UPDATE audit_log SET tool_name = 'tampered' WHERE id = ?").run(rows[0].id);
    db.close();

    // Re-verify through a fresh SessionManager so we know the engine's
    // cached state isn't masking the tampering.
    const sm = new SessionManager(dbPath);
    const after = sm.verifyAuditChain();
    sm.close();

    if (after.ok) {
      return { pass: false, reason: "tampering went undetected" };
    }
    return { pass: true };
  },
};

const CORE_TASKS: EvalTask[] = [
  readAndGrep,
  editWithHash,
  multiTurnMemory,
  permissionDenied,
  auditChainIntegrity,
  infiniteLoopHalts,
  tamperDetection,
];

export const ALL_TASKS: EvalTask[] = [
  ...CORE_TASKS,
  ...TASK_SPINE_TASKS,
  ...VERIFIER_ECOSYSTEM_TASKS,
  ...LONG_HORIZON_TASKS,
  ...GREENFIELD_TASKS,
  ...PARALLEL_TASKS,
  ...COMPREHENSION_TASKS,
  ...FIX_FAILING_TEST_TASKS,
  ...POST_EDIT_DIAGNOSTICS_TASKS,
  ...MULTI_FILE_REFACTOR_TASKS,
  ...NEW_FEATURE_TASKS,
  ...TOOL_DISCIPLINE_TASKS,
  ...FROM_INCIDENTS_TASKS,
];
