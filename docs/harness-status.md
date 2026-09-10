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

#### Addendum, 2026-09-10 (later still) — Phase 1c: the pty, and the five items

The sandbox was disabled **for the python driver only**, on the director's authorization, because
pty allocation was the sole obstacle and the smoke provably makes no model call. Everything else
stayed sandboxed; nothing was pushed. **All five items ran** against the installed binary
(`v0.4.1-dev+c053ca4`) at 80×24 and 120×40: six processes, six clean `/quit` exits with code 0, nine
frames in `.codex/audit-20260910/handoff/installed/tui/`.

**Zero calls, and this time by two ledgers.** `~/.rune/rune.db` is unchanged before, after and
final — 2,891 `cost` rows, newest still `2026-09-10T14:01:18.585Z`; 26,632 events; 683 sessions; the
whole snapshot data block hashing `80afb96a…4972a` all three times, and `config.toml` / `.env` /
`audit.jsonl` unchanged by hash. The stronger proof is the second one: `RUNE_HOME` pointed at a
scratch profile, so the six TUI processes wrote to a database they created themselves — and it holds
`sessions=0, events=0, cost=0`. A call was made impossible rather than merely absent: no credential
index (so `KeychainStore.get` never spawns `security`), the launcher's hard-coded
`source "$HOME/.rune/.env"` bypassed by running `rune-compiled` directly, `defaultProvider =
"ollama"` as the only registered provider (keyless, `localhost:11434`), `[update] check = false`, and
no text ever submitted — every digit keypress gated behind proof that a picker was on screen.

**What the frames show.** The fixed frame is real on the compiled binary: header rows 2–3, composer
21–23, footer 24, alt screen live, no login or connect prompt. `playbook` flipped `off` → `on` from
`/config`, reached disk, and was read back as `on` by a **new process**, then restored. `/help`
fits a 24-row window with every group visible and both `/model` and `/quit` present. The `/model`
picker opened from local state and Escape resolved nothing — footer model unchanged, no request. At
120×40 the header rule spans the full width, the workspace path un-elides, the footer gains its
extra affordances, and rows 25–36 are clean; back at 80×24 the frame is **byte-identical to the
start frame**.

**Three defects the frames caught.** The `/config` change confirmation is the one transcript row
with no left gutter — it starts at column 0 because `settings-command.ts` returns a raw tool result
that `tui.ts` prints unwrapped, where every neighbouring `print` adds two spaces. The settings
picker paints 17 of its 22 rows on a 24-row window and says nothing about the other five —
`routing`, `helper`, `subagents`, `lsp`, `auto_commit` — the same failure `/help` was fixed for in
`8c4c58f`. And the no-provider splash misaligns its `OPENAI_API_KEY` comment by one column.

**Still unverified on the installed binary:** cancellation (needs a running turn), the two-column
`/help` at 120 columns, and the `/model` picker's real 37-provider list — this profile had no
credentials, so level 1 listed two rows.

### 2026-09-11 — Phase 2: one durable task lifecycle, integrated, gated and installed

**Status.** Planned → implemented → tested on this source → **installed and smoke-tested**. Not
published: nothing was pushed, no tag was cut, and no hosted CI run exists for this revision.

Phase 2 ran as three lanes over a shared tree — L (lead lifecycle, compaction, headless, protocol:
`54459b0`, `ff3c23f`, `d1daa15`), W (children, workers, leases: `08d99f8`, `8145eba`), S (the
process-level scenario: `2e564e9`) — against the design in `docs/program/phase-2-lifecycle.md`,
committed here. This entry is the integration step that follows them.

#### What changed, and where

**The engine took the seams Lane W could not wire** (`b2a220a`). Lane W was forbidden from editing
`engine.ts`, so it left eleven optional deps with working defaults. The reaper now runs at **process
start** rather than on the first worker dispatch — a session that dispatches no worker at all should
still not leave a dead run's checkout on disk — and its report goes to the incident trail as
`crash.dirty_exit`, `debug` when the checkout went and `warn` when it could not, because a checkout
the reaper could _not_ clear is uncommitted work still sitting in a directory. No path deletes a
branch. Child checkpoints at tool boundaries, persisted leases and durable worker ids were already
on the production path (`new DelegatedSessions(this.sessions)` and `input.sessionId` supply both),
and `Engine.recordChild` already consumed Lane W's `structured.child`, so those needed confirming
rather than wiring.

