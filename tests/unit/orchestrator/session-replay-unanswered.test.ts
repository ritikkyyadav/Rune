/**
 * T1 — what a resumed run is told about a tool call that never returned.
 *
 * A run killed inside a tool leaves the call on the log and no result. The
 * replay has to close the pair or a strict provider rejects the transcript —
 * and what it closes it WITH is what the model acts on. It said "Not executed …
 * Re-run it", which is false for a command killed mid-flight and is an
 * instruction to repeat it. A push, a publish, a migration or an append that
 * is repeated is not retried: it is done twice.
 */

import { describe, expect, test } from "bun:test";

import {
  eventsToMessages,
  unansweredCall,
} from "../../../packages/orchestrator/src/session-replay";
import type { SessionEvent } from "../../../packages/shared/src/index";

type Ev = { seq: number; event: SessionEvent };
const ev = (seq: number, type: string, payload: Record<string, unknown>): Ev => ({
  seq,
  event: { type, payload } as unknown as SessionEvent,
});

const CALL = (callId: string, toolName: string, toolInput: Record<string, unknown>) => ({
  content: "",
  toolUses: [{ callId, toolName, toolInput }],
});

describe("a call with no result on the log", () => {
  const killedInside = [
    ev(1, "user_msg", { content: "publish the package" }),
    ev(2, "assistant_msg", CALL("call_publish", "bash", { command: "npm publish" })),
    // The process died here. Nothing was written after the call.
  ];

  test("is closed, so the transcript can be replayed at all", () => {
    const messages = eventsToMessages(killedInside);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2]!.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "call_publish",
        toolResultContent: unansweredCall("bash"),
        isError: true,
      },
    ]);
  });

  test("is not said to have been skipped, and the model is not told to run it again", () => {
    const told = unansweredCall("bash");
    expect(told).not.toContain("Not executed");
    expect(told).not.toMatch(/re-?run it/i);
    // What is known, and what is not.
    expect(told).toContain("No result was recorded");
    expect(told).toContain("the previous Rune run ended before bash returned");
    expect(told).toContain("It may not have run, or it may have run in part or in full");
    // What to do about it.
    expect(told).toContain("check the state it would have changed");
    expect(told).toContain("repeat it only if that shows it did not happen");
  });

  test("a call whose tool has no name is still spoken of", () => {
    expect(unansweredCall("")).toContain("before this tool returned");
  });

  test("an ACKNOWLEDGED result is replayed as it was written, beside the one that is missing", () => {
    const messages = eventsToMessages([
      ev(1, "user_msg", { content: "edit, then publish" }),
      ev(2, "assistant_msg", {
        content: "",
        toolUses: [
          { callId: "call_edit", toolName: "edit_file", toolInput: { path: "a.ts" } },
          { callId: "call_publish", toolName: "bash", toolInput: { command: "npm publish" } },
        ],
      }),
      ev(3, "tool_result", { callId: "call_edit", content: "edited a.ts", isError: false }),
      // Killed inside the second call.
    ]);
    const results = messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    expect(results).toEqual([
      {
        type: "tool_result",
        toolCallId: "call_edit",
        toolResultContent: "edited a.ts",
        isError: false,
      },
      {
        type: "tool_result",
        toolCallId: "call_publish",
        toolResultContent: unansweredCall("bash"),
        isError: true,
      },
    ]);
  });

  test("a result that DID arrive is never replaced: only a missing one is spoken for", () => {
    const messages = eventsToMessages([
      ...killedInside,
      ev(3, "tool_result", { callId: "call_publish", content: "+ pkg@1.0.0", isError: false }),
      ev(4, "user_msg", { content: "thanks" }),
    ]);
    const results = messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    expect(results).toEqual([
      {
        type: "tool_result",
        toolCallId: "call_publish",
        toolResultContent: "+ pkg@1.0.0",
        isError: false,
      },
    ]);
  });
});
