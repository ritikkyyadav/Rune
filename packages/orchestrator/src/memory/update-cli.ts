// ─── `rune memory update` — the user's hand, outside the TUI ───
//
// `rune memory` is otherwise a zero-spend surface: it reads the store, and the
// only writes are the user's own forget/pin/clear. `update` is the deliberate
// exception, and it exists because the founder's three modes put the user in
// charge of `manual` — a control that only works inside the TUI is not a
// control the person holds.
//
// So this builds the smallest Engine that can do the two halves of an update:
// the deterministic extractor over the most recent session, then one cheap
// model call to refresh the profile. Everything optional is off — no MCP, no
// skills, no hooks, no checkpoints — because none of it is memory.

import { join } from "path";
import { loadConfig, loadLastModel, type MemoryMode } from "@rune/shared";

export interface MemoryUpdateCliOptions {
  workspace: string;
  focus?: string;
  out: (line: string) => void;
}

/** Exit code: 0 when the profile changed or nothing needed changing, 1 on a refusal. */
export async function runMemoryUpdateCli(opts: MemoryUpdateCliOptions): Promise<number> {
  const { Engine } = await import("../engine");
  const config = loadConfig(opts.workspace);
  const last = loadLastModel();
  const provider = last?.provider ?? config.llm?.defaultProvider ?? "anthropic";
  const model = last?.model ?? "";

  const engine = new Engine({
    model,
    provider: provider as never,
    workspaceRoot: opts.workspace,
    dbPath: config.engine?.dbPath ?? join(opts.workspace, ".rune", "rune.db"),
    toolsBinaryPath: process.env.RUNE_TOOLS_BIN ?? "rune-tools",
    yoloMode: false,
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    // The memory config is the whole point: pass it through so the mode the
    // user chose is the mode this command obeys.
    memory: config.memory,
  });

  try {
    const mode: MemoryMode = engine.memoryMode();
    if (mode === "off") {
      opts.out("  memory is off — `rune memory auto` or `rune memory manual` turns it on");
      return 1;
    }
    // "The current session", outside a session: the most recently active one.
    // A profile refresh reads every session's new activity anyway; this only
    // decides whose words the extractor reads.
    const sessions = engine.listSessions({ status: "all" });
    const sessionId = sessions[0]?.id ?? engine.createSession();
    const r = await engine.updateMemoryNow(sessionId, { focus: opts.focus });
    if (r.learned && r.learned.promoted > 0) {
      opts.out(`  learned ${r.learned.promoted} thing(s) from that session`);
    }
    if (!r.updated) {
      opts.out(`  profile unchanged — ${r.reason}`);
      return 1;
    }
    opts.out(`  profile updated — ~${r.tokensBefore} → ~${r.tokensAfter} tokens`);
    return 0;
  } finally {
    engine.close();
  }
}
