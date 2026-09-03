import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";
import {
  planResearch,
  runResearch,
  createResearchRegistry,
  createResearchPermissionCheck,
  captureSources,
  normalizeUrl,
  collectWarnings,
  extractJson,
  parseFollowUps,
  selectSynthesisSources,
  parseOutline,
  synthesizeReport,
  resolveSettings,
  analyze,
} from "../../../packages/orchestrator/src/research";
import type {
  ResearchEvent,
  ResearchPlan,
} from "../../../packages/orchestrator/src/research-types";
import { isClarification } from "../../../packages/orchestrator/src/research-types";
import type {
  ResearchSource,
  SubQuestionResult,
} from "../../../packages/orchestrator/src/research-types";

type Cat = "read" | "write" | "execute" | "network";

function makeTool(name: string, category: Cat): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      permissionLevel: category === "read" ? "auto" : "confirm",
      category,
    },
    validate: () => ({ valid: true }),
    execute: async (i) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: "ok",
      durationMs: 0,
    }),
  };
}

/** Fake provider that streams a fixed text body (the planner JSON). */
class JsonProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly body: string) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    yield {
      type: "content_delta",
      contentIndex: 0,
      delta: { type: "text_delta", text: this.body },
    };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function planDeps(body: string) {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 0,
    retryBaseMs: 1,
  });
  gw.registerProvider(new JsonProvider(body));
  return { gateway: gw, model: "test-model", provider: "anthropic" as const };
}

// ─── extractJson ───

