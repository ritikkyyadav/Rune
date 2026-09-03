/**
 * `note_hypothesis` and `record_decision` — the two tools beside
 * `record_evidence`, and the harness inference that settles what they raise.
 *
 * The rule they share with `record_evidence`: the model says what it is DOING,
 * and the runtime decides what that is worth. A hypothesis is written while it
 * is still a suspicion; its verdict comes from a check. A decision is written
 * with the evidence it stood on, and an empty citation is recorded rather than
 * argued about — the harness cannot know whether a given commitment needed one,
 * and an argument the model can restate more confidently is one it wins.
 */

import { describe, expect, test } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  NOTE_HYPOTHESIS_SCHEMA,
  RECORD_DECISION_SCHEMA,
  createNoteHypothesisTool,
  createRecordDecisionTool,
  parseEvidenceRefs,
} from "../../../packages/orchestrator/src/narrative-tools";
import {
  artifactsFromResult,
  bashCheckVerdict,
  checkReasonFrom,
} from "../../../packages/orchestrator/src/agent-loop";

function spine(): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn("why did latency rise after v2.18.5?");
  return s;
}

async function call(
  tool: ReturnType<typeof createNoteHypothesisTool>,
  args: Record<string, unknown>,
) {
  const valid = tool.validate?.(args) ?? { valid: true };
  if (!valid.valid) return { ok: false as const, error: valid.error! };
  const out = await tool.execute({
    callId: "c1",
    toolName: tool.schema.name,
    args,
  } as never);
  return { ok: true as const, result: out.result, success: out.success };
}

describe("note_hypothesis", () => {
  test("raises a suspicion as `testing` and hands back its id", async () => {
    const s = spine();
    const tool = createNoteHypothesisTool(() => s);
    const out = await call(tool, { text: "connection pool exhaustion on deploy" });
    expect(out.ok).toBe(true);
    expect(out.ok && out.result).toContain("h1");
    expect(s.hypotheses[0].status).toBe("testing");
    expect(s.hypotheses[0].text).toBe("connection pool exhaustion on deploy");
  });

  test("settles one it already raised, with the reason", async () => {
    const s = spine();
    const tool = createNoteHypothesisTool(() => s);
    await call(tool, { text: "cache eviction" });
    const out = await call(tool, { id: "h1", status: "refuted", reason: "TTL unchanged" });
    expect(out.ok && out.result).toContain("refuted");
    expect(out.ok && out.result).toContain("TTL unchanged");
    expect(s.hypotheses[0].status).toBe("refuted");
  });

  test("refuses to settle a hypothesis nobody raised, and says why", async () => {
    // Recording only the verdict would put a hypothesis into the record at the
    // moment it was answered — a story told backwards.
    const s = spine();
    const tool = createNoteHypothesisTool(() => s);
    const out = await call(tool, { id: "h4", status: "confirmed", reason: "found it" });
    expect(out.ok && out.result).toContain("No hypothesis h4");
    expect(s.hypotheses).toHaveLength(0);
  });

  test("needs text or an id-plus-status, and says which", () => {
    const tool = createNoteHypothesisTool(() => spine());
    expect(tool.validate!({}).valid).toBe(false);
    expect(tool.validate!({ id: "h1" }).valid).toBe(false);
    expect(tool.validate!({ id: "h1", status: "nonsense" }).valid).toBe(false);
    expect(tool.validate!({ id: "h1", status: "refuted" }).valid).toBe(true);
    expect(tool.validate!({ text: "a suspicion" }).valid).toBe(true);
  });

  test("a run with no spine says so instead of failing the turn", async () => {
    const tool = createNoteHypothesisTool(() => undefined);
    const out = await call(tool, { text: "something" });
    expect(out.ok && out.success).toBe(true);
    expect(out.ok && out.result).toContain("No task spine");
  });

  test("evidence given with the verdict lands on the hypothesis", async () => {
    const s = spine();
    const tool = createNoteHypothesisTool(() => s);
    await call(tool, { text: "query regression" });
    await call(tool, {
      id: "h1",
      status: "confirmed",
      reason: "seq scan",
      evidence: [{ kind: "check", ref: "explain analyze", detail: "seq scan on orders" }],
    });
    expect(s.hypotheses[0].evidence[0].ref).toBe("explain analyze");
  });
});

