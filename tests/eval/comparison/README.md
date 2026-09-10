# Reproducible harness comparisons

This directory contains a small live Rune/OpenCode pilot, an executable SWE-bench prediction adapter, and a Harbor adapter. None supplies an overall capability score. The pilot tasks are authored in this repository and are not an independent benchmark.

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
