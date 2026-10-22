// The dogfood test: Rune 1.4.12 and Codex CLI on the same model (Codex,
// gpt-6.1-sol at effort "high"), the same task, on Rune's own source at the
// v1.4.12 commit (688f1e7). Each arm works in its own identical copy of
// `base/`, launched the way the parity rig launches it (its arm), on its
// shipped defaults. Graded from outside with what CI runs plus a hidden test
// neither agent saw.
//
//   bun run ~/rune-evidence/dogfood-20261021/run.ts <plan|baseline|codex|rune>
//
//   plan      print each arm's command line and env names; runs nothing
//   baseline  no agent: grade an untouched copy, the "before" for every grade
//   codex     Codex CLI on the task, then grade
//   rune      Rune 1.4.12 (bin-1.4.12/rune) on the task, then grade
//
// Run from the worktree root so the rig's modules resolve. Evidence is never
// overwritten: an arm whose folder exists refuses to start.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runeArm } from "/Users/ritikyadav890/Project/Alan/.claude/worktrees/reliability-r1-20261014/tests/eval/comparison/arms/rune";
import { codexArm } from "/Users/ritikyadav890/Project/Alan/.claude/worktrees/reliability-r1-20261014/tests/eval/comparison/arms/codex";
import {
  terminalOf,
  workspaceOf,
} from "/Users/ritikyadav890/Project/Alan/.claude/worktrees/reliability-r1-20261014/tests/eval/comparison/arms/types";

const ROOT = join(process.env.HOME!, "rune-evidence", "dogfood-20261021");
const SCRATCH =
  "/private/tmp/claude-501/-Users-ritikyadav890-Project-Alan/01839c7d-5c96-4d39-9a0a-0ddf8339a825/scratchpad/dogfood";
const MODEL = "gpt-6.1-sol";
// Rune sends "high" on Codex when nothing overrides it (codexEffortFor), and
// gpt-6.1-sol matches its reasoning-model rule, so Rune is left on its
// default. Codex CLI would read "max" from the founder's config.toml; the arm
// ignores that file and is held to the same "high".
const EFFORT = "high";
const WALL_MS = 60 * 60_000;
// The grade's tools binary: built from 688f1e7, outside every workspace.
const TOOLS_BIN = join(ROOT, "tools", "rune-tools");
const HIDDEN = "tests/reliability/model-gone.hidden.test.ts";
// The fixture's commit. The change is read against it, not HEAD, so work an
// agent commits (the task says not to) is still in the patch.
const BASE_SHA = "688f1e702aeacaa7a0ef83f3e09ff1a2d9be4fa9";

const mode = process.argv[2];
if (!["plan", "baseline", "codex", "rune"].includes(mode ?? "")) {
  throw new Error("usage: run.ts <plan|baseline|codex|rune>");
}
const prompt = readFileSync(join(SCRATCH, "task.md"), "utf8").trim();
const task = { id: "dogfood-model-unavailable", prompt };
const limitsFor = (arm: "rune" | "codex") => ({
  timeoutMs: WALL_MS,
  model: MODEL,
  provider: "codex",
  mode: "product" as const,
  ...(arm === "codex" ? { reasoningEffort: EFFORT } : {}),
  ...(arm === "rune" ? { command: [join(ROOT, "bin-1.4.12", "rune")] } : {}),
});

if (mode === "plan") {
  for (const [arm, impl] of [
    ["rune", runeArm],
    ["codex", codexArm],
  ] as const) {
    const p = impl.plan(task, join(ROOT, `${arm}-dry`), limitsFor(arm) as never);
    console.log(
      `${arm}: ${JSON.stringify(p.command.map((c) => (c === prompt ? "<task.md>" : c)))}`,
    );
    console.log(`  cwd ${p.cwd}`);
    console.log(
      `  env ${Object.keys(p.env ?? {})
        .sort()
        .join(",")}`,
    );
  }
  process.exit(0);
}

