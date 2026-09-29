// ─── Fairness: every arm judged by one rule ───
//
// The parity index compares Rune with a tool it did not write, so the rig's
// rules are the result as much as the tools are. Before this lane each arm
// decided for itself what counted and they disagreed — a Claude Code timeout
// was unscored while a Rune timeout was a scored failure, a comparator's crash
// after an hour of work left the denominator while Rune's stayed in it, Rune
// ran under a 24-turn cap the comparator never had — and every one of those
// moved rows out of one column and not the other.
//
// This file holds the rig to the contract (tests/eval/parity/types.ts):
//
//   · ONE classifier. The same synthetic situations go through every arm's
//     own parser, written in that tool's own output vocabulary, and must come
//     out identical — scored or unscored, and why.
//   · The parity profile: Rune on its shipped defaults (isolation only), and
//     OpenCode without its step cap.
//   · The Claude Code arm's two modes, flag for flag, at the pinned version.
//   · The Rune arm, through the same interface, against a fake binary.
//   · A series that no longer stops on its first unscored row.
//
// Nothing here reaches a model. Every executable is a fake written into a
// temporary directory, and every environment is synthetic.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_CODE_PINNED_VERSION,
  CLAUDE_PARITY_CONFIG_ENV,
  claudeCodeArgv,
  claudeCodeArm,
  harnessConfigDir,
} from "../../eval/comparison/arms/claude-code";
import { ARMS } from "../../eval/comparison/arms/run-arms";
import { RUNE_NEEDS_MODEL, runeArm } from "../../eval/comparison/arms/rune";
import {
  type ArmCapture,
  type ArmLimits,
  type ArmName,
  type Classification,
  type OutcomeSignals,
  UNSCORED_STOP_SHARE,
  classifyOutcome,
  tooManyUnscored,
} from "../../eval/comparison/arms/types";
import {
  PARITY_RUNE_CONFIG,
  planParityHarness,
  prepareHarness,
} from "../../eval/comparison/harness";
import { runPilot } from "../../eval/comparison/runner";
import { rmTemp } from "../../helpers/tmp";

const scratch: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmTemp(dir);
});

/**
 * Run `body` with some of this process's environment replaced, then put it
 * back. The pilot profile reads `XDG_DATA_HOME` to find OpenCode's credential
 * store; pointing it at a scratch directory keeps these tests from so much as
 * looking for the founder's.
 */
async function withEnv<T>(vars: Record<string, string>, body: () => T | Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

const PROMPT = "Repair parseCsv in csv.ts.";

// ─── The situations, in each tool's own words ───

const cap = (over: Partial<ArmCapture> = {}): ArmCapture => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1000,
  ...over,
});
const lines = (...rows: unknown[]) =>
  rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n");

/** Claude Code prints ONE envelope when the turn ends, and nothing before it. */
const claude = {
  envelope: (fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result: "Fixed parseCsv; the tests pass.",
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 20 },
      ...fields,
    }),
  apiError: (text: string) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      result: text,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
};

/** Codex streams JSONL events for its one turn. */
const codex = {
  start: [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }],
  work: { type: "item.completed", item: { type: "command_execution", command: "bun test" } },
  answer: (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } }),
  done: { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  failed: (message: string) => ({ type: "turn.failed", error: { message } }),
};

/** Rune streams engine events (`--stream-json`) and prints its envelope last. */
const rune = {
  usage: { type: "usage", inputTokens: 100, outputTokens: 20 },
  turn: (stopReason: string) => ({ type: "turn_complete", stopReason, totalTurns: 3 }),
  error: (error: string, recoverable = false) => ({ type: "error", error, recoverable }),
  envelope: (ok: boolean, fields: Record<string, unknown> = {}) => ({
    ok,
    text: "Fixed parseCsv; the tests pass.",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
    ...fields,
  }),
};

/** OpenCode streams JSON events; its ledger is a sqlite file the rig re-prices. */
const opencode = {
  step: { type: "step_finish", part: { tokens: { input: 100, output: 20 } } },
  text: (text: string) => ({ type: "text", part: { text } }),
  error: (statusCode: number, message: string) => ({
    type: "error",
    error: { data: { statusCode, message } },
  }),
};

interface Situation {
  name: string;
  expected: Classification;
  /** The tool reported success. False unless stated. */
  claimed?: boolean;
  /** What the rig adds from outside the tool (the workspace, the build). */
  rig?: Partial<OutcomeSignals>;
  /** Each arm's capture, or a reason the tool has no way to be in this state. */
  captures: Record<ArmName, ArmCapture | string>;
}

const KILLED = { exitCode: null, stopped: "timeout" } as const;
const FINISHED: Record<ArmName, ArmCapture> = {
  "claude-code": cap({ stdout: claude.envelope() }),
  codex: cap({ stdout: lines(...codex.start, codex.work, codex.answer("Fixed."), codex.done) }),
  rune: cap({ stdout: lines(rune.usage, rune.turn("end_turn"), rune.envelope(true)) }),
  opencode: cap({ stdout: lines(opencode.step) }),
};
const SILENT_EXIT: ArmCapture = cap({ exitCode: 1 });

