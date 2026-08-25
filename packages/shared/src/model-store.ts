// ─── Last-used model store ───
// Remembers the provider+model the user last selected, so a *new* session resumes that model
// instead of resetting to the built-in default (e.g. google/gemini-2.5-flash). A tiny JSON sidecar
// at ~/.gear/model.json — same pattern as the theme sidecar and the secrets store.
//
// Precedence at startup (see gear-cli): explicit --model/--provider  >  this sidecar  >  config
// default  >  auto-detect. The sidecar is only written when the user *explicitly* switches models
// (the /model command), so it never silently shadows a freshly edited config default.
//
// Loading is lenient by design: a missing or malformed file is treated as "unset" and never throws.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getGearHome } from "./paths.js";

export interface LastModel {
  provider: string;
  model: string;
}

/**
 * Resolve the model sidecar path. Honors `GEAR_MODEL_PATH` (used by tests and advanced setups);
 * otherwise `~/.gear/model.json`. Computed per-call so the env override always takes effect.
 */
export function getModelStatePath(): string {
  const override = process.env.GEAR_MODEL_PATH;
  if (override) return override;
  return join(getGearHome(), "model.json");
}

/** Read the last-used {provider, model}, or null if unset/unreadable/malformed. Never throws. */
export function loadLastModel(): LastModel | null {
  try {
    const path = getModelStatePath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const provider = raw?.provider;
    const model = raw?.model;
    if (typeof provider === "string" && provider && typeof model === "string" && model) {
      return { provider, model };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the last-used {provider, model}. Never throws — a write failure must not crash the CLI. */
export function saveLastModel(last: LastModel): void {
  try {
    const path = getModelStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ provider: last.provider, model: last.model }, null, 2) + "\n",
    );
  } catch {
    // Ignore — the in-memory switch still applied; only persistence across sessions was lost.
  }
}
