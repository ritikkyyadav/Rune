# Rune: verified progress and remaining work

Last updated: 2026-09-10 (later). **Continuation now follows the [Claude Code handoff](CLAUDE_CODE_HANDOFF.md).**
The combined tree has now completed fresh validation and is committed and installed — see the
[2026-09-10 (later) entry](#2026-09-10-later--phase-1-the-combined-source-is-committed-gated-and-installed)
at the end of this file for what that does and does not cover. Dated evidence files preserve the
source and artifacts that each earlier result actually tested.

**The overall goal is not yet achieved.** Phases 0 and 1 of the handoff are done: one reconciled
build, honestly gated, installed and smoke-tested. Phases 2–7 are not. An overall OpenCode
capability score, equal task cost, dependable long-running self-improvement, and a claim to be the
world's best harness are not established.

## Installed and reviewable

Latest installation: **Rune v0.4.1-dev+c053ca4**, built from commit `c053ca4` on
`gear/phase-0-stabilize` and certified by [the Phase 1 manifest](evidence/verification-20260910b.json).
Source is still marked dirty because the docs in this commit were written after the build.

- Current CLI SHA-256: `78239eb482d93198b59bb8cff882605b731cd2504fe5574583bb7feddf246407`
- Current native SHA-256: `f849020a257b10c26eb6f72ad97c7c49960be48170e5e1faf5259031996633c2`
  (unchanged by that install — the previous build already carried this same `crates/` source)

The last complete validation recorded by this session was **Rune v0.4.1-dev+0946e42**, built from commit
`0946e42cc17fa3ef25da2937abbce5133fdaac4b` plus the completed-plan correction described below.

- CLI SHA-256: `c337e2e0beea270fbf9bfda202ed78eed5069f2e3eca7966f2637a24f2f28aa2`
- Native tools SHA-256: `4aedd8ed0b215ff04a308d884d2d6caa75684f43d4006ccac78414a349e3c287`
- Earlier coordination/worker/evolution work is in `f1b9366`. The September 8–10 audit,
  cache-layout and loop changes are in `897b192`; the Linux CI prerequisite fix is in `0946e42`.
- The completed-plan correction, execution receipts, Linux/plugin containment and evidence updates
  remain working changes. Newer committed inline-check and completion behavior overlaps these fixes
  and needs joint verification. The published
  0.4.1 release should not be assumed to contain them or these newer local commits.

Earlier delivery receipts: [0946e42 verification manifest](evidence/verification-20260910.json).
Implementation history: [audit follow-through](audit-followthrough-20260908.md).

## What changed, and where the limits are

| Area               | Implemented behavior                                                                                                                                                                                        | Still to establish                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Auto coordination  | Bounded/batched reviewer queue, explicit skipped reviews, shared spend reservations; routine bookkeeping avoids default supervisor screening.                                                               | Consistent live latency and cost across workloads.                                                           |
| Compaction         | Actual reduced working set survives restart, including opaque provider blocks and task state.                                                                                                               | Hours-long repeated live compaction/restart stress.                                                          |
| Subagents          | Dirty/untracked source snapshots, dependencies, ownership/conflict checks, durable child checkpoints and leases.                                                                                            | Broader live integration and long-horizon planning results.                                                  |
| Completion         | Native child exit codes feed plans, citations and lessons; custom/compound checks are recognized; same-response bash and citation run in order.                                                             | Check recognition is a heuristic, not proof of adequate coverage or fulfilled intent.                        |
| Loop control       | Bounded silent-response recovery, failure-aware recurrence escalation, persisted reasons for follow-up prompts, and one honest completion path for checked plans.                                           | More varied live recovery and interruption workloads.                                                        |
| Sandbox            | Narrow macOS Chromium startup grants; actual foreground/background browser checks retain tested path denials and secret stripping. Linux CI now requires bubblewrap and passes the correct binary variable. | Linux execution result pending below; hosted CI and cross-platform isolation claims need their own evidence. |
| TUI setup          | Settings are visible at 80×24, validate/apply/persist through one path, and restore after restart without inference.                                                                                        | Broader first-install, provider and internet-connector usability evidence.                                   |
| Frontend work      | Current-preview receipts, delivered screenshots and revision checks; an actual generated frontend passed interaction and viewport tests.                                                                    | General design quality, architecture quality and ten-step execution remain unproven.                         |
| Cost and evolution | Deferred schemas, usage attribution, shared reservations, bounded learning trials with control cohorts and cost/quality promotion rules.                                                                    | Same-cost competitive parity and measured learning lift. Cache-layout savings are not established.           |

The latest regression was in the completed-plan shortcut: a write **after** closing a checked
step received no new evidence on that historical row, so the old completed plan could suppress
verification. The shortcut now records the write count when the plan actually settles and
requires it to be unchanged. Repeating the old completed list cannot refresh that receipt.
A regression failed before the fix; tests now cover earlier-session plans, later edits,
repeated completed lists, valid fresh closure and the persisted Engine gate event.

## Earlier verification, before the latest combined changes

- **4,375 unit tests and 148 integration tests passed, zero failures.** One unit skip requires a
  case-sensitive disk; five integration skips require Go/Java toolchains. All seven real MCP
  server tests and both actual Chromium tests passed in this run.
- **14 uncached typecheck tasks, seven uncached lint tasks and 63/63 mock evaluations passed.**
  The mock baseline is unchanged. Edited integration tests also passed a standalone strict typecheck.
- The unchanged native artifact passed **94 Rust tests** in the September 9 delivery.
- Guarded installation succeeded without an override. Installed CLI/settings/native checks
  are recorded separately in the manifest. The minimal-shell doctor still reports missing `npx`
  on its deliberately restricted PATH; that diagnostic is not presented as fully green.

These establish specific engineering behavior, not a model-capability ranking.

Subsequently, 67 focused receipt/plugin tests passed before the latest shared commits. Their native
binary selection needs correction before claiming they cover the newest Rust plugin changes.
An intermediate Linux container run had 17 passes and four plugin failures. The final corrected
image, `rune-containment-audit:20260910-complete`, compiled successfully but has not been run here.
The handoff gives the command and explains the privileged outer-container qualification.

## Live results — including the failures

| Run                                                             | Rune                                                                                                                       | OpenCode                                                        | What the result supports                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pilot H, same CSV task/model/budget                             | Acceptance passed, **timed out at 240 s**, estimated **$0.15845**                                                          | Acceptance passed, finished **209 s**, estimated **$0.11180**   | Rune's earlier build was slower to finish and about 42% more expensive on this attempt.                 |
| Pilot I, updated September 9 build                              | Provider quota stopped it after 56.7 s; **unscored**, no patch                                                             | Not run                                                         | No competitive conclusion.                                                                              |
| September 9 frontend verification                               | Existing browser check ran once; both screenshots read; step closed; **53.4 s**, six primary calls, estimated **$0.06470** | Not run                                                         | The custom-check receipt regression was closed in an explicitly instructed verification smoke.          |
| Pilot J, September 10 `0946e42` build                           | Acceptance passed, **timed out at 240 s**, estimated **$0.138516**                                                         | Acceptance passed, finished **154 s**, estimated **$0.0751745** | Rune cost about 84% more on this attempt; this predates the receipt and inline-check fixes.             |
| Free-route series C, `be0b468`, recorded by another contributor | **5/6 completed**, estimated total **$0.0273**                                                                             | **4/6 completed**, estimated total **$0.0496**                  | A favorable small series on `gpt-oss:120b`; distinct from the frontier route and not a general ranking. |

Receipts: [Pilot H](evidence/comparison-20260909-h.json),
[H provenance qualifications](evidence/comparison-20260909-h-notes.json),
[Pilot I](evidence/comparison-20260909-i.json),
[Pilot J](evidence/comparison-20260910-j.json),
[free-route series C](evidence/comparison-20260910-free-c-notes.json),
[frontend verification](evidence/verification-live-20260909.json).
These dollar figures are estimated list-equivalent usage, including helpers, not subscription invoices.
One fixture or one attempt is not an overall capability score; artifact acceptance does not turn a timeout into success.

The [September 10 cache probe](evidence/cache-probe-20260910.json) repeated all three request
layouts with four turns each and eight-second pauses. Cache reads were inconsistent: the folded
layout read 1,536 cached tokens in total, the control 2,688, and the trailing-user layout 5,888.
This **does not establish a cache benefit** from folding, nor causally prove it is worse. Earlier
predictions of reliable cache growth, ten completions or cost parity are expectations, not results.

## Remaining work

1. Follow Phases 0–1 of the handoff: reconcile the working patch with newer commits, execute the
   pending Linux checks, run fresh gates, and verify the actual installed artifact.
2. Once a live-evaluation budget is established, repeat migration, dirty-worktree/worker and frontend tasks on the same build with fixed
   model, reasoning, budgets and independent acceptance checks. Measure completed-task cost.
3. Exercise long tasks through compaction, restart, worker failure and user steering; verify the
   resulting code and retained constraints, not just saved state structures.
4. Measure controlled lesson outcomes and run official external benchmarks before claiming
   self-evolution lift or broader competitive superiority. Adapters alone are not benchmark results.
5. Verify fresh installation and containment on each supported OS and finish the provider/internet
   onboarding usability pass. The local Linux container and hosted CI are distinct environments.

The license remains `LicenseRef-Proprietary`, as requested.

## 2026-09-10 (later) — Phase 1: the combined source is committed, gated and installed

**Status of each claim below: implemented and tested on this source, and installed and
smoke-tested — with the exceptions named under "Not proven". Nothing here is published.**

### What changed, and where

Two scoped commits on `gear/phase-0-stabilize`, on top of `8c4c58f`:

- **`980bf1e` — harness.** An executed Bash result now carries `kind: "check" | "execution"`: an
  unclassified command that really ran is an `observed` receipt, never described as "never ran",
  and it earns no verdict and no parent replay. The inline-assertion classifier reads code rather
  than text, so nine shapes that used to pass as checks (a printed assertion word, one in a
  variable or a `-p` literal, words in comments, a verdict swallowed by a bare `catch`) are now
  receipts. A settled plan's waiver is withdrawn by a check that goes red after closure as well as
  by a later write. A check only closes the step it speaks to. `misencodedToolCall` returns `null`
  when a second tool's schema also fits, and a user who asked for JSON is never nudged.
  `turn_complete` reaches the headless contract. Files: `agent-loop.ts`, `brief.ts`, `engine.ts`,
  `headless.ts`, `task-state.ts`, `verification-command.ts`, six unit suites, one integration suite,
  and the new `tests/helpers/native-binary.ts`.
- **`c053ca4` — sandbox.** The Linux namespace root is remounted read-only after the explicitly
  writable workspace, temp and cache roots are bound, under `--unshare-all`, `--new-session` and
  `--cap-drop ALL`, with the network shared back only when policy permits. Sixteen named home
  toolchain roots are bound read-only when present; `$HOME` itself never is, and a unit test fails
  if any of them ever becomes a parent of a credential store. A plugin's code is mounted read-only
  with the plugin root as cwd and a curated environment. A host- or port-restricted plugin is
  refused on Linux unless that plugin's own `allowUnsandboxedTools` opt-in accepts unrestricted
  networking, and taking that opt-in now returns a user-visible notice. Test binary selection is
  explicit and a wrong path throws instead of skipping. Files: `crates/rune-sandbox/**`,
  `plugin-tools.ts`, `tests/eval/harness.ts`, four integration suites.

Nothing else was left modified. The full pre-commit patch every gate ran against is preserved
privately; its SHA-256 is in the manifest.

### Exact checks, on this source

All green, each run once against `c053ca4` unless noted. Full commands, exit codes, wall times,
private log paths and log hashes are in
[the Phase 1 manifest](evidence/verification-20260910b.json).

| Gate                                                       | Result                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `bun test tests/unit`                                      | **4,480 pass · 0 fail · 1 skip** (355 files)         |
| `bun test tests/integration`                               | **159 pass · 0 fail · 5 skip** (164 tests, 33 files) |
| `bun run typecheck --force`                                | 14 of 14 tasks, **0 cached**                         |
| `bun run lint --force`                                     | 7 of 7 tasks, **0 cached**                           |
| `bun run format:check`                                     | clean                                                |
| `cargo fmt --all -- --check`                               | clean                                                |
| `cargo test --locked --workspace`                          | **97 passed · 0 failed**                             |
| `cargo clippy --all-targets --all-features -- -D warnings` | **0 warnings**, uncached                             |
| `bun run eval`                                             | **63 of 63 (100%)**, baseline unchanged              |
| `bun run eval:auto-safety --offline`                       | completed                                            |
| `git diff --check`                                         | clean                                                |
| strict `tsc --noEmit`, 12 edited/new test files            | **0 errors**                                         |

Skips are stated, not hidden: **one unit skip** needs a case-sensitive disk and **five integration
skips** need Go/Java toolchains — both historical. The two Chromium browser cases are **not** in
that count: an already-installed Playwright module was found on this machine and pointed at, so
they ran and passed. Nothing was downloaded. Without `RUNE_TEST_PLAYWRIGHT` the same integration
run is 157 pass / 7 skip, and those two would be skips, never passes.

Two gates were not proof on their first attempt and were rerun rather than reported: `clippy`
reused cargo's fingerprint cache and checked only one crate, so it was rerun in a clean target
directory; and the strict scratch typecheck found a real error in a new test file
(`Bun.serve().port` is `number | undefined`), which was fixed before the gates were recorded.

**Linux containment, rebuilt from the committed tree.** `rune-containment-audit:20260910-final`
(`sha256:6cc55bd332f40bd0b60530e34195bb63b9f2bd3cc64a009143a4b5a89ffb8417`): **ALL STEPS PASSED**,
exit 0 — bubblewrap probe ok, clippy clean, **16 of 16** crate tests, a home toolchain readable
inside the sandbox, `/root/.ssh` and `/root/.rune-secret` **not** readable, and **32 pass · 0 fail ·
0 skip** across the three integration suites. The outer container runs `--privileged` only because
Docker Desktop's VM refuses nested unprivileged user namespaces; that is a property of this rig and
appears in no Rune default.

### The installation

`bash scripts/install.sh` succeeded with **no override** — neither guard fired, because the
installed root is this same checkout and `8c4c58f` is an ancestor of `c053ca4`.

| Artifact        | Before               | After                             |
| --------------- | -------------------- | --------------------------------- |
| `rune-compiled` | `296e1853…f88f4a`    | **`78239eb4…f24640`**             |
| `rune-tools`    | `f849020a…6633c2`    | `f849020a…6633c2` — **unchanged** |
| version         | `v0.4.1-dev+8c4c58f` | **`v0.4.1-dev+c053ca4`**          |

`rune-tools` is byte-identical because the previous installation was already built from this same
`crates/` source and this patch's Linux blocks are `cfg`-gated off on macOS.

In a fresh shell: `rune --version` reports `v0.4.1-dev+c053ca4`; `rune doctor` exits 0 and reports
the build as current; `rune tools-smoke` round-trips write/read/edit/bash. Both Chromium checks
pass against the **installed** native binary. Ten stored sessions replayed through the real
`TurnRenderer` at 80 and 120 columns show clipped long tool rows, banded unified diffs with line
numbers, check rows, streak rollups and read-back ranges, all inside the measure.

`rune doctor`'s provider lines (retired free models on openrouter, a misfiled google retirement,
1,170 rate-limit incidents in seven days) are **diagnostics about the founder's accounts**, not
install failures.

