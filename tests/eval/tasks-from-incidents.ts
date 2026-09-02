/**
 * Regression evals promoted from real incidents (see from-incidents.ts).
 *
 * The contract: every incident CLASS in `from-incidents/classes.json` that has
 * fired ≥3 times gets a deterministic eval here reproducing the failure shape,
 * and its class is recorded in `from-incidents/covered.json` so the miner and
 * the CI check stop flagging it. `bun run tests/eval/from-incidents.ts --check`
 * fails when an uncovered class crosses the threshold.
 *
 * "Deterministic" is the whole point. These reproduce the SHAPE of a real
 * failure through the mock provider — a stream that dies part way, tool
 * arguments the provider itself broke, an error that keeps repeating — so the
 * recovery path is measured on every change rather than the next time the
 * failure happens to occur in production.
 *
 * What they assert is RECOVERY, never the absence of the failure: a stream will
 * always sometimes die. The question the suite answers is whether it costs a
 * turn or the run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalTask } from "./harness";

/** Read a session's events straight from the eval's own database. */
function sessionEvents(dbPath: string, sessionId: string): Array<{ type: string; payload: any }> {
  // Imported lazily so the module stays cheap for `--list`.
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload_json).payload }));
  } finally {
    db.close();
  }
}

const README = "# Fixture\n\nOne file, so a task has something real to edit.\n";

/**
 * `provider.stream_error` — 59 occurrences, 2026-07-14 → 2026-09-01.
 *
 * The provider's stream dies after the model has already said something. The
 * run must survive it: retry, finish the work, and end with the artifact on
 * disk. Before this task the suite could not express a failing stream at all,
 * so the recovery path shipped unmeasured.
 */
const streamErrorRecovery: EvalTask = {
  name: "incident_stream_error_recovery",
  category: "core",
  description: "A stream that dies part way costs a turn, not the run",
  setup: async ({ workspace }) => {
    await Bun.write(join(workspace, "README.md"), README);
  },
  script: [
    // Turn 1: the model starts talking and the connection drops.
    { text: "Let me look at the file", streamError: "stream disconnected: ECONNRESET" },
    // Turn 2: the retry does the work.
    {
      toolCalls: [{ name: "write_file", args: { path: "NOTES.md", content: "recovered\n" } }],
    },
    { text: "Done — wrote NOTES.md." },
  ],
  prompts: ["Write NOTES.md containing the word recovered."],
  maxTurns: 4,
  verify: async ({ workspace }) => {
    const path = join(workspace, "NOTES.md");
    try {
      const text = readFileSync(path, "utf8");
      if (!text.includes("recovered")) {
        return { pass: false, reason: `NOTES.md exists but says ${JSON.stringify(text)}` };
      }
      return { pass: true };
    } catch {
      return {
        pass: false,
        reason: "the run did not survive a mid-stream disconnect: NOTES.md was never written",
      };
    }
  },
};

/**
 * `provider.malformed_tool_json_fatal` — 22 occurrences, 2026-08-25 → 08-29.
 *
 * The provider emits tool arguments that are not valid JSON. The gateway has a
 * salvage path for exactly this; above the unit level nothing exercised it.
 * The run must not die: either the salvage recovers the call, or the loop asks
 * again and finishes. Both are acceptable; a dead run is not.
 */
