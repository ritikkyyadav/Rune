/**
 * Unit tests for `compaction` event handling in eventsToMessages() and the
 * end-to-end persistence round-trip that backs the `/compress` command.
 *
 * Covers:
 *  1. A compaction event collapses all prior messages into one summary.
 *  2. Turns that come after a compaction append after the summary.
 *  3. Chained compactions keep only the latest summary + later turns.
 *  4. Tool pairs before a compaction are fully folded (no orphan blocks).
 *  5. Round-trip via SessionManager: replay shrinks, raw event log is intact.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventsToMessages,
  messageToAssistantPayload,
} from "../../../packages/orchestrator/src/session-replay";
import { SessionManager } from "../../../packages/shared/src/session";
import type { SessionEvent } from "../../../packages/shared/src/session";

type Ev = { seq: number; event: SessionEvent };

function ev(seq: number, type: string, payload: Record<string, unknown>): Ev {
  return { seq, event: { type, payload } };
}

function firstText(content: { type: string; text?: string }[]): string {
  const b = content[0];
  return b && b.type === "text" ? (b.text ?? "") : "";
}

describe("eventsToMessages — compaction replay", () => {
  test("repairs a historical tool call left open by an aborted run", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "inspect x" }),
      ev(2, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "call_open", toolName: "read_file", toolInput: { path: "x" } }],
      }),
      ev(3, "system_note", { content: "agent loop terminated: Infinite loop detected" }),
      ev(4, "user_msg", { content: "resume" }),
    ];

    const messages = eventsToMessages(events);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_open",
      isError: true,
    });
  });

  test("omits an orphan result from the provider-visible replay", () => {
    const messages = eventsToMessages([
      ev(1, "user_msg", { content: "hello" }),
      ev(2, "tool_result", { callId: "missing", content: "orphan" }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  test("round-trips exact provider reasoning state in block order", () => {
    const payload = messageToAssistantPayload({
      role: "assistant",
      content: [
        {
          type: "redacted_thinking",
          provider: "codex",
          data: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "enc" }),
        },
        {
          type: "tool_use",
          toolCallId: "call_1",
          toolName: "read_file",
          toolInput: { path: "x" },
        },
      ],
    });
    const messages = eventsToMessages([
      ev(1, "assistant_msg", payload),
      ev(2, "tool_result", { callId: "call_1", content: "ok" }),
    ]);
    expect(messages[0]?.content.map((block) => block.type)).toEqual([
      "redacted_thinking",
      "tool_use",
    ]);
    expect(messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_1",
    });
  });

  test("drops legacy Codex tool protocol that has no persisted reasoning state", () => {
    const messages = eventsToMessages(
      [
        ev(1, "assistant_msg", {
          content: "checking",
          toolUses: [{ callId: "old", toolName: "read_file", toolInput: { path: "x" } }],
        }),
        ev(2, "tool_result", { callId: "old", content: "legacy output" }),
      ],
      { dropLegacyToolProtocol: true },
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([{ type: "text", text: "checking" }]);
  });

  test("a compaction event collapses all prior messages into one summary", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "hello" }),
      ev(2, "assistant_msg", { content: "hi there" }),
      ev(3, "user_msg", { content: "do a thing" }),
      ev(4, "assistant_msg", { content: "done" }),
      ev(5, "compaction", { summary: "User greeted; asked for a thing; it was done." }),
    ];

    const messages = eventsToMessages(events);

    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
    expect(firstText(messages[0]!.content)).toContain("[Conversation summary]");
    expect(firstText(messages[0]!.content)).toContain("User greeted");
  });

  test("turns after a compaction append after the summary", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "old 1" }),
      ev(2, "assistant_msg", { content: "old reply" }),
      ev(3, "compaction", { summary: "Earlier work." }),
      ev(4, "user_msg", { content: "new question" }),
      ev(5, "assistant_msg", { content: "new answer" }),
    ];

    const messages = eventsToMessages(events);

    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe("user"); // the summary
    expect(firstText(messages[0]!.content)).toContain("Earlier work.");
    expect(messages[1]!.role).toBe("user");
    expect(firstText(messages[1]!.content)).toBe("new question");
    expect(messages[2]!.role).toBe("assistant");
  });

  test("chained compactions keep only the most-recent summary + later turns", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "a" }),
      ev(2, "assistant_msg", { content: "b" }),
      ev(3, "compaction", { summary: "first summary" }),
      ev(4, "user_msg", { content: "c" }),
      ev(5, "compaction", { summary: "second summary" }),
      ev(6, "user_msg", { content: "d" }),
    ];

    const messages = eventsToMessages(events);

    expect(messages.length).toBe(2);
    expect(firstText(messages[0]!.content)).toContain("second summary");
    expect(firstText(messages[0]!.content)).not.toContain("first summary");
    expect(firstText(messages[1]!.content)).toBe("d");
  });

  test("tool pairs before a compaction are fully folded (no orphan blocks)", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "read a file" }),
      ev(2, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "c1", toolName: "read_file", toolInput: { path: "x" } }],
      }),
      ev(3, "tool_result", { callId: "c1", content: "file body" }),
      ev(4, "compaction", { summary: "Read file x." }),
      ev(5, "user_msg", { content: "next" }),
    ];

    const messages = eventsToMessages(events);

    const hasToolBlocks = messages.some((m) =>
      m.content.some((b) => b.type === "tool_use" || b.type === "tool_result"),
    );
    expect(hasToolBlocks).toBe(false);
    expect(messages.length).toBe(2);
    expect(firstText(messages[0]!.content)).toContain("Read file x.");
    expect(firstText(messages[1]!.content)).toBe("next");
  });

  test("missing summary text degrades gracefully to an empty summary marker", () => {
    const events: Ev[] = [
      ev(1, "user_msg", { content: "x" }),
      ev(2, "assistant_msg", { content: "y" }),
      ev(3, "compaction", {}),
    ];

    const messages = eventsToMessages(events);

    expect(messages.length).toBe(1);
    expect(firstText(messages[0]!.content)).toContain("[Conversation summary]");
  });
});

describe("compaction round-trip via SessionManager", () => {
  const dir = mkdtempSync(join(tmpdir(), "gear-compaction-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("persisted compaction event shrinks the replay but not the event log", () => {
    const sm = new SessionManager(join(dir, "gear.db"));
    const s = sm.createSession("/tmp/ws", "test-model");

    sm.appendEvent(s.id, { type: "user_msg", payload: { content: "q1" } });
    sm.appendEvent(s.id, { type: "assistant_msg", payload: { content: "a1" } });
    sm.appendEvent(s.id, { type: "user_msg", payload: { content: "q2" } });
    sm.appendEvent(s.id, { type: "assistant_msg", payload: { content: "a2" } });

    const before = eventsToMessages(sm.getEvents(s.id, 1));
    expect(before.length).toBe(4);

    // Mirror what Engine.compactSession() persists.
    sm.appendEvent(s.id, {
      type: "compaction",
      payload: {
        summary: "Q1 and Q2 were both answered.",
        replacedThroughSeq: 4,
        originalMessages: 4,
        trigger: "manual",
      },
    });

    const after = eventsToMessages(sm.getEvents(s.id, 1));
    expect(after.length).toBe(1);
    expect(firstText(after[0]!.content)).toContain("Q1 and Q2 were both answered.");

    // Append-only: the raw log keeps all 5 events for audit/replay.
    expect(sm.getEvents(s.id, 1).length).toBe(5);

    sm.close();
  });
});
