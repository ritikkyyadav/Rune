# Sub-agent fan-out, live — 2026-09-08

The first watched live use of the `task` tool in this program. Until today the record said
sub-agents ran in 17 of 666 sessions and nothing about parallel work was measured.

## Command

Workspace: a copy of the todo CLI built by session `01a08036` earlier the same day, committed as
a seed. Installed `v0.4.0-dev+cdfb475`, detached, `ollama-turbo/gpt-oss:120b`, `--gear 4`.

```
rune detach "This repository is a small Bun todo CLI. Review it for bugs, edge cases and
missing tests, and you MUST parallelise: use the task tool to launch three sub-agents at once —
one reviewing src/store.ts, one reviewing src/cli.ts, one reviewing src/format.ts plus the
tests — each returning a short list of concrete findings with file and line. Then merge their
findings into REVIEW.md (one section per file, deduplicated, ordered by severity), fix the two
most severe real bugs with tests that prove them, run bun test until green, and stop."
```

Session `01a081db`.

## What happened

|                      |                                                       |
| -------------------- | ----------------------------------------------------- |
| `task` calls         | 3 — one per file, as asked                            |
| Completions          | 33 (30 work, 3 governance: the sub-agent report path) |
| Tool calls           | 17                                                    |
| Retro                | `finished`                                            |
| Fresh input per call | 11.7k tokens; 53.3 KB per prompt                      |
| List estimate        | $0.05, $0 spent                                       |

Output, checked outside the agent:

- `REVIEW.md`: three sections, one per file, 15 findings with line references, each with a
  severity, deduplicated across reviewers.
- Two fixes in `src/store.ts` with tests in `test/store.test.ts`: corrupt-JSON handling that
  used to return an empty list silently, and whitespace-only todo text.
- `bun test`: 11 pass, 0 fail (9 before).

## What this proves, and what it does not

- Proves: the `task` tool fans out on request, the children return structured findings, the
  parent merges them and acts on them, on a free route, with the installed binary.
- Does not prove: anything about scale (three read-only reviewers is the smallest useful case),
  worker sub-agents that write in their own worktrees, the team bus, or cost against doing the
  same review serially. One run.