const SITUATIONS: Situation[] = [
  {
    name: "finished, and said so",
    expected: { scored: true },
    claimed: true,
    captures: FINISHED,
  },
  {
    name: "the clock ran out after the model was reached",
    expected: { scored: true, failure: "timeout" },
    captures: {
      // Killed before its one envelope: nothing on stdout at all.
      "claude-code": cap(KILLED),
      codex: cap({ stdout: lines(...codex.start, codex.work), ...KILLED }),
      rune: cap({ stdout: lines(rune.usage), ...KILLED }),
      opencode: cap({ stdout: lines(opencode.step), ...KILLED }),
    },
  },
  {
    name: "the clock ran out before any model call",
    expected: { scored: true, failure: "timeout" },
    captures: {
      "claude-code": cap(KILLED),
      codex: cap(KILLED),
      rune: cap(KILLED),
      opencode: cap(KILLED),
    },
  },
  {
    name: "the clock ran out while the tool was complaining about a rate limit",
    // Text a process wrote while it was still running is not a terminal
    // report: it may well have been retrying. The clock ended it.
    expected: { scored: true, failure: "timeout" },
    captures: {
      "claude-code": cap({ stderr: "API Error: 429 rate limit reached · retrying", ...KILLED }),
      codex: cap({ stderr: "429 Too Many Requests: rate limit reached, retrying", ...KILLED }),
      rune: cap({ stderr: "429 Too Many Requests: rate limit reached, retrying", ...KILLED }),
      opencode: cap({ stderr: "429 Too Many Requests: rate limit reached, retrying", ...KILLED }),
    },
  },
  {
    name: "a provider error the tool was recovering from, then the clock",
    expected: { scored: true, failure: "timeout" },
    captures: {
      "claude-code":
        "Claude Code retries inside its one envelope; killed, it prints nothing to say it was retrying",
      codex: cap({
        stdout: lines(...codex.start, {
          type: "error",
          message: "stream disconnected; Reconnecting... 1/5",
        }),
        ...KILLED,
      }),
      rune: cap({
        stdout: lines(rune.error("503 Service Unavailable", true), rune.usage),
        ...KILLED,
      }),
      opencode: cap({ stdout: lines(opencode.error(503, "Service Unavailable")), ...KILLED }),
    },
  },
  {
    name: "a terminal refusal the tool reported, and then the clock",
    // Precedence 3: a tool waiting on a refused request was not going to finish.
    expected: { scored: false, unscoredReason: "provider_quota" },
    captures: {
      "claude-code": "Claude Code reports a refusal only in the envelope it prints as it exits",
      codex: cap({
        stdout: lines(...codex.start, codex.failed("You've hit your usage limit.")),
        ...KILLED,
      }),
      rune: cap({ stdout: lines(rune.error("429 Too Many Requests: usage limit")), ...KILLED }),
      opencode:
        "OpenCode's error events do not say whether they are terminal; one followed by a kill was said by a process still running",
    },
  },
  {
    name: "a terminal quota refusal",
    expected: { scored: false, unscoredReason: "provider_quota" },
    captures: {
      "claude-code": cap({
        stdout: claude.apiError("Claude AI usage limit reached|1760000000"),
        exitCode: 1,
      }),
      codex: cap({
        stdout: lines(
          ...codex.start,
          codex.failed("You've hit your usage limit. Try again later."),
        ),
        exitCode: 1,
      }),
      rune: cap({
        stdout: lines(
          rune.error("429 Too Many Requests: usage limit reached"),
          rune.envelope(false, { error: "429 Too Many Requests: usage limit reached" }),
        ),
        exitCode: 1,
      }),
      opencode: cap({ stdout: lines(opencode.error(429, "Rate limit reached")), exitCode: 1 }),
    },
  },
  {
    name: "a terminal authentication refusal",
    expected: { scored: false, unscoredReason: "provider_auth" },
    captures: {
      "claude-code": cap({
        stdout: claude.apiError("Invalid API key · Please run /login"),
        exitCode: 1,
      }),
      codex: cap({
        stdout: lines(...codex.start, codex.failed("401 Unauthorized: not authenticated")),
        exitCode: 1,
      }),
      rune: cap({
        stdout: lines(
          rune.error("401 Unauthorized: invalid api key"),
          rune.envelope(false, { error: "401 Unauthorized: invalid api key" }),
        ),
        exitCode: 1,
      }),
      opencode: cap({ stdout: lines(opencode.error(401, "Unauthorized")), exitCode: 1 }),
    },
  },
  {
    name: "the provider answered 5xx until the tool gave up",
    expected: { scored: false, unscoredReason: "provider_outage" },
    captures: {
      "claude-code": cap({ stdout: claude.apiError("API Error: 529 Overloaded"), exitCode: 1 }),
      codex: cap({
        stdout: lines(...codex.start, codex.failed("unexpected status 503 Service Unavailable")),
        exitCode: 1,
      }),
      rune: cap({
        stdout: lines(
          rune.error("503 Service Unavailable"),
          rune.turn("provider_lost"),
          rune.envelope(false, { stopReason: "provider_lost", error: "503 Service Unavailable" }),
        ),
        exitCode: 1,
      }),
      opencode: cap({ stdout: lines(opencode.error(503, "Service Unavailable")), exitCode: 1 }),
    },
  },
  {
    name: "the connection dropped and no completion was possible",
    expected: { scored: false, unscoredReason: "provider_outage" },
    captures: {
      "claude-code": cap({ stdout: claude.apiError("API Error: Connection error."), exitCode: 1 }),
      codex: cap({
        stdout: lines(...codex.start, codex.failed("stream disconnected before completion")),
        exitCode: 1,
      }),
      rune: cap({
        stdout: lines(
          rune.error("fetch failed: ECONNRESET"),
          rune.envelope(false, { error: "fetch failed: ECONNRESET" }),
        ),
        exitCode: 1,
      }),
      opencode: cap({ stdout: lines({ type: "error", error: "socket hang up" }), exitCode: 1 }),
    },
  },
  {
    name: "a crash before any model call",
    expected: { scored: false, unscoredReason: "crash_before_first_call" },
    captures: {
      "claude-code": cap({ stderr: "TypeError: Cannot read properties of undefined", exitCode: 1 }),
      codex: cap({ stderr: "thread 'main' panicked at src/main.rs:1:1", exitCode: 101 }),
      rune: cap({ stderr: "error: Cannot find module './engine'", exitCode: 1 }),
      opencode: cap({ stderr: "panic: runtime error: nil pointer", exitCode: 1 }),
    },
  },
  {
    name: "a crash after the model was reached",
    expected: { scored: true, failure: "unfinished" },
    captures: {
      "claude-code": cap({
        stdout: claude.envelope({ subtype: "error_during_execution", is_error: true, result: "" }),
        exitCode: 1,
      }),
      codex: cap({ stdout: lines(...codex.start, codex.work), exitCode: 1 }),
      rune: cap({
        stdout: lines(rune.usage),
        stderr: "TypeError: x is not a function",
        exitCode: 1,
      }),
      opencode: cap({ stdout: lines(opencode.step), stderr: "TypeError", exitCode: 1 }),
    },
  },
  {
    name: "the tool stopped at its own turn ceiling",
    expected: { scored: true, failure: "turn_limit" },
    captures: {
      "claude-code": cap({
        stdout: claude.envelope({ subtype: "error_max_turns", is_error: true, result: "" }),
        exitCode: 1,
      }),
      codex: "Codex has no turn ceiling of its own",
      rune: cap({
        stdout: lines(
          rune.usage,
          rune.turn("max_turns"),
          rune.envelope(false, {
            stopReason: "max_turns",
            error: "The run hit its turn ceiling without finishing; the output above is partial.",
          }),
        ),
        exitCode: 1,
      }),
      opencode: "the parity profile gives OpenCode no step cap, so it has no turn ceiling",
    },
  },
  {
    name: "the tool stopped at its own dollar ceiling",
    expected: { scored: true, failure: "budget_limit" },
    captures: {
      "claude-code": cap({
        stdout: claude.envelope({ subtype: "error_max_budget_usd", is_error: true, result: "" }),
        exitCode: 1,
      }),
      codex: "Codex has no dollar ceiling of its own",
      rune: cap({
        stdout: lines(
          rune.usage,
          rune.turn("budget"),
          rune.envelope(false, {
            stopReason: "budget",
            error:
              "The request was refused before it was sent because the run was out of budget; the task is not finished.",
          }),
        ),
        exitCode: 1,
      }),
      // The rig's watcher stands in for the ceiling OpenCode does not have.
      opencode: cap({ stdout: lines(opencode.step), exitCode: null, stopped: "cost limit" }),
    },
  },
  {
    name: "a finished answer that talks about rate limits",
    expected: { scored: true },
    claimed: true,
    captures: {
      "claude-code": cap({
        stdout: claude.envelope({
          result:
            "The client now retries on HTTP 429 Too Many Requests when the usage limit is reached.",
        }),
      }),
      codex: cap({
        stdout: lines(
          ...codex.start,
          codex.answer("Retries on 429 Too Many Requests when the usage limit is reached."),
          codex.done,
        ),
      }),
      rune: cap({
        stdout: lines(
          { type: "text_delta", text: "Retries on 429 Too Many Requests (rate limit)." },
          rune.usage,
          rune.turn("end_turn"),
          rune.envelope(true, { text: "Retries on 429 Too Many Requests (rate limit)." }),
        ),
      }),
      opencode: cap({
        stdout: lines(
          opencode.text("Retries on 429 Too Many Requests (rate limit)."),
          opencode.step,
        ),
      }),
    },
  },
  {
    name: "a provider hiccup the tool recovered from, then finished",
    expected: { scored: true },
    claimed: true,
    captures: {
      "claude-code": cap({
        stdout: claude.envelope(),
        stderr: "API Error: 529 Overloaded · retrying in 2s (attempt 1/10)",
      }),
      codex: cap({
        stdout: lines(
          ...codex.start,
          { type: "error", message: "stream disconnected before completion; Reconnecting... 1/5" },
          codex.answer("Fixed."),
          codex.done,
        ),
      }),
      rune: cap({
        stdout: lines(
          rune.error("503 Service Unavailable", true),
          rune.usage,
          rune.turn("end_turn"),
          rune.envelope(true),
        ),
      }),
      opencode: cap({ stdout: lines(opencode.error(503, "Service Unavailable"), opencode.step) }),
    },
  },
  {
    name: "exited without a word, but the task's files changed",
    // The rig's own evidence of work: a tool that left no ledger but changed
    // the tree had reached the model, and its crash is its own.
    expected: { scored: true, failure: "unfinished" },
    rig: { workspaceTouched: true },
    captures: {
      "claude-code": SILENT_EXIT,
      codex: SILENT_EXIT,
      rune: SILENT_EXIT,
      opencode: SILENT_EXIT,
    },
  },
  {
    name: "exited without a word, and nothing changed",
    expected: { scored: false, unscoredReason: "crash_before_first_call" },
    rig: { workspaceTouched: false },
    captures: {
      "claude-code": SILENT_EXIT,
      codex: SILENT_EXIT,
      rune: SILENT_EXIT,
      opencode: SILENT_EXIT,
    },
  },
  {
    name: "the measured build changed under the run",
    expected: { scored: false, unscoredReason: "source_changed" },
    claimed: true,
    rig: { sourceChanged: true },
    captures: FINISHED,
  },
];

