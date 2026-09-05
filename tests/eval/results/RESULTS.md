# Rune eval — first real measured success rate

Goal: produce Rune's first measured task-success rate on the real engine (live
model, real workspaces, `verify()`-gated), runnable on both a paid ceiling and a
free/keyless floor. This file records what was actually measured, honestly.

## Floor run — 2026-06-19 (free Gemini tier)

`bun run tests/eval/runner.ts --real` · provider `google` / `gemini-2.5-flash`

| Category            | Pass            | Note                                        |
| ------------------- | --------------- | ------------------------------------------- |
| core                | 7/7 (100%)      | clean                                       |
| comprehension       | 4/4 (100%)      | clean                                       |
| fix-failing-test    | 3/3 (100%)      | clean                                       |
| multi-file-refactor | 3/3 (100%)      | clean                                       |
| new-feature         | 0/4 (0%)        | first two ran 169s/69s then quota collapsed |
| tool-discipline     | 0/4 (0%)        | ran after quota exhaustion — 0 turns / $0   |
| **Total**           | **17/25 (68%)** | **throttle-contaminated**                   |

Raw: `floor-gemini-2.5-flash.json` (also the active `../baseline.json`).

### What's trustworthy vs contaminated

- **Trustworthy:** core, comprehension, fix-failing-test, multi-file-refactor —
  all 100% on a real model. Rune reliably does code comprehension, single-file
  bug fixes, and multi-file renames/refactors end-to-end.
- **Contaminated:** new-feature and tool-discipline collapsed to 0/4 at ~3s /
  **0 turns / $0 cost** — the signature of Gemini free-tier rate-limiting, not a
  measured capability gap. The two long new-feature tasks (169s, 69s) exhaust
  the free quota, and everything after fails instantly. An isolated
  tool-discipline rerun also hit 0/4 because the daily quota was already spent.
- **Conclusion:** the free tier _cannot_ produce a clean number — it
  self-throttles mid-suite. A funded/paid key is required for the real ceiling.

## Ceiling run — 2026-06-19 (Ollama Turbo, hardened harness) ✅

`RUNE_EVAL_PROVIDER=ollama-turbo RUNE_EVAL_MODEL=qwen3-coder-next` with pacing
(`RUNE_EVAL_TASK_DELAY_MS=3000`, retries 3 @ 8s base).

| Category            | Measured          | Note                                  |
| ------------------- | ----------------- | ------------------------------------- |
| core                | 7/7 (100%)        |                                       |
| comprehension       | 4/4 (100%)        |                                       |
| fix-failing-test    | 3/3 (100%)        |                                       |
| multi-file-refactor | 3/3 (100%)        |                                       |
| new-feature         | 1/2 (50%)         | 1 genuine miss + 2 throttled          |
| tool-discipline     | 0/0               | all 4 throttled (tail-starved)        |
| **Clean**           | **18/19 = 94.7%** | raw 18/25 (72%); 6 throttled excluded |

Raw: `ceiling-qwen3-coder-next.json` (now the active `../baseline.json`).

**This is Rune's real measured ceiling.** Comprehension, bug-fixes, and
multi-file refactors are 17/17 on a capable model — the 68% floor was mostly
throttle, not capability. Two real (non-throttle) findings:

1. `new_feature_logger_module` genuinely failed — feature built but the test
   file (`app.test.ts`) wasn't created/named so verify's `bun test` matched
   nothing. A real, fixable capability gap.
2. **tool-discipline still unmeasured** — those 4 tasks are at the END of the
   suite; the 90s `new_feature_validation_util` task re-trips the Ollama session
   window and starves the tail. Fix: run tool-discipline alone, or reorder the
   suite so the cheap/strict tasks run before the long generative ones.

## Earlier ceiling attempt — BLOCKED (superseded)

Attempted `openrouter` with `anthropic/claude-sonnet-latest`, then a valid
non-alias id `anthropic/claude-opus-4.8`. Both blocked by:

- **OpenRouter account has no credits** → `"No credits on openrouter"`. Even a
  valid model can't run until the account is funded.
- `~`-prefixed slugs from `/models` (e.g. `~anthropic/claude-sonnet-latest`) are
  aliases the chat endpoint rejects ("400 not a valid model ID"). Use concrete
  ids like `anthropic/claude-opus-4.8`.

To get the clean ceiling: fund the OpenRouter account **or** set a direct
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, then:

```
ANTHROPIC_API_KEY=sk-... RUNE_EVAL_PROVIDER=anthropic \
  RUNE_EVAL_MODEL=claude-sonnet-4-20250514 bun run tests/eval/runner.ts --real
```

## Harness hardening (done 2026-06-19)

The free tier self-throttles mid-suite, so raw pass-rate is meaningless. The
harness now separates throttle noise from real failures:

- **Error capture:** `error` stream events are collected; a 0-turn run that hit
  a rate/usage-limit error is marked `throttled` and shows the _real_ reason
  (`rate-limited: …`) instead of a misleading verify message.
- **Clean pass-rate:** the headline is `passed / measured` where
  `measured = total − throttled`. Throttled tasks count as neither pass nor
  fail. Per-category shows `(N thr)`.
- **Retry + pacing:** throttled tasks retry with exponential backoff
  (`RUNE_EVAL_MAX_RETRIES`, `RUNE_EVAL_RETRY_BASE_MS`), and real runs pace
  between tasks (`RUNE_EVAL_TASK_DELAY_MS`, default 1500ms) to avoid tripping
  per-minute limits.
- **Baseline guard:** every run is archived to `results/run-<ts>-<tag>.json`;
  `baseline.json` is only promoted on a clean run (0 throttled) unless
  `--write-baseline` is passed. This is what stops a broken/rate-limited run
  from clobbering a good baseline (the no-credits "16% ceiling" can't happen).
- **CI gate** (`--min-pass-rate`) now scores the clean rate, so a throttled run
  won't spuriously fail CI.

Status: **all ceiling providers throttled right now** (OpenRouter no-credits,
Gemini free burned, Ollama Turbo session-usage-limit 429). Re-run the full suite
once the Ollama session limit cools down — the new pacing/backoff should let it
complete and produce a genuinely clean ceiling number that promotes to baseline.

## Bugs found while measuring (separate fixes)

1. The eval runner / sweep examples referenced `anthropic/claude-sonnet-4`, an
   **invalid OpenRouter slug** → instant 0-turn failures that look like a 16%
   "ceiling" but are pure provider errors. Don't trust any sub-100ms/0-turn run.
2. No clean cross-provider model remap on fallback: a request for an
   OpenRouter-only id falls back to Google but the id can't be served there
   (handled via remap-to-default, but worth a real model-aliasing pass).
