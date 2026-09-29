# Reproducible harness comparisons

This directory contains a small live Rune/OpenCode pilot, four arms behind one interface (Rune, OpenCode, Claude Code and Codex) with the fairness rules and the paired runner the parity index reads, an executable SWE-bench prediction adapter, and a Harbor adapter. The Claude Code and Codex arms and the paired runner are validated offline and have never been run live. None supplies an overall capability score. The pilot tasks are authored in this repository and are not an independent benchmark.

## Live pilot

Both arms receive identical fresh Git fixtures and prompts. The runner alternates which arm goes first, uses the same primary model and high reasoning, limits each process tree, preserves failures, and runs acceptance checks outside the agent workspace. The working-tree task protects an untracked API from modification. The frontend task checks actual Chromium layouts, keyboard interaction, filtering, favorites persistence and console errors, and saves desktop/mobile screenshots. Those checks do not grade aesthetics.

Use existing sign-ins. The runner references the normal secure credential stores; it does not duplicate OAuth refresh tokens. Raw event logs and SQLite databases are private artifacts and must not be published: provider errors can contain sensitive response headers. Publish only reviewed aggregate reports and redacted evidence.

```sh
# Coding tasks require Bun and a separately installed OpenCode.
bun run tests/eval/comparison/runner.ts --real --model MODEL \
  --tasks csv-state-machine,working-tree-integration,dependent-migration \
  --out /tmp/rune-comparison-fresh --runs 3 --budget-usd 2 --timeout-seconds 300

# For the browser task, install one shared browser runtime outside the fixtures.
npm install --prefix /tmp/rune-benchmark-tools --no-audit --no-fund playwright@1.63.0
PLAYWRIGHT_SKIP_BROWSER_GC=1 node /tmp/rune-benchmark-tools/node_modules/playwright/cli.js install chromium
RUNE_BENCH_PLAYWRIGHT=/tmp/rune-benchmark-tools/node_modules/playwright/index.mjs \
  bun run tests/eval/comparison/runner.ts --real --model MODEL \
  --tasks responsive-project-board --out /tmp/rune-frontend-fresh \
  --budget-usd 4 --timeout-seconds 600
```

The default routes are Rune `codex` and OpenCode `openai`. Override with `--rune-provider` and `--opencode-provider` for API-key routes. The model must be available on both accounts. Use `--rune-bin /absolute/path/to/rune-compiled` to measure an installed artifact; otherwise the source entrypoint is used. Compiled runs record an executable hash; source runs detect changes during execution and exclude contaminated results. Never reuse an output directory or discard an unsuccessful attempt to improve the reported result.

Cost is normalized using Rune's pricing table and all recorded gateway usage, including child sessions and helpers. Unknown costs are null; estimated prices are explicitly marked. These values are neither invoices nor the price of a subscription. OpenCode stores output and reasoning separately; the adapter adds them, following its [versioned usage implementation](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/session/session.ts). Rune reserves estimated spend before inference; OpenCode is stopped after reported usage reaches the ceiling. Overshoots are retained and cannot count as on-budget successes. Timeouts also cannot count as completed successes even when the files pass acceptance.

Terminal quota, authentication and provider-server errors leave the task unscored even when
some inference completed before the interruption. Actual usage and partial artifacts remain
in the report, with a sanitized `unscoredReason`. Each row is judged by the one classifier
every arm shares (see the parity section below): a timeout is a scored failure for Rune
exactly as for OpenCode. An unscored row is recorded and the series goes on; it stops only
once more than a quarter of the planned rows have come back unscored (it used to stop at the
first one). Ordinary tool failures or text mentioning quotas do not trigger the exclusion.
The pilot keeps its own symmetric caps (24 turns for Rune, 24 steps for OpenCode, a per-task
dollar ceiling for both); the parity runner does not. See the
[dated evidence and corrections](../../../docs/audit-followthrough-20260908.md) for the early
attempts; the original aggregate reports were preserved.

Reproduce the adapter checks without inference:

```sh
bun test tests/unit/evolve/comparison.test.ts tests/unit/evolve/anchors.test.ts
bunx tsc --noEmit --target ESNext --module ESNext --moduleResolution Bundler \
  --types bun --skipLibCheck --allowImportingTsExtensions --strict \
  --esModuleInterop tests/eval/comparison/*.ts
```

On macOS, verify that the native shell sandbox can launch Chromium before spending inference
on frontend work. Use an already installed Playwright runtime; this test downloads nothing:

