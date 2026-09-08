# Rune vs OpenCode, same model, same fixtures — 2026-09-08

The first recorded run of the comparison harness in `tests/eval/comparison/`. Both agents ran
the identical model, `gpt-oss:120b`, through their own existing ollama.com credentials
(Rune `ollama-turbo`, OpenCode 1.18.23 `ollama-cloud`), on byte-identical fresh fixtures, with
acceptance checked by the harness outside either agent's workspace. Rune's arm was the installed
release binary `v0.4.0-dev+cdfb475`; OpenCode ran with `permission: allow`, `--variant high`.
Three internally authored coding tasks, two runs each, arm order alternated, $2 list ceiling per
task, 15-minute timeout. Nothing was spent: both routes are free tiers.

## Results

| Task                     | Run | Rune                    | OpenCode                |
| ------------------------ | --- | ----------------------- | ----------------------- |
| csv-state-machine        | 1   | passed · $0.020 · 75 s  | failed · $0.015 · 78 s  |
| csv-state-machine        | 2   | passed · $0.016 · 56 s  | failed · $0.018 · 109 s |
| working-tree-integration | 1   | passed · $0.022 · 83 s  | passed · $0.012 · 55 s  |
| working-tree-integration | 2   | passed · $0.030 · 60 s  | failed · $0.002 · 7 s   |
| dependent-migration      | 1   | passed · $0.038 · 105 s | failed · $0.011 · 50 s  |
| dependent-migration      | 2   | passed · $0.028 · 57 s  | passed · $0.014 · 143 s |

|                             |       Rune |                                 OpenCode |
| --------------------------- | ---------: | ---------------------------------------: |
| Acceptance passed           | **6 of 6** |                               **2 of 6** |
| Mean list cost per task     |     $0.026 | $0.012 (all runs) · $0.013 (passed runs) |
| Mean wall time              |       72 s |                                     74 s |
| Over budget or timed out    |          0 |                                        0 |
| Source changed during a run |       none |                                     none |

Dollar figures are list-price estimates from Rune's shared pricing table applied to both arms'
reported usage; they are not invoices, and both routes billed nothing.

## Reading it

- **Completion.** Rune finished every task; OpenCode finished a third. One OpenCode run ended
  after seven seconds having done almost nothing, a shape the 2026-09-03 trial also saw on this
  endpoint. This is the pitch the README makes, now at six runs per arm instead of one.
- **Cost.** Rune spent about twice OpenCode's tokens per task, roughly 1.9× on the runs both
  passed. That is the price of the plan ledger, evidence recording and verification steps, and
  it is the number the prompt-overhead work is chipping at.
- **Speed.** Equal within noise.

## Limits, as the harness itself states them

Small, internally authored pilot; not SWE-bench or Terminal-Bench and not an overall capability
score. Each harness keeps its own tools, prompts and orchestration; only the model and reasoning
setting are equalised. Two runs per task per arm. One free route, one model. Raw event logs and
databases stay private (provider errors can carry headers); this page is the reviewed aggregate.