describe("extractJson", () => {
  test("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  test("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  test("parses JSON embedded in prose", () => {
    expect(extractJson('Sure, here it is: {"a":3} — done')).toEqual({ a: 3 });
  });
  test("is string-aware (braces inside strings don't break it)", () => {
    expect(extractJson('{"s":"has a } brace"}')).toEqual({ s: "has a } brace" });
  });
  test("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

// ─── planResearch ───

describe("planResearch", () => {
  test("builds a plan from clean JSON", async () => {
    const body = JSON.stringify({
      clarification: "Research X",
      outputFormat: "report",
      subQuestions: [
        { question: "q1", rationale: "r1", sourceScope: "web" },
        { question: "q2", rationale: "r2", sourceScope: "local" },
      ],
    });
    const r = await planResearch(planDeps(body), "Research X");
    expect(isClarification(r)).toBe(false);
    if (!isClarification(r)) {
      expect(r.subQuestions.length).toBe(2);
      expect(r.subQuestions[0].index).toBe(0);
      expect(r.subQuestions[1].sourceScope).toBe("local");
      expect(r.clarification).toBe("Research X");
      expect(r.question).toBe("Research X");
    }
  });

  test("returns a clarification when the model asks", async () => {
    const body = JSON.stringify({ needsClarification: true, questions: ["Who?", "When?"] });
    const r = await planResearch(planDeps(body), "vague request");
    expect(isClarification(r)).toBe(true);
    if (isClarification(r)) expect(r.questions.length).toBe(2);
  });

  test("clamps sub-questions to maxSubQuestions", async () => {
    const subQuestions = Array.from({ length: 6 }, (_, i) => ({
      question: `q${i}`,
      rationale: "",
      sourceScope: "web",
    }));
    const r = await planResearch(planDeps(JSON.stringify({ subQuestions })), "q", {
      maxSubQuestions: 2,
    });
    expect(isClarification(r)).toBe(false);
    if (!isClarification(r)) expect(r.subQuestions.length).toBe(2);
  });

  test("falls back to a single web sub-question on unparseable output", async () => {
    const r = await planResearch(planDeps("I cannot help with that"), "some topic");
    expect(isClarification(r)).toBe(false);
    if (!isClarification(r)) {
      expect(r.subQuestions.length).toBe(1);
      expect(r.subQuestions[0].sourceScope).toBe("web");
    }
  });

  test("revise (feedback) never returns a clarification", async () => {
    const body = JSON.stringify({ needsClarification: true, questions: ["x"] });
    const prior = {
      id: "p",
      question: "q",
      subQuestions: [{ index: 0, question: "q", rationale: "", sourceScope: "web" as const }],
      createdAt: "",
    };
    const r = await planResearch(planDeps(body), "q", {
      feedback: "focus on the EU",
      priorPlan: prior,
    });
    expect(isClarification(r)).toBe(false);
  });
});

// ─── permission gate ───

describe("createResearchPermissionCheck", () => {
  const reg = new ToolRegistry();
  reg.register(makeTool("read_file", "read"));
  reg.register(makeTool("write_file", "write"));
  reg.register(makeTool("bash", "execute"));
  reg.register(makeTool("web_search", "network"));
  reg.register(makeTool("web_fetch", "network"));
  reg.register(makeTool("n8n_trigger", "network"));
  const gate = createResearchPermissionCheck(reg);

  test("allows read tools", async () => {
    expect((await gate({ callId: "c", toolName: "read_file", args: {} })).allowed).toBe(true);
  });
  test("allows the two web tools by name", async () => {
    expect((await gate({ callId: "c", toolName: "web_search", args: {} })).allowed).toBe(true);
    expect((await gate({ callId: "c", toolName: "web_fetch", args: {} })).allowed).toBe(true);
  });
  test("denies write and execute tools", async () => {
    expect((await gate({ callId: "c", toolName: "write_file", args: {} })).allowed).toBe(false);
    expect((await gate({ callId: "c", toolName: "bash", args: {} })).allowed).toBe(false);
  });
  test("denies other network tools (network alone is not enough)", async () => {
    expect((await gate({ callId: "c", toolName: "n8n_trigger", args: {} })).allowed).toBe(false);
  });
  test("denies unknown tools", async () => {
    expect((await gate({ callId: "c", toolName: "nope", args: {} })).allowed).toBe(false);
  });
});

// ─── curated registry by scope ───

describe("createResearchRegistry", () => {
  test("web scope exposes only the web tools", () => {
    const r = createResearchRegistry("gear-tools", "web");
    expect(r.get("web_search")).toBeDefined();
    expect(r.get("web_fetch")).toBeDefined();
    expect(r.get("read_file")).toBeUndefined();
    expect(r.get("write_file")).toBeUndefined();
    expect(r.get("bash")).toBeUndefined();
  });
  test("local scope exposes read tools but no web tools", () => {
    const r = createResearchRegistry("gear-tools", "local");
    expect(r.get("read_file")).toBeDefined();
    expect(r.get("grep")).toBeDefined();
    expect(r.get("web_search")).toBeUndefined();
    expect(r.get("write_file")).toBeUndefined();
  });
  test("both scope exposes read + web, never mutating tools", () => {
    const r = createResearchRegistry("gear-tools", "both");
    expect(r.get("read_file")).toBeDefined();
    expect(r.get("web_search")).toBeDefined();
    expect(r.get("edit_file")).toBeUndefined();
    expect(r.get("bash")).toBeUndefined();
    expect(r.get("n8n_trigger")).toBeUndefined();
  });
});

// ─── source capture & dedup ───

describe("captureSources", () => {
  test("captures web_search results with sequential 1-based indices", () => {
    const map = new Map<string, ResearchSource>();
    const added = captureSources(
      "web_search",
      JSON.stringify({
        results: [
          { title: "A", url: "https://a.com", snippet: "sa" },
          { title: "B", url: "https://b.com", snippet: "sb" },
        ],
      }),
      0,
      map,
      10,
    );
    expect(added.length).toBe(2);
    expect(added[0].index).toBe(1);
    expect(added[1].index).toBe(2);
    expect(map.size).toBe(2);
  });

  test("dedupes by normalized URL across calls", () => {
    const map = new Map<string, ResearchSource>();
    captureSources(
      "web_search",
      JSON.stringify({ results: [{ title: "A", url: "https://a.com/" }] }),
      0,
      map,
      10,
    );
    const again = captureSources(
      "web_search",
      JSON.stringify({ results: [{ title: "A2", url: "https://A.com/?utm_source=x#frag" }] }),
      1,
      map,
      10,
    );
    expect(again.length).toBe(0);
    expect(map.size).toBe(1);
  });

  test("web_fetch upgrades an existing search result in place", () => {
    const map = new Map<string, ResearchSource>();
    captureSources(
      "web_search",
      JSON.stringify({ results: [{ title: "A", url: "https://a.com", snippet: "s" }] }),
      0,
      map,
      10,
    );
    const up = captureSources(
      "web_fetch",
      JSON.stringify({ url: "https://a.com", title: "A full", markdown: "BODY" }),
      1,
      map,
      10,
    );
    expect(up.length).toBe(0);
    const src = [...map.values()][0]!;
    expect(src.fetched).toBe(true);
    expect(src.text).toBe("BODY");
  });

  test("respects the global source cap", () => {
    const map = new Map<string, ResearchSource>();
    const added = captureSources(
      "web_search",
      JSON.stringify({
        results: [{ url: "https://a.com" }, { url: "https://b.com" }, { url: "https://c.com" }],
      }),
      0,
      map,
      1,
    );
    expect(added.length).toBe(1);
    expect(map.size).toBe(1);
  });

  test("ignores non-JSON tool output", () => {
    const map = new Map<string, ResearchSource>();
    expect(captureSources("web_search", "not json", 0, map, 10).length).toBe(0);
  });
});

describe("normalizeUrl", () => {
  test("lowercases host+path and strips a trailing slash", () => {
    expect(normalizeUrl("https://Example.com/Path/")).toBe("https://example.com/path");
  });
  test("drops tracking params and fragments but keeps real query", () => {
    const n = normalizeUrl("https://a.com/?utm_source=x&q=1#frag");
    expect(n).toContain("q=1");
    expect(n).not.toContain("utm");
    expect(n).not.toContain("frag");
  });
});

// ─── runResearch orchestration (fan-out + queue, no network) ───

describe("runResearch", () => {
  // Investigators here never call tools (the provider only streams text), so no
  // network: this exercises the fan-out, the AsyncEventQueue drain, and the
  // zero-source guard end-to-end.
  function deps(body: string) {
    const gw = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    gw.registerProvider(new JsonProvider(body));
    return {
      gateway: gw,
      binaryPath: "gear-tools",
      model: "m",
      provider: "anthropic" as const,
      workspaceRoot: "/tmp",
      sessionId: "s",
    };
  }

  const plan: ResearchPlan = {
    id: "p",
    question: "q",
    subQuestions: [
      { index: 0, question: "a", rationale: "", sourceScope: "web" },
      { index: 1, question: "b", rationale: "", sourceScope: "web" },
    ],
    createdAt: "",
  };

  test("fans out every sub-question and streams plan + step events", async () => {
    const types: string[] = [];
    for await (const ev of runResearch(deps("general info, nothing to cite"), plan, {
      maxParallel: 2,
    })) {
      types.push(ev.type);
    }
    expect(types[0]).toBe("research_plan");
    expect(types.filter((t) => t === "research_step_start").length).toBe(2);
    expect(types.filter((t) => t === "research_step_done").length).toBe(2);
  });

  test("ends with an error (no synthesis) when no sources are found", async () => {
    const events: ResearchEvent[] = [];
    for await (const ev of runResearch(deps("no sources here"), plan, { maxParallel: 2 })) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).not.toContain("research_synthesizing");
    expect(types).not.toContain("research_complete");
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") expect(err.error).toMatch(/no sources/i);
  });

  test("aborts cleanly before fan-out when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const types: string[] = [];
    for await (const ev of runResearch(deps("x"), plan, {}, ac.signal)) types.push(ev.type);
    // plan is emitted, then it bails with an error; no steps run.
    expect(types).toContain("research_plan");
    expect(types).toContain("error");
    expect(types).not.toContain("research_step_start");
  });
});

// ─── citation validation ───

describe("collectWarnings", () => {
  const srcs = (n: number): ResearchSource[] =>
    Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      title: `t${i}`,
      url: `https://x/${i}`,
      fetched: false,
      fromSubQuestion: 0,
    }));
  const okSubs = (n: number): SubQuestionResult[] =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      question: "q",
      status: "ok" as const,
      findings: "f",
      sourceCount: 1,
    }));

  test("no warnings for valid in-range citations", () => {
    expect(collectWarnings("Claim [1] and also [2].", srcs(2), okSubs(2))).toEqual([]);
  });
  test("warns on out-of-range citations", () => {
    const w = collectWarnings("Claim [5].", srcs(2), okSubs(1));
    expect(w.some((x) => /out of range/i.test(x))).toBe(true);
  });
  test("warns when there are no citations", () => {
    const w = collectWarnings("No citations at all.", srcs(2), okSubs(1));
    expect(w.some((x) => /no inline citations/i.test(x))).toBe(true);
  });
  test("warns about failed sub-questions", () => {
    const subs: SubQuestionResult[] = [
      { index: 0, question: "q", status: "failed", findings: "", sourceCount: 0, error: "x" },
    ];
    const w = collectWarnings("Claim [1].", srcs(1), subs);
    expect(w.some((x) => /failed/i.test(x))).toBe(true);
  });
});