```sh
cargo build -p rune-tools
RUNE_TEST_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  bun test tests/integration/browser-sandbox.test.ts
```

The test checks local serving, interaction and screenshots through foreground and background
launch profiles, while denied reads, outside writes and environment secrets remain blocked.
Set `RUNE_TOOLS_BINARY` to test a specific installed native binary. Without the runtime opt-in
or on another OS these two checks are skipped, not reported as browser verification.

## The frozen diagnostic corpus

[`../corpus`](../corpus/README.md) holds twelve pinned tasks with acceptance files the model
never sees, and an offline runner that drives the real engine through five scripted scenarios
per task with **zero model calls**. Four of its fixtures — `csv-state-machine`,
`working-tree-integration`, `dependent-migration` and `responsive-project-board` — are this
directory's, reused verbatim and pinned byte-for-byte by the corpus's sanity check, so the two
sides describe the same task. The offline report measures the harness's detection of an
unfinished run; it measures no model and states no comparison.

```sh
bun run tests/eval/corpus/run-offline.ts --out docs/evidence/corpus-offline-<date>.json
```

The live runner can take the corpus's tasks and the corpus's own acceptance files:

```sh
RUNE_EVAL_BUDGET_USD=4 bun run tests/eval/comparison/runner.ts --real --model MODEL \
  --corpus tests/eval/corpus --out /tmp/rune-corpus-live --budget-usd 2
```

`runPilot` now refuses to start unless `RUNE_EVAL_BUDGET_USD` names a positive number of
dollars, and refuses a `--budget-usd` above it. An unset variable is a refusal, not a default:
live evaluation spends real money and needs someone to have decided to. No live corpus series
has been run.

## Parity: the arms, the fairness rules and the paired runner

The parity index (`docs/program/parity-index.md`, scored by `tests/eval/parity/score.ts`)
reads `ParityRunResult` rows (`tests/eval/parity/types.ts`, the frozen contract) from a
`results.jsonl`, and pairs them on (task, run, mode). The rows come from
`tests/eval/parity/run-pairs.ts`, which runs two arms over the same tasks through the arm
interface in `arms/`. **Nothing here has been run live.**

**Two modes.** `product` is each tool on its own account and best model — the headline and the
release gate. `harness` is both tools on one model through one API key — attribution only,
never a gate. Only the Claude Code arm's argv and environment depend on the mode.

| arm         | parity argv                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rune        | `<rune> -P <prompt> --workspace <fixture> --provider P --model M --gear auto --auto-approve --pristine --stream-json`                                                                                                                                                                                                           |
| claude-code | product: `claude --print --output-format json --model M --effort E --setting-sources project --strict-mcp-config --no-session-persistence --permission-mode acceptEdits --allowedTools Bash,Edit,MultiEdit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite --disallowedTools WebFetch,WebSearch --permission-prompts none <prompt>` |
| claude-code | harness: the same, with `--bare` after `--print`                                                                                                                                                                                                                                                                                |
| opencode    | `opencode run --pure --format json --model P/M --variant high --dir <fixture> <prompt>`                                                                                                                                                                                                                                         |

Every Claude Code flag is read from `claude --help` of **2.1.284** (2026-09-29; it had
auto-updated from 2.1.283 overnight). Product mode's environment is the neutral base plus
`CLAUDE_CONFIG_DIR`, set from `RUNE_PARITY_CLAUDE_CONFIG_DIR` and never inherited, and **no**
API key: a key in the shell would quietly turn a plan run into an API-billed one. Harness mode
keeps `ANTHROPIC_API_KEY` (under `--bare` it is the whole of the auth) and points
`CLAUDE_CONFIG_DIR` at a scratch directory in the evidence folder. There is no
`--max-budget-usd` in either mode.

**The one-time Claude Code evaluation profile.** Product mode never runs on `~/.claude`: the
founder's settings, hooks, CLAUDE.md and plugins are not part of the product being measured.
It runs on a profile made for evaluation and signed into once, by hand:

```sh
CLAUDE_CONFIG_DIR=<dir> claude     # then /login, then /exit
export RUNE_PARITY_CLAUDE_CONFIG_DIR=<dir>   # an absolute path
```

The arm refuses — before it creates or spawns anything — when the variable is unset, relative
or not a directory. Only the directory's existence is checked; nothing inside it is read.

