import { describe, expect, test } from "bun:test";

import {
  SUBAGENT_RESULT_SCHEMA,
  buildChildSummary,
  buildSubagentResult,
  describeCall,
  parseSubagentResult,
  renderTaskResult,
  renderWorkerResult,
  toChildStatus,
  validateSubagentResult,
  type SubagentResult,
} from "../../../packages/orchestrator/src/subagent-result";
import { TASK_TOOL_SCHEMA } from "../../../packages/orchestrator/src/subagent";
import { WORKER_TOOL_SCHEMA } from "../../../packages/orchestrator/src/worker";

/**
 * P6B.3 — the delegation boundary is typed.
 *
 * The property that matters most is not that parsing works; it is that the
 * harness's facts beat the model's claims. A sub-agent can say anything about
 * what it changed and whether checks passed, and those two fields are precisely
 * the ones a parent will act on.
 */

const COMPLETE: SubagentResult = {
  summary: "The retry policy is configured in two places.",
  findings: ["src/http.ts sets maxRetries", "config.toml overrides it"],
  filesExamined: ["src/http.ts", "config.toml"],
  filesChanged: [],
  checks: "not_run",
  confidence: "high",
  unresolved: [],
  stopReason: "end_turn",
  toolCallCount: 7,
};

describe("P6B.3 — both delegation tools declare an outputSchema", () => {
  test("task and worker carry the shared schema", () => {
    expect(TASK_TOOL_SCHEMA.outputSchema).toBe(SUBAGENT_RESULT_SCHEMA);
    expect(WORKER_TOOL_SCHEMA.outputSchema).toBe(SUBAGENT_RESULT_SCHEMA);
  });

  test("the schema names every field the contract promises", () => {
    const props = Object.keys((SUBAGENT_RESULT_SCHEMA.properties ?? {}) as Record<string, unknown>);
    for (const field of [
      "summary",
      "findings",
      "filesExamined",
      "filesChanged",
      "checks",
      "confidence",
      "unresolved",
      "stopReason",
      "toolCallCount",
    ]) {
      expect(props).toContain(field);
    }
  });
});

describe("P6B.3 — parsing what a model actually returns", () => {
  test("a bare object", () => {
    expect(parseSubagentResult(JSON.stringify(COMPLETE))?.summary).toBe(COMPLETE.summary);
  });

  test("a fenced json block with prose around it", () => {
    const text = `Here is my report.\n\n\`\`\`json\n${JSON.stringify(COMPLETE)}\n\`\`\`\n\nHope that helps.`;
    const parsed = parseSubagentResult(text);
    expect(parsed?.findings).toHaveLength(2);
  });

  test("an object embedded in prose, with braces inside its strings", () => {
    const text = `Report: {"summary":"uses a { literal brace } in text","findings":[],"checks":"not_run","confidence":"low","unresolved":[],"filesExamined":[],"filesChanged":[],"stopReason":"end_turn","toolCallCount":1}`;
    expect(parseSubagentResult(text)?.summary).toContain("literal brace");
  });

  test("prose alone parses to null rather than to an invented object", () => {
    // The one thing this must never do. A fabricated `checks: "passed"` is
    // worse than no result at all.
    expect(parseSubagentResult("I looked at the file and it seems fine.")).toBeNull();
  });

  test("an object without a summary is some other object", () => {
    expect(parseSubagentResult('{"findings":["a"],"checks":"passed"}')).toBeNull();
  });

  test("unknown enum values fall back rather than pass through", () => {
    const parsed = parseSubagentResult(
      '{"summary":"x","checks":"probably fine","confidence":"total"}',
    );
    expect(parsed?.checks).toBe("not_run");
    expect(parsed?.confidence).toBe("medium");
  });
});