**The director's rule on a child's turn ceiling** (`b2a220a`). Two resumes arrive through the same
door — a `task_id` and a prompt — and they are not the same event. A crash-resume of a child that
was still running **inherits**: its checkpoint is a boundary record, and `remaining = max − used`,
with a floor of one turn so it can still report. A follow-up on a child that already reported starts
**fresh**, because Lane W's objection holds: a child resumed after `max_turns` with nothing left
cannot take a single turn. The cumulative caps apply either way — `resumeBudgetState` still inherits
spend and backdates the clock — so cost and wall-clock bound the task and only the ceiling
distinguishes the two. What tells them apart is a new `status` field on the checkpoint, written on
the final save only. Both directions are tested (`delegated-sessions.test.ts`): 12 → 5 with the
spend carried, and 8 → 8 with the spend cap still accumulating 0.3 → 0.6.

**S-1 — a tool child no longer outlives its engine** (`0a2cb5d`). Lane S measured it twice: SIGKILL
the engine and the `rune-tools` running the in-flight `bash` was still there six seconds later, its
shell grandchild with it. Nothing was wrong with the interrupt path; a killed process simply sends no
signal. Three layers. A **parent-death watchdog** in `rune-tools` polling `getppid()` every 250 ms
(`PR_SET_PDEATHSIG` is Linux-only and macOS has no equivalent), which on death does what an interrupt
does — SIGKILL the command's whole process group — and exits 129, distinct from the interrupt path's 130. **Process groups** on the two sandbox backends that lacked them: the noop backend (`[sandbox]
mode = "off"`, the very configuration Lane S measured) and the Linux bwrap backend both registered
their child pid-only, so no group kill was available. And a **pid ledger** at
`<workspace>/.rune/tool-children.jsonl`, written by both spawn paths and reaped by a starting engine,
for the two cases the watchdog cannot cover: a `rune-tools` that was itself SIGKILLed, and Windows.
Three refusals before anything is signalled — a live owner's children are its own business, an entry
older than a day names a recycled number, most are already gone — because the cost of a false
positive is killing a stranger's process.

**S-2 — a rescued compaction says its summarizer failed** (`b2a220a`). When the summarizer breaks and
the deterministic tier rescues the compaction, the working set really did shrink, so `failed` is the
wrong word: setting it routes the row to `compaction_failed`, which does not replace the replayed
transcript, and for a real eviction that would resurrect everything just dropped. The reason travels
on its own instead — `failureReason` without `failed`, persisted on the `auto_compaction` row as
`summaryFailure`, replayed from either name, and rendered as "compacted without a summary" with the
reason in the receipt where `flowRow` keeps it whole. Three summarizer 500s used to produce three
rows indistinguishable from healthy evictions.

**A defect the install smoke found, and fixed** (`b1b1262`). Run against the founder's real database,
`rune doctor` offered "552 superseded or orphaned rows, 136 MB — rune doctor prune-checkpoints", and
that command then offered to remove 428 rows / 106 MB. Two predicates: the report counted every row
with _any_ newer version, the prune keeps the newest two. The advisory over-promised by 124 rows and
30 MB in the same sentence that named the command. Same predicate now, `keepVersions: 2` gets a name
so they cannot drift apart again, and the test pins them together in both directions.

#### Exact checks, on this source (`b1b1262`)

Full manifest: [`docs/evidence/verification-20260911.json`](evidence/verification-20260911.json).
Logs and hashes under `.codex/audit-20260910/handoff/gates-phase2/`.