**The parity profile.** Rune runs on its **shipped defaults**: the config it is given is
comments only — no `maxTurns`, no `secondWinds`, no `maxSessionUsd`, no effort, no subagent
or notebook setting. What it keeps is isolation: a fresh `RUNE_HOME`, database and config path
per run, `--pristine`, the founder's sign-ins read through their paths and never copied, and
an allow-listed environment (a `RUNE_*` override in the shell is not a shipped default
either). OpenCode loses its `steps: 24`. No arm is capped by anything but the wall clock
(`WALL_LIMIT_MS`: 20 minutes for a small task, 45 for a serious one).

**One classifier.** Every arm's parser reports facts; `classifyOutcome` (`arms/types.ts`)
alone decides what they mean, for every arm alike, and
`tests/unit/eval/parity-fairness.test.ts` feeds the same situations through all four parsers
and asserts they agree.

| what happened                                                                                                                                    | row                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| the tool finished (exit 0 by itself, its own report says success)                                                                                | scored                             |
| the wall clock ran out, before or after the first model call                                                                                     | scored failure                     |
| the tool's own turn or dollar ceiling (`error_max_turns`, `error_max_budget_usd`, Rune's `max_turns` / `budget`, the rig's watcher for OpenCode) | scored failure                     |
| a crash after the first model call — by the tool's ledger, or because the task's files changed                                                   | scored failure                     |
| a terminal provider refusal the tool reported: quota, auth, outage (5xx, a dropped socket, `provider_lost`)                                      | unscored `provider_*`              |
| a crash before the first model call                                                                                                              | unscored `crash_before_first_call` |
| the task could not be prepared, or the grader could not run                                                                                      | unscored `grader_infrastructure`   |
| the measured Rune build changed during the series                                                                                                | unscored `source_changed`          |

Two refinements hold for every arm: a provider error the tool recovered from is not an outage,
and text a process wrote while the rig was killing it is not a terminal report (it may have
been retrying; the clock ended it).

**Clean, false completion, scope.** `falseCompletion` is the tool claiming success (exit 0 and
its own report — Claude Code `subtype: "success"`, Rune `ok: true`) while the grader's quality
is below 1. `clean` is ended by itself, inside the limit, with no false completion. Scope is
measured from `git status --porcelain --ignored --untracked-files=all` snapshots before and
after the run: **0** for a no-code task (explain, plan) that changed any path other than the
file it asked for — tracked or untracked, ignored or not, committed or deleted; **0.5** for
new ignored or untracked leftovers (`.rune/`, `.claude/`, `target/`, `*.log`, …); **1**
otherwise. `node_modules/` is ignored, and a tool's own state directory is a leftover (0.5),
not a code change. A run that leaves a tree git can no longer read is out of scope (0).

**The paired runner.** For each (task, run) the arm that goes first alternates, across tasks
and repetitions. Each arm gets a fresh workspace from the task's own `prepare`. Both rows of a
pair are written together, so a pair is never half-written: an arm whose run produced no row
at all (the tree could not be prepared, the tool could not be started) is re-run once at
once, and if it still produces none it gets an unscored row, so the pair stays whole. A pair
with an unscored row is re-queued once, as a new run number with the other arm first; its
first attempt stays in the evidence. The series stops only when more than a quarter of the
planned pairs come back unscored. Every row records the `--version` its tool gave just before
that run. `results.jsonl`, `series.json` and every run directory are created fresh or not at
all: an existing one is a refusal, never an overwrite.

**The corpus as parity tasks.** `tests/eval/parity/corpus-source.ts` turns the twelve frozen
tasks into `ParityTask`s: families from `CORPUS_FAMILY`, `noCode` and the expected new file
(`ANSWER.md`, `PLAN.md`) read from each task's own constraints and prompt, the fixture seeded
by `seedTask`, and a grader that runs **every** acceptance command (not stopping at the first
failure) with the checks copied in, in the environment an arm gets rather than the rig's. A
check that exits 2 with its own `PLAYWRIGHT_UNAVAILABLE` marker is impossible here and leaves
the denominator for both arms; an exit 2 without the marker is a failed check.

