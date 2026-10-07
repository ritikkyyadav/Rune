/**
 * A delegated child, read back from its parent's log.
 *
 * Every `task` and `worker` call has always written its whole conversation into
 * the parent session's event log. Nothing read it back except the child itself,
 * resuming from a `task_id` -- so a sub-agent could be inspected for exactly as
 * long as the process that ran it stayed up.
 *
 * Two pure functions and one query are the door. These tests hold them to the
 * properties a reader depends on:
 *
 *   - listing the children never loads their conversations (the query returns
 *     scalars, and a quarter-megabyte payload costs the caller a few of them);
 *   - the LATEST record is the child's state, and a status belongs to the row
 *     that carries it;
 *   - a call and its result become one entry, and a call with no result on
 *     record is kept and marked rather than dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "../../../packages/llm-gateway/src/types";
import { SessionManager } from "../../../packages/shared/src/session";
import {
  DELEGATION_CLIP,
  DELEGATION_PATHS,
  delegationEntries,
  listStoredDelegations,
} from "../../../packages/orchestrator/src/delegation-replay";
import { rmTemp } from "../../helpers/tmp";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function store(): { sessions: SessionManager; session: string } {
  const dir = mkdtempSync(join(tmpdir(), "delegation-replay-"));
  const sessions = new SessionManager(join(dir, "rune.db"));
  // The store is closed before its directory goes: Windows will not delete a
  // database that is still open, and `rmTemp` rides out the moment after.
  cleanup.push(() => {
    sessions.close();
    rmTemp(dir);
  });
  const session = sessions.createSession(dir, "test-model", "test").id;
  return { sessions, session };
}

const row = (seq: number, fields: Record<string, unknown>, at = "2026-10-02T10:00:00.000Z") => ({
  seq,
  at,
  fields,
});

describe("listing a session's children", () => {
  test("the latest record of a child is its state", () => {
    const children = listStoredDelegations([
      // A mid-run checkpoint: no status, because it had not ended.
      row(1, { id: "task_a", kind: "task", name: "planner", label: "map settings", turns: 2 }),
      row(2, {
        id: "task_a",
        kind: "task",
        name: "planner",
        status: "end_turn",
        turns: 5,
        elapsedMs: 31_000,
        recordedAt: "2026-10-02T10:00:31.000Z",
      }),
    ]);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: "task_a",
      kind: "task",
      name: "planner",
      // Kept from the earlier row: the later one did not carry it.
      label: "map settings",
      status: "end_turn",
      turns: 5,
      elapsedMs: 31_000,
      at: "2026-10-02T10:00:31.000Z",
    });
  });

  test("a status belongs to the row that carries it", () => {
    // A follow-up on a child that had finished writes a boundary checkpoint
    // with no status. Inheriting the previous run's `end_turn` would report a
    // child that then died mid-follow-up as having finished cleanly.
    const children = listStoredDelegations([
      row(1, { id: "task_a", kind: "task", status: "end_turn" }),
      row(2, { id: "task_a", kind: "task" }),
    ]);
    expect(children[0]!.status).toBeUndefined();
  });

  test("children come back in the order the log first saw them", () => {
    const children = listStoredDelegations([
      row(1, { id: "task_a", kind: "task" }),
      row(2, { id: "task_b", kind: "worker" }),
      row(3, { id: "task_a", kind: "task", status: "end_turn" }),
      row(4, { id: "task_c", kind: "task" }),
    ]);
    expect(children.map((c) => c.id)).toEqual(["task_a", "task_b", "task_c"]);
    expect(children.map((c) => c.kind)).toEqual(["task", "worker", "task"]);
  });

  test("a row from a build that stored no name still yields the head of its prompt", () => {
    const children = listStoredDelegations([
      row(1, {
        id: "task_a",
        kind: "task",
        prompt: "Find  where\nsettings   live.",
        status: "end_turn",
      }),
    ]);
    expect(children[0]!.name).toBeUndefined();
    expect(children[0]!.promptHead).toBe("Find where settings live.");
  });

  test("a row with no id is not a child", () => {
    expect(
      listStoredDelegations([row(1, { kind: "task" }), row(2, { id: "", kind: "task" })]),
    ).toEqual([]);
  });
});

describe("the projection query", () => {
  test("returns the named fields of one event type, and never the payload", () => {
    const { sessions, session } = store();
    const huge = "x".repeat(200_000);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: `Map the settings surface. ${huge}` }] },
      { role: "assistant", content: [{ type: "text", text: huge }] },
    ];
    sessions.appendEvent(session, { type: "user_msg", payload: { content: "hello" } });
    sessions.appendEvent(session, {
      type: "delegation_checkpoint",
      payload: {
        version: 1,
        id: "task_a",
        kind: "task",
        callId: "c1",
        name: "planner",
        label: "map the settings surface",
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages,
        at: "2026-10-02T10:00:31.000Z",
        startedAt: "2026-10-02T10:00:00.000Z",
        status: "end_turn",
        budget: { spentUsd: 0.1, elapsedMs: 31_000, turnsUsed: 5 },
      },
    });
    // A different type, and a different session: neither is returned.
    sessions.appendEvent(session, { type: "delegation_lease", payload: { id: "task_a", pid: 1 } });
    const other = sessions.createSession("/tmp", "m", "p").id;
    sessions.appendEvent(other, {
      type: "delegation_checkpoint",
      payload: { id: "task_other", kind: "task", messages: [] },
    });

    const rows = sessions.projectEvents(
      session,
      "delegation_checkpoint",
      DELEGATION_PATHS,
      DELEGATION_CLIP,
    );
    expect(rows).toHaveLength(1);
    const fields = rows[0]!.fields;
    expect(fields.id).toBe("task_a");
    expect(fields.callId).toBe("c1");
    expect(fields.name).toBe("planner");
    expect(fields.status).toBe("end_turn");
    expect(fields.elapsedMs).toBe(31_000);
    expect(fields.turns).toBe(5);
    // The prompt is clipped IN the database: what crossed is a label's worth,
    // not the two hundred kilobytes behind it.
    expect(String(fields.prompt).length).toBe(DELEGATION_CLIP.prompt);
    expect(String(fields.prompt).startsWith("Map the settings surface.")).toBe(true);
    expect(JSON.stringify(rows).length).toBeLessThan(2_000);

    // And the pure fold reads exactly what the query returned.
    const [child] = listStoredDelegations(rows);
    expect(child).toMatchObject({
      id: "task_a",
      callId: "c1",
      name: "planner",
      label: "map the settings surface",
      status: "end_turn",
      model: "claude-sonnet-5",
      provider: "anthropic",
      startedAt: "2026-10-02T10:00:00.000Z",
      at: "2026-10-02T10:00:31.000Z",
    });
  });

  test("a field name never reaches the SQL text", () => {
    const { sessions, session } = store();
    sessions.appendEvent(session, { type: "t", payload: { id: "a" } });
    // The names are aliased positionally and the paths are bound, so a hostile
    // name is just a key in the result.
    const hostile = 'x"; DROP TABLE events; --';
    const rows = sessions.projectEvents(session, "t", { [hostile]: "$.payload.id" });
    expect(rows[0]!.fields[hostile]).toBe("a");
    expect(sessions.getEvents(session, 1)).toHaveLength(1);
  });

  test("a missing path is null, and no paths is still the rows", () => {
    const { sessions, session } = store();
    sessions.appendEvent(session, { type: "t", payload: { id: "a" } });
    expect(
      sessions.projectEvents(session, "t", { nope: "$.payload.nope" })[0]!.fields.nope,
    ).toBeNull();
    expect(sessions.projectEvents(session, "t", {})).toHaveLength(1);
    expect(sessions.projectEvents(session, "absent", { id: "$.payload.id" })).toEqual([]);
  });
});

describe("one child's conversation, as entries", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Map the settings surface." }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Probably one table." },
        { type: "text", text: "Starting from the table." },
        {
          type: "tool_use",
          toolCallId: "t1",
          toolName: "grep",
          toolInput: { pattern: "SETTINGS" },
        },
        { type: "tool_use", toolCallId: "t2", toolName: "read_file", toolInput: { path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "t2", toolResultContent: "contents of a" },
        { type: "tool_result", toolCallId: "t1", toolResultContent: "no matches", isError: true },
        { type: "text", text: "[Budget: turn 2 of 16]" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "One table." },
        { type: "tool_use", toolCallId: "t3", toolName: "bash", toolInput: { command: "ls" } },
      ],
    },
  ];

  test("a call and its result are one entry, in the order the calls were made", () => {
    const entries = delegationEntries(messages);
    expect(entries.map((e) => e.kind)).toEqual([
      "prompt",
      "thinking",
      "text",
      "tool",
      "tool",
      "note",
      "text",
      "tool",
    ]);
    // The results arrived t2-then-t1; the entries stay t1-then-t2.
    expect(entries[3]).toEqual({
      kind: "tool",
      toolName: "grep",
      args: { pattern: "SETTINGS" },
      result: "no matches",
      isError: true,
    });
    expect(entries[4]).toMatchObject({
      toolName: "read_file",
      result: "contents of a",
      isError: false,
    });
  });

  test("a call the record never answered is kept, and says so", () => {
    const last = delegationEntries(messages).at(-1)!;
    expect(last).toEqual({
      kind: "tool",
      toolName: "bash",
      args: { command: "ls" },
      result: "",
      isError: false,
      unanswered: true,
    });
  });

  test("what the harness wrote is a note; what the child was asked is a prompt", () => {
    const entries = delegationEntries([
      ...messages,
      // A follow-up on the same task_id is a second thing it was asked.
      { role: "user", content: [{ type: "text", text: "Now check the loader too." }] },
    ]);
    expect(
      entries.filter((e) => e.kind === "prompt").map((e) => (e as { text: string }).text),
    ).toEqual(["Map the settings surface.", "Now check the loader too."]);
    expect(entries.filter((e) => e.kind === "note")).toEqual([
      { kind: "note", text: "[Budget: turn 2 of 16]" },
    ]);
  });

  test("blocks with nothing readable in them produce nothing", () => {
    expect(
      delegationEntries([
        { role: "assistant", content: [{ type: "text", text: "   " }] },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "orphan", toolResultContent: "x" }],
        },
      ]),
    ).toEqual([]);
  });
});
