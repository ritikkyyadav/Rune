# Rune in CI

One prompt in, an answer and an exit code out. No terminal, no cursor
addressing, nothing to answer.

```bash
rune -P "run the tests and fix what fails" --stream-json --gear 3 --workspace .
```

That is the CI form, and every part of it is load-bearing:

| Flag            | Why                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-P "<prompt>"` | headless: stdout is the answer, progress goes to stderr, so `rune -P … > out.txt` captures the answer alone                                                 |
| `--stream-json` | every event as NDJSON while it happens, the envelope last. Without it a run reports one envelope after minutes of silence and "working" looks like "wedged" |
| `--gear 3`      | workspace edits plus a **sandboxed** shell. `4` is full autonomy and skips the permission engine — see below                                                |
| `--workspace .` | the directory the agent may touch, stated rather than inherited from `cwd`                                                                                  |

## The exit-code contract

```
0     the run finished: the model ended its turn
1     execution failed: an error, a stall, a stopped loop, open steps, a safety halt
3     the run needed permission and had nobody to ask
4     the run stopped at a limit: turns, output tokens or budget
5     the provider could not go on: a usage cap (see resumeAt) or lost after retries
130   the run was cancelled; a signal's own code wins (129 SIGHUP, 130 SIGINT, 143 SIGTERM)
```

The exit code says how the run **ended**. Whether the task was **met** is the
envelope's to say: `ok`, `verdict` and `shortfall`, which mean what they meant
before. Until 1.4.3 a finished run whose own verdict was `partial` or `unmet`
exited 1, the same code as a crash, and every live run in the October sittings
did that on work that passed every hidden check. `--strict-verdict` keeps that
rule for a caller that wants it: with it, a finished run exits 1 when its
verdict fails it, in the two cases below.

An `end_turn` event describes the model stopping, not whether it satisfied the
request. A `partial` or `unmet` verdict produces `ok: false` in the JSON envelope
in two cases; the run's text and evidence remain available either way.

- The run stated what done means (a read-back) **and changed files**, and did not
  show all of it.
- The run was held to a criterion from outside itself — the person's, or an
  `--acceptance` check — whether or not anything changed.

Everything else is judged by whether it ran, as it always was: a run that stated no
criteria (a greeting, a question, a first prompt — these end `unmet` with "no criteria
stated" by construction), and a run that only read back its own terms and changed
nothing (a review, a plan, an answer), for which `partial` is the best verdict there
is. A conversational `none` exits 0. Older hosts without a verdict retain their
execution status.

**`done`** (1.4.12) is a finished run whose work stands, short of being shown criterion
by criterion. It needs all of these:

- the run ended on its own and changed files;
- the project's own checks passed on the tree it left, with nothing able to change a file
  run after them (a check red only on failures that predate the run is named, not held
  against it);
- no planned step is open, nothing was seen to fail, and every criterion still short is one
  the run wrote for itself;
- the **request check** found every ask of the person's request in the change. That check
  is one call on the session's model, reading the request beside exactly what the run
  changed (never the person's own uncommitted work). An ask it does not find buys one
  re-prompt naming it; still missing, it is a gap named `the request`, and the run ends
  `partial`.

`done` produces `ok: true`. `met` is unchanged: every criterion shown by a check bound to
it, and no ask of the request found missing.

### How a run ends

The envelope's `stopReason` is the loop's own word for it, and `subtype` is the
same thing in the words the exit code is chosen by.

| `stopReason`                         | `subtype`                | Exit | What to do                                                                                                  |
| ------------------------------------ | ------------------------ | ---- | ----------------------------------------------------------------------------------------------------------- |
| `end_turn`                           | `success`                | 0    | Read `verdict` for whether the task was met                                                                 |
| `open_steps`                         | `error_open_steps`       | 1    | The loop stopped the run with its own planned steps open, after refusing the finish once; resume or re-plan |
| `max_turns`, `max_tokens`            | `error_max_turns`, `…`   | 4    | Continue with `rune resume`, or raise the limit                                                             |
| `budget`                             | `error_budget`           | 4    | Raise the budget, or switch to a priced model                                                               |
| `quota_wall`                         | `error_quota`            | 5    | The provider's usage cap: wait until `resumeAt` (epoch ms), or let `--resume-until` wait for you            |
| `provider_lost`                      | `error_provider`         | 5    | The provider stopped answering after the retries; try again later, `rune resume` continues from the handoff |
| `halted`                             | `error_halted`           | 1    | The run read instructions flagged as injected and a safety block stopped it; read what it read first        |
| `aborted`                            | `error_cancelled`        | 130  | Cancelled; the partial work is kept                                                                         |
| `stalled`, `loop_detected`, `barren` | `error_during_execution` | 1    | Nothing was progressing; resume with a different approach                                                   |

A usage cap was recorded as `provider_lost` before 1.4.3. In one install's
record, 39 of 44 runs that ended that way had hit a Codex limit with a known
reset rather than lost the provider.

Since 1.4.5 a safety block stops the action, not the run: `halted` needs
evidence that the run read injected instructions (see
[`auto-mode.md`](auto-mode.md#what-ends-a-run)). A headless run's own bounds are
`--max-turns <n>` (default 80, `0` for none) and `--max-budget-usd <usd>`; an
interactive session has no turn ceiling unless `[reliability] maxTurns` sets
one.

`max_tokens` is also how a run ends when the conversation no longer fits the
model's context window and compacting it could not make it fit. The error says
so: resume in a fresh session from the handoff, or use a model with a larger
window. Before 1.4.4 the same prompt was sent again until the run ended
`provider_lost`.

`3` is separate from `1` on purpose: the fix is a flag, not a retry. A headless
run **denies every permission request by default**, because the alternative is
silently granting whatever a model asked for to a process nobody is watching.
When that happens, stderr says so once, by count, so a harness does not score a
refusal as a capability failure:

```
2 permission request(s) denied — no approver in a headless run. Pass --auto-approve to grant them.
```

`--auto-approve` grants them. Turn it on deliberately, inside a container or a
throwaway checkout — it is the flag that makes a CI job able to do anything the
model asks for.

## The stream

One JSON object per line, the envelope **last**:

```bash
$ rune -P "say ok" --stream-json
{"type":"text_delta","text":"ok"}
{"type":"usage","inputTokens":812,"outputTokens":3,...}
{"type":"turn_complete","stopReason":"end_turn","totalTurns":1}
{"ok":true,"sessionId":"01a0…","text":"ok","toolCalls":0,"toolErrors":0,"filesChanged":[],"permissionsDenied":0,"usage":{...},"durationMs":1840}
```

Every line before the envelope is an `AgentTurnEvent` — the same 22-member
union the terminal, the desktop and the SDK read, declared once in
`@rune/protocol`. A consumer can render progress with that package and nothing
else.

The envelope carries `sessionId`, which is what makes the run auditable
afterwards:

```bash
rune audit <sessionId>          # the plan with its evidence, every safety decision, the cost
```

`--json` on its own keeps the indented envelope a person reads. `--stream-json`
compacts it, because a pretty-printed record spread over eighteen lines is not
NDJSON and a line-by-line consumer would choke on it.

## Credentials

Rune reads provider keys from the environment, under each provider's own
conventional name — no Rune-specific rename, so a runner that already has a key
for something else needs no new secret:

| Provider   | Variable             |
| ---------- | -------------------- |
| Anthropic  | `ANTHROPIC_API_KEY`  |
| OpenAI     | `OPENAI_API_KEY`     |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google     | `GOOGLE_API_KEY`     |
| Groq       | `GROQ_API_KEY`       |
| xAI        | `XAI_API_KEY`        |
| DeepSeek   | `DEEPSEEK_API_KEY`   |
| Ollama     | `OLLAMA_API_KEY`     |

Behaviour is tuned with `RUNE_*`. The ones a CI job usually wants:

| Variable                    | Effect                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `RUNE_HOME`                 | where config, credentials and the session database live (default `~/.rune`)  |
| `RUNE_WORKSPACE`            | the workspace root, when not passing `--workspace`                           |
| `RUNE_DB_PATH`              | the session database, for a run that should not write to the shared one      |
| `RUNE_TOOLS_BIN`            | the native tool executor. **Required** unless it is on the default path      |
| `RUNE_ROUNDTRIP_TIMEOUT_MS` | how long a permission or question waits before the unattended policy applies |
| `RUNE_TELEMETRY`            | opt-in diagnostics. Off by default; leave it off                             |

`rune doctor` reports what is missing, and `rune tools-smoke` proves the tool
executor works end to end. Run both in a job that is failing for reasons that
are not the model's.

## The GitHub Action

`action/` is a composite action in the `savoir/rune-action` shape. It installs
Rune — a pinned release when one is named, otherwise a build from the checkout
— runs one prompt over the pull request diff, and posts **one** comment with
the review and the audit of the run that produced it.

```yaml
- uses: savoir/rune-action@v1
  with:
    version: v0.3.0 # omit to build from the checkout
    gear: "3"
    prompt: "" # empty runs the default review prompt
  env:
    ANTHROPIC_API_KEY: ${{ secrets.RUNE_REVIEW_API_KEY }}
