# Program status

**2026-09-02, end of day 1.** All eight phases executed by Opus 5 agents in isolated worktrees and landed as draft pull requests. Nothing is merged. The founder merges; the agents never did.

## Pull requests

| PR              | Phase                         | Lane | Head → base                                                        | Landed                                                                                                                                                                                         | Open items                                                                                                                                                         |
| --------------- | ----------------------------- | ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #4              | 1 Ship                        | A    | `lane/a-phase-1` → base                                            | 6 of 7 items; Apache-2.0 LICENSE in its own commit (D1)                                                                                                                                        | signing steps guarded but never run (no Apple / Authenticode certs); public install host (D1); Windows runtime smoke found a real edit-after-read defect (backlog) |
| #5              | 4 Connect anything            | C    | `lane/c-phase-4` → base                                            | 7 of 7; schema tokens/request −89.9%; OAuth 2.1 proven against a local mock server                                                                                                             | live vendor OAuth (Notion, Slack, Linear) unverified: no credentials                                                                                               |
| #6              | 2 One protocol                | B    | `lane/b-phase-2` → base                                            | 9 of 9; `@gear/protocol`, `gear serve`, replay, typed child events, `--stream-json`, SDK seed                                                                                                  | in-process concurrency stays one turn per host process (by design)                                                                                                 |
| #7              | 8 Cheaper per task            | A    | `lane/a-phase-8` → base                                            | 8 of 8; copilot removed (D5, zero sessions), lmstudio dropped, explicit cache policy, effort dial wire tests                                                                                   | cost-per-task drop unmeasured: OpenRouter has no credits, Codex quota exhausted                                                                                    |
| #8              | 6 Trust you can measure       | C    | `lane/c-phase-6` → base                                            | 11 of 11; 227-row corpus, per-source P/R, supervisor false-positive rate 30.6%, worktree workers with shell, schema results, budgets, shared ledger, `gear workflow`                           | 38 corpus labels need a human; second-tier reviewer report blocked on Codex quota; fleet-view grouping waits for #6                                                |
| #9              | 3 The flagship surface        | B    | `lane/b-phase-3` → `lane/b-phase-2`                                | 7 of 7; `gear desktop` launches, one passthrough bridge, `gear serve --web`, Savoir tokens as the single source, contract M2–M4, console frozen, review tab, 4-platform Tauri matrix + updater | in-app OAuth prints `gear login <provider>`; installed app 80 MB (sidecar embeds Bun); updater keypair, certs, icon, download host are founder actions             |
| #10             | 7 Self-improving              | C    | `lane/c-phase-7` → `lane/c-phase-6` (also merges `lane/a-phase-1`) | 10 of 10 + corpus review sheet; attribution hashes, variants allowlist, paired A/B, promote/revert ledger, lifecycle, flywheel, anchors, 21 invariant tests                                    | real A/B arm never run (Codex 429): the loop is closed, not yet measured                                                                                           |
| #11             | 5 Everywhere the work happens | B    | `lane/b-phase-5` → `lane/b-phase-3`                                | 5 of 5; `@gear/sdk` packable, `gear attach ws://`, `docs/ci.md` + `action/` + gated review workflow + `gear pr`, `gear acp` with harness, `apps/vscode` .vsix                                  | Zed and a live VS Code load unverified; npm, marketplace and action publishing are founder actions                                                                 |
| fix/spine-evals | repair                        | —    | → base                                                             | in progress                                                                                                                                                                                    | two spine mock evals regressed with the landing commit `b150dd2` (pass at `b1901e9`)                                                                               |

## Base branch repairs made during execution

`gear/phase-0-stabilize` had been red in CI for days, and each red job hid the next, because `build`, `eval` and `integration` are skipped whenever `ts-lint` fails:

1. `2ceba19` — CI ran only on pull requests to `main`; added the base and `lane/**`.
2. `ede10e9` — a Linux-only unit failure: the shared token counter leaks calibration across test files and bun's file order differs by platform; reset per test.
3. `e4fea93` — Prettier over the files landed by `b150dd2`.
4. `e5253e0` — eight `gear-tools` shell tests gated `#[cfg(unix)]` (fail on windows-latest).
5. `1a9babb` — `bun audit`: two high advisories in `browserslist` via `@vitejs/plugin-react`; root override to a patched release.

Lane branches received `style: prettier pass` commits and, where needed, an empty commit to fire CI (`reopened` does not create a run; `synchronize` does).

## Merge order

