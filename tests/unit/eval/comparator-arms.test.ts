// ─── The comparator arms, validated without a model call ───
//
// The M5 rule is that a comparator counts only once its adapter is VALIDATED,
// and the only validation available before the founder authorises a live run is
// this one: the argv, the environment, the parsing, the dry run and the
// refusal. Everything below runs offline. Nothing here spawns `claude` or
// `codex` — the dry-run test spawns a FAKE of each, and asserts that the only
// thing a dry run ever asks a comparator is `--version`.
//
// What this cannot prove is the other half, and it is worth saying in the file
// rather than only in the README: the flags are read from `--help` at the
// installed version and the captures are transcribed from the documented
// shapes, so the first authorised run is also the first live test of both.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareHarness } from "../../eval/comparison/harness";
import { comparisonPrompt, corpusTasks } from "../../eval/comparison/runner";
import {
  CLAUDE_CODE_ALLOWED_TOOLS,
  CLAUDE_CODE_DISALLOWED_TOOLS,
  claudeCodeArgv,
  claudeCodeArm,
  parseClaudeCodeOutput,
} from "../../eval/comparison/arms/claude-code";
import {
  CODEX_LAST_MESSAGE,
  codexArgv,
  codexArm,
  parseCodexOutput,
} from "../../eval/comparison/arms/codex";
import { opencodeArm } from "../../eval/comparison/arms/opencode";
import { planSeries } from "../../eval/comparison/arms/run-arms";
import type { ArmCapture, ArmLimits } from "../../eval/comparison/arms/types";
import { armEnv, credentialShaped } from "../../eval/comparison/arms/types";
import { rmTemp } from "../../helpers/tmp";

const CORPUS = join(import.meta.dir, "../../eval/corpus");
const SAMPLES = join(import.meta.dir, "../../eval/comparison/arms/samples");
const sample = (name: string) => readFileSync(join(SAMPLES, name), "utf8");

const LIMITS: ArmLimits = {
  timeoutMs: 600_000,
  budgetUsd: 2,
  model: "synthetic-model",
  reasoningEffort: "high",
};

/** The first corpus task, with the prompt both runners send. */
function firstTask() {
  const task = corpusTasks(CORPUS)[0]!;
  return { id: task.id, prompt: comparisonPrompt(task, undefined) };
}

const capture = (overrides: Partial<ArmCapture> = {}): ArmCapture => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1000,
  ...overrides,
});