const ARM_NAMES: ArmName[] = ["claude-code", "codex", "rune", "opencode"];

describe("one classifier: the same situation comes out the same for every arm", () => {
  for (const situation of SITUATIONS)
    test(situation.name, () => {
      const verdicts = new Map<ArmName, Classification>();
      for (const arm of ARM_NAMES) {
        const capture = situation.captures[arm];
        if (typeof capture === "string") continue;
        const parsed = ARMS[arm].parse(capture);
        // The parser's own verdict IS the shared classifier's, on its facts.
        expect({
          scored: parsed.scored,
          ...(parsed.unscoredReason ? { unscoredReason: parsed.unscoredReason } : {}),
          ...(parsed.failure ? { failure: parsed.failure } : {}),
        }).toEqual(classifyOutcome(parsed.signals));
        expect(parsed.outcome as string).toBe(
          parsed.scored ? "scored" : `unscored:${parsed.unscoredReason}`,
        );
        const verdict = classifyOutcome({ ...parsed.signals, ...situation.rig });
        verdicts.set(arm, verdict);
        expect({ arm, verdict }).toEqual({ arm, verdict: situation.expected });
        expect({ arm, claimed: parsed.claimedSuccess }).toEqual({
          arm,
          claimed: situation.claimed ?? false,
        });
      }
      // At least two tools can be in every situation, or it compares nothing.
      expect(verdicts.size).toBeGreaterThanOrEqual(2);
    });

  test("every arm is in every situation it can be in, and says why when it cannot", () => {
    for (const situation of SITUATIONS)
      for (const arm of ARM_NAMES) {
        const capture = situation.captures[arm];
        if (typeof capture === "string") expect(capture.length).toBeGreaterThan(20);
      }
    // Rune and Claude Code — the headline pair — are both in all but the two
    // states only a streaming tool can be in.
    const both = SITUATIONS.filter(
      (s) => typeof s.captures.rune !== "string" && typeof s.captures["claude-code"] !== "string",
    );
    expect(both.length).toBe(SITUATIONS.length - 2);
  });
});

