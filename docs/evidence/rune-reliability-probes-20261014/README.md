Reliability probes and baseline — 14 October 2026

Evidence for [the reliability plan](../../program/rune-reliability-plan-20261014.md). Zero spend: no model calls were made for any of this, nothing was installed, and no product code was edited.

**How Claude Code was studied.** Claude Code was not decompiled. Anthropic's terms for Claude Code bar reverse engineering it and using it to build a competing product, and Rune is one. Everything on the Claude Code side comes from material any user has:

- its public documentation, fetched 14 October 2026 from code.claude.com/docs (pages: errors, headless, permission-modes, tools-reference, sessions, setup, checkpointing, context-window, troubleshooting, env-vars, sandboxing, agent-sdk/agent-loop);
- `claude --help` and `claude --version` (2.1.299);
- the package layout on disk and `codesign -dv` of the shipped binary;
- the behaviour of Claude Code's own Edit tool, observed from inside the working Claude Code session that wrote this file, on the same inputs given to Rune. That is ordinary use of the tool, not a benchmark arm, and spent nothing beyond the session itself.

**Rune under test.** `~/.rune/bin/rune-tools` from build `1.3.4-dev+fe869ae` (`RUNE_TOOLS_SHA256=dbc683aa…` in `rune-compiled.meta`), source at `crates/rune-tools/src/{edit_file,write_file}.rs`. The TypeScript twin `packages/tool-registry/src/tools/multi-edit.ts` declares the same three matching tiers.

## File-tool probes

`edit-probes.sh` reproduces the Rune column. It runs in a temporary directory, prints PASS/FAIL, and exits with the number of failures.

| Probe                                             | Rune rune-tools (1.3.4-dev+fe869ae)                                       | Claude Code Edit (2.1.299)                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P1 edit a 755 shell script                        | mode becomes 600                                                          | mode stays 755                                                                     |
| P2 overwrite a 755 script                         | mode becomes 600                                                          | mode stays 755 (Write)                                                             |
| P3 create a new file (umask 022)                  | mode 600                                                                  | mode 644 (Write)                                                                   |
| P4 edit a file with one Latin-1 byte              | `success: true`; the byte is replaced by U+FFFD in the whole file         | refused: "File is not valid UTF-8 … nothing was written" (Read had already warned) |
| P5 edit a CRLF file with LF `old_text`            | applied; 2 of 3 lines lose `\r` (mixed endings)                           | applied; all 3 lines stay CRLF                                                     |
| P6 `old_text` with the wrong indentation (Python) | `success: true`, `strategy: "indentation"`; `IndentationError` afterwards | refused: "String to replace not found in file"                                     |

Result on 14 October: **6 of 6 fail on Rune**. Causes, all in `crates/rune-tools/src/`: `tempfile::NamedTempFile` creates its file as 0600 and `persist` renames it over the target with no mode copy (P1–P3); `String::from_utf8_lossy` decodes before writing (P4); tiers 2 and 3 split on `\n` and splice `new_text` lines verbatim (P5, P6).

## Baseline from Rune's own records

Read-only (`file:…?immutable=1`), founder's `~/.rune/rune.db` (390 MB) and `~/.rune/blackbox.db`.

**How real edits matched** (all `tool_result` events, 24 May → 14 October 2026):

