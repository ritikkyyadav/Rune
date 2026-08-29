/**
 * The wiring guard for the evidence ledger.
 *
 * Background: the engine recorded checks only for `event.output.toolName ===
 * "run_command"`. The shell tool is registered as `bash`. No tool named
 * `run_command` existed anywhere in the repo — the listener was left behind by
 * a rename that updated ui/turn.ts and missed engine.ts.
 *
 * The consequence was total and silent: CheckLog stayed empty for every
 * session, so `rungForCommand` answered "nothing on record" to every citation,
 * `record_evidence` refused every call, no criterion could ever leave `null`,
 * and `BriefLedger.complete` — "the ONLY definition of done this codebase has"
 * — was unreachable. Meanwhile brief-ledger.test.ts stayed green across 32
 * tests, because every one of them constructs the CheckLog by hand.
 *
 * That is the gap these tests close. They assert the COUPLING (constant ↔ live
 * registry), not the logic — the logic was never broken.
 */

import { describe, test, expect } from "bun:test";

import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { registerBuiltinTools } from "../../../packages/tool-registry/src/tools/builtin";
import {
  CHECK_SOURCE_TOOL,
  CheckLog,
  rungForCommand,
  summarizeCheck,
} from "../../../packages/orchestrator/src/brief";
import { isVerificationCommand } from "../../../packages/orchestrator/src/bin/ui/activity";

/** A registry built exactly the way the engine builds its own. */
function builtins(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, "/nonexistent-gear-tools");
  return registry;
}

describe("check-log wiring: the constant must name a real tool", () => {
  test("CHECK_SOURCE_TOOL resolves against the live builtin registry", () => {
    const handler = builtins().get(CHECK_SOURCE_TOOL);
    expect(handler).toBeDefined();
    expect(handler!.schema.name).toBe(CHECK_SOURCE_TOOL);
  });

  test("it names an EXECUTE tool — a check is something that ran", () => {
    expect(builtins().get(CHECK_SOURCE_TOOL)!.schema.category).toBe("execute");
  });

  test("the stale name is gone, and nothing re-introduced it", () => {
    // The original defect in one assertion: the engine listened for a tool
    // that does not exist. If `run_command` ever comes back as a real tool,
    // this fails and the wiring gets looked at deliberately.
    expect(builtins().get("run_command")).toBeUndefined();
  });
});

describe("check-log wiring: the pieces compose end to end", () => {
  /** Replays what the engine's tool_call_end listener does, verbatim. */
  function record(log: CheckLog, toolName: string, command: string, success: boolean): void {
    if (toolName !== CHECK_SOURCE_TOOL) return;
    if (!command || !isVerificationCommand(command)) return;
    log.record({
      command,
      passed: success,
      at: 0,
      summary: summarizeCheck(success ? "44 pass 0 fail" : "1 fail"),
    });
  }

  test("a passing check on the shell tool reaches the log and settles a citation", () => {
    const log = new CheckLog();
    record(log, CHECK_SOURCE_TOOL, "bun test", true);

    expect(log.all.length).toBe(1);
    const verdict = rungForCommand(log, "bun test");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.rung).toBe("observed");
  });

  test("under the OLD listener name nothing is recorded — the original bug", () => {
    const log = new CheckLog();
    record(log, "run_command", "bun test", true);

    expect(log.all.length).toBe(0);
    const verdict = rungForCommand(log, "bun test");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("nothing on record");
  });

  test("non-verification shell commands stay out of the log", () => {
    const log = new CheckLog();
    record(log, CHECK_SOURCE_TOOL, "git status", true);
    expect(log.all.length).toBe(0);
  });
});
