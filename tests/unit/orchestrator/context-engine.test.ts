import { describe, test, expect, mock } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";

function createMockGateway() {
  return {
    infer: mock(async () => ({
      content: [{ type: "text" as const, text: "Summary of conversation." }],
      model: "test",
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

describe("ContextEngine", () => {
  test("buildPrompt returns valid BuiltPrompt", () => {
    const engine = new ContextEngine({}, createMockGateway());
    const result = engine.buildPrompt(
      "You are a helpful assistant.",
      [{ name: "read_file", description: "Read a file", inputSchema: {} }],
      [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      ],
    );
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.system).toContain("helpful assistant");
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.evictedCount).toBeGreaterThanOrEqual(0);
  });

  test("pinFile adds context that survives budget pass", () => {
    const engine = new ContextEngine({}, createMockGateway());
    engine.pinFile("/src/main.ts", "export function main() { console.log('hello'); }");

    const result = engine.buildPrompt("System", [], []);
    expect(result.system).toContain("System");
    // Pinned file should contribute to token count
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("addDiscovery deduplicates", () => {
    const engine = new ContextEngine({}, createMockGateway());
    engine.addDiscovery("Uses TypeScript", "read_file");
    engine.addDiscovery("Uses TypeScript", "read_file");
    expect(engine.getDiscoveries()).toHaveLength(1);
  });

  test("addDiscovery allows different facts", () => {
    const engine = new ContextEngine({}, createMockGateway());
    engine.addDiscovery("Uses TypeScript", "read_file");
    engine.addDiscovery("Uses React", "read_file");
    expect(engine.getDiscoveries()).toHaveLength(2);
  });

  test("getContextUsage starts at zero", () => {
    const engine = new ContextEngine({}, createMockGateway());
    const usage = engine.getContextUsage();
    expect(usage.used).toBe(0);
    expect(usage.percent).toBe(0);
  });

  test("getContextUsage updates after buildPrompt", () => {
    const engine = new ContextEngine(
      { budget: { maxTokens: 500, workingSetRatio: 0.5, sessionMemoryRatio: 0.25, retrievalRatio: 0.25 } },
      createMockGateway(),
    );
    engine.buildPrompt(
      "You are a very helpful and detailed assistant with extensive capabilities.",
      [],
      [
        { role: "user", content: [{ type: "text", text: "Hello world, please help me with this complex task" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure, I would be happy to help you with that task" }] },
      ],
    );
    const usage = engine.getContextUsage();
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.limit).toBe(500);
    // With a 500-token budget and real content, percent should be meaningful
    expect(usage.percent).toBeGreaterThan(0);
  });

  test("maybeSummarize skips when under threshold", async () => {
    const engine = new ContextEngine({ summarizeTurnsThreshold: 20 }, createMockGateway());
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] },
    ];
    const result = await engine.maybeSummarize(messages);
    expect(result).toBe(false);
  });

  test("maybeSummarize triggers when over threshold", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `Turn ${i}` }],
    }));
    const result = await engine.maybeSummarize(messages);
    expect(result).toBe(true);
    expect(gateway.infer).toHaveBeenCalled();
  });

  test("conversation messages are NEVER individually evicted (pair safety)", () => {
    // Dropping a single message can orphan a tool_use/tool_result pair, which
    // providers reject with a 400. Shrinking history is compactWorkingSet()'s
    // job. Even over a tiny budget, every message must survive buildPrompt.
    const engine = new ContextEngine(
      { budget: { maxTokens: 100, workingSetRatio: 0.5, sessionMemoryRatio: 0.25, retrievalRatio: 0.25 } },
      createMockGateway(),
    );
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `This is message number ${i} with some extra text to consume tokens` }],
    }));
    const result = engine.buildPrompt("System", [], messages);
    expect(result.messages.length).toBe(50);
    expect(result.evictedCount).toBe(0);
  });

  test("auxiliary context (pinned files) is evicted when over budget, not messages", () => {
    const engine = new ContextEngine(
      { budget: { maxTokens: 50, workingSetRatio: 0.5, sessionMemoryRatio: 0.25, retrievalRatio: 0.25 } },
      createMockGateway(),
    );
    engine.pinFile("/big.ts", "word ".repeat(500)); // far over the 50-token budget
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    ];
    const result = engine.buildPrompt("System", [], messages);
    expect(result.evictedCount).toBe(1); // the pinned file was dropped
    // The conversation message is still there (possibly alone).
    const texts = result.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text),
    );
    expect(texts.some((t) => t.includes("hello"))).toBe(true);
  });

  test("aux context that fits is delivered ahead of the conversation", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 100000 } }, createMockGateway());
    engine.pinFile("/src/main.ts", "export function main() {}");
    const result = engine.buildPrompt("System", [], [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(result.messages.length).toBe(2);
    const first = result.messages[0].content[0];
    expect(first.type).toBe("text");
    expect((first as { text: string }).text).toContain("[Pinned: /src/main.ts]");
  });

  test("system prompt is returned byte-identical (cache stability)", () => {
    const engine = new ContextEngine({}, createMockGateway());
    engine.addDiscovery("Uses TypeScript", "read_file");
    const system = "You are a helpful assistant.";
    const result = engine.buildPrompt(system, [], [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(result.system).toBe(system);
  });

  test("noteRealUsage overrides the heuristic with provider-reported counts", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 100000 } }, createMockGateway());
    engine.buildPrompt("System", [], [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(engine.shouldCompact()).toBe(false);

    // Provider reports 180k real input tokens on a 200k-context Claude model
    engine.noteRealUsage({ inputTokens: 150000, cacheReadTokens: 30000 }, "claude-sonnet-4-5");
    const usage = engine.getContextUsage();
    expect(usage.used).toBe(180000);
    expect(usage.limit).toBe(200000);
    expect(engine.shouldCompact()).toBe(true);
  });

  test("noteRealUsage ignores empty usage reports", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 100000 } }, createMockGateway());
    engine.buildPrompt("System", [], [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    const before = engine.getContextUsage();
    engine.noteRealUsage({ inputTokens: 0 }, "claude-sonnet-4-5");
    expect(engine.getContextUsage()).toEqual(before);
  });

  test("getMemory returns summaries and discoveries", () => {
    const engine = new ContextEngine({}, createMockGateway());
    engine.addDiscovery("Project uses Bun runtime", "read_file package.json");
    const memory = engine.getMemory();
    expect(memory.discoveries).toHaveLength(1);
    expect(memory.discoveries[0].fact).toBe("Project uses Bun runtime");
  });

  test("shouldCompact: false before buildPrompt, true once over the high-water mark", () => {
    const engine = new ContextEngine(
      { budget: { maxTokens: 100, workingSetRatio: 0.5, sessionMemoryRatio: 0.25, retrievalRatio: 0.25 } },
      createMockGateway(),
    );
    // No buildPrompt has run yet → unknown usage → must not compact.
    expect(engine.shouldCompact()).toBe(false);

    // Fill well past 70% of the tiny 100-token budget.
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `message ${i} with extra words to consume tokens` }],
    }));
    engine.buildPrompt("System prompt", [], messages);
    expect(engine.shouldCompact()).toBe(true);
  });

  test("shouldCompact stays false when usage is well under budget", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 100000 } }, createMockGateway());
    engine.buildPrompt("Short system", [], [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(engine.shouldCompact()).toBe(false);
  });
});