1. **`fix/spine-evals`** first, so the eval gate is green on the base before anything else lands.
2. **#4** (ship). Decide the LICENSE commit (D1) at merge time.
3. **#5** (connectors) and **#7** (economics), independent of everything else. Expect small conflicts in `gear-cli.ts` (dispatch hooks) and `README.md`.
4. **#6** (protocol) → retarget **#9** to the base → merge → retarget **#11** → merge.
5. **#8** (trust) → retarget **#10** to the base → merge. #10 already merged `lane/a-phase-1`; after #4 is in, its merge commit is redundant and harmless.
6. Expected conflict hot spots across lanes: `packages/orchestrator/src/bin/gear-cli.ts`, `engine.ts`, `packages/shared/src/config.ts`, `docs/auto-mode.md` (#4 rewrote sections; #8 and #10 appended), `docs/program/backlog.md` (append-only, keep both).
7. After the last merge, from the main checkout: `scripts/install.sh`, `gear doctor`, `gear tools-smoke`, then tag `v0.3.0` (the release workflow is tag-driven and refuses a tag that does not match the reported version).

## Phase 9, 2026-09-03

The correction landed. There is no native desktop application: `apps/desktop`
is `apps/web`, `src-tauri` and every `@tauri-apps` dependency are gone, and
`gear` with no arguments starts the engine as a local server and opens a
browser tab on it. `gear --console` (alias `gear tui`) is the terminal.

The Savoir visual system applied in Phase 3.3 is deleted — tokens, stylesheet,
mark, fonts and the console's palette — and replaced by the solid
electric-blue eight-tooth gear on a near-white ground. The mark is generated
from eight numbers so the founder's vector can replace it byte-for-byte.

Two defects found by the phase's own gate and fixed in it:

- **The engine host truncated any response larger than the socket buffer.**
  Bun's `write` reports the bytes it took and queues nothing; the host ignored
  the number, so `get_turn_context` (the whole assembled system prompt) went
  out cut in half and the caller waited fifteen minutes for a line that never
  ended — wedging every later request on the same connection. Present since
  `gear serve` shipped, and reachable from the trace rail with one click.
- **The session list was never fetched after the transport opened**, so a page
  reload came back to an empty sidebar. Invisible until a reload had to restore
  something, which is the case the whole URL product rests on.

## Founder actions the agents could not take

- **D1**: public repo or a public releases mirror + install host; the LICENSE decision; npm scope for `@gear/sdk`; the VS Code marketplace publisher; whether `savoir/gear-action` gets its own repo.
- **D2**: ~~confirm the Savoir DNA~~ **answered and executed in Phase 9.** Still wanted: the ORIGINAL vector of the blue gear (the shipped mark is recreated from the brief's geometry and lives at `apps/web/branding/gear-mark.svg`), the story copy for first-run and the download page, and the ruling on "Gear" vs "Savoir Gear".
- **Certificates and keys**: Apple Developer ID + notarization, Windows Authenticode, the Tauri updater keypair, `GEAR_SIGNING_PRIVATE_KEY` for Linux signatures (`bun scripts/keygen.ts`), `GEAR_REVIEW_API_KEY` for the PR review workflow.
- **Live capacity**: OpenRouter credits or a Codex quota reset unblock four gates at once: Phase 7's real A/B arm (`gear evolve ab doctrine_full --real`), Phase 8's cost-per-task comparison (`bun run eval -- --real --compare`), Phase 6's second-tier reviewer report, and the anchor benchmarks.
- **Labels**: review the 38 inferred corpus rows listed by `bun run eval:auto-safety --list` (the review sheet from Phase 7 recommends a label for each).
- **Validation**: two people on two other machines (Phase 1.8), recorded in `docs/validation.md`.

## Open defects found by execution

- Windows: `edit_file` refuses right after `read_file` of the same path (path-key mismatch in the read-before-edit ledger). First Windows runtime smoke ever.
- Auto mode: supervisor false-positive rate 30.6%; the cheap reviewer catches 13 of 46 reviewer-only blocks; five breaker gaps with file:line in the backlog.
- Two flywheel classes waived with dated reasons (`crash.dirty_exit`, `context.budget_overflow`).
- `scripts/install.sh` never prunes binary backups (~95 generations in `~/.gear/bin`).
- `notebook/store.ts` `decay()` conflates disuse with staleness.
- `parseArgs` runs `strict: false` in `gear-cli.ts`, so undeclared long options silently lose their values.

## Operating notes for the next executing session

- The worktree tool forks from `main`'s tip; every agent must branch explicitly from the current tip of `gear/phase-0-stabilize` (or its lane parent).
- Three Opus agents in parallel exhaust the account's five-hour session limit; two at a time held. Killed agents resume with their context; per-item commits bound the loss.
- Agent gates must include `bun run lint && bun run format:check` and `bun run eval -- --compare` with a freshly built `gear-tools` (`GEAR_TOOLS_BINARY`), not only typecheck and unit tests.
