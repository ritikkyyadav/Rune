import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import type { Arm, PilotOptions } from "./runner";
const write = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
export function runeCost(profile: string): {
  listUsd: number | null;
  models: string[];
  entries: number;
  estimated: boolean;
} {
  const path = join(profile, "rune.db");
  if (!existsSync(path)) return { listUsd: null, models: [], entries: 0, estimated: false };
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query("SELECT payload_json FROM events WHERE json_extract(payload_json,'$.type')='cost'")
      .all() as Array<{ payload_json: string }>;
    const entries = rows.map((row) => JSON.parse(row.payload_json).payload);
    return {
      listUsd:
        entries.length && entries.every((e) => e.priced)
          ? entries.reduce((total, e) => total + e.listCostUsd, 0)
          : null,
      models: [...new Set(entries.map((e) => `${e.provider}/${e.model}`))],
      entries: entries.length,
      estimated: entries.some((e) => e.estimated),
    };
  } finally {
    db.close();
  }
}
export function opencodeCost(data: string, model: string): ReturnType<typeof runeCost> {
  const path = join(data, "opencode", "opencode.db");
  if (!existsSync(path)) return { listUsd: null, models: [], entries: 0, estimated: false };
  const tracker = new CostTracker();
  const db = new Database(path, { readonly: true });
  try {
    // The isolated data directory contains this arm and its child sessions only.
    const rows = db.query("SELECT data FROM message").all() as Array<{ data: string }>;
    let entries = 0;
    for (const row of rows) {
      const message = JSON.parse(row.data);
      if (message.role !== "assistant" || !message.tokens) continue;
      const t = message.tokens;
      if (!(t.input || t.output || t.reasoning || t.cache?.read || t.cache?.write)) continue;
      const id = message.modelID ?? model;
      tracker.record(id, "openai", {
        inputTokens: t.input ?? 0,
        outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
        cacheReadTokens: t.cache?.read ?? 0,
        cacheCreationTokens: t.cache?.write ?? 0,
      });
      entries++;
    }
    const b = tracker.getBreakdown();
    return {
      listUsd: entries && !b.unpricedModels.length ? b.totalListCostUsd : null,
      models: Object.keys(b.byModel),
      entries,
      estimated: b.hasEstimatedRates,
    };
  } finally {
    db.close();
  }
}
export function prepareHarness(
  arm: Arm,
  options: PilotOptions,
  dir: string,
  root: string,
  prompt: string,
  pristine = true,
): { command: string[]; env: NodeJS.ProcessEnv } {
  const profile = join(dir, "profile"),
    data = join(dir, "data");
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env };
  let command: string[];
  if (arm === "rune") {
    const sourceHome = process.env.RUNE_HOME ?? join(homedir(), ".rune");
    Object.assign(env, {
      RUNE_HOME: profile,
      RUNE_DB_PATH: join(profile, "rune.db"),
      RUNE_CONFIG_PATH: join(profile, "config.toml"),
      RUNE_CREDENTIALS_PATH:
        process.env.RUNE_CREDENTIALS_PATH ?? join(sourceHome, "credentials.json"),
      RUNE_CREDENTIAL_INDEX_PATH:
        process.env.RUNE_CREDENTIAL_INDEX_PATH ?? join(sourceHome, "credentials.index.json"),
      // Saved API keys (`/keys set`) live in the home's secrets.json, not the
      // secure store. Without this the isolated profile had no ollama-turbo
      // key, the arm fell through to a retired fallback model and exited in
      // under a second as "no model usage" (2026-09-10).
      RUNE_SECRETS_PATH: process.env.RUNE_SECRETS_PATH ?? join(sourceHome, "secrets.json"),
    });
    write(
      env.RUNE_CONFIG_PATH!,
      `[llm]\nreasoningEffort = "high"\neffortRouting = "off"\n[cost]\nmaxSessionUsd = ${options.budgetUsd}\n[reliability]\nmaxTurns = 24\nsecondWinds = 0\n[subagents]\nmode = "mirror"\nmaxParallel = 3\n[notebook]\nenabled = false\n[evolve]\nplaybook = false\n`,
    );
    command = [
      ...options.runeCommand,
      "-P",
      prompt,
      "--workspace",
      root,
      "--provider",
      options.runeProvider,
      "--model",
      options.model,
      "--gear",
      "auto",
      "--auto-approve",
      ...(pristine ? ["--pristine"] : []),
      "--stream-json",
      "--no-browser",
    ];
  } else {
    const originalData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    mkdirSync(join(data, "opencode"), { recursive: true });
    const auth = join(originalData, "opencode", "auth.json");
    // Share the credential store, never copy refresh tokens into a second
    // independently refreshed store. It is not included in the report.
    if (existsSync(auth)) symlinkSync(auth, join(data, "opencode", "auth.json"));
    Object.assign(env, {
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: join(dir, "config"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: "allow",
        share: "disabled",
        agent: { build: { steps: 24 } },
        model: `${options.opencodeProvider}/${options.model}`,
      }),
    });
    command = [
      ...options.opencodeCommand,
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      `${options.opencodeProvider}/${options.model}`,
      "--variant",
      "high",
      "--dir",
      root,
      prompt,
    ];
  }

  return { command, env };
}
