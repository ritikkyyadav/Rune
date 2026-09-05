/**
 * Two real Engines, one repository, one shared team bus.
 *
 * The unit tests prove the bus primitives; this proves the ENGINE GLUE that
 * the primitives hang from — the part that silently rots when a seam moves:
 * the `team` tool actually reaching the registry, presence/intent flowing
 * between instances, "block" enforcement reaching the permission chain,
 * "warn" enforcement reaching the tool result, worker leases spanning
 * instances, and teammate mail landing in the receiving loop as a harness
 * note. Engines are constructed exactly as the CLI constructs them, minus a
 * provider: nothing here makes a model call.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { ProviderName } from "../../packages/llm-gateway/src/types";
import type { ToolCallOutput } from "../../packages/tool-registry/src/types";

let dir: string;
let busPath: string;
const engines: Engine[] = [];

/** Reach the private seams this test is specifically about. */
type Internals = {
  registry: { list(): Array<{ name: string }> };
  buildPermissionCheck(c: {
    sessionId: string;
    userMessages: string[];
  }): (a: {
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  processToolResult(ctx: {
    toolName: string;
    args: Record<string, unknown>;
    output: ToolCallOutput;
    sessionId: string;
    workspaceRoot: string;
  }): Promise<ToolCallOutput>;
  teamWorkerClaim(paths: string[], label: string): { ok: boolean; error?: string; note?: string };
  teamWorkerRelease(label: string): void;
  renderTeamBlock(): string | null;
  liveLoop: { injectHarnessNote(t: string): void } | null;
  deliverTeamMessages(): void;
};
const inner = (e: Engine) => e as unknown as Internals;

function makeEngine(enforcement: "warn" | "block", tag: string): Engine {
  const e = new Engine({
    model: "fake-model",
    provider: "custom" as ProviderName,
    workspaceRoot: dir,
    dbPath: join(dir, `${tag}.db`),
    toolsBinaryPath: "rune-tools",
    yoloMode: true, // skip the confirm ladder; the team gate is what's under test
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    team: { enabled: true, claimEnforcement: enforcement, dbPath: busPath },
  });
  engines.push(e);
  return e;
}

const okOutput = (): ToolCallOutput => ({
  callId: "c1",
  toolName: "write_file",
  success: true,
  result: "wrote 1 file",
  durationMs: 1,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-team-e2e-"));
  busPath = join(dir, "team.db");
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "session.ts"), "export const a = 1;\n");
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
});