### Remaining defects and uncertainty

1. **An unintended live model call was made.** A piped-mode check written as a negative test
   (`rune -P … -p not-a-real-provider`) was expected to fail before any network. The bogus provider
   was ignored and the run completed a real turn on `codex/gpt-5.6-terra` — 15,480 input tokens,
   2 output, 16.6 s — against a subscription the founder has almost exhausted. It is recorded, not
   omitted. It did prove the piped contract on the installed binary: stdout carried only the JSON
   envelope, every diagnostic went to stderr, and the envelope reported `ok: true`,
   `stopReason: "end_turn"`, exit 0.
2. **The installed 80×24 settings save/restart smoke was not performed**, nor were the picker,
   resize, cancellation or the in-TUI `/help` on the installed binary. All need an interactive pty
   session, and none was driven after the call above. Settings save/apply/persist has 72 unit tests
   on this source; that is source coverage, not an installed smoke.
3. **The headless exit-code contract is proven by unit tests on this source only.** No
   environment-driven offline provider exists that could drive the compiled binary, so a cancelled
   or turn-ceiling run could not be produced without spending.
4. **`command -v rune` still resolves the legacy `~/.alan/bin` shim** ahead of `~/.rune/bin`. The
   shim is byte-identical and reports the new version, so the founder runs the right build — but
   the compatibility path, not the new one, is what `rune` means on this machine.
