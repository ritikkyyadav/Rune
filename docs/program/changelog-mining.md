# Changelog mining: other agents' fixes as a test source

**Pilot, 2026-09-27.** Rune has few users to find its bugs. Other coding agents have many, and
publish what they fixed. The pilot tested whether those fixes, turned into failure _types_ and
then into zero-spend probes against Rune, find real Rune defects.

## Method

1. **Source.** Claude Code's public changelog: 405 releases, 3,338 fix entries. The text is
   "all rights reserved", so it stays in the private audit folder; this page carries only our own
   taxonomy, counts and findings.
2. **Taxonomy by mechanism, not feature.** 34 failure types plus "not applicable" (cloud and
   remote sessions, IDE integrations, third-party clouds, the vendor's own billing). A mechanism
   transfers to Rune; a feature name does not.
3. **Frequencies from a hand-labelled random sample** of 300 entries, with Wilson 95% intervals.
   A rule-based classifier was built first and agreed with hand labels on only 40 of 100, so its
   counts were not used.
4. **Rank** = estimated frequency × applicability to Rune × severity (safety/data loss 4,
   hang/crash/wrong result 3, degraded 2, cosmetic 1) × offline-testable.
5. **Probe** the top types with scripted, zero-spend tests; each probe ends as _held_ (kept as a
   regression test), _defect_ (red test first, then a fix at the mechanism's owner), or _not
   applicable_.

## Ranking (n = 300; 19% not applicable)

| rank | type                                          | est. fixes (95% CI) | severity |
| ---- | --------------------------------------------- | ------------------- | -------- |
| 1    | T17 Permission rules and mode switching       | 267 (181–388)       | S1       |
| 2    | T20 Subagent / background lifecycle           | 211 (137–323)       | S2       |
| 3    | T24 Config / plugin / skill loading           | 167 (102–270)       | S2       |
| 4    | T22 MCP connection lifecycle                  | 122 (69–215)        | S2       |
| 5    | T01 Replay breaks on malformed saved state    | 122 (69–215)        | S2       |
| 6    | T27 Rendering and layout (most frequent: 356) | 356 (256–490)       | S4       |

## Results

| type | held                                                                                                | defects found                                                                                                                                                                                                                                                                                                                                       | status                                                           |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T17  | HOME spellings with trailing slashes; substitutions inside `[[ ]]`; `cd ~ && rm -rf …`; hard resets | five classes auto-allowed with no screening: recursive-flag spellings other than `-rf`; `..` escapes; deleting the workspace itself or `.git`; variable targets; `git checkout -- .` / `git restore .` / `git clean -f`                                                                                                                             | fixed, `585230a`                                                 |
| T20  | scouts are read-only, cannot nest, run inside the parent's call, return partial work when cut off   | `engine.close()` left background shells running; stops sent SIGTERM only, so a shell ignoring it outlived its engine, `kill_shell` and Rune's exit                                                                                                                                                                                                  | fixed, `a36ca74`                                                 |
| T24  | —                                                                                                   | `config.toml` parsing: multi-line arrays dropped (a `deny` list becomes `"["`), quoted values cut at `#`, quoted array items split at commas, escapes never decoded (a path Rune wrote read back doubled); the writer replaced only a multi-line value's first line, leaving invalid TOML; special object keys not filtered; non-regular files read | parsing and the writer fixed, `653698d`; the last two items open |

Every type probed found real defects, several of them S1. Checking the fixes themselves found two
more, in `a36ca74` and `f4a9e71`: a stop could signal a recycled process-group number, and a
mission could be resumed by two processes at once or have its cancel overwritten (fixed in
`18dda21` and `88758b3`). Six of the sampled fixes matched bugs
Rune had already found and fixed the hard way, which is the backtest that the method predicts
Rune's failures.

## Next

- T24's last two items (special object keys, non-regular files at the config path) are open; a
  fix for them is drafted in the private audit folder.
- T22 and T01, then the other open-source agents with full issue trackers (Codex CLI, Gemini CLI,
  OpenCode, Aider), whose entries carry reproductions a changelog line does not.
- Guardrails that keep this from becoming a pile of special cases: fix at the mechanism's owner,
  no net growth of `agent-loop.ts` or `engine.ts`, and a stop rule per type (ten probes in a row
  that hold).
