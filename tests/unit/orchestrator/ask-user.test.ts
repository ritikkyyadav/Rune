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
import type { ToolCallInput } from "@alan/tool-registry";

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
