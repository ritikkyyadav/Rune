/**
 * ask_user across permission modes: the handler's PRESENCE is the
 * interactivity truth. 4th gear no longer withholds a wired handler — full
 * autonomy governs execution (no permission stops), not whether an up-front
 * product question reaches the user sitting in the TUI. (The old withholding
 * threw away a live run's perfect clarify round with "no interactive user is
 * available" while the user watched; the TUI keeps fire-and-forget safe with
 * a 60s auto-continue on its picker.) Truly headless environments never wire
 * a handler, and the tool degrades to its instructive error there.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { rmTemp } from "../../helpers/tmp";

const dir = mkdtempSync(join(tmpdir(), "askuser-hf-"));
const engine = new Engine({
  workspaceRoot: dir,
  dbPath: join(dir, "e.db"),
  enableMcp: false,
  enableSkills: false,
  enableVerification: false,
});

afterAll(() => {
  engine.close();
  rmTemp(dir);
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
  test("headless (no handler wired): instructive error in every mode, no block", async () => {
    for (const mode of ["confirm", "auto", "autonomy-iii"]) {
      engine.setPermissionMode(mode as any);
      const out = await askViaRegistry();
      expect(out.success).toBe(false);
      expect(out.error).toContain("best judgment");
    }
  });

  test("confirm mode: the wired handler answers", async () => {
    engine.setQuestionHandler(async (q) => `answered: ${q.question}`);
    engine.setPermissionMode("confirm");
    const out = await askViaRegistry();
    expect(out.success).toBe(true);
    expect(out.result).toBe("answered: Which database?");
  });

  test("4th gear with a wired handler: the question still reaches the user", async () => {
    engine.setPermissionMode("autonomy-iii"); // legacy spelling of gear-4
    const out = await askViaRegistry();
    expect(out.success).toBe(true);
    expect(out.result).toBe("answered: Which database?");
  });

  test("auto mode: handler available as before", async () => {
    engine.setPermissionMode("auto");
    const out = await askViaRegistry();
    expect(out.success).toBe(true);
  });
});
