# Claude checkpoint — superseded 2026-09-14 23:05 IST

**This checkpoint is history.** The work it describes was finished the same evening; the
current state, the authoritative implemented / tested / installed / pending list, and the
next executable step are in
[harness-status, "2026-09-14 (later)"](harness-status.md#2026-09-14-later--m1-lands-the-wizard-takes-the-frame-the-tree-is-gated-and-installed-and-the-walkthrough-finds-what-the-tests-could-not)
and its addendum. Tree at `c68a349` (2026-09-15 evening; see the note below for the morning state): clean apart from the untracked
`scripts/tui-capture/first-run-frame.ts`; forty-odd commits since `4869e4c` unpushed (push is
the founder's). Installed `v0.4.1-dev+c68a349` (evening): the founder's corrections (single column, eased pulse, memory with three modes), M4, the adapters, the second verifier pass and its fix lanes are all in. Next: a third verifier pass, then M6 + Phase 6, Phase 7. Done since: M2, M3's first branch, the M5
corpus, Lane F (Phase 5), one adversarial verifier pass and its two fix lanes — see
"Addendum 10" in harness-status. Next: M4 (typed repair + delegation; spec to write from the
review's M4 and M3's mechanics), M3's second branch, Phase 6 + M6, Phase 7; a second verifier
pass at the end is the release gate. Lane reports under `.codex/audit-20260910/handoff/m0/`.

**Cap checkpoint, 2026-09-15 ~21:00 IST.** The session cap tripped while Fix lanes E1 (memory
provenance/HMAC/guard/kill switch) and E2 (vault control path, runner authorship, git witness,
symlinks, launcher `.env`, cargo test home, scripts) were starting on the third verifier's
findings (`verify-batch-3-report.md`, 5 critical / 11 high). Neither wrote a file; the tree is
`c22b2a0` plus the verifier's fifteen red `tests/verification/v8-*` files. Installed binary
`v0.4.1-dev+c68a349` — **not safe for a real session with memory in `auto`; no authority key on**.
Resume: relaunch E1 and E2 with the briefs in this session's transcript (or rewrite them from the
report's findings 1–15 and 17–19, 26–28), then gates, reinstall, fourth verifier pass.

---

# Claude checkpoint — 2026-09-14 20:55 IST

Stopped at the founder's request at a safe point: no lane is running, nothing
was reverted, every uncommitted edit is preserved in the working tree AND in a
patch snapshot. The two fix lanes and one helper were cut off by the API
session limit (resets 20:50 IST); their partial edits are what is uncommitted.

## Where the tree is

| Item                             | Value                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Branch                           | `gear/phase-0-stabilize`                                                                                          |
| HEAD                             | `4869e4c` — harness: a contract at intake, a verdict at every exit                                                |
| origin tip                       | `943efee` (founder pushed through Lane E); **4 commits unpushed**: `7946b51`, `35630d7`, `385ff70`, `4869e4c`     |
| Uncommitted                      | 18 files, +694 −62 (`git diff --stat`)                                                                            |
| Snapshot of the uncommitted diff | `.codex/audit-20260910/handoff/checkpoint-uncommitted-0914-2055.diff` (1,153 lines)                               |
| Disk                             | ~24 GiB free                                                                                                      |
| Installed binary                 | `~/.rune/bin/rune-compiled` = `v0.4.1-dev+2f13c19` — **older than HEAD**; nothing from Phase 4/5 is installed yet |

## Commits landed today (all since `62f02d0`, Phase 3 close)

| Hash      | What                                                                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `779ac58` | ui: tui.ts split into tui-frame / tui-input / tui-commands / tui — byte-identical on 9 pty frames (verified on 2 more by V-4)                                                                                                                                                       |
| `b5aef39` | ui: four-region frame — 3-row header, workspace + fixed 40-cell right column (agents panel over composer), status strip; composer 4→21 rows from the panel; child split + ctrl+w; ctrl+f ring; strip+overlay < 100 cols; 60×16 refusal                                              |
| `c0936d5` | harness: sub-agent `name` from the master with shape fallback + suffixes; child AgentTurnEvent stream passed through the agent-loop gate; per-child usage; cancelled child now `aborted` not `end_turn`                                                                             |
| `912f99a` | ui: agents panel — a card per agent leading with its last receipt (`CardReceipt {rung,text,at}`), running/finished, `c` clear, initials, the strip                                                                                                                                  |
| `59b3edc` | ui: composer wraps at pane width, grows into the panel to 21 rows then scrolls; ctrl+b newline; paste chip                                                                                                                                                                          |
| `407e5be` | ui: box grammar for tool output (title/body/receipt), claim rungs as one-cell marks, chrome exemption list, header rule fixed, C0 stripped (render-live found `\r` from HTTP headers breaking frames)                                                                               |
| `415ab86` | ui: composer capture rig                                                                                                                                                                                                                                                            |
| `943efee` | settings: six-step first run without editing config; key in no file; three backlog TUI defects closed                                                                                                                                                                               |
| `7946b51` | ci: `containment-linux` job + tracked `scripts/containment/` (proof only on push)                                                                                                                                                                                                   |
| `35630d7` | ci: `install-smoke` on macos-latest + ubuntu-latest (proof only on push)                                                                                                                                                                                                            |
| `385ff70` | harness: the four verdict-less exits emit `turn_complete` with true stop reasons `provider_lost` / `budget` / `loop_detected` / `barren`                                                                                                                                            |
| `4869e4c` | harness: `contract.ts` — TaskContract at intake (engine.ts ~:5038, before the first model call), amended in onBrief, `contract`/`verdict` rows, `computeVerdict` met/partial/unmet, optional `verdict` on `turn_complete`, `-P` prints `[verdict] …` last; advisory, no guard moved |

## Design and evidence documents written today (untracked, keep)

- `docs/program/phase-4-workspace-layout.md` + `docs/program/phase-4-mocks/*.txt` — the founder's layout, 7 width-verified mocks
- `docs/program/guarantees-program-20260914.md` — the phased program + "The five-day cut"
- `docs/program/guard-inventory-20260914.md` — 38 guards / 56 sites / 13 exits, the fights, the intake and completion seams, the shadow-arbiter mapping
- `docs/program/guarantees-plan-review-20260914.md` — **not written by this session** (another agent/session, "reviewed against HEAD 4869e4c plus the working changes"). Its decision: keep the contract/acceptance direction and the additive/shadow approach; correct acceptance semantics before activating any controller; no wholesale rewrite, no deleting delegation, no mission daemon now. Treat as input for the founder to confirm, not as an instruction.
- Lane and verifier reports: `.codex/audit-20260910/handoff/phase4/{laneA..E,verify}-report.md`, `phase5/{laneB,verify-b}-report.md`, `phase7/ci-report.md`
- `scripts/tui-capture/first-run-frame.ts` (untracked capture script from Lane E)

## Exact tests run (all with zero live model calls)

| Who             | Suite                                                                                                                                                        | Result                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lane A          | `tests/unit/orchestrator/ui-frame.test.ts`; orchestrator units; turbo typecheck                                                                              | 36 pass / 514 expects; 3,120 pass; 7/7                                                                                                                                   |
| Lane B (H)      | `bun test tests/unit` (unsandboxed); integration rig; turbo typecheck                                                                                        | 4,841 pass / 0 fail; 2/2; 8/8                                                                                                                                            |
| Lanes C/D/E (U) | `bun test tests/unit` (unsandboxed); ui-composer; onboarding; typecheck                                                                                      | 3,227 pass / 0 fail; 62; 15; 7/7                                                                                                                                         |
| CI lane         | `scripts/containment/run-suite.sh` macOS half (clippy + `cargo test -p rune-sandbox`); shellcheck + bash -n; YAML parse                                      | 36 / 0                                                                                                                                                                   |
| 5B              | typecheck; `tests/unit`; `tests/integration`; lifecycle-durability                                                                                           | 15/15; 4,880 / 0; 285 / 0; 47/47 (spend fingerprint 3468 → 3468)                                                                                                         |
| V-4             | full unit + integration at `7946b51`; typecheck; 9 verification files                                                                                        | clean; clean; **16 red DEFECT tests**                                                                                                                                    |
| V-5B            | `tests/integration`; typecheck; `tests/unit`                                                                                                                 | 285 / 7 skipped / 0; 15/15; 4,879 / 1 skipped / 1 fail (the concurrent UI fix lane's in-flight `agents-panel.ts`; 38/38 at HEAD in a clean copy); **4 red DEFECT tests** |
| F-4 (cut off)   | `.codex/…/phase4/fix/baseline-v4.log` 0 pass / 16 fail → `regress-check-2.log` 212 pass / 0 fail (the touched ui suites); `e3-e8-check.log` 42 pass / 2 fail | in flight                                                                                                                                                                |
| F-5B (cut off)  | `.codex/…/phase5/fix-b/baseline-red.txt` 0 pass / 4 fail                                                                                                     | in flight                                                                                                                                                                |

## Unfinished changes (the uncommitted diff, by owner)

**F-4 (Sonnet fix lane for the 16 Phase 4 defects) — `packages/orchestrator/src/bin/ui/`:**
`agents-panel.ts` +26 (one tally source for the child tool count — the critical finding), `composer.ts` +72/−18 (wide-char wrap by display width), `viewport.ts` +17 (composer growth below 100 cols must take rows from the strip/panel, never the workspace), `tui-frame.ts` +26, `tui-input.ts` +23 (caret with the `/` palette), `turn.ts` +37, `render.ts` +40 (`ESC(B` charset designator stripped), `read-back.ts` +20/−14 and `theme.ts` +8 (the helper sub-lane wiring the claim-ladder rung), `first-run.ts` +11 (unreachable host vs rejected key receipt), `tests/unit/orchestrator/ui-frame.test.ts` +144 (promoted verification tests), `ui-setup.test.ts` +2. Last note before the cut: "run the full ui-frame.test.ts to validate". The helper sub-lane's last note: checking theme function signatures before its edit.
**Known type errors right now (IDE):** `read-back.ts:106` "Expected 4 arguments, but got 5" (the rung helper call, mid-edit).

**F-5B (Opus fix lane for the verdict forgeries) — harness:**
`parent-check.ts` +108 (new status `not-applicable-on-parent` with patterns for bun/node/cargo/pytest/go "no tests found", missing module/file, command not found), `brief.ts` +92 (relatedness on every rung-moving path; unrelated citations recorded and move nothing), `contract.ts` +41 (drift like-for-like over `GOAL_CAP`; shape-aware verdict — the `GOAL_CAP` import is not yet used), `packages/protocol/src/roundtrips.ts` +18 (verdict kind `none`), `task-state.ts` +7. Last note before the cut: "Now contract.ts — drift, shape, and the verdict".
**Known type error right now (IDE):** `engine.ts:1757` — the `ParentRun` status union (`failed | passed | inconclusive`) does not yet include `not-applicable-on-parent`; engine.ts itself is NOT modified, so the fix is widening that type where `ParentRun` is declared, or mapping the new status at the call site.

**Unknown origin:** `docs/CLAUDE_CODE_HANDOFF.md` +2 lines (check `git diff docs/CLAUDE_CODE_HANDOFF.md` before committing).

**Still red on purpose:** `tests/verification/v4-*.test.ts` (9 files, 16 tests) and `tests/verification/v5b-*.test.ts` (2 files, 4 tests). Each is the spec for its fix; promote to the permanent suites once green, then delete from `tests/verification/`.

## Next action (in order)

1. **After 20:50 IST** resume **F-5B** first (Opus): `git diff -- packages/orchestrator/src/{parent-check,brief,contract,task-state}.ts packages/protocol/src/roundtrips.ts`, fix the `ParentRun` union, finish drift/shape/`none`, make the 4 v5b tests green by fixing the product, promote them, full unit + integration unsandboxed, commit `harness: a rung moves only for a check that could have failed` then `harness: the verdict knows what shape the request was`.
2. Then resume **F-4** (Sonnet): `git diff -- packages/orchestrator/src/bin/ui/ packages/orchestrator/src/first-run.ts tests/unit/orchestrator/ui-frame.test.ts`, fix `read-back.ts:106`, finish the 16 in severity order, promote, re-take the frames the fixes touch, commit per severity group. Run the two lanes **sequentially**, not concurrently — the session limit tripped at two build lanes plus one verifier.
3. Then ONE closing lane: full gates (unit, integration, typecheck, lint, format, cargo, eval, `eval:auto-safety --offline`, strict tsc), `install.sh` (compile in place; never `cp`), doctor, `docs/evidence/verification-20260914.json` mirroring the 20260912 schema, dated entry in `docs/harness-status.md`, Phase 4 row of `docs/CLAUDE_CODE_HANDOFF.md` → "Done with named gaps", backlog additions (setTermWidthOverride's 46 implicit reads; §2.8 wizard split not done; sessionReadout has no seam to the check ledger; card.costUsd never set; child pane lacks tool results; the 80-col wrap is 74 not 76).
4. Founder: push (`git push origin gear/phase-0-stabilize`) so `containment-linux` and `install-smoke` prove themselves; confirm or reject `guarantees-plan-review-20260914.md`.
5. Day 3 per the five-day cut: **5C shadow arbiter** (RunState typed, guards become predicates that propose and log, one arbiter in shadow, ledger rows, guards keep control) — consistent with the review doc's "correct acceptance semantics before activating a new controller", since 5C activates nothing.

## Rules the next session must keep

- Never `git reset` / `checkout --` / `clean` / `stash` / `add -A` / `-u` / `rebase` / `amend` / push. Explicit paths. Commit messages in repo style ending `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Zero live model calls: `rune -p` is `--provider`, `-P` is headless — never point the installed binary or the source entrypoint at a real provider; only the loopback mock under a scratch `RUNE_HOME`. Never modify `~/.rune/rune.db`.
- Sandboxed by default; sandbox OFF only for pty captures, the mock rig (sockets), full bun suites, `bun run eval*`, `install.sh`. `bun test … </dev/null`. Export `RUNE_TOOLS_BIN`/`RUNE_TOOLS_BINARY=$PWD/target/debug/rune-tools`.
- Budget: at most two lanes at once; Sonnet for verifiers/captures/mechanical fixes; Opus only for contract/arbiter logic. The weekly cap resets Mondays 15:30 IST; the session cap is a rolling 5-hour window.