5. Lane A's residuals stand: the relatedness rule stands down for a step that touched no files; a
   report-shaped final step still settles a plan; `headlessExitCode` does not separate failure from
   cancellation; `providerLostEnd` does not emit `turn_complete`. Lane B's stand too: no per-host
   Linux egress, 15 of 16 toolchain roots structural only, credential masking on Linux by
   construction rather than by explicit mask. All are in `docs/program/backlog.md`.

### Not proven

Ordinary (unprivileged) Linux runners; x86_64 or a non-root user; hosted CI on this branch;
Windows; any live evaluation, pilot or benchmark. Nothing here changes the standing live results,
which remain mixed.

### Next executable step

Phase 2 of the handoff — one durable task lifecycle — is unblocked and needs no external
dependency for its deterministic fault-injection half. Phase 7's live comparisons remain blocked on
a provider budget the founder has not established.

### 2026-09-10 (later still) — Phase 1b: the installed TUI, without a model

A follow-on pass to close the four installed-binary smokes Phase 1 left undone — settings
save/restart at 80×24, `/help`, the model picker, resize — plus tool-row and diff rendering, all
under a hard no-spend rule after the unintended call above.

**Zero model calls, proven.** Both provider ledgers were snapshotted before and after every command
and are byte-identical: `~/.rune/rune.db` holds **2,891** `cost` rows before and after, newest still
`2026-09-10T14:01:18.585Z` (Phase 1's own accident); 26,632 events, 683 sessions, 3,279 incidents,
all unchanged; `config.toml`, `.env` and `audit.jsonl` unchanged by hash. Only three rune
invocations were made — `rune --help`, read in full first, and `rune doctor` twice, whose
implementation is a synchronous function with no `fetch` in it. Nothing was typed into a composer.

**Four of the five interactive items could not run at all.** The sandbox this pass ran under refuses
to allocate a pseudo-terminal: `/dev/ptmx` is denied outright (`PermissionError [Errno 1]`), the
legacy `/dev/pty??` fallback reports "out of pty devices", and `script(1)` fails the same way. The
TUI needs `setRawMode`, `fake-tty.ts` only forces `isTTY` for a `bun --preload` render and cannot
drive the compiled binary, and `cols()` is `process.stdout.columns || 80` with no environment seam.
So the start screen, settings persistence, `/help`, the picker and resize are **still unverified on
the installed binary**, and cancellation was not attempted at all — it needs a running turn.
A VT screen model, a pty driver and a five-item script were written and left in place
(`.codex/audit-20260910/handoff/installed/tui/`); **none of it has ever been executed.**

**What did get done.** Tool rows and banded diffs were rendered at 80 and 120 columns from a stored
session through the real `TurnRenderer` — call rows named against the workspace, a left-elided path,
a clipped command, counted streak rollups, `✓`/`✗` check rows, rolled-up output, read-back ranges,
hunk headers on their own line with numbered gutters, and the closing receipt. That is **source-side
rendering**, not the compiled binary. It is at least the same source: `git diff c053ca4..b75a104 --
packages crates` is empty and the install-time `DIRTY=1` was docs only, so the version-skew doubt is
closed and only the compile step is unproven.

Running the script with the sandbox off is the whole remaining job, and it costs nothing.