describe("the classifier's order, stated once", () => {
  const base: OutcomeSignals = { exitCode: 1, claimedSuccess: false, reachedModel: true };

  test("a timeout is the tool failing, whether or not it had reached the model", () => {
    for (const reachedModel of [true, false, null])
      expect(classifyOutcome({ ...base, reachedModel, stopped: "timeout" })).toEqual({
        scored: true,
        failure: "timeout",
      });
  });

  test("a changed build outranks everything, a claimed success outranks a provider error", () => {
    expect(
      classifyOutcome({ ...base, claimedSuccess: true, exitCode: 0, sourceChanged: true }),
    ).toEqual({ scored: false, unscoredReason: "source_changed" });
    expect(
      classifyOutcome({ ...base, claimedSuccess: true, exitCode: 0, provider: "quota" }),
    ).toEqual({ scored: true });
  });

  test("a terminal refusal outranks the clock that also ran out", () => {
    expect(classifyOutcome({ ...base, provider: "auth", stopped: "timeout" })).toEqual({
      scored: false,
      unscoredReason: "provider_auth",
    });
  });

  test("a crash counts once a call went through, by the ledger or by the tree", () => {
    const crash = { ...base, reachedModel: false };
    expect(classifyOutcome(crash)).toEqual({
      scored: false,
      unscoredReason: "crash_before_first_call",
    });
    expect(classifyOutcome({ ...crash, reachedModel: null })).toEqual({
      scored: false,
      unscoredReason: "crash_before_first_call",
    });
    expect(classifyOutcome({ ...crash, workspaceTouched: true })).toEqual({
      scored: true,
      failure: "unfinished",
    });
    expect(classifyOutcome(base)).toEqual({ scored: true, failure: "unfinished" });
  });
});