describe("record_decision", () => {
  test("records the commitment with the evidence behind it", async () => {
    const s = spine();
    const tool = createRecordDecisionTool(() => s);
    const out = await call(tool as never, {
      text: "restore the (customer_id, created_at) index",
      based_on: [{ kind: "check", ref: "explain analyze", detail: "seq scan on 1.2M rows" }],
    });
    expect(out.ok && out.result).toContain("d1");
    expect(out.ok && out.result).toContain("1 piece");
    expect(s.decisionsRecorded[0].basedOn).toHaveLength(1);
  });

  test("an uncited decision is recorded AND told it is uncited", async () => {
    const s = spine();
    const tool = createRecordDecisionTool(() => s);
    const out = await call(tool as never, { text: "keep the existing schema" });
    expect(out.ok && out.result).toContain("NO evidence cited");
    expect(s.decisionsRecorded).toHaveLength(1);
  });

  test("needs text", () => {
    const tool = createRecordDecisionTool(() => spine());
    expect(tool.validate!({}).valid).toBe(false);
    expect(tool.validate!({ text: "  " }).valid).toBe(false);
    expect(tool.validate!({ text: "decided" }).valid).toBe(true);
  });
});

describe("evidence refs are validated, not trusted", () => {
  test("shapeless entries are dropped, good ones kept and stamped", () => {
    const refs = parseEvidenceRefs([
      { kind: "check", ref: "bun test" },
      { kind: "invented", ref: "x" },
      { kind: "file", ref: "" },
      "just a string",
      null,
      { kind: "file", ref: "src/a.ts", detail: "line 42" },
    ]);
    expect(refs.map((r) => r.ref)).toEqual(["bun test", "src/a.ts"]);
    expect(refs[0].at).toBeTruthy();
  });

  test("a non-array is no evidence at all, and never throws", () => {
    expect(parseEvidenceRefs(undefined)).toEqual([]);
    expect(parseEvidenceRefs("bun test")).toEqual([]);
    expect(parseEvidenceRefs({ kind: "check", ref: "x" })).toEqual([]);
  });

  test("the list is bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "file", ref: `f${i}.ts` }));
    expect(parseEvidenceRefs(many)).toHaveLength(8);
  });
});

describe("the schemas cost what they claim", () => {
  test("both are read-category and auto-permission — they touch nothing", () => {
    for (const schema of [NOTE_HYPOTHESIS_SCHEMA, RECORD_DECISION_SCHEMA]) {
      expect(schema.category).toBe("read");
      expect(schema.permissionLevel).toBe("auto");
    }
  });

  test("neither offers the model a way to declare a conclusion proven", () => {
    // The same rule read_back holds: a status is reported, and the harness's
    // own reading of a check is what a reader is shown beside it.
    const props = (RECORD_DECISION_SCHEMA.inputSchema as any).properties;
    expect(Object.keys(props).sort()).toEqual(["based_on", "text"]);
    expect(props.based_on.items.properties.kind.enum).toEqual([
      "check",
      "file",
      "step",
      "artifact",
      "answer",
    ]);
  });
});