// ─── reflection / iterative deepening ───

describe("parseFollowUps", () => {
  test("returns [] when the supervisor says coverage is sufficient", () => {
    const asked = new Set<string>();
    expect(
      parseFollowUps({ sufficient: true, followUps: [{ question: "x" }] }, 5, 3, asked),
    ).toEqual([]);
  });

  test("assigns continuing indices starting from startIndex", () => {
    const asked = new Set<string>(["a"]);
    const out = parseFollowUps(
      {
        sufficient: false,
        followUps: [{ question: "B", sourceScope: "local" }, { question: "C" }],
      },
      5,
      3,
      asked,
    );
    expect(out.map((q) => q.index)).toEqual([5, 6]);
    expect(out[0].sourceScope).toBe("local");
    expect(out[1].sourceScope).toBe("web"); // default
  });

  test("dedupes against already-asked questions (case-insensitive) and records new ones", () => {
    const asked = new Set<string>(["already asked"]);
    const out = parseFollowUps(
      { followUps: [{ question: "Already Asked" }, { question: "fresh one" }] },
      2,
      3,
      asked,
    );
    expect(out.map((q) => q.question)).toEqual(["fresh one"]);
    expect(asked.has("fresh one")).toBe(true);
  });

  test("caps to maxFollowUps and returns [] when budget is 0", () => {
    const asked = new Set<string>();
    const many = {
      followUps: [{ question: "a" }, { question: "b" }, { question: "c" }, { question: "d" }],
    };
    expect(parseFollowUps(many, 0, 2, asked).length).toBe(2);
    expect(parseFollowUps(many, 0, 0, new Set()).length).toBe(0);
  });

  test("is defensive: junk input yields no follow-ups", () => {
    expect(parseFollowUps(null, 0, 3, new Set())).toEqual([]);
    expect(parseFollowUps({ followUps: "nope" }, 0, 3, new Set())).toEqual([]);
    expect(parseFollowUps({ followUps: [{ rationale: "no question" }] }, 0, 3, new Set())).toEqual(
      [],
    );
  });
});