| Gate                                                       | Result                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cargo build --locked -p rune-tools`                       | exit 0; `af10bd52…51af`                                                                                                         |
| `bun test tests/unit` (sandbox off)                        | **4,527 pass / 0 fail / 1 skip**, 356 files, 16,388 expects, 53 s                                                               |
| `bun test tests/integration` (sandbox off)                 | **212 pass / 0 fail / 7 skip**, 35 files, 1,010 expects, 78 s — includes the scenario suite                                     |
| `lifecycle-durability.test.ts` ×3                          | **42 pass / 0 fail / 0 todo**, 130 expects, identical three times, 24 s each                                                    |
| browser (Playwright 1.62.1 from bun's store)               | 2 pass / 0 fail — run separately; counted as _skipped_ in the integration row                                                   |
| `bun run typecheck --force`                                | 14/14, 0 cached                                                                                                                 |
| `bun run lint --force`                                     | 7/7, 0 cached                                                                                                                   |
| `cargo fmt --all -- --check`                               | clean                                                                                                                           |
| `cargo test --locked --workspace`                          | **103 pass / 0 fail** (rune-index 15, rune-sandbox 30, rune-tools 58)                                                           |
| `cargo clippy --all-targets --all-features -- -D warnings` | 0 warnings, forced re-check                                                                                                     |
| `bun run eval`                                             | **63/63 (100%)**, baseline **unchanged**                                                                                        |
| `bun run eval:auto-safety --offline`                       | 227 scenarios, P 90.0% / R 89.1% / F1 89.6%, 0 live requests                                                                    |
| `git diff --check` · `bunx prettier --check .`             | clean                                                                                                                           |
| strict scratch `tsc --noEmit` over 12 changed test files   | **0 errors in any test file**                                                                                                   |
| Linux containment image `rune-containment-audit:20260911`  | **ALL STEPS PASSED** — bwrap ok, clippy 0, 22 crate tests, 32 integration pass, home toolchain visible and home credentials not |

**Installed.** `bash scripts/install.sh`, no override flag, no guard triggered.
`rune-compiled` `78239eb4…6407` → `d0f03687…a9c2`; `rune-tools` `f849020a…33f2` → `01d8600b…ee48`;
the `rune` launcher shim is byte-identical. `rune --version` → `Rune v0.4.1-dev+b1b1262`.
`rune doctor` and `rune tools-smoke` green. `rune doctor prune-checkpoints` **DRY RUN only** —
`--apply` was never passed and the founder's database was not modified.

**The orphan proof, on the installed binary.** The scenario's own fixture, scratch `RUNE_HOME` and
loopback mock, driving `~/.rune/bin/rune` rather than `bun rune-cli.ts`. Before the kill: `node
long.mjs …` under `rune-tools --workspace <fixture> bash`. SIGKILL the engine → exit 137. Polled
`ps` for **0.33 s**: nothing left. The same probe against the _previous_ installed binary left both
alive past six seconds.

**Zero model calls, by ledger.** `~/.rune/rune.db` `cost` rows 2,891 → 2,891, newest still
`2026-09-10T14:01:18.585Z`; events 26,632 → 26,632; sessions 683 → 683; `blackbox.db` incidents
3,279 → 3,279; every credential file unchanged by hash. Two deliberate differences: `rune-compiled`'s
hash (the installs) and 81 lines appended to `~/.rune/audit.jsonl` — sandboxed-`bash` receipts
carrying hashes, not content, from the installers' own smokes and `tools-smoke`.

**The IDE's eleven diagnostics.** Checked one at a time with a strict scratch `tsc`: **eight stale,
three real**. Real: `GatewayConfig.retryBaseMs` missing from a test literal (pre-existing since
`f1b9366`, harmless at runtime because `maxRetries` is 0), and four dead symbols in `worker.ts` /
`subagent.ts` that all predate every Phase 2 lane — including a second, superseded copy of the
provenance banner `subagent-result.ts` has rendered since P6B.3. Per-item verdicts in
`.codex/audit-20260910/handoff/gates-phase2/step0-diagnostics.md`.

#### Remaining defects and uncertainty

Every item is in the manifest's `notProven`; the ones that matter most:

- **Windows has only one of the three S-1 layers.** The watchdog is `#[cfg(unix)]`; the pid ledger
  records a pid with no process group there, so a Windows engine can kill a leftover `rune-tools`
  but not its command's descendants. Untested — there is no Windows machine here.