**The authorisation.** A live series refuses to start unless `RUNE_EVAL_BUDGET_USD` (a dollar
ceiling for the whole series) or `RUNE_EVAL_QUOTA_PCT` (a plain number from 1 to 100: stop once
a Rune row reports that share of its subscription window used) is set. The first pair always
runs; before each later one, the dollar gate stops the series if the spend so far plus the
costliest pair so far would pass the ceiling, and the quota gate stops it at the share. A run
whose cost nobody reported blinds the dollar gate, and **no Rune build reports its window
yet**, so the quota gate is blind today: the series stops as soon as no authorisation it was
given can still be enforced — on `RUNE_EVAL_QUOTA_PCT` alone, that is after the first pair.
One pair can overshoot the dollar ceiling.

```sh
# The plan: every pair, argv, cwd and env names. Spawns nothing, not even --version.
bun run tests/eval/parity/run-pairs.ts --dry-run --arms rune,claude-code --mode product \
  --runs 2 --rune-model MODEL --claude-code-model MODEL --claude-code-effort high \
  --out /tmp/parity-plan

# Only after the founder authorises it in their own words, with the task count and arm order.
RUNE_EVAL_BUDGET_USD=<dollars> RUNE_PARITY_CLAUDE_CONFIG_DIR=<dir> \
  bun run tests/eval/parity/run-pairs.ts --real --arms rune,claude-code --mode product \
  --runs 2 --rune-model MODEL --claude-code-model MODEL --out <fresh-dir>
bun tests/eval/parity/report.ts --results <fresh-dir>/results.jsonl --out <report-dir>
```

Validated offline, with fakes only (injected arms, and the real arm modules pointed at fake
binaries — including a run whose `results.jsonl` the landed scorer accepts and pairs):

```sh
bun test tests/unit/eval/parity-fairness.test.ts tests/unit/eval/parity-run-pairs.test.ts \
  tests/unit/eval/comparator-arms.test.ts tests/unit/eval/comparator-envelope.test.ts \
  tests/unit/eval/comparator-arm-env.test.ts tests/unit/eval/comparator-series-budget.test.ts
bunx tsc --noEmit -p tests/eval
```

## The Claude Code and Codex arms

Two more comparators, built to the same interface as the OpenCode arm
(`arms/types.ts`: a plan, a parser, and a `runArm` that is only those two either
side of a spawn). Both are **validated and idle**: they have never been run
live, and the number they would produce does not exist yet. `arms/run-arms.ts`
runs any of the four arms — Rune included now — as a per-row series with the
legacy report shape; the paired rows the parity index reads come only from
`tests/eval/parity/run-pairs.ts` (above).

**Pinned versions.** `claude` 2.1.284 (Claude Code), whose `--help` every flag
below was read from on 2026-09-29, and `codex-cli` 0.154.0, installed on
2026-09-15. Every result records what `--version` said at the time of the run —
the paired runner asks before every run, because Claude Code updates itself — and
a row whose version is missing is not evidence.

**Flags, and why each one is there.**

| arm         | argv                                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code | `claude --print --output-format json --model M --effort high --setting-sources project --strict-mcp-config --no-session-persistence --permission-mode acceptEdits --allowedTools Bash,Edit,MultiEdit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite --disallowedTools WebFetch,WebSearch --permission-prompts none <prompt>` |
| codex       | `codex exec --json --sandbox workspace-write -c sandbox_workspace_write.network_access=false -c model_reasoning_effort="high" -m M --ignore-user-config --color never -C <fixture> --output-last-message <evidence>/last-message.txt <prompt>`                                                                            |