describe("selectSynthesisSources", () => {
  const src = (index: number, over: Partial<ResearchSource> = {}): ResearchSource => ({
    index,
    title: `t${index}`,
    url: `https://x/${index}`,
    fetched: false,
    fromSubQuestion: 0,
    ...over,
  });

  test("preserves citation order and shows each source's real [index]", () => {
    const blocks = selectSynthesisSources(
      [src(1, { snippet: "s1" }), src(2, { snippet: "s2" })],
      1000,
      100000,
    );
    expect(blocks[0].startsWith("[1] ")).toBe(true);
    expect(blocks[1].startsWith("[2] ")).toBe(true);
  });

  test("truncates each body to charsPerSource", () => {
    const blocks = selectSynthesisSources(
      [src(1, { fetched: true, text: "x".repeat(50) })],
      10,
      100000,
    );
    expect(blocks[0]).toContain("x".repeat(10));
    expect(blocks[0]).not.toContain("x".repeat(11));
  });

  test("budgets full-text (fetched) sources first when the total cap is tight", () => {
    // Snippet-only [1] would normally come first, but with a 10-char total budget
    // the fetched [2] gets the body; [1] is reduced to its header line.
    const blocks = selectSynthesisSources(
      [src(1, { snippet: "AAAAA" }), src(2, { fetched: true, text: "BBBBBBBBBB" })],
      10,
      10,
    );
    const byIndex = Object.fromEntries(blocks.map((b) => [b.slice(1, b.indexOf("]")), b]));
    expect(byIndex["2"]).toContain("BBBBBBBBBB"); // full-text source kept its body
    expect(byIndex["1"].includes("\n")).toBe(false); // snippet-only dropped to header
  });
});

