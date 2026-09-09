import { describe, test, expect } from "bun:test";
import { createTodoWriteHandler } from "../../../packages/tool-registry/src/tools/todo-write";

const FAKE_INPUT = {
  toolName: "todo_write",
  callId: "test-call-1",
  sessionId: "session-1",
  workspaceRoot: "/tmp",
};

describe("createTodoWriteHandler", () => {
  const handler = createTodoWriteHandler();

  // --- schema ---
  test("has correct schema name and metadata", () => {
    expect(handler.schema.name).toBe("todo_write");
    expect(handler.schema.permissionLevel).toBe("auto");
    expect(handler.schema.category).toBe("read");
    expect(typeof handler.schema.description).toBe("string");
    expect(handler.schema.description.length).toBeGreaterThan(0);
  });

  // --- validate: valid inputs ---
  test("accepts a list with a single pending item", () => {
    const result = handler.validate({
      items: [{ content: "Do the thing", status: "pending" }],
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts items with all valid statuses", () => {
    const result = handler.validate({
      items: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "in_progress" },
        { content: "Step 3", status: "pending" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  // --- validate: invalid inputs ---
  test("rejects missing items", () => {
    const result = handler.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/items/);
  });

  test("rejects non-array items", () => {
    const result = handler.validate({ items: "not-an-array" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/items/);
  });

  test("rejects empty items array", () => {
    const result = handler.validate({ items: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/);
  });

  test("rejects item with missing content", () => {
    const result = handler.validate({
      items: [{ status: "pending" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/content/);
  });

  test("rejects item with empty content string", () => {
    const result = handler.validate({
      items: [{ content: "", status: "pending" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/content/);
  });

  test("accepts item with status synonym 'done' as completed", () => {
    const result = handler.validate({
      items: [{ content: "Do work", status: "done" }],
    });
    expect(result.valid).toBe(true);
  });

  test("accepts string shortcut items", () => {
    const result = handler.validate({ items: ["not-an-object"] });
    expect(result.valid).toBe(true);
  });

  // --- validate: coercions and edge cases ---
  test("coerces string with completed checkbox", () => {
    const result = handler.validate({ items: ["[x] Done thing"] });
    expect(result.valid).toBe(true);
  });

  test("coerces string with pending checkbox", () => {
    const result = handler.validate({ items: ["[ ] Pending thing"] });
    expect(result.valid).toBe(true);
  });

  test("coerces string with dash prefix", () => {
    const result = handler.validate({ items: ["- simple task"] });
    expect(result.valid).toBe(true);
  });

  test("adds missing status as pending", () => {
    const result = handler.validate({ items: [{ content: "no status" }] });
    expect(result.valid).toBe(true);
  });

  test("maps status synonyms to completed", () => {
    const result = handler.validate({ items: [{ content: "x", status: "done" }] });
    expect(result.valid).toBe(true);
  });

  test("maps status synonyms to in_progress", () => {
    const result = handler.validate({ items: [{ content: "x", status: "wip" }] });
    expect(result.valid).toBe(true);
  });

  test("maps status synonyms to pending", () => {
    const result = handler.validate({ items: [{ content: "x", status: "open" }] });
    expect(result.valid).toBe(true);
  });

  test("accepts content synonym title", () => {
    const result = handler.validate({ items: [{ title: "my title" }] });
    expect(result.valid).toBe(true);
  });

  test("maps kind synonym to inspect", () => {
    const result = handler.validate({ items: [{ content: "look", kind: "review" }] });
    expect(result.valid).toBe(true);
  });

  test("drops unknown kind without error", () => {
    const result = handler.validate({ items: [{ content: "task", kind: "unknown" }] });
    expect(result.valid).toBe(true);
  });

  // --- canonical kinds must survive validation ---
  test("preserves canonical kind 'inspect'", () => {
    const result = handler.validate({ items: [{ content: "c1", kind: "inspect" }] });
    expect(result.valid).toBe(true);
  });
  test("preserves canonical kind 'change' (case-insensitive)", () => {
    const result = handler.validate({ items: [{ content: "c2", kind: "Change" }] });
    expect(result.valid).toBe(true);
  });
  test("preserves canonical kind 'verify'", () => {
    const result = handler.validate({ items: [{ content: "c3", kind: "verify" }] });
    expect(result.valid).toBe(true);
  });

  test("rejects read-back shape with helpful message", () => {
    const result = handler.validate({
      items: [{ done_when: [], reading: "you" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/read-back shape/);
  });

  test("rejects non-object item like number", () => {
    const result = handler.validate({ items: [42] });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/number/);
  });

  // --- execute: result shape ---
  test("returns success with JSON result containing items", async () => {
    const items = [
      { content: "Write tests", status: "in_progress" as const },
      { content: "Ship it", status: "pending" as const },
    ];
    const output = await handler.execute({ ...FAKE_INPUT, args: { items } });

    expect(output.success).toBe(true);
    expect(output.callId).toBe("test-call-1");
    expect(output.toolName).toBe("todo_write");
    expect(typeof output.durationMs).toBe("number");

    const parsed = JSON.parse(output.result);
    expect(parsed).toEqual({ items });
  });

  test("result shape has exactly the items passed in", async () => {
    const items = [{ content: "Only task", status: "completed" as const }];
    const output = await handler.execute({ ...FAKE_INPUT, args: { items } });

    expect(output.success).toBe(true);
    const parsed = JSON.parse(output.result);
    expect(Object.keys(parsed)).toEqual(["items"]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].content).toBe("Only task");
    expect(parsed.items[0].status).toBe("completed");
  });

  test("execute normalises string shortcut to canonical shape", async () => {
    const raw = { items: ["[x] Done thing", "- simple"] } as any;
    const output = await handler.execute({ ...FAKE_INPUT, args: raw });
    const parsed = JSON.parse(output.result);
    expect(parsed.items).toEqual([
      { content: "Done thing", status: "completed" },
      { content: "simple", status: "pending" },
    ]);
  });
});