describe("a series stops only when MORE than a quarter is unscored", () => {
  test("the boundary", () => {
    expect(UNSCORED_STOP_SHARE).toBe(0.25);
    expect(tooManyUnscored(3, 12)).toBe(false);
    expect(tooManyUnscored(4, 12)).toBe(true);
    expect(tooManyUnscored(1, 4)).toBe(false);
    expect(tooManyUnscored(2, 4)).toBe(true);
    expect(tooManyUnscored(0, 1)).toBe(false);
    expect(tooManyUnscored(1, 1)).toBe(true);
  });

  test("runPilot records an unscored row and goes on, instead of `break tasksRun`", async () => {
    // Every run of this fake reports a terminal quota refusal and exits 1, so
    // every row is unscored. Two tasks × two arms = four planned rows: the
    // first unscored row (1 of 4) must NOT stop the series; the second (2 of
    // 4, more than a quarter) must.
    const dir = temp("pilot-stop-");
    const fake = join(dir, "refused");
    writeFileSync(
      fake,
      `#!${process.execPath}\n` +
        `if (process.argv.includes("--version")) { console.log("fake 0"); process.exit(0); }\n` +
        `console.log(JSON.stringify({ type: "error", error: "Quota exceeded: usage limit" }));\n` +
        `process.exit(1);\n`,
    );
    chmodSync(fake, 0o755);
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    let report: Awaited<ReturnType<typeof runPilot>>;
    try {
      report = await withEnv({ XDG_DATA_HOME: join(dir, "xdg") }, () =>
        runPilot({
          out: join(dir, "report"),
          model: "synthetic-model",
          runeProvider: "codex",
          opencodeProvider: "openai",
          budgetUsd: 1,
          timeoutMs: 20_000,
          runs: 1,
          tasks: ["csv-state-machine", "off-by-one-window"],
          corpus: join(import.meta.dir, "../../eval/corpus"),
          runeCommand: [fake],
          opencodeCommand: [fake],
          route: "scripted",
        }),
      );
    } finally {
      console.log = log;
    }
    expect(report.results).toHaveLength(2);
    expect(report.results.map((row) => row.unscoredReason)).toEqual([
      "provider_quota",
      "provider_quota",
    ]);
    expect((report as Record<string, unknown>).stoppedEarly).toMatch(/2 of 4 planned row/);
    expect(lines.join("\n")).toContain("more than a quarter");
  }, 60_000);
});

// ─── The Claude Code arm: two modes, flag for flag ───

/**
 * Every flag either mode passes, read from `claude --help` of Claude Code
 * 2.1.284 on 2026-09-29 (CLAUDE_CODE_PINNED_VERSION). A flag added to the argv
 * must be added here, which is the prompt to check it against the help of
 * the version the arm is pinned to.
 */
const CLAUDE_HELP_FLAGS_2_1_284 = new Set([
  "--print",
  "--bare",
  "--output-format",
  "--model",
  "--effort",
  "--setting-sources",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--permission-prompts",
]);

const CLAUDE_TAIL = [
  "--setting-sources",
  "project",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash,Edit,MultiEdit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite",
  "--disallowedTools",
  "WebFetch,WebSearch",
  "--permission-prompts",
  "none",
  PROMPT,
];

