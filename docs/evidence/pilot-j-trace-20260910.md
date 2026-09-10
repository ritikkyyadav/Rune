# Pilot J, read from the run's own database — 2026-09-10

Pilot J ran the CSV task on the `0946e42` build with the ephemeral-tail fold, gpt-5.6-sol at high
reasoning, a 240 s limit and a $1 cap, against OpenCode 1.18.23 on the same model. Aggregate:
Rune passed acceptance but hit the limit after 11 primary completions and one supervisor call
at an estimated $0.1385; OpenCode finished in 154.2 s over 10 steps at $0.0752. This note reads
the Rune arm's `rune.db` cost events and event stream, the way the Pilot H note did.

## The cache now extends

| Request | Prompt tokens | Cached | Uncached | Note |
| ------- | ------------: | -----: | -------: | ---- |
| 1 | 10,046 | 0 | 10,046 | cold |
| 2 | 10,408 | 3,840 | 6,568 | doctrine phase switch, as in every run |
| 3 | 11,249 | 10,240 | 1,009 | |
| 4 | 11,527 | 0 | 11,527 | **full miss** after `read_back` |
| 5 | 14,976 | 11,392 | 3,584 | |
| 6 | 15,310 | 0 | 15,310 | **full miss** after the first passing `bun test` |
| 7 | 15,400 | 15,104 | 296 | |
| 8 | 23,881 | 15,232 | 8,649 | three tool results landed at once |
| 9 | 24,495 | 23,680 | 815 | |
| 10 | 24,882 | 24,320 | 562 | 98% hit |

Pilot H on the previous build read 12,160 cached tokens on every request from the fifth to the
last while prompts grew to 18,212. Here the cached count tracks the prompt from request 7 on. That
is what the fold was for, and it is the first live run that shows it. It is one run.

The two full misses are not the tail. Each follows a moment the just-in-time doctrine adds a
section to the system prompt: the plan section after `read_back`, the verification section after
the first passing check. A changed system prompt invalidates the whole prefix, so each costs a
re-read of the entire prompt, about 27,000 uncached tokens together, roughly a fifth of this run's
input spend. Serving those sections as tail text, the way the ledger now rides, would keep the
prefix; that is a design change to measure, not a claim.

## Where the completions went

Seventeen tool calls across eleven completions. The work was done by completion 6: read, list,
status, read `package.json`, `read_back`, one `apply_patch` carrying the parser and its tests
(1,998 output tokens, 67 s of the 240), then `bun test` green and cited as `verified` against the
parent commit in the same response as the check. That is the same-response citation working.

Completions 7 to 11 went to evidence bookkeeping:

- A `bun -e '…assert.deepEqual(…)…'` probe passed and was cited for criterion 1.
  `record_evidence` answered "nothing on record": inline scripts were not recognized as checks.
  The model re-ran it as a standalone command, cited again, was refused again, and was rewording
  it with character codes when the limit hit. Three completions and one supervisor screen.
- The classifier now recognizes `node -e`, `bun -e`, `python -c`, `deno eval`, `ruby -e` and
  `perl -e` scripts that assert, expect, exit non-zero or raise. A script that only prints is still
  not a check. Pinned in `tests/unit/orchestrator/verification-command.test.ts`.
- The refusal text says "a citation to a command that never ran is not evidence". The command had
  run. A reply that says "ran, exit 0, not a recognized check; write it as a test file or cite a
  check command" would stop the rewording. That change touches `brief.ts`, which another session
  has in flight, so it is recorded here rather than made.

OpenCode's ten steps: three `todowrite` calls, three globs and three reads in two batches, one
`apply_patch`, `bun test` plus `git diff --check` in one batch, a diff review, and the closing
message. Both harnesses spend three to four completions on bookkeeping; Rune's extra three were
the refused citations.

## Per completion

Rune: 11 completions in the 196 s before its last request, about 18 s each, one of them the
67 s patch. OpenCode: 10 steps in 154 s, about 15 s each, its patch 1,169 output tokens. Per-token
prices were identical on both sides; with the three refused-citation completions removed, Rune's
estimate on this run would have been about $0.11 against OpenCode's $0.075, and it would have
finished inside the limit. That is arithmetic on one run, not a result.

Receipts: `.codex/audit-20260910/comparison-j/` (private), aggregate to be recorded by the
session that ran it.
