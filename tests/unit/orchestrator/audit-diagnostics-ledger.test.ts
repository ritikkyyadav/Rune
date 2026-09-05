import { describe, test, expect } from "bun:test";

import { diagnosticsLedger } from "../../../packages/orchestrator/src/bin/audit-cli";

// P10.1: `rune audit` counts how many edits carried a language-server block
// and how many of those files were clean again before the verifier ran. The
// ledger is pure over the session log, so it is tested without a database.

let seq = 0;
const next = () => ++seq;

function edit(callId: string, toolName = "edit_file") {
  return {
    seq: next(),
    event: { type: "assistant_msg", payload: { content: "", toolUses: [{ callId, toolName }] } },
  };
}

function result(callId: string, payload: Record<string, unknown>, isError = false) {
  return {
    seq: next(),
    event: {
      type: "tool_result",
      payload: { callId, content: JSON.stringify(payload), isError },
    },
  };
}

function verified() {
  return {
    seq: next(),
    event: {
      type: "task_state",
      payload: { state: { verification: { status: "passed", attempts: 1 } } },
    },
  };
}

const BLOCK = "src/a.ts:4:9 error Type 'string' is not assignable to type 'number'.";

describe("diagnosticsLedger", () => {
  test("a block followed by a clean edit of the same file counts as cleared", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1"),
      result("c1", { path: "src/a.ts", diagnostics: BLOCK }),
      edit("c2"),
      result("c2", { path: "src/a.ts" }),
      verified(),
    ]);
    expect(led.edits).toBe(1);
    expect(led.reported).toBe(1);
    expect(led.cleared).toBe(1);
    expect(led.outstanding).toBe(0);
    expect(led.verifierSeq).not.toBeNull();
  });

  test("a block that survives to the verifier is outstanding, not cleared", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1"),
      result("c1", { path: "src/a.ts", diagnostics: BLOCK }),
      verified(),
      edit("c2"),
      result("c2", { path: "src/a.ts" }),
    ]);
    expect(led.edits).toBe(1);
    // The clean edit landed AFTER the checks ran, so it is not this loop.
    expect(led.cleared).toBe(0);
    expect(led.outstanding).toBe(0);
  });

  test("a run with no checks at all still credits clearing", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1"),
      result("c1", { path: "src/a.ts", diagnostics: BLOCK }),
      edit("c2"),
      result("c2", { path: "src/a.ts" }),
    ]);
    expect(led.verifierSeq).toBeNull();
    expect(led.cleared).toBe(1);
  });

  test("the +N more tail is a count, not a diagnostic", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1"),
      result("c1", {
        path: "src/a.ts",
        diagnostics: `${BLOCK}\nsrc/a.ts:9:1 warning unused\n+7 more`,
      }),
    ]);
    expect(led.reported).toBe(2);
    expect(led.outstanding).toBe(1);
  });

  test("apply_patch results are accounted per file it touched", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1", "apply_patch"),
      result("c1", {
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        diagnostics: "src/a.ts:1:1 error boom\nsrc/b.ts:2:2 error bang",
      }),
      edit("c2", "apply_patch"),
      result("c2", { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }),
    ]);
    expect(led.files).toBe(2);
    expect(led.reported).toBe(2);
    expect(led.cleared).toBe(2);
  });

  test("reads, failures and unparseable results are ignored", () => {
    seq = 0;
    const led = diagnosticsLedger([
      edit("c1", "read_file"),
      result("c1", { path: "src/a.ts", diagnostics: BLOCK }),
      edit("c2"),
      result("c2", { path: "src/a.ts", diagnostics: BLOCK }, true),
      edit("c3"),
      {
        seq: next(),
        event: { type: "tool_result", payload: { callId: "c3", content: "…truncated…" } },
      },
    ]);
    expect(led.edits).toBe(0);
    expect(led.files).toBe(0);
  });

  test("a session that never saw a block reports nothing", () => {
    seq = 0;
    const led = diagnosticsLedger([edit("c1"), result("c1", { path: "src/a.ts" })]);
    expect(led.edits).toBe(0);
    expect(led.reported).toBe(0);
    expect(led.cleared).toBe(0);
  });
});