```

One comment, edited in place on every push, found by an HTML marker rather than
by the bot's login — so changing the token does not start a second thread. A
reviewer wants the current state of the change, not a history of what a model
thought about earlier versions of it.

The comment has two halves and they are not the same kind of claim. The review
is the model's opinion. The collapsed audit summary underneath is what the run
actually **did**: the tools it called, the permission decisions and their
reasons, the cost. Publishing them together is the difference between "a bot
said this" and "a bot said this, and here is its receipt".

The default prompt asks for a plan ledger and for verified and inspected to be
kept apart — a review that says "looks correct" about code it never ran is
worth knowing about as such.

### Running it without a pull request

The whole action body is `action/review.ts`, so it can be run locally against
any checkout. `--dry-run` prints the comment instead of posting it:

```bash
bun action/review.ts --dry-run \
  --workspace . --base main --gear 3 \
  --rune-cmd "bun packages/orchestrator/src/bin/rune-cli.ts"
```

`tests/integration/rune-action.test.ts` runs exactly that path against a fake
model, so the action is exercised on every test run rather than first executed
on somebody's pull request.

### Running it with no provider key at all

```bash
bun action/review.ts --dry-run --mock \
  --workspace . --base main --gear 2 \
  --rune-cmd "bun packages/orchestrator/src/bin/rune-cli.ts"
