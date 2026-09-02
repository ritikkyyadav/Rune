import { describe, expect, test } from "bun:test";

import {
  SUBAGENT_RESULT_SCHEMA,
  buildSubagentResult,
  parseSubagentResult,
  renderTaskResult,
  renderWorkerResult,
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
      "/tmp/gear-nonexistent-workspace",
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
      { conflicts: ["src/parser.ts"], branch: "gear/worker-1" },
    );
    expect(text).toContain("MERGE CONFLICTS");
    expect(text).toContain("gear/worker-1");
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
