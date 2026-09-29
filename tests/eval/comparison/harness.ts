import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import { getPreset } from "../../../packages/shared/src/providers";
import { armEnv } from "./arms/types";
import type { Arm, PilotOptions } from "./runner";
const write = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const repo = resolve(import.meta.dir, "../../..");

/**
 * A digest of the source a non-binary Rune command runs from: the tracked and
 * untracked files under packages/, crates/ and skills/. Taken before and after
 * a source run; a difference means the row measured two builds.
 */
export function sourceDigest(): string {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  if (listed.status !== 0) throw new Error(listed.stderr);
  const files = listed.stdout
    .split("\0")
    .filter((path) => /^(?:packages|crates|skills)\//.test(path))
    .sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const full = join(repo, path);
    if (existsSync(full) && lstatSync(full).isFile())
      hash.update(path + "\0").update(readFileSync(full));
  }
  return hash.digest("hex");
}

/**
 * The OpenCode arm's LIVE spend cap.
 *
 * Extracted from `runPilot`'s stdout callback so it can be compiled and tested
 * on its own. It could not be, before: the accounting sat in an inline closure
 * inside a `catch { return false; }`, in a workspace with no typecheck, so when
 * `CostTracker.record`'s signature changed the stale call throwing at runtime
 * read as "this line is not a step" — the ledger stayed at zero and the cap
 * could never fire. On a paid route that is an uncapped-spend path.
 *
 * `observe` never throws: a shape it does not recognise is not a step, and a
 * benchmark's stdout is not a contract. The parity profile does not use it:
 * no arm has a dollar ceiling there.
 */
export function openCodeBudgetWatcher(
  model: string,
  budgetUsd: number,
): { observe(event: unknown): boolean; totalListCostUsd(): number } {
  const monitor = new CostTracker();
  return {
    observe(event: unknown): boolean {
      const row = event && typeof event === "object" ? (event as Record<string, any>) : null;
      if (row?.type !== "step_finish") return false;
      const t = row.part?.tokens;
      if (!t) return false;
      monitor.record(
        model,
        "openai",
        {
          inputTokens: t.input ?? 0,
          outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
          cacheReadTokens: t.cache?.read ?? 0,
          cacheCreationTokens: t.cache?.write ?? 0,
        },
        // Every OpenCode step is the competitor's own turn as far as this side
        // can tell — the same reading `opencodeCost` takes of its database.
        // Stated rather than inherited (P3B I1).
        { role: "primary" },
      );
      return monitor.getLedger().totalListCostUsd >= budgetUsd;
    },
    totalListCostUsd: () => monitor.getLedger().totalListCostUsd,
  };
}
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
      tracker.record(
        id,
        "openai",
        {
          inputTokens: t.input ?? 0,
          outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
          cacheReadTokens: t.cache?.read ?? 0,
          cacheCreationTokens: t.cache?.write ?? 0,
        },
        // Re-pricing a competitor's ledger. OpenCode records one row per
        // assistant message and draws no line between its own overhead and the
        // work, so every row here is the agent's turn as far as this side can
        // tell — which is what `primary` means. Stating it beats inheriting a
        // default (P3B I1).
        { role: "primary" },
      );
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

// ─── Two profiles ───
//
// `pilot` is what `runPilot` and `swebench.ts` have always run: a Rune config
// that caps the run at 24 turns with no second winds and a per-task dollar
// ceiling, and an OpenCode config capped at 24 steps. Inside the pilot that is
// symmetric — both arms carry the same caps — and `swebench.ts` depends on the
// dollar ceiling, so it stays exactly as it was, and it stays the default.
//
// `parity` is what the parity index measures: each tool as it SHIPS. The pilot
// caps were a handicap the moment the other arm was Claude Code, which ran
// with no turn cap at all — so the parity profile writes no `maxTurns`, no
// `secondWinds`, no `maxSessionUsd`, no effort and no subagent or notebook
// overrides, and OpenCode loses `steps: 24`. What it keeps is ISOLATION and
// nothing else:
//
//   · a fresh RUNE_HOME, database and config path per run, so no run reads
//     another's memory, sessions or learned tactics — and `--pristine`, which
//     keeps the evolved notebook out of it;
//   · the founder's saved sign-ins, READ through RUNE_CREDENTIALS_PATH /
//     RUNE_CREDENTIAL_INDEX_PATH / RUNE_SECRETS_PATH, never copied;
//   · `--provider` / `--model` from the series, `--stream-json` for the event
//     record, and `--gear auto --auto-approve` so nothing waits on a person;
//   · an ALLOW-listed environment (`armEnv`), the same rule every comparator
//     arm is held to: a `RUNE_*` override in the founder's shell (a sandbox
//     mode, a browser switch, a model) is not a shipped default either.
//
// The parity plan is a pure value: `planParityHarness` builds it, and
// `materialiseHarness` writes its files, so a dry run can print it without
// creating anything.

export type HarnessProfile = "pilot" | "parity";

/** What the parity profile writes as Rune's config: a comment, and no setting. */
export const PARITY_RUNE_CONFIG =
  "# Parity profile: Rune's shipped defaults. Nothing is overridden here: no turn\n" +
  "# ceiling, no second winds, no dollar ceiling, no effort, no subagent settings.\n";

/** The OpenCode config the parity profile hands over: permission and sharing only. */
export function parityOpenCodeConfig(provider: string, model: string): Record<string, unknown> {
  return { permission: "allow", share: "disabled", model: `${provider}/${model}` };
}

/**
 * Names the Rune arm keeps beyond the neutral base: where its native tools
 * binary is (part of the arm, not a setting of it). The provider's own key is
 * added per run from the preset; the profile paths are SET, never inherited.
 */