const dir = join(ROOT, mode!);
if (existsSync(dir)) throw new Error(`${dir} exists — evidence is never overwritten`);
for (const need of [TOOLS_BIN, join(ROOT, "base", "target", "release", "rune-tools")]) {
  if (!existsSync(need)) throw new Error(`missing ${need}`);
}
if (mode === "rune" && !existsSync(join(ROOT, "bin-1.4.12", "rune"))) {
  throw new Error("missing bin-1.4.12/rune — the released 1.4.12 binary");
}
mkdirSync(dir, { recursive: true });
const workspace = workspaceOf(dir);
cpSync(join(ROOT, "base"), workspace, { recursive: true, verbatimSymlinks: true });

// ── The run ──
const startedAt = new Date().toISOString();
console.log(`started ${startedAt}: ${mode}`);
const result =
  mode === "baseline"
    ? null
    : await (mode === "rune" ? runeArm : codexArm).runArm(task, dir, limitsFor(mode) as never);
const completedAt = new Date().toISOString();
if (result) writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`agent done ${completedAt}`);

// ── The grade, from outside ──
// AGENT=0: Bun prints its normal summary even when started from an agent.
const env = {
  ...process.env,
  AGENT: "0",
  TURBO_TELEMETRY_DISABLED: "1",
  RUNE_TOOLS_BIN: TOOLS_BIN,
  RUNE_TOOLS_BINARY: TOOLS_BIN,
};
const count = (text: string, word: string) => {
  const m = new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(text);
  return m ? Number(m[1]) : null;
};
type Step = {
  exit: number | null;
  seconds: number;
  pass: number | null;
  fail: number | null;
  skip: number | null;
};
const step = (name: string, cmd: string[], timeout = 30 * 60_000): Step => {
  const t0 = Date.now();
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  writeFileSync(
    join(dir, `grade-${name}.log`),
    text.length > 400_000 ? text.slice(-400_000) : text,
  );
  const s: Step = {
    exit: r.status,
    seconds: Math.round((Date.now() - t0) / 1000),
    pass: count(text, "pass"),
    fail: count(text, "fail"),
    skip: count(text, "skip"),
  };
  console.log(`grade ${name}: ${JSON.stringify(s)}`);
  return s;
};

// What the agent left, captured before the grade touches the tree.
const git = (...args: string[]) =>
  spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .stdout ?? "";
const status = git("status", "--porcelain=v1", "-uall");
writeFileSync(join(dir, "status.txt"), status);
const commits = git("log", "--oneline", `${BASE_SHA}..HEAD`).split("\n").filter(Boolean);
let patch = git("diff", BASE_SHA);
const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
for (const f of untracked) {
  patch += spawnSync("git", ["-C", workspace, "diff", "--no-index", "--", "/dev/null", f], {
    encoding: "utf8",
  }).stdout;
}
writeFileSync(join(dir, "change.patch"), patch);
const numstat = git("diff", BASE_SHA, "--numstat")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

const grade = {
  format: step("format", ["bun", "run", "format:check"]),
  lint: step("lint", ["bunx", "turbo", "lint", "--force"]),
  typecheck: step("typecheck", ["bunx", "turbo", "typecheck", "--force"]),
  reliability: step("reliability", ["bun", "run", "reliability"]),
  hidden: (() => {
    copyFileSync(join(SCRATCH, "model-gone.hidden.test.ts"), join(workspace, HIDDEN));
    try {
      return step("hidden", ["bun", "test", HIDDEN], 10 * 60_000);
    } finally {
      rmSync(join(workspace, HIDDEN), { force: true });
    }
  })(),
  unit: step("unit", ["bun", "test", "tests/unit/"]),
  integration: step("integration", ["bun", "test", "tests/integration/"]),
};

const summary = {
  mode,
  model: MODEL,
  effort: EFFORT,
  startedAt,
  completedAt,
  agent: result
    ? {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stopped: result.stopped ?? null,
        terminal: terminalOf(result.signals),
        claimedSuccess: result.claimedSuccess,
        turns: result.turns,
        calls: result.calls,
        listUsd: result.listUsd,
        reportedCostUsd: result.reportedCostUsd,
        usage: result.usage,
        models: result.models,
        version: result.version,
      }
    : null,
  change: {
    commits,
    tracked: numstat.map(([a, d, f]) => ({ file: f, added: Number(a), deleted: Number(d) })),
    untracked,
  },
  grade,
};
writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