describe("the exact argv, cwd and environment", () => {
  test("Claude Code: print, json, the confinement flags, and the prompt verbatim and last", () => {
    const task = firstTask();
    const plan = claudeCodeArm.plan(task, "/evidence/csv-claude-code", LIMITS);
    expect(plan.command).toEqual([
      "claude",
      "--print",
      "--output-format",
      "json",
      "--model",
      "synthetic-model",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Edit,MultiEdit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite",
      "--disallowedTools",
      "WebFetch,WebSearch",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-budget-usd",
      "2",
      task.prompt,
    ]);
    // The fixture directory, and no `--add-dir`: the working directory is the
    // only directory the file tools may write.
    expect(plan.cwd).toBe("/evidence/csv-claude-code/workspace");
    expect(plan.command).not.toContain("--add-dir");
    expect(plan.command).not.toContain("--dangerously-skip-permissions");
    // The prompt is one argv element, never a shell string, and it is the
    // task's own text — the rig's autonomy footer and nothing else added.
    expect(plan.command.at(-1)).toBe(task.prompt);
    expect(plan.command.filter((token) => token === task.prompt)).toHaveLength(1);
    expect(task.prompt.startsWith("Repair parseCsv in csv.ts.")).toBe(true);
    expect(task.prompt.startsWith("-")).toBe(false);
    // The allow list and the deny list are single comma-separated tokens, so a
    // variadic option can never swallow the positional prompt.
    expect(claudeCodeArgv(task.prompt, LIMITS)).toContain(CLAUDE_CODE_ALLOWED_TOOLS.join(","));
    expect(claudeCodeArgv(task.prompt, LIMITS)).toContain(CLAUDE_CODE_DISALLOWED_TOOLS.join(","));
  });

  test("Codex: exec, json, workspace-write with no network, effort by config override", () => {
    const task = firstTask();
    const plan = codexArm.plan(task, "/evidence/csv-codex", LIMITS);
    expect(plan.command).toEqual([
      "codex",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'model_reasoning_effort="high"',
      "-m",
      "synthetic-model",
      "--ignore-user-config",
      "--color",
      "never",
      "-C",
      "/evidence/csv-codex/workspace",
      "--output-last-message",
      `/evidence/csv-codex/${CODEX_LAST_MESSAGE}`,
      task.prompt,
    ]);
    expect(plan.cwd).toBe("/evidence/csv-codex/workspace");
    // The sandbox is never turned off, whatever else changes here.
    expect(plan.command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(plan.command).not.toContain("danger-full-access");
    // The answer text lands OUTSIDE the workspace, so it can never become a
    // file the acceptance grades.
    expect(plan.artifacts!.lastMessage!.startsWith(plan.cwd)).toBe(false);
    expect(codexArgv(task.prompt, "/w", { ...LIMITS, reasoningEffort: undefined })).not.toContain(
      "model_reasoning_effort",
    );
  });

  test("each arm keeps its own auth and nothing else", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/founder",
      ANTHROPIC_API_KEY: "sk-ant-synthetic",
      CLAUDE_CODE_OAUTH_TOKEN: "oat-synthetic",
      OPENAI_API_KEY: "sk-openai-synthetic",
      OPENROUTER_API_KEY: "sk-or-synthetic",
      AWS_SECRET_ACCESS_KEY: "aws-synthetic",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/founder/gcp.json",
      SCW_SECRET_KEY: "scw-synthetic",
      RUNE_HOME: "/evidence/profile",
      RUNE_DB_PATH: "/evidence/profile/rune.db",
    };
    const claude = armEnv(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
      base,
    );
    expect(Object.keys(claude).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "HOME",
      "PATH",
    ]);
    const codex = armEnv(["OPENAI_API_KEY"], base);
    expect(Object.keys(codex).sort()).toEqual(["HOME", "OPENAI_API_KEY", "PATH"]);
    // Rune's own configuration never reaches a comparator: it would be reading
    // the measuring instrument.
    expect(codex.RUNE_HOME).toBeUndefined();
    // The predicate is the capture rig's — suffixes plus the documented chain —
    // so a provider nobody listed is still scrubbed.
    expect(credentialShaped("SCW_SECRET_KEY")).toBe(true);
    expect(credentialShaped("SOMEHOST_SECRET")).toBe(true);
    expect(credentialShaped("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(credentialShaped("PATH")).toBe(false);
  });

  test("the OpenCode arm is the SAME arm: identical argv and env to prepareHarness", () => {
    const task = firstTask();
    // Real directories, one each: `prepareHarness` creates the arm's profile
    // and symlinks the shared OpenCode credential store, which is part of what
    // "identical" means here and cannot be done twice into one directory.
    const dir = mkdtempSync(join(tmpdir(), "arm-opencode-"));
    const twin = mkdtempSync(join(tmpdir(), "arm-opencode-twin-"));
    const plan = opencodeArm.plan(task, dir, LIMITS);
    const prepared = prepareHarness(
      "opencode",
      {
        out: "",
        model: "synthetic-model",
        runeProvider: "",
        opencodeProvider: "openai",
        budgetUsd: 2,
        timeoutMs: 600_000,
        runs: 1,
        runeCommand: [],
        opencodeCommand: ["opencode"],
        route: "live",
      },
      twin,
      `${twin}/workspace`,
      task.prompt,
    );
    // The evidence directory is the only thing that differs, so it is the only
    // thing normalised away.
    const here = (value: string) => value.split(twin).join(dir);
    expect(plan.command).toEqual(prepared.command.map(here));
    expect(
      Object.fromEntries(Object.entries(plan.env).map(([k, v]) => [k, here(v ?? "")])),
    ).toEqual(Object.fromEntries(Object.entries(prepared.env).map(([k, v]) => [k, here(v ?? "")])));
    rmTemp(dir);
    rmTemp(twin);
  });
});

