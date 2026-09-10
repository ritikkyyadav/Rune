/**
 * One definition of what a run changed, through the Engine.
 *
 * The older test calls `filesChangedFrom` directly and asserts the headless
 * envelope for a `write_file`. This drives a REAL `apply_patch` — the tool
 * the predicate exists for, whose paths live in the RESULT and not in the
 * arguments — and then pins the consumer that used to disagree: an event
 * stream carries the call but not always its result, and the TUI footer read
 * the predicate without one, so its edited-files readout was short by every
 * patched file. The predicate now falls back to the patch's own file headers,
 * and the footer passes the result.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import { filesChangedFrom } from "../../packages/orchestrator/src/lifecycle";
import { headlessEnvelope, runHeadless } from "../../packages/orchestrator/src/headless";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  });
  return dir;
}

function makeEngine(dir: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(process.env.RUNE_HOME!, "rune.db"),
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as never);
  cleanup.push(() => engine.close());
  return engine;
}

function script(engine: Engine, turns: ContentBlock[][]): UsageProvider {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  provider.onRequest = (_r, index) => turns[index - 1] ?? [{ type: "text", text: "Done." }];
  return provider;
}

describe("filesChanged through the Engine", () => {
  test("a real apply_patch reaches the headless envelope with every file it wrote", async () => {
    const dir = tempWorkspace("v2-fc-");
    writeFileSync(join(dir, "one.ts"), "export const a = 1;\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.ts",
      "@@",
      "-export const a = 1;",
      "+export const a = 2;",
      "*** Add File: two.ts",
      "+export const b = 3;",
      "*** End Patch",
      "",
    ].join("\n");

    const engine = makeEngine(dir);
    script(engine, [
      [{ type: "tool_use", toolCallId: "p1", toolName: "apply_patch", toolInput: { patch } }],
      [{ type: "text", text: "Patched both files." }],
    ]);
    const session = engine.createSession();
    const result = await runHeadless(engine, session, "Apply the patch.");

    expect(readFileSync(join(dir, "one.ts"), "utf8")).toContain("a = 2");
    expect(readFileSync(join(dir, "two.ts"), "utf8")).toContain("b = 3");
    expect(result.toolErrors).toBe(0);
    expect(result.filesChanged.sort()).toEqual(["one.ts", "two.ts"]);
    expect(JSON.parse(headlessEnvelope(result)).filesChanged.sort()).toEqual(["one.ts", "two.ts"]);
  });

  test("a caller with no result still gets every file the patch named", () => {
    // The TUI footer called `filesChangedFrom(ev.output.toolName, ev.args)`
    // while the other three consumers passed `ev.output.result` — one export,
    // four callers, two answers. Both halves are closed: the footer passes the
    // result, and a result-less caller reads the patch's own file headers
    // rather than answering "nothing changed".
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.ts",
      "@@",
      "-export const a = 1;",
      "+export const a = 2;",
      "*** Add File: two.ts",
      "+export const b = 3;",
      "*** End Patch",
      "",
    ].join("\n");
    const result = JSON.stringify({ files: [{ path: "one.ts" }, { path: "two.ts" }] });
    expect(filesChangedFrom("apply_patch", { patch }, result)).toEqual(["one.ts", "two.ts"]);
    expect(filesChangedFrom("apply_patch", { patch })).toEqual(["one.ts", "two.ts"]);
    // A patch that names no file is still not a licence to invent one.
    expect(filesChangedFrom("apply_patch", { patch: "*** Begin Patch\n*** End Patch\n" })).toEqual(
      [],
    );
  });
});