describe("P6B.3 — the harness's facts beat the model's claims", () => {
  test("filesChanged comes from what was observed, not from what was claimed", () => {
    const result = buildSubagentResult({
      finalText: JSON.stringify({ ...COMPLETE, filesChanged: ["src/everything.ts"] }),
      toolCallCount: 3,
      stopReason: "end_turn",
      trail: [],
      filesChanged: ["src/actually-written.ts"],
    });
    expect(result.filesChanged).toEqual(["src/actually-written.ts"]);
  });

  test("toolCallCount and stopReason are the harness's", () => {
    const result = buildSubagentResult({
      finalText: JSON.stringify({ ...COMPLETE, toolCallCount: 999, stopReason: "end_turn" }),
      toolCallCount: 4,
      stopReason: "max_turns",
      trail: [],
    });
    expect(result.toolCallCount).toBe(4);
    expect(result.stopReason).toBe("max_turns");
  });

  test("checks cannot be claimed when the harness did not run any", () => {
    const result = buildSubagentResult({
      finalText: JSON.stringify({ ...COMPLETE, checks: "passed" }),
      toolCallCount: 1,
      stopReason: "end_turn",
      trail: [],
      checks: "not_run",
    });
    expect(result.checks).toBe("not_run");
  });
});

describe("P6B.3 — a run that wrote no summary still returns its ground", () => {
  test("an empty report names the cause and keeps the trail", () => {
    const result = buildSubagentResult({
      finalText: "",
      toolCallCount: 8,
      stopReason: "max_turns",
      trail: ["read_file src/a.ts", "grep retry"],
    });
    expect(result.summary).toContain("ran out of turns");
    expect(result.filesExamined).toHaveLength(2);
    expect(result.confidence).toBe("low");
    // Running out of turns and choosing to say nothing are different failures
    // with different fixes; the old code reported them identically.
    const other = buildSubagentResult({
      finalText: "",
      toolCallCount: 1,
      stopReason: "end_turn",
      loopError: "provider 429",
      trail: [],
    });
    expect(other.summary).toContain("provider 429");
  });

  test("the renderer says INCOMPLETE and suggests the next step", () => {
    const result = buildSubagentResult({
      finalText: "",
      toolCallCount: 8,
      stopReason: "max_turns",
      trail: ["read_file src/a.ts"],
    });
    const text = renderTaskResult(result, { maxTurns: 12, topBudget: 32, effort: "standard" });
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("thorough");
    expect(text).toContain("32");
  });
});

describe("P6B.3 — the worker manifest is measured, not reported", () => {
  test("a claimed file that is not on disk is named", () => {
    const text = renderWorkerResult(
      { ...COMPLETE, filesChanged: ["definitely/not/here.ts"], summary: "Built it." },
      "/tmp/rune-nonexistent-workspace",
    );
    expect(text).toContain("MISSING — claimed but not on disk");
  });

  test("the closing warning follows the checks field", () => {
    const base = { ...COMPLETE, filesChanged: ["a.ts"], summary: "Built it." };
    expect(renderWorkerResult({ ...base, checks: "not_run" }, "/tmp/x")).toContain("NOT VERIFIED");
    expect(renderWorkerResult({ ...base, checks: "passed" }, "/tmp/x")).toContain("CHECKS PASSED");
    expect(renderWorkerResult({ ...base, checks: "failed" }, "/tmp/x")).toContain("CHECKS FAILED");
  });

  test("merge conflicts are reported as their own block", () => {
    const text = renderWorkerResult(
      { ...COMPLETE, filesChanged: ["a.ts"], summary: "Built it." },
      "/tmp/x",
      { conflicts: ["src/parser.ts"], branch: "rune/worker-1" },
    );
    expect(text).toContain("MERGE CONFLICTS");
    expect(text).toContain("rune/worker-1");
  });
});

describe("P6B.3 — validation", () => {
  test("a complete object validates", () => {
    expect(validateSubagentResult(COMPLETE).valid).toBe(true);
  });

  test("problems are named individually", () => {
    const check = validateSubagentResult({ summary: "", findings: "nope", checks: "maybe" });
    expect(check.valid).toBe(false);
    expect(check.problems).toContain("summary missing");
    expect(check.problems).toContain("findings is not an array");
    expect(check.problems).toContain("checks invalid");
  });

  test("a non-object is not a result", () => {
    expect(validateSubagentResult("a string").valid).toBe(false);
    expect(validateSubagentResult(null).valid).toBe(false);
    expect(validateSubagentResult([COMPLETE]).valid).toBe(false);
  });
});