describe("parseOutline", () => {
  test("keeps title+focus, dedupes by title, caps to maxSections", () => {
    const out = parseOutline(
      {
        sections: [
          { title: "Executive Summary", focus: "the gist" },
          { title: "Background", focus: "history" },
          { title: "background", focus: "dupe" }, // case-insensitive dupe → dropped
          { title: "Conclusion" },
        ],
      },
      2,
    );
    expect(out.map((s) => s.title)).toEqual(["Executive Summary", "Background"]);
    expect(out[0].focus).toBe("the gist");
    expect(out[1].focus).toBe("history");
  });

  test("skips entries without a title and defaults focus to empty string", () => {
    const out = parseOutline({ sections: [{ focus: "no title" }, { title: "Real" }] }, 10);
    expect(out).toEqual([{ title: "Real", focus: "" }]);
  });

  test("is defensive: junk yields []", () => {
    expect(parseOutline(null, 5)).toEqual([]);
    expect(parseOutline({ sections: "nope" }, 5)).toEqual([]);
    expect(parseOutline({}, 5)).toEqual([]);
  });
});

// ─── long-form synthesis (outline → write each section) ───

describe("synthesizeReport", () => {
  // A provider that returns a different scripted body on each successive call
  // (outline, then one body per section) so we can drive the whole long-form path.
  class ScriptedProvider implements LlmProvider {
    readonly name = "anthropic" as const;
    private i = 0;
    constructor(private readonly bodies: string[]) {}
    async infer(): Promise<InferenceResponse> {
      throw new Error("not used");
    }
    async *inferStream(): AsyncGenerator<StreamEvent> {
      const body = this.bodies[this.i++] ?? "";
      yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: body } };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    async countTokens(): Promise<number> {
      return 1;
    }
    async healthCheck(): Promise<boolean> {
      return true;
    }
  }

  function gw(bodies: string[]) {
    const g = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    g.registerProvider(new ScriptedProvider(bodies));
    return g;
  }

  const plan: ResearchPlan = {
    id: "p",
    question: "How does X work?",
    subQuestions: [{ index: 0, question: "a", rationale: "", sourceScope: "web" }],
    createdAt: "",
  };
  const subResults: SubQuestionResult[] = [
    { index: 0, question: "a", status: "ok", findings: "finding a", sourceCount: 1 },
  ];
  const sources: ResearchSource[] = [
    {
      index: 1,
      title: "S1",
      url: "https://s1",
      fetched: true,
      text: "body one",
      fromSubQuestion: 0,
    },
    {
      index: 2,
      title: "S2",
      url: "https://s2",
      fetched: false,
      snippet: "snip two",
      fromSubQuestion: 0,
    },
  ];

  async function collect(gen: AsyncGenerator<ResearchEvent>) {
    const events: ResearchEvent[] = [];
    for await (const ev of gen) events.push(ev);
    const report = events
      .filter(
        (e): e is Extract<ResearchEvent, { type: "research_report_delta" }> =>
          e.type === "research_report_delta",
      )
      .map((e) => e.text)
      .join("");
    return { events, report };
  }

  test("long-form: outlines, then writes each section with its heading + a progress notice", async () => {
    const outline = JSON.stringify({
      sections: [
        { title: "Executive Summary", focus: "gist" },
        { title: "Background", focus: "history" },
        { title: "Conclusion", focus: "wrap" },
      ],
    });
    const bodies = [
      outline,
      "Summary body [1].",
      "Background body [2].",
      "Conclusion body [1][2].",
    ];
    const s = resolveSettings({ depth: "standard" }); // maxSections 7 → outline's 3 used
    const { events, report } = await collect(
      synthesizeReport({ gateway: gw(bodies) }, plan, subResults, sources, s, "m", "anthropic"),
    );

    // Headings are emitted by us (guaranteed structure), bodies by the model.
    expect(report).toContain("## Executive Summary");
    expect(report).toContain("## Background");
    expect(report).toContain("## Conclusion");
    expect(report).toContain("Summary body [1].");
    expect(report).toContain("Conclusion body [1][2].");

    // One progress notice per section, naming each.
    const notices = events
      .filter((e) => e.type === "notice")
      .map((e) => (e as { message: string }).message);
    expect(notices.filter((m) => /Writing section \d+\/3/.test(m)).length).toBe(3);
    // No fatal error.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("quick (maxSections=1): a single call, no per-section headings/notices", async () => {
    const s = resolveSettings({ depth: "quick" });
    const { events, report } = await collect(
      synthesizeReport(
        { gateway: gw(["The whole report in one go [1]."]) },
        plan,
        subResults,
        sources,
        s,
        "m",
        "anthropic",
      ),
    );
    expect(report).toBe("The whole report in one go [1].");
    expect(
      events.some(
        (e) => e.type === "notice" && /Writing section/.test((e as { message: string }).message),
      ),
    ).toBe(false);
  });

  test("a failed section is downgraded to a notice; the rest of the report still builds", async () => {
    const outline = JSON.stringify({
      sections: [
        { title: "Alpha", focus: "a" },
        { title: "Beta", focus: "b" },
      ],
    });
    // Outline ok, Alpha ok, Beta errors (empty body still streams fine here, so
    // force an error by exhausting into a provider error via a throwing body).
    const throwingProvider = new (class implements LlmProvider {
      readonly name = "anthropic" as const;
      private i = 0;
      async infer(): Promise<InferenceResponse> {
        throw new Error("not used");
      }
      async *inferStream(): AsyncGenerator<StreamEvent> {
        const call = this.i++;
        if (call === 0) {
          yield {
            type: "content_delta",
            contentIndex: 0,
            delta: { type: "text_delta", text: outline },
          };
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else if (call === 1) {
          yield {
            type: "content_delta",
            contentIndex: 0,
            delta: { type: "text_delta", text: "Alpha body [1]." },
          };
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: "error", error: "model exploded" };
        }
      }
      async countTokens(): Promise<number> {
        return 1;
      }
      async healthCheck(): Promise<boolean> {
        return true;
      }
    })();
    const g = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    g.registerProvider(throwingProvider);
    const s = resolveSettings({ depth: "standard" });
    const { events, report } = await collect(
      synthesizeReport({ gateway: g }, plan, subResults, sources, s, "m", "anthropic"),
    );

    expect(report).toContain("## Alpha");
    expect(report).toContain("Alpha body [1].");
    expect(report).toContain("## Beta"); // heading still emitted
    // The Beta failure is a notice, not a fatal error event.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "notice" && /could not be completed/.test((e as { message: string }).message),
      ),
    ).toBe(true);
  });
});