export const RUNE_PARITY_ENV = ["RUNE_TOOLS_BIN", "RUNE_TOOLS_BINARY"] as const;

export interface ParityHarnessSpec {
  command: string[];
  provider: string;
  model: string;
  /** Where the allow-list, the credential paths and XDG_DATA_HOME are read from. */
  env?: NodeJS.ProcessEnv;
  /** Names the task adds for every arm alike (`taskEnvNames`). */
  taskEnv?: readonly string[];
}

export interface HarnessPlan {
  command: string[];
  env: NodeJS.ProcessEnv;
  /** Directories to create before the spawn. */
  dirs: string[];
  /** Files to write before the spawn, path → contents. */
  files: Record<string, string>;
  /** Symlinks to make before the spawn, link → target. Never a copy. */
  links: Record<string, string>;
}

/** The provider's own key variable, from the one provider roster. */
const providerKeyNames = (provider: string): string[] => {
  const envVar = getPreset(provider)?.envVar;
  return envVar ? [envVar] : [];
};

export function planParityHarness(
  arm: Arm,
  spec: ParityHarnessSpec,
  dir: string,
  root: string,
  prompt: string,
): HarnessPlan {
  const source = spec.env ?? process.env;
  const taskEnv = spec.taskEnv ?? [];
  if (arm === "rune") {
    const profile = join(dir, "profile");
    const configPath = join(profile, "config.toml");
    const sourceHome = source.RUNE_HOME ?? join(homedir(), ".rune");
    const env = armEnv(
      [...RUNE_PARITY_ENV, ...providerKeyNames(spec.provider), ...taskEnv],
      source,
    );
    Object.assign(env, {
      RUNE_HOME: profile,
      RUNE_DB_PATH: join(profile, "rune.db"),
      RUNE_CONFIG_PATH: configPath,
      RUNE_CREDENTIALS_PATH: source.RUNE_CREDENTIALS_PATH ?? join(sourceHome, "credentials.json"),
      RUNE_CREDENTIAL_INDEX_PATH:
        source.RUNE_CREDENTIAL_INDEX_PATH ?? join(sourceHome, "credentials.index.json"),
      // Saved API keys (`/keys set`) live in the home's secrets.json, not the
      // secure store. Without this the isolated profile had no ollama-turbo
      // key, the arm fell through to a retired fallback model and exited in
      // under a second as "no model usage" (2026-09-10).
      RUNE_SECRETS_PATH: source.RUNE_SECRETS_PATH ?? join(sourceHome, "secrets.json"),
    });
    // A pinned compiled build finds its native tools beside it. The isolated
    // RUNE_HOME hides the installed `~/.rune/bin/rune-tools` from the lookup,
    // so the sibling is named explicitly rather than left to PATH.
    if (!env.RUNE_TOOLS_BIN && spec.command.length === 1) {
      const sibling = join(dirname(spec.command[0]!), "rune-tools");
      if (existsSync(sibling)) env.RUNE_TOOLS_BIN = sibling;
    }
    return {
      command: [
        ...spec.command,
        "-P",
        prompt,
        "--workspace",
        root,
        "--provider",
        spec.provider,
        "--model",
        spec.model,
        "--gear",
        "auto",
        "--auto-approve",
        "--pristine",
        "--stream-json",
      ],
      env,
      dirs: [profile],
      files: { [configPath]: PARITY_RUNE_CONFIG },
      links: {},
    };
  }
  const data = join(dir, "data");
  const originalData = source.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const auth = join(originalData, "opencode", "auth.json");
  const env = armEnv([...providerKeyNames(spec.provider), ...taskEnv], source);
  Object.assign(env, {
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: join(dir, "config"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(parityOpenCodeConfig(spec.provider, spec.model)),
  });
  return {
    command: [
      ...spec.command,
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      `${spec.provider}/${spec.model}`,
      "--variant",
      "high",
      "--dir",
      root,
      prompt,
    ],
    env,
    dirs: [join(data, "opencode"), join(dir, "profile")],
    // Share the credential store, never copy refresh tokens into a second
    // independently refreshed store. The link is made only when the store
    // exists; its contents are never read here.
    links: existsSync(auth) ? { [join(data, "opencode", "auth.json")]: auth } : {},
    files: {},
  };
}

/** Write a harness plan's directories, files and links. The only side effect. */
export function materialiseHarness(plan: HarnessPlan): void {
  for (const path of plan.dirs) mkdirSync(path, { recursive: true });
  for (const [path, value] of Object.entries(plan.files)) write(path, value);
  for (const [link, target] of Object.entries(plan.links)) {
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link);
  }
}

export function prepareHarness(
  arm: Arm,
  options: PilotOptions,
  dir: string,
  root: string,
  prompt: string,
  pristine = true,
  profile: HarnessProfile = "pilot",
): { command: string[]; env: NodeJS.ProcessEnv } {
  if (profile === "parity") {
    const plan = planParityHarness(
      arm,
      {
        command: arm === "rune" ? options.runeCommand : options.opencodeCommand,
        provider: arm === "rune" ? options.runeProvider : options.opencodeProvider,
        model: options.model,
      },
      dir,
      root,
      prompt,
    );
    materialiseHarness(plan);
    return { command: plan.command, env: plan.env };
  }
  const profileDir = join(dir, "profile"),
    data = join(dir, "data");
  mkdirSync(profileDir, { recursive: true });
  const env = { ...process.env };
  let command: string[];
  if (arm === "rune") {
    const sourceHome = process.env.RUNE_HOME ?? join(homedir(), ".rune");
    Object.assign(env, {
      RUNE_HOME: profileDir,
      RUNE_DB_PATH: join(profileDir, "rune.db"),
      RUNE_CONFIG_PATH: join(profileDir, "config.toml"),
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
