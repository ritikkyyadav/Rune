# Reproducible harness comparisons

This directory contains a small live Rune/OpenCode pilot, two further comparator arms (Claude Code and Codex) validated offline and never yet run, an executable SWE-bench prediction adapter, and a Harbor adapter. None supplies an overall capability score. The pilot tasks are authored in this repository and are not an independent benchmark.

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
in the report, with a sanitized `unscoredReason`. The runner stops further tasks after an
infrastructure interruption. Ordinary tool failures or text mentioning quotas do not trigger
this exclusion. See the [dated evidence and corrections](../../../docs/audit-followthrough-20260908.md)
for the early attempts; the original aggregate reports were preserved.

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

## The Claude Code and Codex arms

Two more comparators, built to the same interface as the OpenCode arm
(`arms/types.ts`: a plan, a parser, and a `runArm` that is only those two either
side of a spawn). Both are **validated and idle**: they have never been run
live, and the number they would produce does not exist yet.

**Pinned versions.** `claude` 2.1.270 (Claude Code) and `codex-cli` 0.154.0, the
versions installed on the founder's machine on 2026-09-15. Every result records
what `--version` said at the time of the run; a row whose version is missing is
not evidence.

**Flags, and why each one is there.**

| arm         | argv                                                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claude-code | `claude --print --output-format json --model M --effort high --permission-mode acceptEdits --allowedTools Bash,Edit,MultiEdit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite --disallowedTools WebFetch,WebSearch --permission-prompts none --strict-mcp-config --no-session-persistence --max-budget-usd N <prompt>` |
| codex       | `codex exec --json --sandbox workspace-write -c sandbox_workspace_write.network_access=false -c model_reasoning_effort="high" -m M --ignore-user-config --color never -C <fixture> --output-last-message <evidence>/last-message.txt <prompt>`                                                                     |

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

**The environment.** Each arm keeps only the names that are its own auth
(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`;
`OPENAI_API_KEY`) and loses every other credential-shaped variable, by the
capture rig's stated predicate — secret suffixes plus the documented AWS/GCP
credential chain. Rune's own `RUNE_*` configuration is dropped too: a comparator
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
- **Only two arms have a dollar ceiling.** Rune reserves before inference and
  Claude Code takes `--max-budget-usd`. Codex has no such flag: its only
  per-task cap is the clock. OpenCode is stopped after a reported step crosses
  the ceiling, so an overshoot is possible and is recorded.
- **Tools, orchestration, prompts, subagents and helper routing stay each
  harness's own.** That is the point of the comparison and also its limit.

**The subscription-quota caveat.** On the founder's accounts these arms
authenticate against a Claude subscription and a ChatGPT plan. A run there
spends **quota, not dollars**: Claude Code's `total_cost_usd` is the tool's own
list-price reconstruction, Codex prints no cost figure at all, and the `listUsd`
this rig records for Codex is Rune's pricing table applied to Codex's reported
tokens. None of those is an invoice, quota is reported separately from API list
cost (the review's M5), and quota is the resource no ledger can refund.

**Unscored, not failed.** Quota, authentication, provider-server and timeout
interruptions produce `unscored:<reason>` with the usage retained and stop the
series. A turn ceiling is not an interruption: it is the comparator failing the
task, and it stays scored.

**Validated offline.**

```sh
bun test tests/unit/eval/comparator-arms.test.ts tests/unit/eval/corpus-budget-guard.test.ts
bunx tsc --noEmit -p tests/eval
bun run tests/eval/comparison/arms/run-arms.ts --dry-run \
  --arms claude-code,codex --corpus tests/eval/corpus --model MODEL --out /tmp/arm-plan
```

The unit tests assert the exact argv, cwd and environment for a corpus task; the
classification of checked-in, credential-free **synthetic** captures for success,
quota refusal, auth failure, timeout and a malformed envelope
([`arms/samples/README.md`](arms/samples/README.md) says how they were written
and what that limits); that the OpenCode arm's argv and env are byte-identical
through the new interface; and that `--dry-run` plans all twelve tasks for both
arms while the only thing either comparator is ever asked is `--version`. A dry
run of the OpenCode arm does create that arm's profile directory, because
`prepareHarness` builds its environment by writing one; it starts no process.

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

The Rune side of the same comparison is `runner.ts --corpus` (above), which
seeds the same fixtures and grades with the same `acceptance.json`.

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