- **Ordinary Linux runners are not covered.** Every Linux result came from `docker run --privileged`,
  because Docker Desktop's VM refuses nested unprivileged user namespaces. That is a property of the
  rig, not of Rune.
- **A `rune-tools` SIGKILLed while its command runs** has unit coverage of the reaper's decisions but
  no end-to-end probe.
- **Child budget inheritance is proven on the artifact a crash leaves**, not on a crash: the two
  turn-ceiling tests are in-process.
- **The prune was never applied.** Dry run twice against the founder's database; that the 428 rows
  would delete cleanly is proven on a scratch database only.
- **No live long run.** Zero model calls by construction; the handoff's "reserve live long runs for
  an agreed budget" is unmet because there is no budget.

#### Next executable step

Phase 3 (make Auto efficient at equal task quality), which the handoff scopes to `auto-mode.ts`,
`auto-containment.ts`, `auto-metrics.ts`, `turn-budget.ts`, `subagent-budget.ts` and the gateway's
usage ledger, and which explicitly starts with measurement rather than more model roles. Its
acceptance target — completed-task cost no greater than the baseline harness at equal quality —
needs paid comparison runs, so treat it as a target until measured. External dependency: a live
evaluation budget, which does not exist today.

## 2026-09-11 — three adversarial verifications, and what they changed

Phase 2 was re-read by three independent verifiers who were told to attack it rather than confirm
it: **V1** the containment and install layer, **V2** the orchestrator's correctness claims, **V3**
the worker layer, the durability rig and the evidence documents. Their reports and their red tests
are in `.codex/audit-20260910/handoff/verify/`. Everything below is a finding against work this file
already called done. Three fix lanes (F1 containment, F2 orchestrator, F3 workers and evidence) took
them.

**Twelve findings carry a HIGH or MEDIUM severity from their verifier.** V2 did not grade its
findings, so its five defect areas are listed after them at the granularity it used.

| #     | Severity | Finding                                                                                                                                                                                                                                                                                                                                           | Lane |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| V1-1  | HIGH     | The restart reaper kills a pid it never spawned: `child-ledger.ts` has no identity check, so a recycled number outside the 24-hour window is signalled. Proven by killing a `/bin/sleep` the engine never started                                                                                                                                 | F1   |
| V3-F1 | HIGH     | `08d99f8`'s headline is false in the shipped engine: `registerDelegationTools()` ran 281 lines before `this.delegatedSessions` was constructed, so every real dispatch used a store with **no** `SessionManager` — zero `delegation_checkpoint` and zero `delegation_lease` rows ever written, and a resumed `task_id` answered "Unknown task_id" | F2   |
| V3-F2 | HIGH     | Two parallel sessions in one repository allocate the **same** worker id: the counter key was 8 characters of a time-bucketed UUIDv7 (one bucket per 65,536 ms) and its read-modify-write had no lock. Measured: 24 colliding ids across two processes                                                                                             | F3   |
| V1-1b | MEDIUM   | One restart does not finish the reap — owner rows are judged before the child rows whose owner this pass just SIGKILLed, so the orphan is kept until a second pass                                                                                                                                                                                | F1   |
| V1-4  | MEDIUM   | A Linux toolchain root that is itself a symlink to `$HOME` is bound whole, and the lexical guard test cannot see it: `~/.ssh/id_rsa` becomes readable through `/root/.local/bin/.ssh/id_rsa`                                                                                                                                                      | F1   |
| V1-5b | MEDIUM   | macOS silently widens a declared plugin host to a whole port (`api.example.com:443` becomes `remote ip "*:443"`) with `notes: []`, where Linux refuses the same declaration and says so                                                                                                                                                           | F1   |
| V1-7b | MEDIUM   | `install.sh` copies four artifacts to `*.backup-<epoch>` on every install and nothing ever prunes them. Live on this machine: 97 backup files, 24 generations, `~/.rune/bin` at 2.0 GB — on a founder with zero budget                                                                                                                            | F1   |
| V3-F3 | MEDIUM   | The durability suite's zero-spend guard was unsound: it asserted the row count of the founder's live `~/.rune/rune.db`, which other processes write and WAL-checkpoint, and it failed 2 of 3 verification runs that spent nothing                                                                                                                 | F3   |
| V3-F4 | MEDIUM   | The boundary-checkpoint dedup could not tell two child boundaries apart — it hashed the compaction output, which truncates every tool result at 1,500 characters and collapses every image, so the second boundary was never written and the child re-ran that call on resume                                                                     | F3   |
| V3-F5 | MEDIUM   | The 2 MiB per-run checkpoint budget stopped **silently** — a bare `return`, no event, no field, so a long child's crash granularity collapsed to "the final save only" with nothing saying when                                                                                                                                                   | F3   |
| V3-F6 | MEDIUM   | The resume lease identified its holder by pid alone: a recycled pid held a `task_id` for the full 30 minutes, and — the dangerous direction — a lease written on another machine was cleared the instant its pid looked dead locally                                                                                                              | F3   |
| V3-F7 | LOW/MED  | The worker reaper destroyed a dead worker's **gitignored** files and reported a clean reap: `git status --porcelain` does not list them and `add -A` does not stage them                                                                                                                                                                          | F3   |