describe("parsing the recorded captures — synthetic, credential-free", () => {
  test("Claude Code: a finished run is scored, with its usage, turns and cost", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stdout: sample("claude-code.success.stdout.txt") }),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.turns).toBe(9);
    expect(parsed.reportedCostUsd).toBe(0.4213);
    expect(parsed.usage).toEqual({
      inputTokens: 5120,
      outputTokens: 3310,
      reasoningTokens: 0,
      cacheReadTokens: 204810,
      cacheWriteTokens: 18422,
    });
    expect(parsed.models).toEqual(["claude-synthetic-model"]);
    expect(parsed.resultText).toContain("All 14 tests pass");
  });

  test("Claude Code: a turn ceiling is the comparator failing the task, and stays scored", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stdout: sample("claude-code.max-turns.stdout.txt"), exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.detail).toBe("error_max_turns");
    expect(parsed.usage!.inputTokens).toBe(9110);
  });

  test("Claude Code: prose about rate limits is task evidence, not an outage", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stdout: sample("claude-code.quota-prose.stdout.txt") }),
    );
    expect(parsed.outcome).toBe("scored");
    expect(parsed.resultText).toContain("429");
  });

  test("Claude Code: a quota refusal is unscored, with usage retained", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stderr: sample("claude-code.quota.stderr.txt"), exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("unscored:provider_quota");
    expect(parsed.unscoredReason).toBe("provider_quota");
  });

  test("Claude Code: an auth failure is unscored, not a failed task", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stderr: sample("claude-code.auth.stderr.txt"), exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("unscored:provider_authentication");
  });

  test("Claude Code: a killed tree is unscored:timeout whatever it printed", () => {
    const parsed = parseClaudeCodeOutput(
      capture({
        stdout: sample("claude-code.timeout.stdout.txt"),
        exitCode: null,
        stopped: "timeout",
      }),
    );
    expect(parsed.outcome).toBe("unscored:timeout");
  });

  test("Claude Code: a truncated envelope is an error — neither a score nor an outage", () => {
    const parsed = parseClaudeCodeOutput(
      capture({ stdout: sample("claude-code.malformed.stdout.txt") }),
    );
    expect(parsed.outcome).toBe("error");
    expect(parsed.detail).toBe("malformed envelope");
    expect(parsed.usage).toBeNull();
  });

  test("Codex: a finished turn is scored, usage summed, answer from the agent_message item", () => {
    const parsed = parseCodexOutput(capture({ stdout: sample("codex.success.events.txt") }));
    expect(parsed.outcome).toBe("scored");
    expect(parsed.usage).toEqual({
      inputTokens: 41200,
      outputTokens: 5300,
      reasoningTokens: 4100,
      cacheReadTokens: 38000,
      cacheWriteTokens: 2100,
    });
    expect(parsed.turns).toBe(1);
    expect(parsed.resultText).toContain("state machine");
    // Codex prints no dollar figure at this version. Null, never zero.
    expect(parsed.reportedCostUsd).toBeNull();
  });

  test("Codex: --output-last-message wins over the event text when both exist", () => {
    const parsed = parseCodexOutput(
      capture({
        stdout: '{"type":"turn.completed","usage":{"input_tokens":10}}',
        lastMessage: "the final answer\n",
      }),
    );
    expect(parsed.resultText).toBe("the final answer");
  });

  test("Codex: a quota refusal is unscored and the completed turn's usage is kept", () => {
    const parsed = parseCodexOutput(
      capture({ stdout: sample("codex.quota.events.txt"), exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("unscored:provider_quota");
    expect(parsed.usage!.inputTokens).toBe(8100);
  });

  test("Codex: an auth failure is unscored", () => {
    const parsed = parseCodexOutput(
      capture({ stdout: sample("codex.auth.events.txt"), exitCode: 1 }),
    );
    expect(parsed.outcome).toBe("unscored:provider_authentication");
  });

  test("Codex: a stream killed on the clock is unscored:timeout", () => {
    const parsed = parseCodexOutput(
      capture({ stdout: sample("codex.timeout.events.txt"), exitCode: null, stopped: "timeout" }),
    );
    expect(parsed.outcome).toBe("unscored:timeout");
  });

  test("Codex: a stream with no parsable event is an error", () => {
    const parsed = parseCodexOutput(
      capture({ stdout: sample("codex.malformed.events.txt"), exitCode: 0 }),
    );
    expect(parsed.outcome).toBe("error");
  });

  test("Codex: the non-JSON form's usage line is read as a floor", () => {
    const parsed = parseCodexOutput(capture({ stdout: sample("codex.plain-usage.stdout.txt") }));
    // No events: the row is an error, and the usage is still recorded, because
    // "the flag was missing" must never look like "the run cost nothing".
    expect(parsed.outcome).toBe("error");
    expect(parsed.usage!.inputTokens).toBe(50600);
  });
});

describe("--dry-run prints the plan for all twelve tasks and executes nothing", () => {
  /**
   * A stand-in for a comparator: it appends its argv to a log and prints a
   * version. The log path is baked into the script rather than read from the
   * environment, because the environment is exactly what these arms scrub.
   */
  function fakeTool(dir: string, name: string, log: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho "${name} 0.0.0-fake"\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  test("twenty-four planned runs, and the only child process is --version", () => {
    const dir = mkdtempSync(join(tmpdir(), "arm-dry-run-"));
    try {
      const log = join(dir, "argv.log");
      writeFileSync(log, "");
      fakeTool(dir, "claude", log);
      fakeTool(dir, "codex", log);
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dir, "../../eval/comparison/arms/run-arms.ts"),
          "--dry-run",
          "--arms",
          "claude-code,codex",
          "--corpus",
          CORPUS,
          "--model",
          "synthetic-model",
          "--out",
          join(dir, "out"),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          timeout: 120_000,
        },
      );
      expect(result.status).toBe(0);
      const lines = result.stdout.split("\n");
      // Every one of the twelve pinned tasks, twice — once per arm.
      for (const task of corpusTasks(CORPUS))
        expect(lines.filter((line) => line.includes(`${task.id} ·`))).toHaveLength(2);
      expect(result.stdout).toContain("24 run(s) planned");
      expect(result.stdout).toContain("claude-code: version claude 0.0.0-fake");
      expect(result.stdout).toContain("codex: version codex 0.0.0-fake");
      // The plan a reviewer reads is the plan the live path would run.
      expect(result.stdout).toContain("--permission-prompts");
      expect(result.stdout).toContain("sandbox_workspace_write.network_access=false");
      // And the proof that nothing ran: the comparators were asked for their
      // version and were never asked for a turn.
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["--version", "--version"]);
    } finally {
      rmTemp(dir);
    }
  });

  test("planSeries names every task once per arm and spawns nothing but --version", () => {
    const dir = mkdtempSync(join(tmpdir(), "arm-plan-"));
    try {
      const log = join(dir, "argv.log");
      writeFileSync(log, "");
      const claude = fakeTool(dir, "claude", log);
      const codex = fakeTool(dir, "codex", log);
      const plan = planSeries({
        arms: ["claude-code", "codex"],
        out: join(dir, "out"),
        corpus: CORPUS,
        model: "synthetic-model",
        reasoningEffort: "high",
        budgetUsd: 2,
        timeoutMs: 600_000,
        command: { "claude-code": [claude], codex: [codex] },
      });
      expect(plan.runs).toHaveLength(24);
      expect(new Set(plan.runs.map((run) => run.task)).size).toBe(12);
      expect(plan.versions).toEqual({
        "claude-code": "claude 0.0.0-fake",
        codex: "codex 0.0.0-fake",
      });
      // Two version probes for the plan header, and one more per arm for the
      // parity block. Nothing else, and never a prompt.
      const argv = readFileSync(log, "utf8").trim().split("\n");
      expect(new Set(argv)).toEqual(new Set(["--version"]));
    } finally {
      rmTemp(dir);
    }
  });
});