That is Claude Code's product mode; harness mode adds `--bare` after `--print`
(see the parity section for what each mode's environment holds).
`--setting-sources project` loads only the fixture's settings, never the user's
or a local override; there is no `--max-budget-usd`, because no arm is capped by
anything but the clock.

Claude Code's confinement is the tool's own mechanism: edits proceed without a
prompt, the task's tools are pre-approved so nothing legitimate waits on an
approval nobody can answer, web tools are denied, and `--permission-prompts none`
turns everything else that would ask — a write outside the fixture, with no
`--add-dir` — into a denial. Codex's is `--sandbox workspace-write` with network
access switched off explicitly; `--output-last-message` writes outside the
workspace so the answer text can never become a file the acceptance grades.

Both arms run in the fixture directory with the same wall-clock limit as the
Rune arm, and are sent the same prompt bytes — `comparisonPrompt` is one
function both runners import.

**The environment.** An allow-list (`armEnv`): the child gets a named neutral
base (`PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP`, `TERM`, `LANG`/`LANGUAGE`/`LC_*`)
plus the names the arm declares as its own, and nothing else. Claude Code keeps
`CLAUDE_CONFIG_DIR` in product mode — SET from `RUNE_PARITY_CLAUDE_CONFIG_DIR`,
never inherited, and with no API key — and `ANTHROPIC_API_KEY` in harness mode;
Codex keeps `OPENAI_API_KEY` and `CODEX_HOME`. A browser task adds
`RUNE_BENCH_PLAYWRIGHT` and `PLAYWRIGHT_BROWSERS_PATH` to every arm alike. A
`*_BASE_URL`, a proxy, `NODE_OPTIONS` or a model override in the shell never
reaches an arm, and neither does Rune's own `RUNE_*` configuration: a comparator
that read it would be reading the measuring instrument.

**What these arms cannot match.**

- **Model parity is impossible across all four arms.** Claude Code runs
  Anthropic models; the Codex CLI runs OpenAI models. A Claude-Code-versus-Codex
  row crosses model families, so it is a comparison of two products, not of two
  harnesses over one model. Same-model parity exists only between Rune and
  OpenCode, which can both be pointed at the same OpenAI model.
- **Reasoning is named, not proven equal.** `--effort high`,
  `-c model_reasoning_effort="high"`, OpenCode's `--variant high` and Rune's
  `reasoningEffort = "high"` are four vendors' words for a setting nobody has
  shown to be the same amount of thinking.
- **No arm has a dollar ceiling in a parity run.** Every arm is capped by the
  clock and nothing else; the money gate sits in front of the series. In the
  legacy `run-arms.ts` series the per-task `--budget-usd` is enforced during a
  run only for OpenCode (the rig stops it after a reported step crosses the
  figure, so an overshoot is possible and is recorded); for the other arms it
  is the series gate's estimate of one run, which a run can overshoot.
- **Tools, orchestration, prompts, subagents and helper routing stay each
  harness's own.** That is the point of the comparison and also its limit.

**The subscription-quota caveat.** On the founder's accounts these arms
authenticate against a Claude subscription and a ChatGPT plan. A run there
spends **quota, not dollars**: Claude Code's `total_cost_usd` is the tool's own
list-price reconstruction, Codex prints no cost figure at all, and the `listUsd`
this rig records for Codex is Rune's pricing table applied to Codex's reported
tokens. None of those is an invoice, quota is reported separately from API list
cost (the review's M5), and quota is the resource no ledger can refund.

**Scored or unscored: one classifier.** These arms no longer decide for
themselves. A quota, authentication or provider-server refusal the tool reported
is `unscored:<reason>` with the usage retained; a timeout, the tool's own turn or
dollar ceiling, and a crash after the first model call are the tool failing the
task and stay scored — for these arms exactly as for Rune (the table in the
parity section). An unscored row no longer stops a series; more than a quarter of
the planned rows or pairs coming back unscored does.

**Validated offline.**

```sh
bun test tests/unit/eval/comparator-arms.test.ts tests/unit/eval/comparator-envelope.test.ts \
  tests/unit/eval/comparator-arm-env.test.ts tests/unit/eval/parity-fairness.test.ts \
  tests/unit/eval/corpus-budget-guard.test.ts
bunx tsc --noEmit -p tests/eval
bun run tests/eval/comparison/arms/run-arms.ts --dry-run \
  --arms claude-code,codex --corpus tests/eval/corpus --model MODEL --out /tmp/arm-plan
```

The unit tests assert the exact argv, cwd and environment for a corpus task, in
both of Claude Code's modes; the classification of checked-in, credential-free
**synthetic** captures for success, quota refusal, auth failure, timeout and a
malformed envelope ([`arms/samples/README.md`](arms/samples/README.md) says how
they were written and what that limits), and of the same synthetic situations
written in all four tools' vocabularies; that the OpenCode arm's argv and env are
byte-identical to the parity harness's, and differ from the pilot's only by its
step cap; the Claude Code and Rune arms end to end against fake binaries; and
that `--dry-run` plans all twelve tasks for both arms while the only thing either
comparator is ever asked is `--version`. A dry run writes nothing: an arm's plan
is a pure value, and its profile directories are made only when it runs.

**Nothing has been run live.** The flags are read from `--help` at the installed
version and the captures are transcribed from the documented shapes, so the
first authorised run is also the first live test of both.

**The authorisation.** The live path refuses to start unless
`RUNE_EVAL_BUDGET_USD` names a positive number of dollars, and refuses a
`--budget-usd` above it — the same door the Rune and OpenCode arms stand behind.
Beyond that: **no live comparator run happens without the founder's explicit
authorisation, in their own words, naming the task count and the arm order.** It
spends their subscription quota, which makes it an external action, and no
instruction in a brief, a plan or a report substitutes for it.

```sh
# Only after that authorisation, with the task count and arm order it named.
RUNE_EVAL_BUDGET_USD=<dollars> bun run tests/eval/comparison/arms/run-arms.ts --real \
  --arms claude-code,codex --corpus tests/eval/corpus --model MODEL --effort high \
  --tasks csv-state-machine,off-by-one-window,queue-race \
  --out /tmp/rune-arms-<date> --budget-usd 2 --timeout-seconds 600
```

`--arms rune,claude-code` puts the Rune arm (the parity profile) in the same
series; `runner.ts --corpus` (above) is the older pilot's Rune side, on the pilot
profile. All of them seed the same fixtures and grade with the same
`acceptance.json`. Rows either one writes are not pairs: for the parity index,
use `run-pairs.ts` and its own door (`RUNE_EVAL_BUDGET_USD` or
`RUNE_EVAL_QUOTA_PCT`).

## SWE-bench predictions

Export the official dataset as JSONL, retaining `instance_id`, `repo`, `base_commit` and `problem_statement`. Provision one clean disposable checkout per pinned instance under `REPOS/INSTANCE_ID`, with its original Git remote and exact base commit. The adapter refuses missing IDs, dirty checkouts and wrong repository origins before inference. It does not provision Python dependencies or benchmark containers.

```sh
bun run tests/eval/comparison/swebench.ts --real \
  --dataset-jsonl /path/to/official-verified.jsonl --repos-root /path/to/repos \
  --model MODEL --provider PROVIDER --out /tmp/rune-swe-fresh \
  --budget-usd 2 --timeout-seconds 600
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path /tmp/rune-swe-fresh/predictions.jsonl --run_id UNIQUE_RUN_ID
```

Predictions contain the actual Git patch, including new/deleted files, using a temporary index that preserves the checkout's index. Agent prose is never redirected into a patch. Partial and empty patches remain visible. Only the [official SWE-bench evaluator](https://www.swebench.com/SWE-bench/guides/evaluation/) determines resolution. Choose a unique run ID to avoid reusing cached evaluation results.

## Terminal-Bench through Harbor

The pinned 20-task list is a **legacy core list**, not a verified Terminal-Bench 2.0 subset. The adapter validates every pinned ID against a supplied Harbor-format dataset and refuses mismatches instead of silently substituting tasks. For a new benchmark version, start a separately named series with its own recorded task selection.

The adapter implements [Harbor's custom agent interface](https://www.harborframework.com/docs/agents), tested against `harbor==0.22.0`. Supply a Linux bundle directory with executable `rune` and `rune-tools` matching the container architecture, through `RUNE_BENCH_BUNDLE`. It uploads them and verifies the binary inside the environment; it never runs the macOS binary or falls back to host execution. Provider API keys are passed as environment values, never command text or provenance. This adapter does not copy desktop subscription credentials into containers.

```sh
uv venv --python 3.12 /tmp/rune-harbor-venv
uv pip install --python /tmp/rune-harbor-venv/bin/python harbor==0.22.0
PYTHONPATH=tests/eval/comparison /tmp/rune-harbor-venv/bin/python \
  -m unittest tests/eval/comparison/test_harbor_agent.py

# Name preflight first; add --real only for an actual credentialed benchmark run.
/tmp/rune-harbor-venv/bin/python tests/eval/comparison/harbor_run.py \
  --tasks-root /path/to/legacy-harbor-tasks --model MODEL --out /tmp/rune-harbor-job
```

Put the isolated environment's `bin` directory on PATH when running the job. Set `RUNE_BENCH_PROVIDER`, `RUNE_BENCH_BUDGET_USD` and `RUNE_BENCH_TIMEOUT_SECONDS` as needed. Harbor owns the outer container; nested native sandboxing is disabled explicitly only inside that container. The adapter downloads private logs and gateway ledger data, leaving absent usage unknown. Harbor's verifier assigns rewards. A container run does not validate Rune's native Linux sandbox by itself.

Both external adapters currently run the **pristine control**. An evolved anchor still needs a frozen learned profile, matching control, provenance and an actual official run. The offline adapter checks and local pilot are not evidence that either external benchmark has been completed.