// ─── the analyst stage ───

describe("analyze (the analyst stage)", () => {
  /** Streams one scripted body and captures every request it served. */
  class CapturingProvider implements LlmProvider {
    readonly name = "anthropic" as const;
    requests: InferenceRequest[] = [];
    constructor(private readonly body: string) {}
    async infer(): Promise<InferenceResponse> {
      throw new Error("not used");
    }
    async *inferStream(req: InferenceRequest): AsyncGenerator<StreamEvent> {
      this.requests.push(req);
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: this.body },
      };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    async countTokens(): Promise<number> {
      return 1;
    }
    async healthCheck(): Promise<boolean> {
      return true;
    }
  }

  function capturingGw(body: string) {
    const g = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    const p = new CapturingProvider(body);
    g.registerProvider(p);
    return { g, p };
  }

  const plan: ResearchPlan = {
    id: "p",
    question: "Is the widget market about to consolidate?",
    subQuestions: [{ index: 0, question: "a", rationale: "", sourceScope: "web" }],
    createdAt: "",
  };
  const subResults = [
    { index: 0, question: "a", status: "ok" as const, findings: "finding a", sourceCount: 1 },
  ];

  test("produces the notes and demands judgment, not coverage", async () => {
    const notes =
      "1. THESIS — consolidation within 18 months. 2. THE DISCONFIRMING CASE — margins say otherwise. " +
      "3. IMPLICATIONS — pricing power shifts. 4. SIGNALS TO WATCH — the next two earnings. 5. CONFIDENCE AND GAPS — thin on private players.";
    const { g, p } = capturingGw(notes);
    const out = await analyze({ gateway: g }, plan, subResults, "m", "anthropic");
    expect(out).toBe(notes);
    const sys = String(p.requests[0].system ?? "");
    expect(sys).toContain("THE DISCONFIRMING CASE");
    expect(sys).toContain("SIGNALS TO WATCH");
    const user = JSON.stringify(p.requests[0].messages);
    expect(user).toContain("Is the widget market about to consolidate?");
    expect(user).toContain("finding a");
  });

  test("a trivially short answer degrades to null instead of shipping filler", async () => {
    const { g } = capturingGw("ok.");
    expect(await analyze({ gateway: g }, plan, subResults, "m", "anthropic")).toBeNull();
  });

  test("a failing call degrades to null — the report ships without its analysis layer", async () => {
    const g = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    expect(await analyze({ gateway: g }, plan, subResults, "m", "anthropic")).toBeNull();
  });

  test("quick synthesis threads ANALYST NOTES into the prompt; null omits the block", async () => {
    const s = resolveSettings({ depth: "quick" });
    const sources = [
      { index: 1, title: "S1", url: "https://s1", fetched: true, text: "b", fromSubQuestion: 0 },
    ];
    const withNotes = capturingGw("report body");
    for await (const _ of synthesizeReport(
      { gateway: withNotes.g },
      plan,
      subResults,
      sources,
      s,
      "m",
      "anthropic",
      "THESIS: consolidation is coming.",
    )) {
      // drain
    }
    const prompt = JSON.stringify(withNotes.p.requests[0].messages);
    expect(prompt).toContain("ANALYST NOTES");
    expect(prompt).toContain("consolidation is coming");

    const without = capturingGw("report body");
    for await (const _ of synthesizeReport(
      { gateway: without.g },
      plan,
      subResults,
      sources,
      s,
      "m",
      "anthropic",
      null,
    )) {
      // drain
    }
    expect(JSON.stringify(without.p.requests[0].messages)).not.toContain("ANALYST NOTES");
  });

  test("the planner is told to include an adversarial sub-question", async () => {
    const { g, p } = capturingGw('{"clarification":"c","subQuestions":[{"question":"q1"}]}');
    await planResearch({ gateway: g, model: "m", provider: "anthropic" }, "should we enter?");
    expect(String(p.requests[0].system ?? "")).toContain("adversarial");
  });
});