V2's five defect areas, at its own granularity: a report-shaped plan waives the settled-plan gate
and a check that runs nothing closes a step (**`apply_patch` records no touched file**); the inline
check classifier buys relatedness from a comment, a log string or a Python comment, and three
project-level runners are vacuous; a dirty-tree claim is never stale and a claim decays one rung per
call; **the rung demotion is never persisted** across a restart; and the TUI footer's
`filesChanged` predicate drops `apply_patch`. All are F2's.

Two V3 findings are recorded without a lane: **F8** — the "a usable partial result" test asserts
that recovery _completed_ (`stopReason` is a string, every todo closed), which is not the criterion
it is named for, and no case in the file refuses recovery; and **F9** — the new lifecycle events are
genuinely small (`brief`, `checkpoint`, `run_trace`, `task_state` together are 9.5% of one killed
run's payload), but `auto_compaction` rows are ~58 KB each and are the shape that rebuilt the 184
MiB checkpoint table.

### What this file itself said that was wrong

V3's evidence sub-audit recomputed all 32 log hashes in the Phase 1 and Phase 2 manifests and found
them exact, and the installed binaries still hash to their recorded values. Five statements in _this
file_ did not hold:

- **`:210-212` "…all inside the measure"** — false, and it inherits a false manifest entry.
  `verification-20260910b.json` `checks[16]` records a ten-session render and certifies it with the
  log of a **three**-session one; corrected in that file's `corrections[0]`. The real measurement:
  `frames/01a08083-…80.txt` line 437 is **107 display columns** in an 80-column frame, ASCII apart
  from `│`, `✗` and `…`. A visible over-width row exists and is now a tracked backlog item.
- **`:14-22` "Latest installation: v0.4.1-dev+c053ca4, CLI SHA `78239eb4…`"** — stale. Those are the
  pre-Phase-2 hashes; `:415-416` of this same file records `v0.4.1-dev+b1b1262` and
  `d0f03687…`/`01d8600b…` as what is installed.
- **`:9-10` "Phases 2–7 are not [done]"** — stale, contradicted by `:327-457` here and by
  `CLAUDE_CODE_HANDOFF.md:96`. Phase 2 shipped; 3–7 have not.
- **`:411` strict `tsc` "0 errors in any test file"** — true as written, and it omits what the
  manifest records honestly: the run's `exit: 2` and the 23 pre-existing package-level errors.
- **`:417` "`rune doctor` … green"** — partial. `installed-phase2/doctor.txt` carries a `✗` and two
  `!` (retired free models, the 184 MB checkpoint table). Diagnostics about the founder's accounts
  rather than about the build, as `:214` says — but "green" is not the word for a report with a `✗`
  in it, and `CLAUDE_CODE_HANDOFF.md:78` is the rule this breaks.

The lines above are left standing rather than rewritten, so that what was claimed and what was found
can both be read.