| Tier                    |                                                                                                                             Edits |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------: |
| exact                   |                                                                                                                             1,445 |
| whitespace-insensitive  |                                                                                                                                 0 |
| indentation-insensitive | 3 (evolab3 `backend/tests/test_ncbi.py` 2026-08-29; a sub-agent's `src/store.ts` 2026-09-08; `logs/app/workspace.jsx` 2026-10-11) |

These counts come from `edit_file` and `multi_edit` results, which report a tier per edit; `apply_patch`'s 125 recorded calls never did, so fallback use there is unknown. Whether the three edits mis-indented code was not checked. 19 of the 788 `edit_file` and `multi_edit` calls in `audit_log` were rejected for a stale hash and cost a re-read.

```sql
select coalesce(sum((length(payload_json)-length(replace(payload_json,'strategy\":\"indentation','')))
       / length('strategy\":\"indentation')),0)
from events where type='tool_result' and payload_json like '%strategy%';
```

**How runs ended, and what they claimed** (every `verdict` event since the verdict ledger began, 14 September → 14 October 2026; 163 runs):

| Verdict                          | end_turn | provider_lost | aborted | max_turns | halted | open_steps |
| -------------------------------- | -------: | ------------: | ------: | --------: | -----: | ---------: |
| met                              |        0 |             0 |       0 |         0 |      0 |          0 |
| partial                          |       27 |            30 |       8 |         4 |      2 |          1 |
| unmet                            |       41 |            14 |       5 |         1 |      1 |          0 |
| none (question, nothing written) |       28 |             0 |       1 |         0 |      0 |          0 |

```sql
select json_extract(payload_json,'$.payload.verdict.kind'),
       json_extract(payload_json,'$.payload.verdict.execution.status'), count(*)
from events where type='verdict' group by 1,2 order by 3 desc;
```

- **No recorded run has ever ended `met`.**
- **44 of 163 (27%) ended `provider_lost`, and 39 of those 44 were quota walls**, not lost providers: they come from 11 sessions whose system notes say `Quota exceeded … 429, usage_limit_reached`. The other 5 come from 4 sessions. The guard-inventory mislabelling (loop-detector, barren and budget exits recorded as `provider_lost`) was fixed in `0ede69d` on 14 September and those exits now name themselves; what the label still merges is "your plan's quota is used up until a known time" with "the provider did not answer," which need different actions from the person.
- The share is rising: 14 of 21 runs in the week of 6 October, and 13 of the 15 runs after the 13 October stall-fix install — all 13 in two sessions in `~/Project/Business` on `gpt-6.1-sol`, each a fresh message meeting the same Codex wall.
- Incidents since 14 September, transport only: `provider.terminal` 119, `provider.rate_limit` 29, `provider.stream_error` 20. (`blackbox.db` was last written 13 October 15:17, so today's sessions are not in it yet.)

```sql
with pl as (select session_id, count(*) n from events where type='verdict'
            and json_extract(payload_json,'$.payload.verdict.execution.status')='provider_lost' group by session_id),
     q  as (select distinct session_id from events where type='system_note'
            and (payload_json like '%usage_limit%' or payload_json like '%Quota exceeded%' or payload_json like '%quota%'))
select case when q.session_id is null then 'other' else 'quota wall' end, sum(pl.n), count(*)
from pl left join q on q.session_id = pl.session_id group by 1;
```

These rows mix the founder's daily sessions with test sessions that wrote to the default home; rig runs that set their own `RUNE_DB_PATH` are not in them.

## Install state observed

`~/.rune/bin`: launcher script, `rune-compiled` (ad-hoc, linker-signed; `TeamIdentifier=not set`), `rune-compiled.meta` pointing at the worktree `.claude/worktrees/cost-latency-20261013`, `rune-tools`, and **250 `rune-compiled.backup-*` files, 5.4 GB**. The launcher runs `git rev-parse` and `find -newer` against the source tree on every launch.

Claude Code on this Mac: npm package `@anthropic-ai/claude-code` 2.1.299 with per-platform optional dependencies; `bin/claude.exe` is a Developer-ID-signed Mach-O (`TeamIdentifier=Q6L2SF6YDW`, `flags=0x10000(runtime)`, i.e. hardened runtime). Its native installer (documented, not used here) keeps versions under `~/.local/share/claude/versions/` behind the `~/.local/bin/claude` symlink.

## After R1 (lane `lane/reliability-r1-20261014`, same day)

`bash edit-probes.sh <lane>/target/debug/rune-tools`: **6 of 6 pass** (the installed build still fails 6 of 6). The same rules hold in `multi_edit` and `apply_patch`, and both implementations pass one table, `tests/helpers/file-contract.ts`: 15 cases plus write_file's own 4, with the Rust half failing 15 of 19 against the installed binary. Eight deliberate mutants each turned at least one case red. The commits and gate results are in the progress ledger's entry for 14 October.