describe("the refusal reason a reader sees", () => {
  test("keeps what the check found and drops what the model was told to do", () => {
    const refusal =
      "the last check during this step FAILED (bun test pool.test.ts): 2 failing, pool at 20%. " +
      "Fix it and re-run the check, or re-submit to mark the step unproven.";
    const reason = checkReasonFrom(refusal);
    expect(reason).toContain("bun test pool.test.ts");
    expect(reason).toContain("pool at 20%");
    expect(reason).not.toContain("re-submit");
    expect(reason).not.toContain("unproven");
  });

  test("a refusal with no instruction tail survives whole, bounded", () => {
    expect(checkReasonFrom("nothing ran while it was open")).toBe("nothing ran while it was open");
    expect(checkReasonFrom("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("a check's verdict is its exit code, not the tool's success flag", () => {
  // The defect this closes: `bash` reports success for any command that RAN,
  // so a failing test suite was a successful call with `exit_code: 1` — and the
  // spine recorded it as a PASS. `docs/plan-ledger.md` has said since b150dd2
  // that a completion right after a failing check is refused; for checks the
  // model ran itself that rule could never fire, because the spine never saw a
  // failure. The web transcript reducer already read the code; the spine, which
  // is where the rule is enforced, did not.
  const shell = (fields: Record<string, unknown>) => ({
    success: true,
    result: JSON.stringify({ stdout: "", stderr: "", exit_code: 0, ...fields }),
  });

  test("exit 0 is a pass", () => {
    expect(bashCheckVerdict(shell({ stdout: "12 pass" }))).toEqual({
      passed: true,
      summary: "ok",
      exitCode: 0,
    });
  });

  test("a non-zero exit is a FAILURE, however successfully the tool ran it", () => {
    const verdict = bashCheckVerdict(
      shell({ exit_code: 1, stdout: "1 pass\n1 fail\nerror: expect(300).not.toBe(300)" }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.summary).toContain("expect(300)");
  });

  test("the summary reads BOTH streams — bun test puts its verdict on stderr", () => {
    // Measured, not assumed: `bun test` leaves stdout holding its version
    // banner and writes the failure to stderr. A stdout-only reading quoted
    // "bun test v1.3.14" back as the reason a theory was ruled out.
    const verdict = bashCheckVerdict(
      shell({
        exit_code: 1,
        stdout: "bun test v1.3.14 (0d9b296a)",
        stderr: "error: expect(received).not.toBe(expected)\n(fail) the cache TTL changed [0.1ms]",
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toContain("the cache TTL changed");
    expect(verdict.summary).not.toContain("bun test v1.3.14");
  });

  test("a timeout is a failure even at exit 0", () => {
    const verdict = bashCheckVerdict(shell({ timed_out: true, stdout: "" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toBe("timed out");
  });

  test("stderr answers when stdout is silent", () => {
    const verdict = bashCheckVerdict(shell({ exit_code: 2, stderr: "tsc: cannot find module" }));
    expect(verdict.summary).toContain("cannot find module");
  });

  test("a failed tool call is a failed check", () => {
    const verdict = bashCheckVerdict({ success: false, error: "spawn ENOENT" });
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toContain("ENOENT");
  });

  test("a result that is not the shell's JSON falls back to the flag", () => {
    // Embedders and stubbed registries return plain strings; the old behaviour
    // is the right one there, and it must not throw.
    expect(bashCheckVerdict({ success: true, result: "ok" })).toEqual({
      passed: true,
      summary: "ok",
    });
    expect(bashCheckVerdict({ success: true }).passed).toBe(true);
  });
});

describe("artifacts a tool result announces", () => {
  test("a research report's saved path", () => {
    const result =
      'Research complete — "vector databases"\n12 sources · 4 sub-question(s) completed\n' +
      "Full report saved to: .gear/research/vector-databases.md\n\n# Report";
    expect(artifactsFromResult("research", result)).toEqual([
      { kind: "report", ref: ".gear/research/vector-databases.md" },
    ]);
  });

  test("a dashboard's url", () => {
    const result = JSON.stringify({ id: "d1", title: "Latency", url: "http://127.0.0.1:7799/d1" });
    expect(artifactsFromResult("interactive_dashboard", result)).toEqual([
      { kind: "preview", ref: "http://127.0.0.1:7799/d1" },
    ]);
  });

  test("anything else announces nothing, and malformed output never throws", () => {
    // A file write is already in the file ledger; this function exists only for
    // the outputs that never pass through it.
    expect(artifactsFromResult("bash", "ok")).toEqual([]);
    expect(artifactsFromResult("write_file", "ok")).toEqual([]);
    expect(artifactsFromResult("research", "Research failed")).toEqual([]);
    expect(artifactsFromResult("interactive_dashboard", "not json")).toEqual([]);
    expect(artifactsFromResult("interactive_dashboard", "")).toEqual([]);
  });
});