const malformedToolJson: EvalTask = {
  name: "incident_malformed_tool_json",
  category: "core",
  description: "Tool arguments the provider itself broke do not kill the run",
  setup: async ({ workspace }) => {
    await Bun.write(join(workspace, "README.md"), README);
  },
  script: [
    // Truncated JSON on the wire — the shape the black box recorded.
    {
      toolCalls: [{ name: "write_file", args: { path: "OUT.md", content: "x" } }],
      rawToolArgs: '{"path": "OUT.md", "content": "x',
    },
    // The loop asks again; this time the arguments are whole.
    {
      toolCalls: [{ name: "write_file", args: { path: "OUT.md", content: "salvaged\n" } }],
    },
    { text: "Done — wrote OUT.md." },
  ],
  prompts: ["Write OUT.md containing the word salvaged."],
  maxTurns: 4,
  verify: async ({ workspace }) => {
    try {
      const text = readFileSync(join(workspace, "OUT.md"), "utf8");
      return text.includes("salvaged")
        ? { pass: true }
        : { pass: false, reason: `OUT.md says ${JSON.stringify(text)}` };
    } catch {
      return {
        pass: false,
        reason: "malformed tool arguments killed the run: OUT.md was never written",
      };
    }
  },
};

/**
 * `loop.consecutive_errors` — 19 occurrences, 2026-07-15 → 2026-09-01.
 *
 * Errors that keep repeating. The loop must STOP, cleanly, with the run's state
 * recorded — not spin until a cap fires and not exit silently. What this task
 * asserts is the handoff: a run that dies has to leave behind an account of
 * where it stood, because that record is the only thing resume has.
 */
const consecutiveErrors: EvalTask = {
  name: "incident_consecutive_errors_handoff",
  category: "core",
  description: "Repeated provider errors stop the loop cleanly and leave a record",
  setup: async ({ workspace }) => {
    await Bun.write(join(workspace, "README.md"), README);
  },
  script: [
    { text: "starting", streamError: "provider error: 500 internal" },
    { text: "retrying", streamError: "provider error: 500 internal" },
    { text: "retrying", streamError: "provider error: 500 internal" },
    { text: "retrying", streamError: "provider error: 500 internal" },
    { text: "retrying", streamError: "provider error: 500 internal" },
  ],
  prompts: ["Refactor the README into three sections."],
  maxTurns: 3,
  verify: async ({ dbPath, sessionId }) => {
    const events = sessionEvents(dbPath, sessionId);
    const retro = [...events].reverse().find((e) => e.type === "retro");
    if (!retro) {
      return {
        pass: false,
        reason:
          "a run that died on repeated errors wrote no retro — the record resume depends on is missing",
      };
    }
    const outcome = String(retro.payload?.retro?.outcome ?? "");
    // "finished" would mean the loop declared success on a run where every
    // single completion failed, which is the failure this task exists to catch.
    if (outcome === "finished") {
      return {
        pass: false,
        reason: "the run reported `finished` after five consecutive stream failures",
      };
    }
    return { pass: true };
  },
};

/**
 * `provider.empty_completion` — 10 occurrences, all-time.
 *
 * The model returns a message with no text and no tool calls. There is nothing
 * to act on and nothing to say, and the loop has to notice rather than treat
 * silence as an answer and declare the turn finished.
 */
const emptyCompletion: EvalTask = {
  name: "incident_empty_completion",
  category: "core",
  description: "A completion with nothing in it is not an answer",
  setup: async ({ workspace }) => {
    await Bun.write(join(workspace, "README.md"), README);
  },
  script: [
    // Nothing at all: no text, no tool call.
    {},
    // The loop asks again and the model does the work.
    {
      toolCalls: [{ name: "write_file", args: { path: "EMPTY.md", content: "answered\n" } }],
    },
    { text: "Done." },
  ],
  prompts: ["Write EMPTY.md containing the word answered."],
  maxTurns: 4,
  verify: async ({ workspace }) => {
    try {
      const text = readFileSync(join(workspace, "EMPTY.md"), "utf8");
      return text.includes("answered")
        ? { pass: true }
        : { pass: false, reason: `EMPTY.md says ${JSON.stringify(text)}` };
    } catch {
      return {
        pass: false,
        reason: "an empty completion ended the run: EMPTY.md was never written",
      };
    }
  },
};

export const FROM_INCIDENTS_TASKS: EvalTask[] = [
  streamErrorRecovery,
  malformedToolJson,
  consecutiveErrors,
  emptyCompletion,
];
