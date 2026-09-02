# Gear in CI

One prompt in, an answer and an exit code out. No terminal, no cursor
addressing, nothing to answer.

```bash
gear -P "run the tests and fix what fails" --stream-json --gear 3 --workspace .
```

That is the CI form, and every part of it is load-bearing:

| Flag            | Why                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-P "<prompt>"` | headless: stdout is the answer, progress goes to stderr, so `gear -P … > out.txt` captures the answer alone                                                 |
| `--stream-json` | every event as NDJSON while it happens, the envelope last. Without it a run reports one envelope after minutes of silence and "working" looks like "wedged" |
| `--gear 3`      | workspace edits plus a **sandboxed** shell. `4` is full autonomy and skips the permission engine — see below                                                |
| `--workspace .` | the directory the agent may touch, stated rather than inherited from `cwd`                                                                                  |

## The exit-code contract

```
0   the turn completed
1   the turn raised a terminal error
3   the run needed permission and had nobody to ask
```

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
$ gear -P "say ok" --stream-json
{"type":"text_delta","text":"ok"}
{"type":"usage","inputTokens":812,"outputTokens":3,...}
{"type":"turn_complete","stopReason":"end_turn","totalTurns":1}
{"ok":true,"sessionId":"01a0…","text":"ok","toolCalls":0,"toolErrors":0,"filesChanged":[],"permissionsDenied":0,"usage":{...},"durationMs":1840}
```

Every line before the envelope is an `AgentTurnEvent` — the same 22-member
union the terminal, the desktop and the SDK read, declared once in
`@gear/protocol`. A consumer can render progress with that package and nothing
else.

The envelope carries `sessionId`, which is what makes the run auditable
afterwards:

```bash
gear audit <sessionId>          # the plan with its evidence, every safety decision, the cost
```

`--json` on its own keeps the indented envelope a person reads. `--stream-json`
compacts it, because a pretty-printed record spread over eighteen lines is not
NDJSON and a line-by-line consumer would choke on it.

## Credentials

Gear reads provider keys from the environment, under each provider's own
conventional name — no Gear-specific rename, so a runner that already has a key
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

Behaviour is tuned with `GEAR_*`. The ones a CI job usually wants:

| Variable                    | Effect                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `GEAR_HOME`                 | where config, credentials and the session database live (default `~/.gear`)  |
| `GEAR_WORKSPACE`            | the workspace root, when not passing `--workspace`                           |
| `GEAR_DB_PATH`              | the session database, for a run that should not write to the shared one      |
| `GEAR_TOOLS_BIN`            | the native tool executor. **Required** unless it is on the default path      |
| `GEAR_ROUNDTRIP_TIMEOUT_MS` | how long a permission or question waits before the unattended policy applies |
| `GEAR_TELEMETRY`            | opt-in diagnostics. Off by default; leave it off                             |

`gear doctor` reports what is missing, and `gear tools-smoke` proves the tool
executor works end to end. Run both in a job that is failing for reasons that
are not the model's.

## The GitHub Action

`action/` is a composite action in the `savoir/gear-action` shape. It installs
Gear — a pinned release when one is named, otherwise a build from the checkout
— runs one prompt over the pull request diff, and posts **one** comment with
the review and the audit of the run that produced it.

```yaml
- uses: savoir/gear-action@v1
  with:
    version: v0.3.0 # omit to build from the checkout
    gear: "3"
    prompt: "" # empty runs the default review prompt
  env:
    ANTHROPIC_API_KEY: ${{ secrets.GEAR_REVIEW_API_KEY }}
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
  --gear-cmd "bun packages/orchestrator/src/bin/gear-cli.ts"
```

`tests/integration/gear-action.test.ts` runs exactly that path against a fake
model, so the action is exercised on every test run rather than first executed
on somebody's pull request.

### This repository's own workflow

`.github/workflows/gear-review.yml` runs the action on pull requests here,
**gated on `GEAR_REVIEW_API_KEY` being present**. Without the secret it skips
with a notice instead of failing. A workflow that needs a key and does not
check for one fails red on every fork and every pull request opened before the
key exists, and a red check nobody can fix teaches people to ignore red checks.

## `gear pr <n>`

For working a pull request locally rather than in CI:

```bash
gear pr 12            # fetch the head into its own worktree and start a session on it
gear pr 12 --review   # frame the session as a review rather than as work
gear pr 12 --brief    # print the brief and stop
```

It fetches `refs/pull/<n>/head` with plain git — a ref every GitHub remote
publishes, so it works on a runner where `gh` is not authenticated — puts it in
`.gear/worktrees/pr-<n>` rather than over your working tree, and hands the
session the author's description **verbatim** as its brief. The author's own
account of the change is the thing a review is checked against; a summary of it
written by the reviewer is already a reading.