```

`--mock` (or `RUNE_REVIEW_PROVIDER=mock`) makes `review.ts` start its own
provider: Ollama reads its base URL from `OLLAMA_HOST` and authenticates
nothing, so a thirty-line server is a complete provider as far as Rune is
concerned. Everything else is real — the diff, the session, the turn, the audit,
the comment.

The comment says what it is in three places: **the heading**, a blockquote
before anything else, and the footer. A comment that looks like a review and was
produced by a mock is worse than no comment at all.

### This repository's own workflow

`.github/workflows/rune-review.yml` runs the action on pull requests here, in
one of three modes:

| `RUNE_REVIEW_API_KEY` | Pull request from | What runs                                                                              |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| set                   | anywhere          | a real review from a real model                                                        |
| not set               | this repository   | the same action against the **mock provider**, posting a comment labelled as a dry run |
| not set               | a fork            | skipped with a notice                                                                  |

The mock path exists because the previous gate was a claim that had never been
tested: the workflow was gated on a secret that does not exist, so it skipped on
every pull request ever opened here and the action's comment path — post once,
then edit that same comment forever — had never run outside a test. Now it runs
on every PR and the real-model path stays behind the secret.

The fork case stays skipped: a fork's `GITHUB_TOKEN` is read-only, so posting
would fail with a 403 — a red check a contributor cannot fix, which is the thing
the gate existed to avoid in the first place.

Both modes write the **same** comment, found by the same HTML marker, so the
first real review replaces the dry run in place rather than starting a second
thread under it.

## `rune pr <n>`

For working a pull request locally rather than in CI:

```bash
rune pr 12            # fetch the head into its own worktree and start a session on it
rune pr 12 --review   # frame the session as a review rather than as work
rune pr 12 --brief    # print the brief and stop
```

It fetches `refs/pull/<n>/head` with plain git — a ref every GitHub remote
publishes, so it works on a runner where `gh` is not authenticated — puts it in
`.rune/worktrees/pr-<n>` rather than over your working tree, and hands the
session the author's description **verbatim** as its brief. The author's own
account of the change is the thing a review is checked against; a summary of it
written by the reviewer is already a reading.

The title and body come from `gh pr view` when the CLI is authenticated, and
from the REST API otherwise. That fallback reads **`GITHUB_API_URL`**, the
variable every Actions runner sets and which names the Enterprise Server API
root on a self-hosted one, so `rune pr` works on GHES with nothing to configure.
Both calls time out at 30 s: a GitHub that accepts a connection and never
answers used to hang the command with nothing on screen.

`tests/integration/rune-pr.test.ts` runs all of it against a **local bare
repository with a `refs/pull/<n>/head` ref in it** — the same shape GitHub
publishes, and the only thing the command needs from a remote, which is the
whole reason it uses plain git. It drives both metadata paths (a stub `gh` on
PATH, and the REST fallback against a fake API at `GITHUB_API_URL`) and asserts
the worktree, the branch, the brief, and that the working tree it was run from
is untouched.

It found one defect: **re-running `rune pr <n>` after the author pushed used to
fail outright.** Git refuses to update a branch that is checked out in a
worktree, so the fetch died with "refusing to fetch into branch" before the code
that exists to move the worktree to the new head could run — the second run, the
one a person makes _because_ the author pushed, was the broken one. The head now
lands on `refs/rune/pull/<n>` first, which is not a branch and so is never
checked out anywhere.