// ─── P10.9 — research runs on the workflow executor ───

/**
 * A provider that fails for one named sub-question and answers for the rest.
 *
 * The point of running the round on the executor is its per-node isolation, and
 * the only way to prove isolation is to break one node.
 */
class PartlyFailingProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(
    private readonly failOn: string,
    private readonly body: string,
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(req: InferenceRequest): AsyncGenerator<StreamEvent> {
    const asked = JSON.stringify(req.messages ?? []);
    if (asked.includes(this.failOn)) throw new Error("provider refused this investigator");
    yield {
      type: "content_delta",
      contentIndex: 0,
      delta: { type: "text_delta", text: this.body },
    };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe("P10.9 — the research fan-out is the executor's", () => {
  const plan: ResearchPlan = {
    id: "p",
    question: "q",
    subQuestions: [
      { index: 0, question: "the one that breaks", rationale: "", sourceScope: "web" },
      { index: 1, question: "the one that answers", rationale: "", sourceScope: "web" },
    ],
    createdAt: "",
  };

  function deps(provider: LlmProvider) {
    const gw = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    gw.registerProvider(provider);
    return {
      gateway: gw,
      binaryPath: "gear-tools",
      model: "m",
      provider: "anthropic" as const,
      workspaceRoot: "/tmp",
      sessionId: "s",
    };
  }

  test("one dead investigator does not stop the round", async () => {
    // Per-node isolation is what the executor is for, and it is what a
    // hand-rolled fan-out has to remember to do. One sub-question that cannot
    // be answered must cost exactly that sub-question.
    const events: ResearchEvent[] = [];
    for await (const ev of runResearch(
      deps(new PartlyFailingProvider("the one that breaks", "nothing to cite")),
      plan,
      { maxParallel: 2 },
    )) {
      events.push(ev);
    }
    const done = events.filter((e) => e.type === "research_step_done");
    expect(done).toHaveLength(2);
    const statuses = done.map((e) => (e as { status: string }).status).sort();
    // The other investigator finished; `empty` is its honest outcome here,
    // since this provider streams prose and cites nothing.
    expect(statuses).toEqual(["empty", "failed"]);
    // Both steps were announced before either finished — the round is a wave,
    // not a queue of one.
    expect(events.filter((e) => e.type === "research_step_start")).toHaveLength(2);
  });

  test("the executor's concurrency ceiling is the round's", async () => {
    let live = 0;
    let peak = 0;
    class CountingProvider implements LlmProvider {
      readonly name = "anthropic" as const;
      async infer(): Promise<InferenceResponse> {
        throw new Error("not used");
      }
      async *inferStream(): AsyncGenerator<StreamEvent> {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        yield {
          type: "content_delta",
          contentIndex: 0,
          delta: { type: "text_delta", text: "nothing to cite" },
        };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
      async healthCheck(): Promise<boolean> {
        return true;
      }
    }
    const wide: ResearchPlan = {
      ...plan,
      subQuestions: [0, 1, 2, 3].map((index) => ({
        index,
        question: `q${index}`,
        rationale: "",
        sourceScope: "web" as const,
      })),
    };
    for await (const _ of runResearch(deps(new CountingProvider()), wide, { maxParallel: 2 })) {
      void _;
    }
    // Bounded fan-out, not thousands: the ceiling that used to live in
    // `mapWithConcurrency` here is now the executor's, and it still binds.
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});