describe("the Claude Code arm's two modes", () => {
  const limits: ArmLimits = { timeoutMs: 1, model: "opus", reasoningEffort: "high" };

  test("product: the tool as a customer runs it, on its own evaluation profile", () => {
    expect(CLAUDE_CODE_PINNED_VERSION).toBe("2.1.284");
    expect(claudeCodeArgv(PROMPT, limits)).toEqual([
      "claude",
      "--print",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--effort",
      "high",
      ...CLAUDE_TAIL,
    ]);
  });

  test("harness: --bare on an API key, otherwise the same argv", () => {
    expect(claudeCodeArgv(PROMPT, { ...limits, mode: "harness" })).toEqual([
      "claude",
      "--print",
      "--bare",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--effort",
      "high",
      ...CLAUDE_TAIL,
    ]);
  });

  test("no dollar ceiling in either mode, and every flag is in the pinned help", () => {
    for (const mode of ["product", "harness"] as const) {
      const argv = claudeCodeArgv(PROMPT, { ...limits, mode, budgetUsd: 2 });
      expect(argv).not.toContain("--max-budget-usd");
      expect(argv).not.toContain("--max-turns");
      for (const token of argv.filter((t) => t.startsWith("--")))
        expect({ token, known: CLAUDE_HELP_FLAGS_2_1_284.has(token) }).toEqual({
          token,
          known: true,
        });
    }
  });

  test("product mode refuses, by name, without its evaluation profile", () => {
    const task = { id: "t", prompt: PROMPT };
    const refusal = (env: NodeJS.ProcessEnv) =>
      claudeCodeArm.plan(task, "/evidence/run", { ...limits, env }).refusal;
    const unset = refusal({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/x/.claude" });
    expect(unset).toContain(CLAUDE_PARITY_CONFIG_ENV);
    expect(unset).toContain("CLAUDE_CONFIG_DIR=<dir> claude");
    expect(unset).toContain("/login");
    expect(refusal({ [CLAUDE_PARITY_CONFIG_ENV]: "relative/profile" })).toMatch(/absolute path/);
    expect(refusal({ [CLAUDE_PARITY_CONFIG_ENV]: "/no/such/profile/anywhere" })).toMatch(
      /existing directory/,
    );
    expect(refusal({ [CLAUDE_PARITY_CONFIG_ENV]: tmpdir() })).toBeUndefined();
  });

  test("product mode never falls back to a home or profile that happens to exist", () => {
    // A HOME with a real `.claude` in it, and an inherited CLAUDE_CONFIG_DIR
    // pointing at an existing directory: neither is the evaluation profile.
    const home = temp("claude-home-");
    mkdirSync(join(home, ".claude"));
    const plan = claudeCodeArm.plan({ id: "t", prompt: PROMPT }, "/evidence/run", {
      ...limits,
      env: { PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    expect(plan.refusal).toMatch(new RegExp(`${CLAUDE_PARITY_CONFIG_ENV} is not set`));
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("harness mode refuses without a key; the scratch profile is inside the evidence", () => {
    const task = { id: "t", prompt: PROMPT };
    const plan = (env: NodeJS.ProcessEnv) =>
      claudeCodeArm.plan(task, "/evidence/run", { ...limits, mode: "harness", env });
    expect(plan({ PATH: "/usr/bin" }).refusal).toMatch(/ANTHROPIC_API_KEY/);
    const keyed = plan({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-synthetic" });
    expect(keyed.refusal).toBeUndefined();
    expect(keyed.env.CLAUDE_CONFIG_DIR).toBe(harnessConfigDir("/evidence/run"));
    expect(keyed.env.CLAUDE_CONFIG_DIR!.startsWith("/evidence/run/")).toBe(true);
  });
});

// ─── Fakes that stand in for a tool, and never for a model ───

/** A POSIX shell stand-in for `claude` that logs its argv and environment. */
function fakeClaude(dir: string): { bin: string; log: string } {
  const log = join(dir, "claude-log");
  mkdirSync(log, { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.284 (Claude Code)"; exit 0; fi',
      `printf '%s\\n' "$@" > ${JSON.stringify(join(log, "argv.txt"))}`,
      `env > ${JSON.stringify(join(log, "env.txt"))}`,
      `echo '${claude.envelope({ num_turns: 2 })}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

/**
 * A stand-in for the `rune` binary: one executable file, so the arm hashes it.
 * It writes two priced `cost` events into the profile database the arm reads,
 * touches the workspace, and prints the stream and the envelope.
 */
function fakeRune(dir: string, options: { rewriteSelf?: boolean } = {}): string {
  const bin = join(dir, options.rewriteSelf ? "rune-rebuilt" : "rune");
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      `import { Database } from "bun:sqlite";`,
      `import { appendFileSync, writeFileSync } from "node:fs";`,
      `if (process.argv.includes("--version")) { console.log("rune 9.9.9-fake"); process.exit(0); }`,
      `writeFileSync(process.env.RUNE_HOME + "/seen.json", JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), home: process.env.RUNE_HOME, db: process.env.RUNE_DB_PATH }));`,
      `const db = new Database(process.env.RUNE_DB_PATH);`,
      `db.exec("CREATE TABLE events (payload_json TEXT)");`,
      `for (const listCostUsd of [0.01, 0.02]) db.prepare("INSERT INTO events VALUES (?)").run(JSON.stringify({ type: "cost", payload: { model: "m", provider: "openai", priced: true, listCostUsd } }));`,
      `db.close();`,
      `const workspace = process.argv[process.argv.indexOf("--workspace") + 1];`,
      `writeFileSync(workspace + "/done.txt", "ok\\n");`,
      options.rewriteSelf ? `appendFileSync(${JSON.stringify(bin)}, "// rebuilt mid-run\\n");` : "",
      `console.log(JSON.stringify({ type: "usage", inputTokens: 10, outputTokens: 2 }));`,
      `console.log(JSON.stringify({ type: "turn_complete", stopReason: "end_turn", totalTurns: 2 }));`,
      `console.log(JSON.stringify({ ok: true, text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } }));`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** A shell environment that is synthetic from end to end. */
const SYNTHETIC_ENV = (home: string): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  ANTHROPIC_API_KEY: "sk-ant-synthetic",
  OPENAI_API_KEY: "sk-openai-synthetic",
  ANTHROPIC_BASE_URL: "https://evil.example/v1",
  RUNE_SANDBOX: "off",
  RUNE_MODEL: "something-cheaper",
  RUNE_HOME: join(home, ".rune"),
});

describe.skipIf(process.platform === "win32")("the arms against fake binaries", () => {
  test("Claude Code product mode refuses before it creates or spawns anything", async () => {
    const dir = temp("claude-refused-");
    const { bin, log } = fakeClaude(dir);
    const evidence = join(dir, "evidence");
    const failure = await claudeCodeArm
      .runArm({ id: "t", prompt: PROMPT }, evidence, {
        timeoutMs: 10_000,
        command: [bin],
        env: SYNTHETIC_ENV(dir),
      })
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(failure?.message).toContain(CLAUDE_PARITY_CONFIG_ENV);
    expect(existsSync(join(log, "argv.txt"))).toBe(false);
    expect(existsSync(evidence)).toBe(false);
  });

  test("Claude Code product mode: the child sees the profile and no key", async () => {
    const dir = temp("claude-product-");
    const { bin, log } = fakeClaude(dir);
    const profile = join(dir, "eval-profile");
    mkdirSync(profile);
    const evidence = join(dir, "evidence");
    mkdirSync(join(evidence, "workspace"), { recursive: true });
    const result = await claudeCodeArm.runArm({ id: "t", prompt: PROMPT }, evidence, {
      timeoutMs: 10_000,
      model: "opus",
      command: [bin],
      env: { ...SYNTHETIC_ENV(dir), [CLAUDE_PARITY_CONFIG_ENV]: profile },
    });
    expect(result.scored).toBe(true);
    expect(result.claimedSuccess).toBe(true);
    expect(result.version).toBe("2.1.284 (Claude Code)");
    expect(result.binarySha256).toBe(createHash("sha256").update(readFileSync(bin)).digest("hex"));
    const argv = readFileSync(join(log, "argv.txt"), "utf8").trimEnd().split("\n");
    expect(argv).toEqual(claudeCodeArgv(PROMPT, { timeoutMs: 1, model: "opus" }).slice(1));
    const env = readFileSync(join(log, "env.txt"), "utf8");
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${profile}\n`);
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).not.toContain("ANTHROPIC_BASE_URL");
    expect(env).not.toContain(CLAUDE_PARITY_CONFIG_ENV);
  });

  test("Claude Code harness mode: --bare, the key, and a scratch profile", async () => {
    const dir = temp("claude-harness-");
    const { bin, log } = fakeClaude(dir);
    const evidence = join(dir, "evidence");
    mkdirSync(join(evidence, "workspace"), { recursive: true });
    await claudeCodeArm.runArm({ id: "t", prompt: PROMPT }, evidence, {
      timeoutMs: 10_000,
      model: "opus",
      mode: "harness",
      command: [bin],
      env: SYNTHETIC_ENV(dir),
    });
    expect(readFileSync(join(log, "argv.txt"), "utf8").split("\n")).toContain("--bare");
    const env = readFileSync(join(log, "env.txt"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-synthetic\n");
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${harnessConfigDir(evidence)}\n`);
    expect(existsSync(harnessConfigDir(evidence))).toBe(true);
  });

  test("the Rune arm: parity profile, its own ledger, its own version and hash", async () => {
    const dir = temp("rune-arm-");
    const bin = fakeRune(dir);
    const evidence = join(dir, "evidence");
    mkdirSync(join(evidence, "workspace"), { recursive: true });
    const limits: ArmLimits = {
      timeoutMs: 20_000,
      model: "m",
      provider: "openai",
      command: [bin],
      env: SYNTHETIC_ENV(dir),
    };
    const task = { id: "t", prompt: PROMPT };
    const plan = runeArm.plan(task, evidence, limits);
    // The plan is the parity harness's plan, byte for byte.
    const harness = planParityHarness(
      "rune",
      { command: [bin], provider: "openai", model: "m", env: limits.env!, taskEnv: [] },
      evidence,
      join(evidence, "workspace"),
      PROMPT,
    );
    expect(plan.command).toEqual(harness.command);
    expect(plan.env).toEqual(harness.env);

    const result = await runeArm.runArm(task, evidence, limits);
    expect(result.scored).toBe(true);
    expect(result.claimedSuccess).toBe(true);
    // Calls and cost from the profile database's `cost` events.
    expect(result.calls).toBe(2);
    expect(result.listUsd).toBeCloseTo(0.03);
    expect(result.version).toBe("rune 9.9.9-fake");
    expect(result.binarySha256).toBe(createHash("sha256").update(readFileSync(bin)).digest("hex"));
    const seen = JSON.parse(readFileSync(join(evidence, "profile", "seen.json"), "utf8"));
    expect(seen.argv).toEqual(plan.command.slice(1));
    expect(seen.home).toBe(join(evidence, "profile"));
    // Isolation, not settings: a RUNE_* override in the founder's shell is not
    // a shipped default, and never reaches the arm. The provider's key does.
    expect(seen.env).not.toContain("RUNE_SANDBOX");
    expect(seen.env).not.toContain("RUNE_MODEL");
    expect(seen.env).not.toContain("ANTHROPIC_API_KEY");
    expect(seen.env).not.toContain("ANTHROPIC_BASE_URL");
    expect(seen.env).toContain("OPENAI_API_KEY");
    expect(readFileSync(join(evidence, "profile", "config.toml"), "utf8")).toBe(PARITY_RUNE_CONFIG);
  }, 30_000);

  test("the Rune arm: a build that changed under the run is source_changed", async () => {
    const dir = temp("rune-rebuilt-");
    const bin = fakeRune(dir, { rewriteSelf: true });
    const evidence = join(dir, "evidence");
    mkdirSync(join(evidence, "workspace"), { recursive: true });
    const result = await runeArm.runArm({ id: "t", prompt: PROMPT }, evidence, {
      timeoutMs: 20_000,
      model: "m",
      provider: "openai",
      command: [bin],
      env: SYNTHETIC_ENV(dir),
    });
    expect(result.claimedSuccess).toBe(true);
    expect(result.scored).toBe(false);
    expect(result.unscoredReason).toBe("source_changed");
  }, 30_000);

  test("the Rune arm refuses to run a model it would not record", () => {
    expect(runeArm.plan({ id: "t", prompt: PROMPT }, "/e", { timeoutMs: 1 }).refusal).toBe(
      RUNE_NEEDS_MODEL,
    );
  });
});

// ─── The parity profile: isolation, and no settings ───

describe("the parity harness profile", () => {
  const env = SYNTHETIC_ENV("/home/founder");

  test("Rune runs on its shipped defaults: the config it gets sets nothing", () => {
    const plan = planParityHarness(
      "rune",
      { command: ["/opt/rune"], provider: "openai", model: "m", env },
      "/evidence/run",
      "/evidence/run/workspace",
      PROMPT,
    );
    const config = plan.files["/evidence/run/profile/config.toml"];
    expect(config).toBe(PARITY_RUNE_CONFIG);
    // Every line a comment: no maxTurns, no secondWinds, no maxSessionUsd, no
    // effort, no subagent or notebook setting — nothing a customer would not have.
    for (const line of config!.split("\n").filter(Boolean)) expect(line.startsWith("#")).toBe(true);
    expect(plan.command).toEqual([
      "/opt/rune",
      "-P",
      PROMPT,
      "--workspace",
      "/evidence/run/workspace",
      "--provider",
      "openai",
      "--model",
      "m",
      "--gear",
      "auto",
      "--auto-approve",
      "--pristine",
      "--stream-json",
    ]);
    // Isolation: a fresh home, database and config per run; the founder's
    // saved sign-ins READ through their paths, never copied.
    expect(plan.env.RUNE_HOME).toBe("/evidence/run/profile");
    expect(plan.env.RUNE_DB_PATH).toBe("/evidence/run/profile/rune.db");
    expect(plan.env.RUNE_CONFIG_PATH).toBe("/evidence/run/profile/config.toml");
    expect(plan.env.RUNE_CREDENTIALS_PATH).toBe("/home/founder/.rune/credentials.json");
    expect(plan.env.RUNE_SANDBOX).toBeUndefined();
    expect(plan.env.RUNE_MODEL).toBeUndefined();
    expect(plan.env.OPENAI_API_KEY).toBe("sk-openai-synthetic");
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("OpenCode runs as it ships: no step cap", () => {
    const plan = planParityHarness(
      "opencode",
      { command: ["opencode"], provider: "openai", model: "m", env },
      "/evidence/run",
      "/evidence/run/workspace",
      PROMPT,
    );
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!);
    expect(config).toEqual({ permission: "allow", share: "disabled", model: "openai/m" });
    expect(JSON.stringify(config)).not.toContain("steps");
    expect(plan.env.RUNE_HOME).toBeUndefined();
  });

  test("the pilot profile keeps its symmetric caps, for runPilot alone", async () => {
    const dir = temp("pilot-profile-");
    const options = {
      out: "",
      model: "m",
      runeProvider: "codex",
      opencodeProvider: "openai",
      budgetUsd: 2,
      timeoutMs: 1,
      runs: 1,
      runeCommand: ["/opt/rune"],
      opencodeCommand: ["opencode"],
    };
    await withEnv({ XDG_DATA_HOME: join(dir, "xdg") }, () => {
      const rune = prepareHarness(
        "rune",
        options,
        join(dir, "r"),
        join(dir, "r/workspace"),
        PROMPT,
      );
      const config = readFileSync(rune.env.RUNE_CONFIG_PATH!, "utf8");
      expect(config).toContain("maxTurns = 24");
      expect(config).toContain("secondWinds = 0");
      expect(rune.command).toContain("--no-browser");
      const oc = prepareHarness(
        "opencode",
        options,
        join(dir, "o"),
        join(dir, "o/workspace"),
        PROMPT,
      );
      expect(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!).agent).toEqual({ build: { steps: 24 } });
    });
  });
});
