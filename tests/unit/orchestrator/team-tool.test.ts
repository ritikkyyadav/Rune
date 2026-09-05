// ─── `team` tool + /team command: the two surfaces of one bus ───

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamBus } from "../../../packages/orchestrator/src/team/bus";
import { createTeamTool, renderTeamStatus } from "../../../packages/orchestrator/src/team/tool";
import { runTeamCommand } from "../../../packages/orchestrator/src/team/command";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";

let dir: string;
let dbPath: string;
const buses: TeamBus[] = [];

const open = (workspace = "/repo/main"): TeamBus => {
  const b = TeamBus.open({ dbPath, repoKey: "/repo/common", workspace });
  expect(b).not.toBeNull();
  buses.push(b!);
  return b!;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-team-tool-"));
  dbPath = join(dir, "team.db");
});

afterEach(() => {
  for (const b of buses.splice(0)) b.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (args: Record<string, unknown>): ToolCallInput => ({
  toolName: "team",
  callId: "c1",
  args,
  sessionId: "s1",
  workspaceRoot: "/repo/main",
});

describe("team tool — validation", () => {
  const tool = createTeamTool({ getBus: () => null });

  test("rejects unknown actions and malformed inputs", () => {
    expect(tool.validate({}).valid).toBe(false);
    expect(tool.validate({ action: "dance" }).valid).toBe(false);
    expect(tool.validate({ action: "send" }).valid).toBe(false);
    expect(tool.validate({ action: "send", message: "  " }).valid).toBe(false);
    expect(tool.validate({ action: "claim", paths: [] }).valid).toBe(false);
    expect(tool.validate({ action: "claim", paths: ["src/", 3] }).valid).toBe(false);
    expect(tool.validate({ action: "claim", paths: ["src/"], minutes: -5 }).valid).toBe(false);
    expect(tool.validate({ action: "intent" }).valid).toBe(false);
  });

  test("accepts each well-formed action", () => {
    expect(tool.validate({ action: "status" }).valid).toBe(true);
    expect(tool.validate({ action: "send", message: "hi", to: "g-x" }).valid).toBe(true);
    expect(tool.validate({ action: "claim", paths: ["src/auth/"], minutes: 10 }).valid).toBe(true);
    expect(tool.validate({ action: "release" }).valid).toBe(true);
    expect(tool.validate({ action: "intent", intent: "building X" }).valid).toBe(true);
  });
});

describe("team tool — actions against a live bus", () => {
  test("no bus → instructive failure, never a throw", async () => {
    const tool = createTeamTool({ getBus: () => null });
    const out = await tool.execute(input({ action: "status" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("not available");
  });

  test("status reports solo honestly, then shows peers/claims/mail", async () => {
    const mine = open();
    const tool = createTeamTool({ getBus: () => mine });
    let out = await tool.execute(input({ action: "status" }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("No other Rune instances");

    const peer = open();
    peer.setIntent("migrating the DB layer");
    peer.claim(["migrations/"], { reason: "schema rework" });
    peer.send("heads up: schema v2 lands today");
    out = await tool.execute(input({ action: "status" }));
    expect(out.result).toContain(peer.instanceId);
    expect(out.result).toContain("migrating the DB layer");
    expect(out.result).toContain("migrations/");
    expect(out.result).toContain("1 unread message");
  });

  test("send: broadcast + direct + unknown target", async () => {
    const mine = open();
    const peer = open();
    const tool = createTeamTool({ getBus: () => mine });
    let out = await tool.execute(input({ action: "send", message: "hello all" }));
    expect(out.success).toBe(true);
    expect(peer.drainInbox().map((m) => m.body)).toEqual(["hello all"]);

    out = await tool.execute(input({ action: "send", message: "just you", to: peer.instanceId }));
    expect(out.success).toBe(true);
    expect(peer.drainInbox().map((m) => m.body)).toEqual(["just you"]);

    out = await tool.execute(input({ action: "send", message: "x", to: "g-ghost1" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("g-ghost1");
  });

  test("claim conflict names the holder and coaches coordination", async () => {
    const mine = open();
    const peer = open();
    peer.setIntent("auth rework");
    expect(peer.claim(["src/auth/"]).ok).toBe(true);
    const tool = createTeamTool({ getBus: () => mine });
    const out = await tool.execute(input({ action: "claim", paths: ["src/auth/session.ts"] }));
    expect(out.success).toBe(false);
    expect(out.error).toContain(peer.instanceId);
    expect(out.error).toContain("auth rework");
    expect(out.error).toContain("coordinate");
  });

  test("claim + release round-trip", async () => {
    const mine = open();
    const peer = open();
    const tool = createTeamTool({ getBus: () => mine });
    const out = await tool.execute(
      input({ action: "claim", paths: ["src/ui/"], reason: "ui pass", minutes: 5 }),
    );
    expect(out.success).toBe(true);
    expect(peer.findConflictingClaim("src/ui/panel.tsx")?.instanceId).toBe(mine.instanceId);
    const rel = await tool.execute(input({ action: "release" }));
    expect(rel.success).toBe(true);
    expect(peer.findConflictingClaim("src/ui/panel.tsx")).toBeNull();
  });

  test("intent action updates presence", async () => {
    const mine = open();
    const peer = open();
    const tool = createTeamTool({ getBus: () => mine });
    await tool.execute(input({ action: "intent", intent: "shipping the release" }));
    expect(peer.peers().find((p) => p.id === mine.instanceId)?.intent).toBe("shipping the release");
  });
});

describe("/team command", () => {
  test("off-bus explains how to enable", () => {
    const lines = runTeamCommand(null, "");
    expect(lines.join("\n")).toContain("[team] enabled = true");
  });

  test("status, send, claim, release, intent, usage", () => {
    const mine = open();
    const peer = open();
    peer.setIntent("docs pass");

    expect(runTeamCommand(mine, "").join("\n")).toContain(peer.instanceId);
    expect(runTeamCommand(mine, "send all good morning").join("\n")).toContain("queued");
    expect(peer.drainInbox().map((m) => m.body)).toEqual(["good morning"]);
    expect(runTeamCommand(mine, `send ${peer.instanceId} direct hi`).join("\n")).toContain(
      "queued",
    );
    expect(peer.drainInbox().map((m) => m.body)).toEqual(["direct hi"]);

    expect(runTeamCommand(mine, "claim src/core/").join("\n")).toContain("Claimed");
    expect(peer.findConflictingClaim("src/core/x.ts")?.instanceId).toBe(mine.instanceId);
    expect(runTeamCommand(mine, "release").join("\n")).toContain("Released 1");

    expect(runTeamCommand(mine, "intent polishing the TUI").join("\n")).toContain("Intent");
    expect(peer.peers().find((p) => p.id === mine.instanceId)?.intent).toBe("polishing the TUI");

    expect(runTeamCommand(mine, "bogus").join("\n")).toContain("Usage");
  });
});

describe("renderTeamStatus", () => {
  test("shows own id and worktree distinction", () => {
    const mine = open();
    const other = open("/repo/worktree-b");
    const text = renderTeamStatus(mine);
    expect(text).toContain(mine.instanceId);
    expect(text).toContain(other.instanceId);
    expect(text).toContain("separate worktree");
  });
});
