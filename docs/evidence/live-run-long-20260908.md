# Long live run on a free route — 2026-09-08

The second P12.6 live check, after the public release: a multi-file task with tests, run
detached, on the free ollama.com route, with the installed `v0.4.0-dev+a93731f` binary
(checksum `3bee21e6…`). No credits spent.

## Command

```sh
rune detach "Build a small but complete command-line todo manager in TypeScript for Bun
in this empty repository. Requirements: src/store.ts persists todos to a JSON file whose
path is given by the TODO_FILE env var (default ./todos.json) with add/list/complete/remove
operations and stable numeric ids; src/cli.ts exposes 'add <text>', 'list' (with --all to
include completed), 'done <id>', 'rm <id>' and prints readable output and non-zero exit
codes on bad input; src/format.ts renders the list as an aligned table. Write bun:test
tests for the store (at least 6 cases including persistence across instances and bad ids)
and for the CLI by spawning it as a subprocess (at least 4 cases). Add a package.json with
a test script and a short README with usage examples. Run the tests and fix everything
until they all pass. Then run the CLI once end to end (add two, complete one, list) and
paste the output into the README. Stop when done." \
  --gear 4 --workspace /tmp/rune-long-1421 -p ollama-turbo -m gpt-oss:120b
```

Fresh `git init` workspace. Session `01a08036`.

## The first attempt died, and that was a defect

The same command run an hour earlier printed `detached run started` and then ended at its
first completion: `openrouter/minimax/minimax-m3:free is gone — HTTP 404`. `rune detach`
parsed `-p`, `-m` and `--gear` and forwarded none of them to the host, so the run booted on
the pinned model, which OpenRouter had retired that day. Fixed in `a93731f`: the launcher
hands the flags to the host as session-scoped environment that beats the pin, and prints
the route it used. The run above is the retry on the fixed binary; its cost rows name
`ollama-turbo/gpt-oss:120b` on every completion.

## Result

|                        |                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Retro outcome          | `finished`                                                                                                        |
| Tool calls             | 28, 2 failed                                                                                                      |
| Completions            | 29, all on `ollama-turbo/gpt-oss:120b`                                                                            |
| Checks passed / failed | 3 / 0                                                                                                             |
| Files written          | 9 (`src/store.ts`, `src/cli.ts`, `src/format.ts`, two test files, `package.json`, `README.md`, two run artifacts) |
| Wall time              | about 13 minutes                                                                                                  |

Independent check, outside the agent:

```
$ bun test
 9 pass
 0 fail
Ran 9 tests across 2 files. [342.00ms]

$ TODO_FILE=/tmp/t.json bun run src/cli.ts add "write the report"
Added #1: write the report
$ … add "ship it"; done 1; list --all
ID  STATUS     TEXT
-------------------
1   done       write the report
2   pending    ship it
$ … done 99 ; echo $?
1
```

The README carries the pasted end-to-end output as asked.

## Economics (`rune cost 01a08036`)

```
               Spent  $0.00  (subscription / free tier — no metered charge)
          Completions  29  (29 work · 0 governance (0%))
      Fresh in / call  23.4k  (uncached input the provider had to read)
     Cache read ratio  0%  (0 of 677.7k input served warm)
        List estimate  $0.07  (at published rates, regardless of who paid)
  Prompt bytes / call  96.0KB  (measured on 29 of 29 completions)
             doctrine  38.3KB  (40%)
         tool schemas  30.2KB  (31%)
         conversation  26.6KB  (28%)
```

Against the five-minute run earlier today (84 KB per call, doctrine 46%, schemas 50%,
conversation 4%): the conversation grows with the task, the doctrine does not, and the tool
schemas are already 28% smaller in this build because three rarely used tools are deferred.
Doctrine plus schemas is still 71% of every call. That is what lane P13.1 is working on.

## What this proves, and what it does not

- Proves: a detached, unattended, multi-file task with its own tests completes on a free
  route with the installed release binary, and the artifact passes outside the agent.
- Proves: the `rune detach` route defect and its fix, on the same day.
- Does not prove: hours-long reliability (this was thirteen minutes), behaviour under a
  rate-limit cap mid-run, or anything about sub-agents.

## Three builds, one task, one route — the afternoon comparison

Same prompt, same fresh workspace shape, `ollama-turbo/gpt-oss:120b`, `--gear 4`, detached.
One run per arm; the model's own variance is visible in the completion counts, so read the
per-call rows as the measurement and the per-run rows as anecdotes.

|                              |    morning build `a93731f` (full doctrine) | P13.1 as landed `6774add` (plan section gated) | P13.1 + plan restored `cdfb475` |
| ---------------------------- | -----------------------------------------: | ---------------------------------------------: | ------------------------------: |
| Session                      |                                 `01a08036` |                                     `01a08059` |                      `01a0805e` |
| Outcome                      | finished, 9/9 tests pass outside the agent |                                  finished, 9/9 |                 finished, 10/10 |
| Completions                  |                                         29 |                                             28 |                              60 |
| Tool calls / failed          |                                     28 / 2 |                                         27 / 7 |                          57 / 7 |
| Malformed `todo_write` calls |                                          1 |                                          **7** |                               3 |
| Plan steps closed            |                                          3 |                                              0 |                               1 |
| Checks passed / failed       |                                      3 / 0 |                                          5 / 0 |                          18 / 3 |
| Fresh input tokens per call  |                                      23.4k |                                   18.0k (−23%) |                    19.8k (−15%) |
| Prompt bytes per call        |                                    96.0 KB |                                        69.6 KB |                         77.7 KB |
| Doctrine per call            |                                    38.3 KB |                                        24.9 KB |                         26.2 KB |
| Tool schemas per call        |                                    30.2 KB |                                        20.2 KB |                         20.2 KB |
| Conversation per call        |                                    26.6 KB |                                        24.5 KB |                         30.0 KB |

What holds across all three: the per-call saving from P13.1 — schemas −33%, doctrine −32%,
fresh tokens −15% to −23% — and task completion with independently passing tests. What does
not hold: the number of completions a task takes. The third run chose a `tsconfig` + `tsc`
route the other two did not and spent twice the completions fighting type errors; that is the
model, not the prompt. With one run per arm, per-task cost is noise-dominated, and a real
comparison needs several runs per arm — the comparison harness in `tests/eval/comparison/`
exists for exactly that and has recorded zero runs.

On the plan section: malformed `todo_write` calls went 1 → 7 when the section was gated and
back to 3 when restored. Consistent with the section mattering, not proof at n=1; the section
costs about 1 KB per call and the ledger is the product's contract, so it stays.
