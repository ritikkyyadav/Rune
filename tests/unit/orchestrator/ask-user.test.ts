/**
 * ask_user tool: blocking clarification questions.
 *  - delegates to the wired QuestionHandler and returns the answer
 *  - degrades to an instructive error when no handler is wired (headless)
 *  - validates question + 2-6 options
 *  - handler is read at EXECUTE time (late wiring by the CLI/TUI works)
 */

import { describe, test, expect } from "bun:test";
import { createAskUserTool, ASK_USER_SCHEMA } from "../../../packages/orchestrator/src/ask-user";
import type { QuestionHandler } from "../../../packages/orchestrator/src/ask-user";
import type { ToolCallInput } from "@gear/tool-registry";

function makeInput(args: Record<string, unknown>): ToolCallInput {
  return { toolName: "ask_user", callId: "c1", args, sessionId: "s1", workspaceRoot: "/tmp" };
}

describe("ask_user", () => {
  test("returns the handler's answer", async () => {
    const tool = createAskUserTool(() => async (q) => `picked: ${q.options[1]}`);
    const out = await tool.execute(
      makeInput({ question: "Which DB?", options: ["postgres", "sqlite"] }),
    );
    expect(out.success).toBe(true);
    expect(out.result).toBe("picked: sqlite");
  });

  test("a batched round tells each question where it sits", async () => {
    // The picker renders these as `2 of 4`. Without them a round of four
    // arrives as four unrelated interruptions: after the first, the person
    // answering cannot tell whether they are nearly done or have just started.
    const seen: Array<{ q: string; index?: number; total?: number }> = [];
    const tool = createAskUserTool(() => async (q) => {
      seen.push({ q: q.question, index: q.index, total: q.total });
      return q.options[0]!;
    });
    const out = await tool.execute(
      makeInput({
        questions: [
          { question: "Platform?", options: ["web", "native"] },
          { question: "Depth?", options: ["working core", "prototype"] },
          { question: "Data?", options: ["live", "fixtures"] },
        ],
      }),
    );
    expect(out.success).toBe(true);
    expect(seen).toEqual([
      { q: "Platform?", index: 0, total: 3 },
      { q: "Depth?", index: 1, total: 3 },
      { q: "Data?", index: 2, total: 3 },
    ]);
  });

  test("a single question carries no round position, so nothing renders `1 of 1`", async () => {
    let seen: { index?: number; total?: number } = { index: -1, total: -1 };
    const tool = createAskUserTool(() => async (q) => {
      seen = { index: q.index, total: q.total };
      return q.options[0]!;
    });
    await tool.execute(makeInput({ question: "Which DB?", options: ["postgres", "sqlite"] }));
    expect(seen).toEqual({ index: 0, total: 1 });
  });

  test("headless (no handler) → instructive error, not a hang", async () => {
    const tool = createAskUserTool(() => undefined);
    const out = await tool.execute(
      makeInput({ question: "Which DB?", options: ["postgres", "sqlite"] }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toContain("best");
  });

  test("handler is read at execute time (late wiring)", async () => {
    let handler: QuestionHandler | undefined;
    const tool = createAskUserTool(() => handler);
    handler = async () => "late answer";
    const out = await tool.execute(makeInput({ question: "Q?", options: ["a", "b"] }));
    expect(out.success).toBe(true);
    expect(out.result).toBe("late answer");
  });

  test("validation: question and 2-6 options required", () => {
    const tool = createAskUserTool(() => undefined);
    expect(tool.validate({ question: "", options: ["a", "b"] }).valid).toBe(false);
    expect(tool.validate({ question: "q", options: ["only-one"] }).valid).toBe(false);
    expect(
      tool.validate({ question: "q", options: ["a", "b", "c", "d", "e", "f", "g"] }).valid,
    ).toBe(false);
    expect(tool.validate({ question: "q", options: ["a", "b"] }).valid).toBe(true);
  });

  test("schema keeps ask_user out of the parallel-safe read pool", () => {
    expect(ASK_USER_SCHEMA.category).toBe("execute");
    expect(ASK_USER_SCHEMA.permissionLevel).toBe("auto");
  });

  test("handler failure surfaces as a tool error", async () => {
    const tool = createAskUserTool(() => async () => {
      throw new Error("UI torn down");
    });
    const out = await tool.execute(makeInput({ question: "Q?", options: ["a", "b"] }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("UI torn down");
  });
});