describe("G24 — the child summary a parent's lifecycle carries", () => {
  test("a conflicted merge is retained, typed, and lists what conflicted", () => {
    const child = buildChildSummary({
      stopReason: "end_turn",
      integration: "retained",
      conflicts: ["src/api.ts", "src/client.ts"],
      branch: "rune/worker-w0198-1",
    });
    expect(child).toEqual({
      status: "end_turn",
      integration: "retained",
      conflicts: ["src/api.ts", "src/client.ts"],
      branch: "rune/worker-w0198-1",
    });
  });

  test("a clean merge says no conflicts rather than omitting the field", () => {
    // "conflicts is missing" and "there were none" must not be the same shape:
    // a consumer counting conflicts has to be able to tell them apart.
    expect(buildChildSummary({ stopReason: "end_turn", integration: "merged" })).toEqual({
      status: "end_turn",
      integration: "merged",
      conflicts: [],
    });
    // A read-only child integrates nothing, so it claims neither field.
    expect(buildChildSummary({ stopReason: "end_turn" })).toEqual({ status: "end_turn" });
  });

  test("stop reasons map onto the lifecycle vocabulary, and never guess 'finished'", () => {
    expect(toChildStatus("max_turns")).toBe("max_turns");
    expect(toChildStatus("aborted")).toBe("aborted");
    expect(toChildStatus("max_tokens")).toBe("max_tokens");
    // A budget is a deliberate stop with the work kept; neither has a member.
    expect(toChildStatus("cost_budget")).toBe("halted");
    expect(toChildStatus("time_budget")).toBe("halted");
    // A run that cannot say how it ended did not end well.
    expect(toChildStatus("")).toBe("stalled");
    expect(toChildStatus(undefined)).toBe("stalled");
    expect(toChildStatus("something new")).toBe("stalled");
    // The contract has no `error` member; a child that died on one is stalled.
    expect(toChildStatus("error")).toBe("stalled");
  });
});

describe("a worker report that was never written still says so", () => {
  const partial = (over: Partial<SubagentResult> = {}): SubagentResult =>
    buildSubagentResult({
      finalText: "",
      toolCallCount: 12,
      stopReason: "max_turns",
      trail: ["glob src/f1.ts", "read_file src/api.ts"],
      filesChanged: ["src/api.ts"],
      ...over,
    });

  test("the worker renderer labels it INCOMPLETE and names the cause", () => {
    // The scout's renderer has done both since P6B.3; the worker's did neither,
    // so a build that ran out of turns reached the lead reading like a report.
    const text = renderWorkerResult(partial(), "/tmp/rune-nonexistent");
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("ran out of turns");
    expect(text).toContain("Stopped: max_turns");
    expect(text).toContain("not a report");
  });

  test("it carries the tool receipts as well as the manifest", () => {
    const text = renderWorkerResult(partial(), "/tmp/rune-nonexistent");
    expect(text).toContain("It ran 12 tool calls, covering:");
    expect(text).toContain("glob src/f1.ts");
    expect(text).toContain("read_file src/api.ts");
    // The measured half is still there and still measured.
    expect(text).toContain("WORKER MANIFEST");
    expect(text).toContain("MISSING — claimed but not on disk");
  });

  test("a complete report is unchanged: no banner, no receipts, no stop line", () => {
    const text = renderWorkerResult(
      { ...COMPLETE, filesChanged: ["a.ts"], summary: "Built it.", stopReason: "end_turn" },
      "/tmp/x",
    );
    expect(text).not.toContain("INCOMPLETE");
    expect(text).not.toContain("Stopped:");
    expect(text).not.toContain("covering:");
    expect(text.startsWith("Built it.")).toBe(true);
  });

  test("the receipt names the subject, not just the tool", () => {
    // `args.path` alone made every glob/grep receipt read as a bare tool name.
    expect(describeCall({ path: "src/api.ts" })).toBe(" src/api.ts");
    expect(describeCall({ pattern: "src/**/*.ts" })).toBe(" src/**/*.ts");
    expect(describeCall({ query: "retry" })).toBe(" retry");
    expect(describeCall(undefined)).toBe("");
    expect(describeCall({ recursive: true })).toBe("");
  });
});