afterEach(() => {
  for (const e of engines.splice(0)) e.getTeamBus()?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("two Rune instances in one repository", () => {
  test("the team tool is registered, and only when a bus exists", () => {
    const withBus = makeEngine("warn", "a");
    expect(
      inner(withBus)
        .registry.list()
        .some((t) => t.name === "team"),
    ).toBe(true);

    const solo = new Engine({
      model: "fake-model",
      provider: "custom" as ProviderName,
      workspaceRoot: dir,
      dbPath: join(dir, "solo.db"),
      toolsBinaryPath: "rune-tools",
      yoloMode: true,
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
    });
    engines.push(solo);
    expect(solo.getTeamBus()).toBeNull();
    expect(
      inner(solo)
        .registry.list()
        .some((t) => t.name === "team"),
    ).toBe(false);
    expect(solo.getStatus().team.enabled).toBe(false);
  });

  test("presence, intent, and the ephemeral [Team] block", () => {
    const a = makeEngine("warn", "a");
    expect(inner(a).renderTeamBlock()).toBeNull(); // solo → nothing injected

    const b = makeEngine("warn", "b");
    b.getTeamBus()!.setIntent("migrating the DB layer");

    const block = inner(a).renderTeamBlock();
    expect(block).toContain("[Team");
    expect(block).toContain(b.getTeamBus()!.instanceId);
    expect(block).toContain("migrating the DB layer");
    expect(block).toContain("SAME working tree");
    expect(a.getStatus().team.peerCount).toBe(1);
    expect(a.getStatus().team.instanceId).toBe(a.getTeamBus()!.instanceId);
  });

  test('"block" refuses a write into a peer\'s claimed scope, and only there', async () => {
    const a = makeEngine("block", "a");
    const b = makeEngine("block", "b");
    a.getTeamBus()!.setIntent("auth rework");
    expect(a.getTeamBus()!.claim(["src/auth/"], { reason: "auth rework" }).ok).toBe(true);

    const gate = inner(b).buildPermissionCheck({ sessionId: "s1", userMessages: [] });
    const denied = await gate({
      callId: "c1",
      toolName: "write_file",
      args: { path: "src/auth/session.ts" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain(a.getTeamBus()!.instanceId);
    expect(denied.reason).toContain("auth rework");

    // Outside the lease the team gate is silent — the write proceeds.
    const fine = await gate({
      callId: "c2",
      toolName: "write_file",
      args: { path: "src/ui/panel.tsx" },
    });
    expect(fine.allowed).toBe(true);

    // And the holder itself is never blocked by its own claim.
    const ownGate = inner(a).buildPermissionCheck({ sessionId: "s1", userMessages: [] });
    expect(
      (await ownGate({ callId: "c3", toolName: "write_file", args: { path: "src/auth/x.ts" } }))
        .allowed,
    ).toBe(true);
  });

  test('"warn" lets the write through but annotates the result', async () => {
    const a = makeEngine("warn", "a");
    const b = makeEngine("warn", "b");
    a.getTeamBus()!.setIntent("auth rework");
    a.getTeamBus()!.claim(["src/auth/"]);

    const gate = inner(b).buildPermissionCheck({ sessionId: "s1", userMessages: [] });
    expect(
      (
        await gate({
          callId: "c1",
          toolName: "write_file",
          args: { path: "src/auth/session.ts" },
        })
      ).allowed,
    ).toBe(true);

    const out = await inner(b).processToolResult({
      toolName: "write_file",
      args: { path: "src/auth/session.ts" },
      output: okOutput(),
      sessionId: "s1",
      workspaceRoot: dir,
    });
    expect(out.success).toBe(true);
    expect(out.result).toContain("[TEAM]");
    expect(out.result).toContain(a.getTeamBus()!.instanceId);
    expect(out.result).toContain("wrote 1 file"); // original result preserved
  });

  test("a peer's recent write on the same path warns even with no claim", async () => {
    const a = makeEngine("warn", "a");
    const b = makeEngine("warn", "b");

    await inner(a).processToolResult({
      toolName: "write_file",
      args: { path: "src/shared/types.ts" },
      output: okOutput(),
      sessionId: "s1",
      workspaceRoot: dir,
    });

    const out = await inner(b).processToolResult({
      toolName: "write_file",
      args: { path: "src/shared/types.ts" },
      output: okOutput(),
      sessionId: "s2",
      workspaceRoot: dir,
    });
    expect(out.result).toContain("[TEAM]");
    expect(out.result).toContain(a.getTeamBus()!.instanceId);
    expect(out.result).toMatch(/also wrote/i);

    // A path nobody else touched stays clean.
    const clean = await inner(b).processToolResult({
      toolName: "write_file",
      args: { path: "src/only-mine.ts" },
      output: okOutput(),
      sessionId: "s2",
      workspaceRoot: dir,
    });
    expect(clean.result).not.toContain("[TEAM]");
  });

  test("worker leases span instances and are released after the run", () => {
    const a = makeEngine("block", "a");
    const b = makeEngine("block", "b");

    const first = inner(a).teamWorkerClaim(["src/auth/"], "w1");
    expect(first.ok).toBe(true);

    const blocked = inner(b).teamWorkerClaim(["src/auth/session.ts"], "w1");
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain(a.getTeamBus()!.instanceId);

    // Disjoint files are unaffected.
    expect(inner(b).teamWorkerClaim(["src/ui/"], "w2").ok).toBe(true);

    inner(a).teamWorkerRelease("w1");
    expect(inner(b).teamWorkerClaim(["src/auth/session.ts"], "w3").ok).toBe(true);
  });

  test('"warn" enforcement lets a worker lease proceed with a note', () => {
    const a = makeEngine("warn", "a");
    const b = makeEngine("warn", "b");
    a.getTeamBus()!.claim(["src/auth/"]);
    const res = inner(b).teamWorkerClaim(["src/auth/session.ts"], "w1");
    expect(res.ok).toBe(true);
    expect(res.note).toContain("[TEAM]");
    expect(res.note).toContain(a.getTeamBus()!.instanceId);
  });

  test("teammate mail reaches the receiver's live loop as a harness note", () => {
    const a = makeEngine("warn", "a");
    const b = makeEngine("warn", "b");
    a.getTeamBus()!.setIntent("auth rework");
    a.getTeamBus()!.send("session.ts now exports refreshToken()");

    const notes: string[] = [];
    inner(b).liveLoop = { injectHarnessNote: (t) => notes.push(t) };
    inner(b).deliverTeamMessages();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("session.ts now exports refreshToken()");
    expect(notes[0]).toContain(a.getTeamBus()!.instanceId);
    expect(notes[0]).toContain("auth rework");
    // Framed as peer info, never as an instruction outranking the user.
    expect(notes[0]).toMatch(/user instructions still take precedence/i);

    // Delivered once: the cursor advanced.
    inner(b).deliverTeamMessages();
    expect(notes).toHaveLength(1);
  });

  test("mail queued while idle is held, then delivered when a run starts", () => {
    const a = makeEngine("warn", "a");
    const b = makeEngine("warn", "b");
    inner(b).liveLoop = null; // idle
    a.getTeamBus()!.send("heads up");
    inner(b).deliverTeamMessages();
    expect(b.getTeamBus()!.pendingMessageCount()).toBe(1); // nothing consumed

    const notes: string[] = [];
    inner(b).liveLoop = { injectHarnessNote: (t) => notes.push(t) };
    inner(b).deliverTeamMessages();
    expect(notes).toHaveLength(1);
  });
});
