/**
 * Autonomy III must never park a run on a human question: the engine
 * withholds the ask_user handler in that mode, so the tool degrades to its
 * proceed-on-your-best-judgment error instead of blocking forever.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../packages/orchestrator/src/engine";

const dir = mkdtempSync(join(tmpdir(), "askuser-hf-"));
const engine = new Engine({
  workspaceRoot: dir,
  dbPath: join(dir, "e.db"),
  enableMcp: false,
  enableSkills: false,
  enableVerification: false,
});
engine.setQuestionHandler(async (q) => `answered: ${q.question}`);

afterAll(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

async function askViaRegistry() {
  const registry = (engine as any)["registry"];
  return registry.execute({
    toolName: "ask_user",
    callId: "c1",
    args: { question: "Which database?", options: ["sqlite", "postgres"] },
    sessionId: "s",
    workspaceRoot: dir,
  });
}

describe("ask_user under permission modes", () => {
  test("confirm mode: the wired handler answers", async () => {
    engine.setPermissionMode("confirm");
    const out = await askViaRegistry();
    expect(out.success).toBe(true);
    expect(out.result).toBe("answered: Which database?");
  });

  test("Autonomy III: handler is withheld — instructive error, no block", async () => {
    engine.setPermissionMode("autonomy-iii");
    const out = await askViaRegistry();
    expect(out.success).toBe(false);
    expect(out.error).toContain("best judgment");
  });

  test("back to auto mode: handler is available again", async () => {
    engine.setPermissionMode("auto");
    const out = await askViaRegistry();
    expect(out.success).toBe(true);
  });
});
