# Rune: verified progress and remaining work

Last updated: 2026-09-10 (later). **Continuation now follows the [Claude Code handoff](CLAUDE_CODE_HANDOFF.md).**
The combined tree has now completed fresh validation and is committed and installed — see the
[2026-09-10 (later) entry](#2026-09-10-later--phase-1-the-combined-source-is-committed-gated-and-installed)
at the end of this file for what that does and does not cover. Dated evidence files preserve the
source and artifacts that each earlier result actually tested.

**The overall goal is not yet achieved.** Phases 0, 1 and 2 of the handoff are done — one reconciled
build, honestly gated, installed and smoke-tested, and one durable task lifecycle — and all three
have since been re-read by adversarial verifiers, whose twelve findings were fixed and re-verified.
Phases 3–7 are not done. An overall OpenCode capability score, equal task cost, dependable
long-running self-improvement, and a claim to be the world's best harness are not established.

## Installed and reviewable

Latest installation: **Rune v0.4.1-dev+33cea48**, built from commit `33cea48` on
`gear/phase-0-stabilize` from a clean tree (`RUNE_SOURCE_DIRTY=0`) and certified by
[the re-verification manifest](evidence/verification-20260911b.json).

- Current CLI SHA-256: `a58f592060542f95522202ebe31fadb0b6b5d4fbcc7680a9db21e426aa347f29`
- Current native SHA-256: `c5b44f6e3620aae0cf82941a9e155fb95097815b1cd673eb9c98aa1347a28416`
- The `rune` launcher shim is unchanged across every install in this series:
  `5a22d1513ef3a12596add9c53f2591f1f46a8938a3ef9f8cd7db0c3f6edfc2f5`

Two earlier installations this file used to name as "latest" — `v0.4.1-dev+c053ca4` (CLI
`78239eb4…`, native `f849020a…`) from Phase 1, and `v0.4.1-dev+b1b1262` (CLI `d0f03687…`, native
`01d8600b…`) from Phase 2 — are superseded. V3's evidence sub-audit found the first of those still
sitting here after the second had shipped; the fix is this block, and the rule is that the "latest
installation" is re-stated in the same commit that installs it.

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
`rune tools-smoke` green; `rune doctor` reported ✓ on every build-facing line and carried a `✗` and
two `!` about the founder's accounts and database, which the sentence originally here called "green"
and which V3 corrected. `rune doctor prune-checkpoints` **DRY RUN only** — `--apply` was never
passed and the founder's database was not modified.

> **Superseded 2026-09-11 (later).** The two hashes and the version in this paragraph are no longer
> what is installed. Twelve findings against the work above were fixed and the tree was rebuilt:
> the installed build is now **`Rune v0.4.1-dev+33cea48`**, CLI `a58f5920…a29f`, native
> `c5b44f6e…8416`, from a clean `33cea48` (`RUNE_SOURCE_DIRTY=0`). See
> [the 2026-09-11 (later) entry](#2026-09-11-later--the-twelve-findings-re-verified-and-the-fixes-graded-on-the-installed-binary)
> and [its manifest](evidence/verification-20260911b.json). The lines above are left standing
> rather than rewritten so that what was claimed and what superseded it can both be read.

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

## 2026-09-11 (later) — the twelve findings re-verified, and the fixes graded on the installed binary

A fourth pass (V4b) re-ran the work of the three verifiers and the three fix lanes from the entry
above, against `33cea48` on a clean tree, and graded the fixes on the binary the founder runs rather
than only on the source. It wrote nothing to `~/.rune/rune.db`, made **zero live model calls**, and
started from the position that every prior claim was unproven until reproduced. Manifest:
[`evidence/verification-20260911b.json`](evidence/verification-20260911b.json). Raw logs:
`.codex/audit-20260910/handoff/verify/v4/`.

### Where each claim stands

**Planned.** Nothing new. This pass proposed no work; it graded work already done.

**Implemented.** All twelve HIGH/MEDIUM findings and five of V2's six defect areas have a fix in the
tree, across `ca92940`, `0fc1c99`, `db09279`, `08b2439`, `311e901`, `9876957` and `5220b05`. The
sixth — a `report`-shaped plan waiving the settled-plan gate — is deliberately **not** fixed; it is
pinned by a characterisation test and left as the founder's decision.

**Tested on this source.** Every fix has a named test that passes at `33cea48`. All twenty proving
and migrated test files together: **204 pass / 0 fail**. Full gates:

| Gate                                                                     | Result                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `bun test tests/unit`                                                    | **4,579 pass / 0 fail / 1 skip** (364 files)                                                        |
| `bun test tests/integration`                                             | **227 pass / 0 fail / 7 skip** (40 files) — see the flake below                                     |
| `bun test tests/integration/lifecycle-durability.test.ts`                | **45 pass / 0 fail**, alone, 24.5 s                                                                 |
| `cargo test --locked --workspace`                                        | **109 pass / 0 fail** (rune-index 15, rune-sandbox 36, rune-tools 58)                               |
| `cargo clippy --all-targets --all-features -- -D warnings`               | 0 warnings, every crate re-checked (the sources were touched first, so not a cache hit)             |
| `cargo fmt --all -- --check` · `git diff --check` · `prettier --check .` | clean, each with its own log recording command and exit                                             |
| `bun run typecheck --force` · `bun run lint --force`                     | 14/14 · 7/7, 0 cached                                                                               |
| `bun run eval` · `bun run eval:auto-safety --offline`                    | **63/63**, baseline unchanged · 227 scenarios, P 90.0 / R 89.1 / F1 89.6, 0 live requests           |
| strict scratch `tsc` over the 21 test files changed since `5775166`      | **0 errors in any test file**; 21 pre-existing unused-symbol errors in `packages/`, hence `exit: 2` |

Six of the fixes carry a **mutation proof** — the fix reverted, the test watched to go red on its
exact assertion, the revert undone, the test watched to go green — covering all five HIGH findings:
the reaper's identity check, the unwired delegation store, the worker-id collision (two tests),
`apply_patch` reaching the spine, and the unpersisted rung demotion.

**Installed and smoke-tested.** The binary is `v0.4.1-dev+33cea48` (CLI `a58f5920…`, native
`c5b44f6e…`), installed from a clean tree with no override flag; all three artifacts were re-hashed
at the start of this pass and are byte-identical to the install record. Three proofs were run
against `~/.rune/bin/rune` itself, each through the scenario rig's fixture under a scratch
`RUNE_HOME` whose only route is a loopback mock:

- **Orphans.** Engine SIGKILLed mid-`bash` with `node long.mjs` running under a real `rune-tools`:
  exit 137, and **0.32 s** of polled `ps` later nothing survived.
- **Delegation.** One dispatch wrote **2 `delegation_lease`** and **3 `delegation_checkpoint`** rows,
  and a **second process** resumed the `task_id` — `success: true`, not "Unknown task_id". V3
  measured 0 and 0 for these on the shipped engine, including on the founder's own database.
- **Pid reuse.** Two hand-written ledger rows, both with a dead owner, neither with a `pgid`. The row
  whose start time was a lie left its live `sleep` **alive**; the row whose start time was true had
  its `sleep` **reaped** — in the same pass, by the installed engine's own startup reap. The second
  row is the control: without it, "the stranger survived" could mean the reaper never ran.

`rune doctor` is **not green** and this file will not call it that again: every build-facing line is
`✓` (build current at `33cea48d`, `rune-tools` ok, mcp ok, recorder clean), and it carries one `✗`
pair and three `!` lines about retired free models, a stale provider-health entry and the 184 MB
checkpoint table. `rune doctor prune-checkpoints` was **DRY RUN only** — it reports
`would remove 428 rows, 106 MB — nothing was deleted`, and `--apply` has still never been run.
`~/.rune/rune.db` `cost` rows were 2,931 before and after, newest row unmoved.

**Published.** Nothing. No push, no tag, no release. `v0.4.1` remains the last public tag.

### What this pass found that the earlier ones did not

- **A shipped example was graded against a rule it no longer met.** F1's macOS host-enforcement fix
  made `bun test tests/integration` red: the example plugin declares `example.com:443`, which
  Seatbelt can only widen to `*:443`, so it is now refused — and `plugin-examples.test.ts` is the one
  gate that runs the example **as shipped**, while `plugin-tools-sandbox.test.ts` rewrites the hosts
  to loopback first and stayed green. Fixed in `33cea48`, which also asserts that the refusal reaches
  `drainMcpNotices` naming the tool and the flag, rather than the tool vanishing without a word.
- **The integration gate is flaky with Playwright enabled.** With `RUNE_TEST_PLAYWRIGHT` set, one run
  of `bun test tests/integration` gave **215 / 5 skip / 14 fail** and the next gave **229 / 5 / 0**.
  All fourteen were scenario A of `lifecycle-durability`, which is 45/0 alone and 47/0 beside the
  browser suite. The run under test had already ended — four consecutive errors exhausted its retries
  and the turn completed — but `Run.waitForEvent` rejects only on its own 120 s deadline, so the
  driver waited the full two minutes and thirteen downstream assertions then failed in fractions of a
  millisecond each. Two separable problems: an unexplained loopback failure under load, and a rig
  that turns one flake into 120 s and fourteen red tests. Neither is fixed; both are in the backlog.
- **A spared reap is invisible.** `reapOrphanedToolChildren` files an incident for every `killed` row
  and nothing for a `kept` one, so the founder whose process was spared for `identity mismatch: …` —
  the entire point of the reaper fix — cannot see that it happened. Proof (c) had to read the string
  back from source rather than from the running binary.

### What is still not proven

**Linux was not re-run at all.** The containment image was not rebuilt: the Docker daemon does not
answer — sandboxed the socket refuses, and unsandboxed `docker version` produces nothing and is
still blocked when a 15 s kill lands. It was probed twice, twenty minutes apart, the second time with
10 GiB free, so the disk (6.6 GiB when the pass began, under its 8 GiB floor) is not what stopped it.
No attempt was made to repair Docker. Three things therefore remain open, all named by F1: `clippy -D warnings`
has **never run green on Linux** since the dead `has_pair` helper was removed; the Linux `bun`
integration step has never loaded with `process-identity.ts` present; and `probe.sh`'s
`~/.local/bin -> $HOME` re-probe — V1-4's **actual** escape — has never been executed. V1-4's four
`linux::tests` are `#[cfg(target_os = "linux")]` and ran **zero** times on this host; `cargo test`
here confirms it (no test path beginning `linux::` appears in the log). What macOS could check was
checked: `linux.rs` parses and is formatted, and the symbol Linux clippy called dead is gone.

Also unchanged: **Windows** (the watchdog is `#[cfg(unix)]`; the reaper falls back to killing on
liveness alone there and says so — reasoned, never run); **no live model call anywhere**, so every
durability claim holds against a scripted gateway and none against a real provider; the prune has
still never been applied; V3's **F8** (the "usable partial result" test asserts that recovery
_completed_) and **F9** (`auto_compaction` rows at ~58 KB each) have no lane; and `command -v rune`
still resolves the legacy `~/.alan/bin` shim.

## 2026-09-11 (later still) — Phase 3 closed: what the overhead is, what four lanes moved, and what was withdrawn

Phase 3 ran in three parts. **3A** measured where an Auto run's money and wall clock actually go,
from 683 sessions of the founder's own databases, and wrote
[`program/phase-3-auto-efficiency.md`](program/phase-3-auto-efficiency.md) with a reproducible
script beside it. **3B** built four lanes against that measurement, then had each lane read by an
adversarial verifier and repaired by a fix lane. **3C** — this entry — audited the gates, finished
the test rig, re-measured five things on the binary the founder runs, and closed the phase.
Manifest: [`evidence/verification-20260912.json`](evidence/verification-20260912.json). Raw logs:
`.codex/audit-20260910/handoff/phase3/`. **Zero live model calls**, `~/.rune/rune.db` untouched
(2,931 cost rows before and after, newest row unmoved).

### Where each claim stands

**Planned.** Nothing new. 3C proposed no work; it graded work already done and closed the phase.
What the lanes did NOT get to is written down as backlog, not as done: the skills catalog at
9,293 B (32.8% of the fixed prefix), `interject()` not re-running the doctrine router, and the live
frontier pair that is the only way to settle the cache question.

**Implemented.** Eighteen commits, `9279bc7` through `2f13c19`. Lane 0 put a role, a latency, a
cache breakpoint, a prefix hash, a child's start/integrate stamps and a write verdict on rows that
had none. Lane A stopped charging a run twice for a late citation and stopped a write that changed
nothing from re-arming the evidence gates. Lane B took six classes of ordinary command off the
reviewer's desk and bounded a hung review at one deadline instead of two. Lane C wrote the sentence
a model gets when it cites a command that is not a check.

**Two of the four headline savings were withdrawn on the evidence, and the manifest says so rather
than quietly keeping the number.** Lane C's cheaper compaction bought 12,000 bytes by reading the
new segment at merge fidelity — and the verifier proved that segment is the only read those messages
ever get, so a 901–2,400-character tool result was losing up to 62.5% of its middle permanently. It
is back to 21,629 bytes. Lane C's doctrine trim (−741 B) rested on the claim that a mode is only ever
asked for on the opening turn; `interject()` folds mid-run steering into the same run, so it is
reverted and complemented by a just-in-time section instead. **Lane C's net prompt saving is
0 bytes and its net correctness change is two closed holes.**

What did hold: Lane A's no-op write is **7 → 6 completions** with the control unmoved at 7; Lane A's
late citation gives back **3 turns** on a 3-criterion script with the completion count flat, and
flat is how the lane reported it; Lane B's ordinary script is **6 reviewer calls → 1**, and the
repair did not move it because all five of its commands are exact shapes that survived; and the
codex fold went from **313 of 836 shared prefix bytes to 835 of 836**, with the non-folding control
unmoved at 343/886.

**Tested on this source.** The four verifiers raised 40-odd findings; the four fix lanes closed the
HIGH and MEDIUM ones in `cb1b700`, `cce7751`, `2451bc1`, `80aa136`, `6637d68`, `5671ef7`, `1625db1`,
`7eb6ca8` and `03aaa7f`, each with a migrated test. 3C's gate audit reran ten gates and reused three:

| Gate                                                      | Result                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun test tests/unit`                                     | **4,734 pass / 0 fail / 1 skip** (377 files, 63.7 s)                                                      |
| `bun test tests/integration`                              | **260 pass / 0 fail / 7 skip** (45 files, 112.4 s)                                                        |
| `bun test tests/integration/lifecycle-durability.test.ts` | **45 pass / 0 fail**, alone, 26.4 s                                                                       |
| `bun run typecheck --force` · `bun run lint --force`      | **15/15** · **7/7**, 0 cached                                                                             |
| `prettier --check .` · `git diff --check`                 | clean                                                                                                     |
| strict `tsc` over the Phase 3 files                       | **0 errors over 46 files** — the gate was widened to include `tests/helpers/scenario.ts`                  |
| `bun run eval` · `bun run eval:auto-safety --offline`     | **63/63**, baseline unchanged · P 92.8 / R 89.1 / F1 90.9, supervisor shapes 100/100/100, 0 live requests |
| `cargo test` · `cargo clippy` · `cargo fmt --check`       | reused — `crates/` has not moved since `9876957`                                                          |

**3C found a real defect of its own.** P3B I2 put an origin marker on every synthetic re-prompt, and
nothing read it. A gate, a nudge and — once `730fd97` tagged `drainHarnessNotes` — every just-in-time
doctrine note reached the three readers that mean _what the user said_: `/rewind`'s turn list,
session replay, and the permission check's **trusted-intent corpus**. A two-message conversation came
back with 2 KB of house style sitting between the founder's words, filed as the founder's words. The
trusted corpus is the one that matters beyond cosmetics, because a harness note carries connector
notes and teammate mail that nobody typed. Fixed in `793d0ce`: one predicate, `isHarnessAuthoredTurn`,
read at all four sites.

**Installed and smoke-tested.** The binary is `v0.4.1-dev+2f13c19` (CLI `28668d09…`, native
`c5b44f6e…`, launcher unchanged), installed from this tree with no override flag, proven to host a
session by the installer's own `rune serve --check` before the atomic swap. `rune doctor` is not
green and this file will not call it that: every build-facing line is `✓`, and it carries the same
two `✗` retired-free-model lines and three `!` lines as the last entry. The prune was **DRY RUN
only** — `would remove 428 rows, 106 MB` — and `--apply` has still never been run.

Five things were then re-measured **on that binary**, driven through `tests/helpers/scenario.ts`
against a loopback mock under a scratch `RUNE_HOME`. The rig gained a `RUNE_SCENARIO_CLI` hook to
make that possible; it throws rather than falling back, because a measurement labelled with the
wrong subject is worse than no measurement, and a control run with the variable pointed at a path
that does not exist proves the suites actually read it.

- **Attribution.** `costRowsWithRoleTag == costRows` (6 = 6) and `userMsgWithOriginMarker == the
scripted re-prompt count` (2 = 2), read back by the same analysis script the 3A report used. Of
  three `user_msg` rows, two are marked harness rows and the third is the founder's own sentence.
- **`793d0ce`, on the installed binary.** Resuming the session, the engine renders the conversation
  with exactly two user lines — both the founder's — and none of the four harness strings. The wire
  conversation still carries them, and should: they were sent, and the model's next answer depends on
  them.
- **The finish path.** Green check → no-op write → finish is **6 completions and zero gates**; the
  control that changed a file is **7, with `gate:execution-evidence`**. The unrecognised-check
  receipt lands on completion 5 and is said once.
- **The reviewer.** 6 → 1 on the ordinary script, none blocking; the dangerous probe **still
  screens** — three containment denials, the last one `critical`.
- **Compaction fidelity.** A criterion in the middle of a long tool result survives two compactions:
  the second summarizer request renders the same head length per clipped body as the first.

**Published.** Nothing. No push, no tag, no release. `v0.4.1` remains the last public tag.

### What is still not proven

**The codex fold cannot be measured on the installed binary at all**, and that is a property of the
rig rather than a shortcut: `foldsEphemeralTail` is true only for `codex`, the codex route speaks the
Responses API, and `tests/helpers/mock-model-server.ts` serves `/chat/completions` and nothing else.
It was re-measured in-process instead, and the half that CAN be driven through the binary — prefix
stability on a non-folding host — was.

**Linux was not re-run, and the disk is not the excuse this time.** The Docker daemon does not
answer: `docker version` produced one newline unsandboxed and was still blocked when a 15 s kill
landed, and `/var/run/docker.sock` does not exist, with the CLI installed and current (29.1.3) and
Docker Desktop's processes running. Free space was **19 GiB**, more than twice the 8 GiB floor. No
repair was attempted. So `clippy -D warnings` has still never run green on Linux since the dead
`has_pair` helper was removed, the Phase 2 crate fixes (`311e901`, `9876957`) have never been rerun
there, and `probe.sh`'s `~/.local/bin -> $HOME` re-probe — V1-4's _actual_ escape — has still never
been executed.

**No before/after on a real corpus, and none is claimed.** §2.5 of the 3A document says it plainly:
the two post-fix eras hold 42 completions between them. Every 3B number is a fixed-script
measurement through a mock, which can show what the HARNESS spends and can never show what a model
chooses to do once the runtime stops making something expensive. Lane A says this about its own A2
and it is true of the phase. The **live cache question stays open** — a frontier pair costs about
$0.43 at list against ~5% of the weekly Codex allowance, and no arm was authorised.

Also unchanged: **Windows** (reasoned, never run); the pre-change arms of A3 and A1 (reproducing
them needs `packages/` reverted); the seconds B1 gives back (the mock answers instantly, so the
fixed script measures the call count and not the wall clock); and two of `793d0ce`'s four sites —
`/rewind`'s list and the trusted-intent corpus — which have no surface a piped process can reach and
are pinned at this source only.

### Environment notes

**The first 3C attempt was stopped by a full disk.** It ran the gates, found and fixed `793d0ce`,
fixed two strict-tsc errors in test rigs (`2f13c19`), installed the build and ran doctor, the prune
dry run and the tools smoke — and then `/` reached **0 bytes free**, from an unrelated build in
`~/Project/Say` running at the same time. It did not take the re-measurements, write the manifest or
write this entry; this pass audited its artifacts rather than assuming them, and reran every gate
whose subject had moved since. A standing contributor: the installer reports **2,173.5 MB** of its
own backups in `~/.rune/bin`, 105 files across 27 generations, of which keeping the newest five
would reclaim 1,755 MB. `--prune-backups` was not passed.

## 2026-09-14 — M0: the two interrupted lanes finished, and a forged citation no longer buys a rung

The founder stopped the Phase 4/5 effort at 20:55 IST with two fix lanes cut off mid-edit
([the checkpoint](CLAUDE_CHECKPOINT.md)). This entry is M0 of
[the corrected plan](program/guarantees-plan-review-20260914.md#m0--freeze-the-subject-and-finish-the-interrupted-batch),
executed inside the original handoff's scope: the subject was frozen
(`.codex/audit-20260910/handoff/m0/snapshot.txt` + the 1,153-line uncommitted diff), the
two lanes were finished by two Opus workers on disjoint files, each read by the supervising
session against its own probes, and the guard inventory was reconciled against the commits
that landed after it was written. **Zero live model calls**; `~/.rune` untouched.

### Where each claim stands

**Implemented** — five commits on `gear/phase-0-stabilize` after `4869e4c`:

| Commit    | What                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `42e7c62` | harness: `record_evidence` is gated by relatedness on the criterion branch, scoped by `criterionScope` to the files the criterion's own words name; a set-aside citation is recorded (`Evidence.unrelated`) and moves nothing; `runOnParentCommit` reports `not-applicable-on-parent` for a runner that collected nothing or a path the parent never had — a failure by absence buys no rung                   |
| `977789a` | harness: `failingChecks` keys on the quote-preserving `normalizeCommand` (review finding 1); `contractShape` rewritten work → plan → question → chat → `unknown`, `ship` out of the chat words (review finding 2); `briefDrift` compares like with like over `GOAL_CAP`; verdict kind `none` for question/plan/chat with no criteria and no writes; `rune audit` paints it dim                                 |
| `31c6c56` | ui: the caret sits on the field row with the `/` palette open at 80×24 (the real cause was `renderBand` dividing the caret's row by the region, not the painted rows — not the verifier's guess); below 100 columns the composer's extra rows COVER the workspace's bottom rows instead of shrinking it, so nothing above re-lays while typing; stale child header on shrink; wide-char wrap; `ESC(B` stripped |
| `ec8490e` | ui: one tool call counts once on a child card (typed event and string echo reconciled by a per-member credit); no initials collision                                                                                                                                                                                                                                                                           |
| `9d0f9da` | ui: the wizard's saved-vs-active rows name the source that won (and the heading no longer trims out of its columns); an unreachable host is a host receipt, not a rejected key; the read-back close routes through `capRung`/`rungMark`/`rungPaint` and an untouched criterion renders blank                                                                                                                   |

The A2 rebuild is a **design deviation from the inherited fix**, recorded for the founder:
capping the collapsed composer at its minimum turned the spec green but left 80×24 with a
one-row field and no palette at all (both captured on a pty). Covering the workspace's bottom
rows keeps rows 1–16 byte-identical between rest and a three-line draft; the frames are in
`.codex/audit-20260910/handoff/m0/f4-frames/`.

**Tested on this source.** Every one of the 20 red verification specs (4 contract, 16 UI) is
green by a product change and promoted into a permanent suite; `tests/verification/` is empty.
The contract lane mutation-tested its verdict (forcing `met` kills 3 of 4 promoted tests; the
drift test is independent of it by design); the UI lane reverted each of the 15 inherited
fixes in turn and 14 specs died — E3's did not, because it only greps for a call site, so the
lane rendered the table for real and found two more defects in it (fixed in `9d0f9da`).

| Gate                                                                                                                          | Result                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| contract suites (`contract`, `parent-check`, `brief-ledger`, `verification-command*`, promoted `task-contract-*` integration) | **134 pass / 0 fail** re-run by the supervisor at `977789a`; lane: 276 + 12                        |
| ui suites + `first-run` + `ui-grammar` + `ui-glyphs`                                                                          | **283 pass / 0 fail** re-run by the supervisor at `9d0f9da`; lane: 727 across its wider set        |
| `bun test tests/unit` (unsandboxed)                                                                                           | **4,924 / 1 skip / 0** at `977789a` (contract lane); **4,944 / 1 skip / 0** at `9d0f9da` (UI lane) |
| `bun test tests/integration` (unsandboxed)                                                                                    | **289 / 7 skip / 0** at `977789a`                                                                  |
| `bunx tsc --noEmit -p packages/orchestrator`, `-p packages/protocol`                                                          | 0 errors at `9d0f9da` (the `read-back.ts:106` error is gone)                                       |
| lint, format, cargo, clippy, eval, eval:auto-safety, strict tsc                                                               | **not run in M0** — deferred to the M1 close, on the final combined source                         |

Supervisor probes beyond the lanes' tests: the four review examples classify as the review
demands, `looks good, ship it` and a pasted stack trace are `unknown` (not `chat`, not
`feature`), a question that WROTE a file is back to `unmet`, and the quoted-path example
yields `partial` with the red check named.

**Installed.** Nothing. The binary the founder runs is still `v0.4.1-dev+2f13c19`; nothing
from Phase 4, 5B or M0 is live. Install is the M1 close's job, on the final combined source.

**Published.** Nothing. `4869e4c` and these five are unpushed; push is the founder's.

### The authoritative list (the M0 exit)

- **Implemented and tested on this source:** the four-region frame, agents panel, composer,
  named sub-agents with their own stream, box grammar and claim rungs, the six-step first
  run with saved-vs-active and masked keys, the CI workflows (`containment-linux`,
  `install-smoke`), TaskContract at intake, a verdict on every exit, and the five M0 commits.
- **Installed and smoke-tested:** `v0.4.1-dev+2f13c19` only — Phase 3's close. Everything
  since is source-only.
- **Independently demonstrated:** nothing since Phase 3's five re-measurements.
- **Pending, by original phase:** Phase 4 — the installed fresh-profile walkthrough and
  §2.8's wizard-in-frame split (at 120×40 `/setup` still drops the panel; frame
  `120x40-setup-wizard-no-split.txt`). Phase 5 — untouched. Phase 6 — untouched. Phase 7 —
  the two CI jobs have never executed (unpushed), Linux is still unrun (the Docker client
  is present, no daemon socket, no reset attempted), Windows is reasoned only, no live run.
- **Pending, by milestone:** M1 in flight on
  [its spec](program/m1-acceptance-semantics.md); M2–M6 not started.

### Next executable step

The M1 lane's three commits (derived criterion status; amendments that keep what the user
and the evaluator stated; the runtime running `--acceptance` at the finish gate), then ONE
closing pass: the full gate list from the handoff's Phase 1, `install.sh` without overrides,
doctor, `docs/evidence/verification-20260914.json`, and the installed fresh-profile
walkthrough from the handoff's Phase 4.

## 2026-09-14 (later) — M1 lands, the wizard takes the frame, the tree is gated and installed, and the walkthrough finds what the tests could not

Three lanes after M0, each read by the supervising session against its own probes, then one
closing pass. **Zero live model calls** anywhere in this entry; `~/.rune/rune.db` untouched.

### Where each claim stands

**Implemented.**

| Commit    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4d227fd` | M1 (a): a criterion has an `id`, a `source` (`user` / `inferred` / `evaluator`), `required`, and a `method`; evidence carries `executionId`, `verifier`, `result`, `env`; `criterionStatus()` derives `unassessed / satisfied / failed / stale / needs_review` from those facts; `met` = every required criterion `satisfied`, no red check, no open step; every verdict carries `execution {stopReason, status}` beside `kind`; the rung stays what it was and `verified` becomes attribution, reported and never required |
| `9421556` | M1 (b): a model amendment cannot shorten the task — an omitted `user`/`evaluator` criterion is put back and recorded in `amendments[].kept`; `revision` and `constraints` never shrink; `record_evidence` refuses evaluator criteria; a resumed run inherits the contract, not only the brief                                                                                                                                                                                                                               |
| `8cbaabd` | M1 (c): `--acceptance <file>` — evaluator criteria loaded at intake, never rendered into any prompt (T1 greps every outgoing request body), run once by the runtime through the registry's `bash` at the finish gate, `verifier: acceptance-command@1`; advisory, no refusal, no re-prompt                                                                                                                                                                                                                                  |
| `16fe3ae` | M1 (d), from the supervisor's own probe: an execution receipt (`echo done`, exit 0) derived `satisfied` under M1 because the old cap at `observed` had been holding by accident; `rungForCommand` now stamps `verifier: execution-receipt@1` and `criterionStatus` derives `needs_review` for it, from the log's kind or from the verifier alone (saved rows)                                                                                                                                                               |
| `75a1153` | Phase 4 §2.8: `/setup` takes the four regions above 100 columns — the six-step ledger and SAVED vs ACTIVE in the panel, receipts as boxes in the workspace, the titled question in the composer, `◆ setup · no model called yet` in the strip; at 80×24 Lane E's footer layout is kept byte-for-byte with the no-model line added                                                                                                                                                                                           |
| `4a6774d` | Prettier over the thirteen files the lanes wrote (whitespace, two leading union pipes, one quote style)                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Tested on this source** — the handoff's full gate list, run once on `16fe3ae` by
`.codex/audit-20260910/handoff/m0/run-gates.sh` (logs beside it in `gates/`), unsandboxed:

| Gate                                                             | Result                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bun test tests/unit`                                            | **4,991 pass / 0 fail / 1 skip** (4,992 ran, 381 files, 57.1 s)                                      |
| `bun test tests/integration`                                     | **303 pass / 0 fail / 7 skip** (310 ran, 52 files, 116.4 s)                                          |
| `lifecycle-durability` alone                                     | **47 / 0**, 26.4 s                                                                                   |
| `bun run typecheck --force`                                      | **15 / 15**, 0 cached                                                                                |
| `bun run lint --force` · `prettier --check .`                    | **red on the first run** — thirteen lane files unformatted; fixed in `4a6774d`, both rerun **green** |
| `cargo fmt --check` · `cargo test --locked --workspace` · clippy | clean · **109 / 0** · 0 warnings (build cached; `crates/` unchanged since `9876957`)                 |
| `bun run eval`                                                   | **63 / 63**, baseline unchanged                                                                      |
| `bun run eval:auto-safety --offline`                             | P 92.8 / R 89.1 / F1 90.9, supervisor shapes 100 / 100 / 100, **0 live requests**                    |
| `git diff --check`                                               | clean                                                                                                |

The formatting commit that followed changes no token but whitespace, two union pipes and one
quote style (checked per file with whitespace and commas stripped); the eight suites it touches
were rerun on it (**261 / 0**) with lint and format green.

Independent probes by the supervisor, beyond the lanes' tests: ten hand-built criterion shapes
through `criterionStatus` (fresh check → satisfied; later red run → failed; digest moved →
stale; undatable → needs_review; unrelated → unassessed; legacy `observed` → needs_review;
legacy `verified` → satisfied; verifier without result → needs_review; review method →
needs_review; and the execution receipt that was `satisfied` until `16fe3ae`). The M1 lane's
own mutation (`criterionStatus` forced to `satisfied`) kills 26 tests including T1, T3, T5, FP
and FN; the execution-receipt clause removed kills exactly its two.

**Installed and smoke-tested.** `bash scripts/install.sh`, no override flag, from a tree whose
only untracked file is `scripts/tui-capture/first-run-frame.ts`; the staged binary hosted a
session over the socket before the atomic swap. **Rune v0.4.1-dev+4a6774d**: CLI
`d18b42ba07f8d79cd26d516ea158e53380db8ace7e69f37c0dd8d50d34cbe704`, native `c5b44f6e…`
(unchanged since Phase 2), launcher `5a22d151…` (unchanged). In a fresh shell `command -v rune`
resolves `~/.rune/bin/rune` and `rune --version` says the build. `rune doctor`: every build
line `✓`, the same three `✗` retired-free-model lines as before, `checkpoints` still `!`; the
build line reads `current — gear/phase-0-stabilize@4a6774da+dirty` (the untracked capture
script). `rune tools-smoke` round-trips write · read · edit · bash. `rune --help` carries
`--acceptance`. The installer reports **2,257 MB** of its own backups (109 files, 28
generations); `--prune-backups` was not passed.

Then, **on that binary**:

- `tests/integration/lifecycle-durability.test.ts` with `RUNE_SCENARIO_CLI=~/.rune/bin/rune`:
  **47 / 0** (24.7 s); the control with the variable pointed at `/nonexistent/rune` fails
  with `points at a binary that does not exist`, so the suite read it.
- **The Phase 4 walkthrough** (`.codex/audit-20260910/handoff/m0/walkthrough-installed.py`,
  the wizard lane's rig with the child swapped for the installed launcher): at 120×40 and
  80×24, idle → `/setup` → provider `custom` → loopback base URL → model → key typed (masked)
  → key accepted (`200 OK`, keychain named) → esc → a NEW process on the same profile. Sixteen
  frames in `walkthrough-frames/`. The key appears in no frame and in no file under the
  profile, both sizes. The scratch `rune.db` holds no events.

**Independently demonstrated: one Phase 4 defect the source tests could not see.** The
wizard's own relaunch runs with `--pristine`, a flag that outranks the file, so its frame
proves the SAVED column and nothing about restart. Relaunched without the flag — with the
saved profile, the mock key restored in the keychain and the mock listening
(`restart-proof-keyed.py`), and again with every `*_API_KEY` scrubbed from the child
(`restart-proof-scrubbed.py`) — the new process runs **`gemini-2.5-flash`**, not the saved
`custom · mock-small`, and the panel says so honestly (`provider custom / google`). The
handoff's Phase 4 acceptance ("restart-required changes say so", and then take effect) is
therefore **not met on the installed binary**. In code: the boot's config branch
(`rune-cli.ts` ~:948) honours `llm.defaultProvider` only if it passes `isCliProvider`, a
hand-written list of five ids — the same rot class as the sticky-model bug that file's own
comment describes — so a saved `custom` (or any of the thirty-odd presets) falls through to
auto-detect. Why auto-detect then lands on google with no key in the environment is not yet
explained; a fix lane is on it (see the addendum below).

**Published.** Nothing. Fourteen commits since `4869e4c` were unpushed at that point (more since); push is the founder's.

### What is still not proven

- **Windows** (reasoned, never run) and **Linux** (the Docker client is present, no daemon
  socket; not reset; the two CI jobs have never executed because the branch is unpushed).
- **Any live model call.** Every M1 exit test drives a scripted provider; nothing here says
  what a real model does with `--acceptance` criteria it cannot see.
- **`--acceptance` on the installed binary** is proven by construction only (`--help` shows
  it; the finish-gate run is exercised in-process by T1/T2/FP/FN on source).
- **The rest of §2.8**: `/model`, `/sandbox` and `/keys` still claim the footer; `/help` and
  `/status` are not in the workspace; the narration rows between receipts are not written.
- **Resize during a wizard step** and **a `/config` change in the same session** are pinned on
  source, not re-taken on the installed binary.
- **M1's per-run protection**: a `user` criterion survives amendments and an interrupted
  resume, not a NEW message after a clean finish (the spec's own rule; a decision for M2).

### Addendum — the walkthrough's defect fixed, reinstalled, and proven on the binary

`a22866b` — harness: the provider you saved is the provider you get back. Two defects, both
the rot the file's own comment already described for the sticky path: `rune-cli.ts:904`
honoured `llm.defaultProvider` only through `isCliProvider`, a six-id literal, so a saved
`custom` (or any of the ~30 presets) fell through to auto-detect, and `hasCreds` (`:848`) never
asked the keychain; and `:1316` handed every provider outside those six
`DEFAULT_MODELS.google = gemini-2.5-flash` when the selected provider was not registered —
the line that printed gemini in the frames even with `custom` active. The selection is now a
pure function, `resolveStartupSelection` in `startup-selection.ts` (flags → sticky → config →
auto, sticky semantics verbatim), with `modelForProvider` replacing the google literal;
fifteen unit cases including the three regressions. The lane also found that a repo-level
`.env` is auto-loaded by `bun` for any run whose cwd is the checkout, which is the
parent-process half of "google from nowhere" and a local artifact, not product state.

Reinstalled without an override: **Rune v0.4.1-dev+a22866b**, CLI
`d341ec7314eb737a04f97a2c1013f42540004353f5573513ed7c1aa3376cd192`, native and launcher
unchanged. On that binary: `rune doctor` build line `current — …@a22866b8+dirty`;
`tools-smoke` round-trips; lifecycle **47 / 0** through `RUNE_SCENARIO_CLI`; and
`restart-proof-keyed.py` — the same relaunch that showed gemini — now reads
**`> 1st gear · mock-small`** in the strip with SAVED vs ACTIVE `custom custom` /
`mock-small mock-small` (`walkthrough-frames/120x40-restart-keyed-{idle,setup}.txt`, re-taken;
the source-side proof is `120x40-restart-keyed-FIXED-source.txt`). The keychain was left as
found. Gates on `a22866b`: unit **5,006 / 0 / 1 skip** (the lane, unsandboxed), integration
**303 / 0 / 7 skip** (the supervisor, unsandboxed), typecheck clean, prettier clean.

The original Phase 4 acceptance now holds for the walked steps: setup without editing a
config file, precedence explained in the panel, the key nowhere in transcript or logs,
controls persisting, and restart-required changes taking effect on restart. What the
walkthrough did not exercise is listed under "What is still not proven" above.

### Addendum 2 — the rest of §2.8, and what the frames found

`564ef36`, `3ae51ee`, `48caa0c`. `/config`, `/sandbox` and `/model` were already in the
workspace (all three resolve to the band picker Lane E built) and are now pinned by test;
`/keys` splits as §2.8 says — the roster in the workspace, the masked field in the composer,
the caret following it; `/help` and `/status` were already committed to the transcript and
`/status` already the idle panel. Drawing them found two `/help` defects: it measured width and
height against the window rather than the workspace, so at 120×40 half its rows were written
past the 78-cell pane and clipped, and a 36-row workspace could outgrow its compact form. Both
now read the workspace. The capture rig scrubs credentials **by shape** (`*_API_KEY`,
`*_TOKEN`) instead of a ten-name roster that missed three, and asserts nothing
credential-shaped survives; the repo-level `.env` is confirmed not to reach the child (bun
loads it from cwd only, and the child's cwd is the scratch workspace). Twenty-two frames at
120×40 and 80×24 in `p4b-frames/`; `rune.db` has no events after each walk. Gate suite
**767 / 0** (was 751); full unit **5,068 / 0 / 1 skip** on a tree that also held the M2
lane's in-flight work. Two deviations, stated: the band key field masks the whole value while
typing (the footer editor keeps last-four, frozen by §2.2), and `/keys` writes the raw key to
`secrets.json` because that is the store the command exists for. Still missing from §2.8: the
setup narration rows, the collapsed ledger behind ctrl+f, `/config`'s number editor in the
footer's ask mode, and mocks for these six surfaces.

### Addendum 3 — M2: a controller that decides and cannot act, watching every clean guard

`a9a9f37` and `b5632fb`. `run-state.ts` is the versioned read-only snapshot the inventory's
§4.2 named (absent fields stay `undefined`, never invented); `arbiter.ts` is `decide(state,
event) → Decision`, a function of two values with no `this`, no clock and no module state —
the six-class ladder (user > safety > budget > environment > contract > progress), class 5
never proposing `complete`, a terminal absorbing per run id, a missing input answering
`unknown`. `shadow-arbiter.ts` wires it beside **seventeen guards and the verdict at
twenty-six sites**, all additive: the only lines removed from `agent-loop.ts` are the three
that gave `providerLostEnd` one optional argument, and the supervisor diffed the file hunk by
hunk to confirm no guard moved. Rows `shadow_decision` (capped at 200 per run),
`shadow_capped` and `shadow_summary`, each under 2 KB, inputs reduced to booleans, numbers
and enum words — five canaries (user text, tool arguments, a result, a halt reason, a
key-shaped string) reach no row. `[controller] shadow` defaults on for the lead loop and is
off for sub-agents by construction; `rune audit` prints the summary block. One deviation from
the spec, stated: the rows are not in `RUN_TRACE_EVENTS` (an allow-list over
`AgentTurnEvent` whose drift law forbids naming non-events) and are rows of their own type,
like `contract` and `verdict`.

**What the shadow saw.** Over twelve deterministic scenarios (a gate refusing a finish, a
supervisor halt, an empty completion accepted, an empty completion bail, a non-retryable
provider failure, a budget refusal, a turn ceiling, an abort, an open plan, a loop-detector
kill, a barren-turn kill, a truncation ceiling) the arbiter disagreed with the guards
**once**: at G9, `arbiter abandoned(environment) · guard complete(end_turn)`. The
supervisor's reading of the site is that this is a label, not a behaviour — the loop falls
through into the finish gates and the verdict after accepting the silence — and
[the M3 spec](program/m3-first-migration.md) makes that branch the first the controller owns.
Two scenarios recorded an `unknown` at the verdict site (no contract in scope; the arbiter
refused to guess) and two recorded `unshadowed` guards. Overhead, measured and not
thresholded: 0–4 rows per run, p50 8–364 µs, p95 up to 948 µs on a cold first observation,
under 1.4 ms per run.

**Tested.** `arbiter`, `run-state`, `shadow-arbiter`, `shadow-engine-rows`,
`shadow-no-effect`, `shadow-report` and `lifecycle-durability` rerun by the supervisor:
**119 / 0**, spend fingerprint unmoved. The eight fast gates rerun on `b5632fb` by
`run-gates.sh`: unit **5,068 / 0 / 1 skip** (386 files), integration **329 / 0 / 7 skip**
(55 files), lifecycle 47 / 0, typecheck 15 / 15, lint 7 / 7, format, prettier and
`git diff --check` clean. Cargo, clippy and the two evals are reused from the 16fe3ae run:
`crates/` and `tests/eval` did not move.

**Installed.** `bash scripts/install.sh`, no override: **Rune v0.4.1-dev+a47e9fc** (the
docs commit atop `b5632fb`), CLI `d842162656d2beecd4e71ab80c1881466aabffd2576129948a40123de7c2a17d`,
native and launcher unchanged; doctor's build line current, tools-smoke green. Through that binary (`RUNE_SCENARIO_CLI`), `lifecycle-durability` is **47 / 0** again.

**Residual, from the lane's own report.** The absorbing rule hides later decisions in a run
(the disagreement count is a floor); G9 will always disagree on a contracted run until M3
relabels it; steps are keyed on the turn; overhead was measured on a scripted rig; `spentUsd`
is wired and unused because N1 aborts from a gateway callback and is not shadowed; "sub-agents
never get one" is by construction, proven by grep.

### Addendum 4 — M3: the first decision the controller owns, behind a switch that defaults off

`9fa5d5c`, `ef17f59`, `a6ec327`. First the label: the empty-completion site records
`verifying`, not `complete(end_turn)` — it completes nothing, it stops retrying and falls into
the finish path — and the arbiter's G9 rule matches, so the twelve-scenario shadow report now
reads **zero disagreements** (rerun by the supervisor: `[S4] … none`). Then the switch:
`[controller] authority = []`; with `"E4"` present the site calls `decide`, writes an applied
`decision` row **before** the act, and acts through the same code paths; the inline
predicate survives only as the `legacy` closure, which is the rollback. An arbiter answer
outside the branch's three transitions is refused and `legacy()` stands, with the row saying
so. The counter joins the durable budget: a run SIGKILLed after two empty completions that
resumes and gets a third abandons (proven on the real kill rig, with a control that gets a
fresh three when authority is off). Nothing weakened; three expectation changes named in the
lane's report. Gates: focused 121/0, `controller-e4` 7/0, lifecycle 47/0 with the spend
fingerprint unmoved, full unit **5,092 / 0 / 1 skip**, integration **336 / 0 / 7 skip**
(unsandboxed, the lane). The supervisor reran the six suites that matter: **124 / 0**. The
second branch (the bounded acceptance re-prompt) is NOT built; the spec's section stands as
the next M3 step. Not installed: the founder's binary is `a47e9fc`, and with authority off the
branch behaves as before, so nothing changes for a user until the founder opts in.

### Addendum 5 — M5's corpus, frozen and run offline once: zero false completions, and two defects on the other side

`8c63f53`, `0ea4b56`. Twelve tasks in `tests/eval/corpus/` — 3 fix, 2 omission-prone
feature, 2 migration, 2 frontend, 2 research, 1 dirty-worktree; the four comparison fixtures
reused verbatim and pinned byte-for-byte — each with an `--acceptance` file the model never
sees, a hand-written correct solution, and five scripted-provider scenarios (`correct`,
`omission`, `wrong`, `silent`, `stopped`). The sanity suite runs every acceptance file
against its solution in a scratch checkout: **14 pass / 0 fail / 2 skip** (16 tests; the earlier "20" counted the six budget-guard tests too), the two browser tasks
green in real Chromium when `RUNE_BENCH_PLAYWRIGHT` is set and reported as skips otherwise.
The live runner now refuses to start without `RUNE_EVAL_BUDGET_USD` (six tests); no live run
was made and none is authorised.

The offline runner drove the real engine through all sixty rows with **zero model calls**
([`evidence/corpus-offline-20260914.json`](evidence/corpus-offline-20260914.json)):

| family                 | attempted | false completions | false negatives |
| ---------------------- | --------- | ----------------- | --------------- |
| fix                    | 15        | 0 / 12            | 0 / 3           |
| omission-prone feature | 10        | 0 / 8             | 0 / 2           |
| migration              | 10        | 0 / 8             | 0 / 2           |
| frontend               | 10        | 0 / 8             | **2 / 2**       |
| research               | 10        | 0 / 8             | **2 / 2**       |
| dirty-worktree         | 5         | 0 / 4             | 0 / 1           |
| **total**              | **60**    | **0 / 48**        | **4 / 12**      |

This measures the harness's detection with a scripted model, never a model's ability. Every
deliberately broken arm ended `partial` or `unmet` with the failed evaluator criterion named.
The four false negatives are the finding, and both are harness defects:

1. **A finish gate that outlasts one second makes a just-taken citation `stale`.** Isolated
   by adding `sleep 3` to one acceptance command and changing nothing else: `met` →
   `partial`. Cause: `REVISION_MEMO_MS = 1_000` in `engine.ts` — a citation's revision is
   read from a memo up to a second old, and when the acceptance gate outlasts the memo the
   fresh read disagrees. A verdict must not depend on how long the checks take. Reported to
   the backlog; the fix belongs to the lane that owns the file.
2. **A question or a plan cannot reach `met` through its own citation** — `grep -c '##'
ANSWER.md` is an execution receipt, so the model's criterion derives `needs_review` and the
   verdict is `partial` even with every evaluator criterion `satisfied`. M1's conservatism
   (T7) working as written, and a consumer counting `met` as success scores a correct
   explanation as a miss. A decision for the fix lane: an evaluator-satisfied run with only
   `needs_review` inferred criteria left should be reportable as such.

Three corpus traps were found and corrected before the run and are dated in the README's
Changes section rather than hidden — Prettier had reformatted the verbatim fixtures and
invalidated three digests (now `.prettierignore`d), and `queue-race`'s wrong arm initially
passed everything. **Not installed** (test fixtures only). Not covered: the browser tasks
without Playwright; anything live.

### Addendum 6 — the adversarial verifier's pass over the batch, and what it found

Per the founder's rule (2026-09-11, reaffirmed 2026-09-15): one verifier over M1, M2, M3,
the Phase 4 remainder and the corpus, assuming every claim false. Report:
`.codex/audit-20260910/handoff/m0/verify-batch-report.md`; eighteen red tests under
`tests/verification/v6-*` (30 failing assertions, 3 deliberate green controls), 33 archived
harnesses. Zero model calls; nothing in `packages/` edited.

**Four critical acceptance forgeries, live on the installed binary** (which carries M1):
(1) the acceptance script is inside the workspace and the model can overwrite it with
`console.log('1 pass')` → `met`, nothing built; (2) `node check.mjs header.csv` — an argument
the script ignores — defeats `criterionScope`, reopening V-5B's F1 with one word; (3) a
model-written `verify-header.sh` that prints `1 pass` is classified a check by name → `met`
with zero product change; (4) evidence is dated at citation, not at check time — fix, green
check, revert, cite → `satisfied` at rung `verified`; the same root as the corpus's
`REVISION_MEMO_MS` false negatives. **High:** `engine-host.ts` (detach/serve/acp) never got
the boot fix; `bun test tests/unit` is red at HEAD because the corpus's budget guard fires for
a scripted zero-spend caller; `swebench.ts --real` and `RUNE_EVAL_REAL=1` bypass the budget
authorisation; the corpus acceptance passes deliberately wrong solutions in three of three
families attacked (so "0 / 48" measured the twelve hand-written arms, not the oracle); a
throw inside a shadow observation kills the run it only watches. Twelve mediums and eight
lows, listed in the report.

**What held:** acceptance text reaches no prompt; evaluator citations are refused; the `kept`
rule holds; `decide` is pure over 32,844 calls with zero credential leaks across eleven
canaries; M3's row-before-act, the SIGKILL table and the byte-identical authority-off diff
all reproduce; the installed binary is exactly `a47e9fc`; the spend fingerprint is unmoved.

**Record corrections made in this commit:** the M1 entry's integration count was 303 pass
of 310 ran (the same misread `bf8895d` corrected for the unit line); the corpus sanity count
is 14 pass / 2 skip, not 20 (the earlier figure included the six budget-guard tests); the
unpushed count was fourteen, not ten. Also true and not fixable after the fact: the
`gates/` logs cited by the M1 entry were overwritten by the `b5632fb` rerun; the M1 entry's
numbers stand on the entry itself and the lane reports, not on those files.

**Two fix lanes are running on disjoint files** (A: the four forgeries, the revision stamp,
the shadow try, three mediums; B: engine-host, the red gate, the spend paths, the corpus
hardening, startup-selection's mutation survivors, the rig scrub). M4 does not start until
both land and their tests are promoted. This is the loop working: the build lanes' own tests
were green, the supervisor's probes caught two holes, and the adversary caught four more that
matter most.

### Addendum 7 — Fix lane A: the four forgeries closed, and a claim is dated when its check ran

`f85b263`, `6d9c8d6`, `f3989cb`, `bdd901c`, `d9c524e`. The acceptance runs from outside the
workspace: every in-workspace script an acceptance file names is copied at intake into a
`mkdtemp` directory the tools cannot reach, its sha256 pinned and re-checked before the gate,
the command rewritten to run the copy with `cwd` = the workspace (so scripts address the tree
by relative path; anything the entry loads goes in the criterion's `files`). A script host's
relatedness scope stops at the entry script — trailing argv the script ignores buys nothing;
`grep`, `bun test a b`, `pytest x y` unchanged. A check whose entry script the run itself
wrote is priced like an execution receipt (`self-authored-check@1`, `needs_review`, the
receipt naming the file); project checks stay checks. The workspace revision is stamped on
the `CheckRun` when the check runs, un-memoised, and the verdict's `now` is fresh too — a
revert after a green check reads `stale`, and `sleep 2` in an acceptance command no longer
changes a verdict, which also closes the corpus's two frontend false negatives at the root.
The shadow lane's snapshot is a thunk inside one `try` at all twenty-six sites, so a throwing
observation cannot fail the run; the summary row is bounded and `overheadUs` measures the
arbiter's two spans with the row sink beside it as `sinkUs`. The inherited allowance reads the
row's number; `evaluators { satisfied, total }` rides every verdict and `verdictLine` (`met`
unchanged); `true` / `:` / `exit 0` derive `needs_review`; the evaluator refusal reveals no
index range. Each fix mutation-tested red and restored by hash; eight verifier tests promoted
into the permanent suites; three expectation changes named. Supervisor rerun of the thirteen
suites that matter: **404 / 0**. Lane's gates: integration **344 / 0 / 7 skip**, unit
**5,121 / 1 fail / 1 skip** — the one failure is V6 #6, lane B's budget guard, not this lane's.
Spend fingerprint unmoved. Left for lane B: the `--help` text and the corpus checks' root
resolution (`process.cwd()`), both written out in the lane's report.

### Addendum 8 — Lane F: the frontend and architecture loops, as doctrine and as record

`024dba3`, `5caf984`, `224040e`, `272d05e`, `95c3d54` (original Phase 5). **F1** — `frontend`
and `architecture` are just-in-time doctrine sections routed by request shape, no longer a
slice of the fixed prefix; routing now runs per user message, which also closes the Phase 3
residue that a mid-run steer got no routing at all; a plain fix request pays zero bytes (the
test measures the whole first request). **F2** — a frontend-shaped run with no browser
mounted says so on the first turn, in a harness note before the first completion, and in the
read-back's `leave`; `rune doctor` prints a browser line (config state, the MCP module,
Chromium builds in Playwright's cache); a capture naming an origin the run did not serve is
refused, pinned three ways. **F3** — `docs/program/visual-rubric.json` (`visual-rubric@1`,
eight criteria: hierarchy, spacing rhythm, type scale, contrast, responsive integrity, state
clarity, focus visibility, reference consistency) and `visual-review.ts`: the reviewer must
be a different model family, is blind by type (the prompt has no field for the request), and
produces `pass | fail | unclear` with a quote and never a number (`8/10` and `B+` are struck,
`390px` and `3:1` kept); with no independent reviewer configured it records `no independent
reviewer` and makes no call; the evidence lands on a `method: review` criterion, which M1
derives as `needs_review` — a second model supplements and cannot certify. **F4** — plan steps
carry `interface`, `invariant`, `migration`, `acceptance`, `dependsOn` when the model supplies
them (the runtime invents none); a step closing over an open dependency is refused
(`open_dependency`); a failing check on a step that rests on an upstream interface requests
one replan naming it. **F5** — two fixtures under `tests/integration/fixtures/phase5/`: a form
with states, and a three-module change whose step 3 breaks on step 1's interface — the
inconsistent step 3 scores 5 of 7, with exactly the two criteria that exercise the interface
through step 3's caller red while the broken build still exits 0.

Supervisor rerun of the ten suites that matter: **144 / 0**. Lane's gates: unit 5,188 / 0 /
1 skip, integration 358 / 0 / 7 skip, lifecycle 47 / 0, and the browser sandbox suite 2 / 0
against real Chromium 151 (a real Playwright module installed into a scratch directory
outside the repo, since bun's cache cannot resolve one). **Not done, with hunks in the lane's
report:** `rune audit` naming the screenshots and the `leave` pre-flight reaching the live
brief field (both now in a follow-up), and nothing calls the visual reviewer in a live run —
no reviewer budget is authorised, and **no claim about design quality is made: the rubric has
never been run by a real reviewer.**

### Addendum 9 — Fix lane B: every door that can spend refuses, one startup ladder for every process, and the corpus attacked back

`0424906`, `e514f42`, `3baaa57`, `edd96ef` (+ the `--help` and `process.cwd()` hunks from
lane A). The unit gate is green again: the budget guard asked "is there a budget?" before
asking "can this run spend?"; a pure `pilotSpendRoute` now answers the second first, so a
scripted zero-dollar caller is never refused and `--real`, `swebench.ts --real` and
`RUNE_EVAL_REAL=1` all refuse at the door without `RUNE_EVAL_BUDGET_USD`, proved without a
model call. The stated cause of the non-hermetic mock eval was wrong and the lane said so: a
stray `OLLAMA_API_KEY` leaves it at 63/63; a **blank `RUNE_TOOLS_BINARY`** (which the brief's
own zsh export produces) is what gave 24/63 — blank is now unset and an unreachable binary is
refused, and the credential env is scrubbed before the first Engine. `engine-host.ts`
(detach/serve/acp) lost its private five-id ladder and calls `resolveStartupSelection` +
`modelForProvider`, verified by a real stdio boot; a provider disabled in `/keys` is not
selected as keyed; an unknown `--provider` is refused by name with the nearest ids; a
hand-edited `[controller] authority = 4` is warned about and ignored, never fatal; the dead
`custom`-in-keychain branch was deleted rather than made real (making it real is a
`secrets.ts`/`buildGateway` change first — the one place the lane chose against the verifier's
prescription, with its reasoning in the report). `startup-selection.test.ts` went from 15 to
32 cases and **0 of 12 mutations survive**. The corpus's acceptance was hardened on the three
attacked tasks plus one the lane broke itself, the four attacks became `wrong-v6` arms, and
`cache-plan` names its omission: **64 rows, 0 skipped, false completions 0 / 52, false
negatives 2 / 12** ([`evidence/corpus-offline-20260915.json`](evidence/corpus-offline-20260915.json)),
the two remaining being the research family's own-citation limit recorded in the backlog.
The capture rig scrubs by a stated predicate (eight suffixes, chain variables, and the
registry's forty-three provider env names parsed from source) shared with its own leak guard.

Supervisor rerun: startup-selection, engine-host, `tests/unit/eval`, config shapes, corpus
sanity and the evolve comparison suite — **100 / 0 / 2 skip**; `tests/verification/` is
empty. Lane's gates: unit **5,197 / 0 / 1 skip**, integration **358 / 0 / 7 skip**, `bun run
eval` 63/63 with a bogus `OLLAMA_API_KEY` exported. Two caveats the lane recorded: another lane
edited the tree concurrently (explicit paths only were staged), and the founder's own resumed
codex session moved `~/.rune`'s cost rows 3491 → 3493 at 07:20 IST — no lane command used the
default home or a live route.

### Addendum 10 — the closing pass, 2026-09-15 morning

Everything above is on one tree. The handoff's full gate list ran once on `44f1b05`
(`run-gates.sh`, unsandboxed): unit **5,201 ran / 0 fail** (397 files), integration **368 ran
/ 0 fail** (60 files), lifecycle 47 / 0, typecheck 15 / 15 and lint 7 / 7 uncached, cargo fmt
clean, cargo test **109 / 0**, clippy 0 warnings, `bun run eval` 63 / 63 with the baseline
unchanged, `eval:auto-safety --offline` P 92.8 / R 89.1 / F1 90.9 with 0 live requests,
`git diff --check` clean; Prettier was red on the two corpus evidence JSON files and clean
after `e3fb2eb`. Installed without an override: **Rune v0.4.1-dev+e3fb2eb**, CLI
`4cccec1d1773cd8960dcde96e863ec3036df5af17304b1dc5dc24560a7218bbd`, native `c5b44f6e…`
unchanged since Phase 2. On that binary: doctor's build line current and its new browser line
honest (`off by config … chromium-1243`), tools-smoke green, lifecycle **47 / 0** through
`RUNE_SCENARIO_CLI`, and the keyed restart proof reads `> 1st gear · mock-small`. The manifest
[`evidence/verification-20260914.json`](evidence/verification-20260914.json) carries all of it
under `afterFixes`. Disk: 11 GiB free (Playwright and builds took 14 GiB overnight; the 8 GiB
floor still holds). Nothing pushed; the founder's push will be the first time
`containment-linux` and `install-smoke` execute.

**Where the program stands, in the handoff's vocabulary.** Phases 0–3: done on earlier
revisions, unchanged. Phase 4: done with named gaps, installed, walked through. Phase 5:
built and tested on source; not independently demonstrated (no reviewer has run the rubric,
no live frontend task). Phase 6: untouched. Phase 7: gates and install done; platforms, CI
execution and reproducible live comparisons pending. M0, M1, M2 done; M3 first branch done;
M5 corpus built and run offline twice; one adversarial verification pass done and every
finding closed; M4 and M6 not started. **No claim of cost parity, superior design, or
beneficial self-evolution is made; none was measured.**

## 2026-09-15 (afternoon) — the founder's three asks: the single column back, a calm working mark, and a memory that learns only what a person said or a check proved

### Addendum 11 — autonomous memory, with provenance instead of summarisation

`44111d2`, `ca23537`, `36f3d31`, `1e2834a`; design in
[`program/memory-autonomous.md`](program/memory-autonomous.md). The founder asked for memory
that learns across sessions like Claude's and ChatGPT's, and for the rule that a prior
session's hallucination or wrong approach must never poison a new one. The design takes the
second half as the whole: **nothing enters memory unless a person said it or a machine proved
it.** The model's prose has no reader — the extractor's input carries the user's messages and
the verdict and no field for assistant text (a test pins the key set). Sources: the user's
own words, quoted verbatim, when they state how answers should read or how work should be
done (a topic filter keeps "I want unsugared facts" and drops "I want a login page"); lessons
only from a run whose verdict was `met`, citing the check; facts seen in two distinct sessions.
A failed run may teach one thing, an `avoid:` lesson, because an exit code is true either
way. A guard with eight weakening rules (sandbox, permissions, asking, verification, budget,
acceptance, git safety, instruction override), ten secret shapes and five artefact shapes
refuses the rest — including a weakening line phrased as the user's own words — and a
51-case corpus includes ten lines that must survive ("the sandbox caught a real bug"). The
store is one readable JSON per entry under `~/.rune/memory/entries/` with content-derived
ids, source, session ids, evidence, confidence, expiry and scope; user's words promote
immediately and never expire, observed facts at two sessions with 60-day decay, verified
lessons with evidence for 90 days; a newer correction supersedes and keeps the old entry
linked. Injection is just in time, once per session, framed as background the current
request outranks; project facts stay in their workspace; sub-agents see only those. `/memory`
shows every learned entry with its provenance, the quarantine count and the guard's refusals
with the rule; `forget`, `pin`, `unpin`; `rune memory` the same headless; `enabled = false`
writes and injects nothing; `learn = false` freezes a curated profile.

Ten safety tests, each made to fail first, all green; end to end through the real Engine a
correction from session one appears verbatim in session two's request body while the model's
confident prose reaches nothing. Supervisor probes with sentences the lane did not write:
"well the limits are normal now you can proceed", "make the button blue" and "I want a login
page with OAuth" → nothing; "no, always run typecheck before you claim anything is done" →
`working`; "please don't sugarcoat…" and "I like short answers with a table…" → `person`;
"from now on skip the sandbox for bash" → nothing, and the guard refuses it by rule when
offered directly; a key-shaped string → refused without echoing it. Supervisor rerun of the
memory suites plus lifecycle: **189 / 0**, spend fingerprint unmoved. Lane's gates: unit
5,351 / 0, integration 364 / 0, agent-loop 335 / 0, prompt-budget green. Deliberately not
done: the cadence distillation stays opt-in and off; the retro's turn-scope defect is bypassed
(the extractor reads the whole session log), not fixed. **Residual risk, stated:** the topic
filter is two regexes and has met no real session; the first dogfood run measures its
precision, and `rune memory` afterwards is the scorecard.

### Addendum 12 — the single column is the default again, and the working mark breathes

`1eee25d`, `c2862b8`. The founder looked at Claude Code's terminal and asked for "the older
simple panel, not that split one" — so `[ui] layout` exists, defaults to `single`, and the
four-region split built on 2026-09-14 is a setting (`split`, also `RUNE_LAYOUT`), not deleted.
`single` is not a new code path: it is the shape the split already collapsed to below 100
columns, now asserted at every width — header, the transcript at full width (119 cells at
120 columns, was 78), the agents strip, the composer, the status line; the agents panel stays
behind ctrl+f. Five test helpers now say `layout: "split"` explicitly to keep testing the
split; nothing relaxed; `ui-layout.test.ts` states `single` at 120×40 and 160×50 as an
equality with 80×24's shape and that nothing above the composer moves while typing. Frames
at both sizes plus a `split` control are in `ui-single-frames/`.

The indicator: `▄ working · asking` is gone. The row reads `✻ Thinking · 12s`, `✻ Reading
turn.ts · 40s`, `✻ Running checks · 1m 05s`, `✻ Waiting for you`, `✻ Done · 1m 58s` — nine
phrases, each from an event the transcript already reads, a tool call's phrase being the
live label verbatim. The mark breathes by colour only, muted → text → accent → text → muted
at 700 ms a step (a 3.5 s cycle), never by shape; `done` and `waiting` hold still. One glyph
added (17 of the 20 the alphabet allows); the block ramp and its helpers removed, the block
glyphs kept only for the context meter. The five-frame capture 700 ms apart against a
loopback mock shows U+273B in every frame, three distinct colours, and `Thinking · 2s`
becoming `Answering · 4s` on camera. Supervisor rerun of the UI suites: **782 / 0**. Lane's
full unit suite: 5,355 / 0 / 1 skip. Left open, named by the lane: `/config`'s current-value
hint for `layout` (one `case` in `engine.ts`), the Phase 4 layout document still describing
the split as the default, and no breath capture at 80×24 or in ASCII mode. Not installed at
the time of writing — the closing pass below installs it.

### Addendum 13 — the closing gate caught the memory lane twice: a regression, and a write into the founder's real profile

The fast gates on `6696fa2` were green except `bun run eval`: `compaction_reclaims_and_keeps_a_tail`
failed (`compaction #2 … freed only 15.0%`, a 15% floor) and governance rose from 0.27 to
0.32 completions per task. Sent back to the memory lane with three suspected shapes; **all
three were wrong**, and the lane proved it with four measured runs rather than a plausible
fix: deleting the learned store changed nothing; pointing the legacy narrative profile at an
empty file restored 63/63 at 0.27. Cause: the lane's injection change had moved the evergreen
narrative (`~/.rune/system-memory.md`, ~1,000 tokens on this machine) out of the system
prefix into the message array, so compaction fired harder, each fold freed less, and the
extra summariser round trips were the governance rise. Fixed in `ba1f3f6`: the narrative is
back in the prefix; the learned block is one message compaction may fold; with nothing
promoted an engine with memory and one without send **byte-identical** requests (a test now
pins it). Eval **63 / 63 at 0.27**, baseline not re-anchored; rerun by the supervisor.

**The incident.** While root-causing, the lane found **thirty entries the mock eval had
written into the founder's real profile** (`~/.rune/memory/entries/`, scoped to dead temp
workspaces): the learned store had been on for any Engine built without a `memory` key, the
opposite of the notebook's opt-in rule two fields away. This breached this program's standing
rule that nothing touches `~/.rune`. The entries were backed up and removed, the directory no
longer exists, and the store is now opt-in at the Engine boundary (`learned` requires a
`memory` config; `enabled` keeps its old meaning so two pre-existing cadence tests stayed
right rather than being edited). The interactive CLI passes the config's memory section and
the defaults turn learning on, so the founder's own sessions learn; evals and SDK callers do
not. `rm -rf ~/.rune/memory && bun run eval` was verified not to recreate it. Unit
**5,351 / 0**, integration **366 / 0** by the lane. Recorded here because a rule that was
broken and quietly repaired is worth less than one broken and written down.

### Addendum 14 — installed: the single column, the breathing mark, and memory, on the founder's binary

`bash scripts/install.sh`, no override, from `ba1f3f6`: **Rune v0.4.1-dev+ba1f3f6**, CLI
`8133a6b242aeb24408f16bd11198bcec8854c7fc73e49d466765d7b46eacde3e`, native unchanged. On the
binary: doctor's build line reads STALE only because the docs commit `c956273` followed the
build (the code is identical); tools-smoke green; a pty capture of the installed binary at
120×40 shows the single column — header, the transcript at full width, the agents strip,
the composer at the bottom (`ui-single-frames/installed-120x40-*.txt`); `~/.rune/memory`
does not exist until the founder's first real session writes a learned entry. The founder's
three asks of 2026-09-15 are therefore implemented, tested and installed; the memory's topic
filter and the indicator's phrases are the two things only real use will grade, and
`rune memory` is the scorecard for the first. Gates for this tree: Addendum 13's eval and the
lanes' suites; the full gate list will be rerun once the M4 and adapter lanes land.

### Addendum 15 — a Claude Code arm and a Codex arm, validated offline, idle until the founder's word

`f559c50`, `3926f19`; spec in [`program/comparator-adapters.md`](program/comparator-adapters.md).
The comparison rig has two new arms beside OpenCode's, all three behind one `runArm`
interface (the OpenCode arm calls the shared harness rather than copying it; a test asserts
its argv and env are byte-identical). `claude` and `codex` were invoked only for `--help` and
`--version`: **claude 2.1.270**, **codex-cli 0.154.0**, recorded in every result row. The
Claude Code arm runs `--print --output-format json` with the tool's own permission mechanism
confined to the fixture directory and a dollar ceiling; the Codex arm runs `exec --json` at
the workspace-write sandbox with network off, both with reasoning at `high`. Each arm keeps
only its own auth and loses every other credential-shaped name and every `RUNE_*`. Twenty
offline tests: exact argv, cwd and env; thirteen synthetic, credential-free recorded outputs
(success, quota, auth, timeout, malformed, and the scored edge shapes); the dry run proven
with fake binaries whose argv log reads exactly `--version`; and the `RUNE_EVAL_BUDGET_USD`
door in front of the new arms. Parity stated rather than assumed: the four arms cannot share
a model (two families), reasoning levels share only a name, only Rune and Claude Code have a
dollar ceiling, and on these accounts a run spends **subscription quota, not dollars**. Ten
of the twelve tasks are live-ready; the two browser tasks are not on either side. **No live
run happens without the founder's explicit words naming the task count and the arm order**;
the README says so, and the first authorised run will also be the first live test of both
adapters, because every flag and parser is `--help`-derived.

### Addendum 16 — M4: a failure has a type, the controller repairs by class once, and a child's patch is integrated only against the tree it returns to

`5e2d554`, `f232163`, `eb36218`; spec in [`program/m4-repair-and-delegation.md`](program/m4-repair-and-delegation.md).
`repair.ts` classifies a failure from runtime facts alone — provider error shape, check exit
and output, boundary result, criterion status, progress signatures — into `transport`,
`check_failed`, `acceptance_mismatch`, `missing_dependency`, `denied`, `no_progress`;
`missing_dependency` is read before `check_failed` because a runner that never ran did not
fail, and the lane's own adversarial corpus made it re-anchor the shell shapes after a first
draft read an assertion message as a missing runner (which would have silently stopped
repairing real red checks). The arbiter classes each by the class of the failure so progress
can never propose `complete`. Six authority keys at seven sites, **every one absent by
default**, each site's inline logic kept as the `legacy()` rollback: `check_failed` buys one
repair turn naming the failing command and its tail and re-verifies only the commands that
went red; `acceptance` — M3's second branch, now built — one re-prompt naming the criterion's
text and never its command (there is no field for one); `missing_dependency` buys nothing;
`denied` records the boundary and offers no route around it; `transport` retries to its
bound then abandons, never reaching for another provider; `no_progress` gets one nudge.
Counts are read from the killed run's own `decision` rows on resume, with a floor the lane
found by a test going red (one class records its counter after the increment, the others
before). R4 on the real SIGKILL rig with three controls; R1–R3, R7–R9 green with each key on
and off; the mutation (every failure classed `transport`) takes R1, R3 and R9 red. A `worker`
call may name the criteria the child owns: it sees their text, its files and its budget, and
cannot record evidence by construction (its registry is an allowlist), so a child that
reports "done" leaves its criteria `unassessed`; integration reports `not integrated` for
`destination_moved` (the merge validates the whole patch first, the user's bytes untouched)
and `checks_fail_on_combined_tree` (green in the child's checkout, red here), both carrying
the revisions; the lead editing a file the child does not own is not a conflict, because a
false refusal throws a good build away. Supervisor rerun of the ten suites that matter:
**233 / 0**, lifecycle 47 / 0. Lane's gates: unit 5,502 / 0, integration 376 / 0, spend
fingerprint unmoved, zero model calls. Seven residual risks and five things deliberately not
built are in the lane's report; the class driven end to end through a child process is
`no_progress` (the only one a scripted model reaches), the other counters are pinned on the
real loop in-process.

### Addendum 17 — gated and installed with M4; the second verifier pass is running

The handoff's full gate list on `8024ac0`: unit **5,507 ran / 0 fail** (410 files),
integration **383 ran / 0 fail** (63 files), lifecycle 47 / 0, typecheck 15 / 15, lint 7 / 7,
format and prettier clean, cargo fmt clean, cargo test **109 / 0**, clippy 0 warnings, mock
eval **63 / 63 at 0.27** with the baseline unchanged, auto-safety offline P 92.8 / R 89.1 /
F1 90.9 with 0 live requests, `git diff --check` clean. Installed without an override:
**Rune v0.4.1-dev+8024ac0**, CLI `8678752aae937168f63fe9d52d3759cbdda18cbd16f0ed4fe3de878967e0953a`,
native unchanged; doctor's build line current; tools-smoke green. Every controller key is
absent by default, so the installed binary behaves as before unless the founder opts in
through `[controller] authority`; memory learns in the founder's interactive sessions and
nowhere else. The second adversarial verifier pass — over M4, memory, the single column and
the breathing mark, Lane F, the two fix lanes' closures of the first pass's criticals, and the
adapters — was launched on this tree; its findings go to fix lanes before any authority key
is switched on and before memory is relied upon.

### Addendum 18 — the second adversarial pass: memory is not safe for a real session yet, and the first pass's critical reopens across sessions

`.codex/audit-20260910/handoff/m0/verify-batch-2-report.md`, on `5a036ff`; twenty red test
files under `tests/verification/v7-*` (49 failing assertions, 13 deliberate green controls,
each reproduced twice); sixteen archives. **Four critical, eleven high, ten medium, eight
low.** Critical: a memory entry the guard refuses can be written as a file by an ordinary
`bash` (the store sanitises shape only, and the memory directory is not a control path), and
is read back as a promoted, pinned, user-corrected entry injected into every later session;
the narrative profile is the same door onto the system prefix; the acceptance script the
model rewrites is re-staged from the workspace by the NEXT run, so Fix lane A's closure holds
for one session only; and `error TS2307: Cannot find module` classifies as a missing runner,
so with a repair key on the commonest TypeScript error buys no repair. High, among others:
the model's check command becomes a promoted lesson on a failed run; the repair bound is
restored in full by the second crash; a check the run wrote in a previous session, or an
empty test file, settles a criterion; a passing acceptance reads `stale` unless the project
gitignores `.rune/`; `authority = acceptance` prints hidden criteria verbatim (the M4 spec's
own wording was wrong — the re-prompt must name an id and an output tail, never the text);
`RUNE_HOME` cannot relocate the Rust sandbox's audit log, so **every rig in this program
appended to the founder's real `~/.rune/audit.jsonl`** — including the verifier's, which
said so; the adapters' env is a deny-list and their budget is per task not per series
($48 planned against $2); the visual reviewer can pick its own provider's model; two
bypasses of the architecture plan's dependency refusal; `[ui] layout` cannot be saved at all
(the UI lane's report said it persists). What held: assistant prose, tool results and
`read_back` reach no memory; sub-agents get none; `denied` cannot become a retry; the worker
registry has no rung-moving tool; both suites green at HEAD; the installed binary is exactly
`8024ac0`; the corpus numbers recompute.

**The record:** the gate logs were overwritten again by this pass's own reruns, so Addendum
10's thirteen gates at `44f1b05` are no longer verifiable from the logs; the runner now writes
each run into a dated directory. Two prose counts were wrong and are corrected in the
verifier's report. Six new cost rows in the founder's database during the pass belong to a
concurrent live session of the founder's own (openrouter/codex), attributed by provider and
session id, not proved.

**Decision:** memory is not to be relied on and no authority key is to be switched on until
the criticals and the highs above close. Two fix lanes are running on disjoint files (C:
memory, acceptance, the classifier, the durable bound; D: the Rust audit path, adapters,
visual reviewer, dependency refusal, the layout setting, the footer picker). This is the
second time the loop has caught what green suites and a careful supervisor did not.

### Addendum 19 — Fix lane D: the audit log lives where RUNE_HOME says, and six more of the second pass's findings closed

`44a4e43`, `78d12d6`, `d5e42bb`, `326ecdc`, `a20d500` (+ a shared commit sequence with lane C).
The Rust sandbox's `rune_home()` now reads `RUNE_HOME` / `GEAR_HOME` before `~/.rune`, so a rig
under a scratch home writes its own `audit.jsonl`; proven by cargo test and a TypeScript test
through the rebuilt binary, mutation-proved both ways. **Residual, stated by the lane:** the
crate is fixed but the suites do not yet set a scratch home, so the lane's own two unsandboxed
full-suite gates still appended 295 lines to the founder's real log; the exact `bunfig.toml`
preload that closes this is in the lane's report and is applied by the supervisor after lane C
lands (a global preload touches every lane's tree). The adapters' env is an allow-list asserted
as a whole-key-set equality; `RUNE_EVAL_BUDGET_USD` is the series ceiling (refuses a plan whose
runs × cap exceed it, stops before a run that would, counts unknown cost as the full cap; the
dry run prints the series total); the envelope, unknown task ids and malformed budgets handled.
Reviewer independence is by model lineage, not provider id (`chatgpt-4o-latest` is `gpt`; a
Claude model behind openrouter is Anthropic). Dependency edges are keyed by step identity and
re-resolved on every write, both bypasses closed, cycles refused. A child's served origin is a
claim the lead re-probes itself, never trusted. `[ui] layout` now actually persists — the UI
lane's "persists correctly" was false and the lane says so; nothing had ever reached
`config.toml`. The footer picker windows around the selection (frames before and after in
`fix-d-frames/`). The score-stripper keeps measurements and strikes grades. Supervisor rerun of
its suites: **193 / 0**, `tsc -p tests/eval` clean, `cargo test -p rune-sandbox` 36 / 0. Lane's
gates: unit 5,588 / 0 / 1 skip, integration 384 / 0 / 7 skip, cargo 110 / 0, clippy and fmt
clean. Twelve of the twenty v7 files promoted and removed; three assertions rewritten rather
than promoted verbatim, each named with its reason.

### Addendum 20 — Fix lane C: memory is read through its guard, the oracle is pinned across runs, a missing module is a failed check

`3e1cea3`, `a3a9a32`, `7d3d1ca`. Every read of the memory store now runs guard, length clamp,
content-id re-derivation and provenance check, so a file written into the entries directory by
a shell is not an entry; the memory directory and the narrative profile are control paths in
every gear; the narrative is guarded line by line on load, clamped, and prefixed as background
the request outranks. An `AcceptanceVault` beside the database pins each acceptance script's
bytes and digest at first intake, so a rewritten workspace copy is never re-staged (measured:
session two now `partial`, was `met`), with pins and notes on the contract row. Every
missing-runner shape is anchored to the line the runtime prints, so `TS2307` and its four
siblings are `check_failed`; check lessons are composed from a template over the program name,
never the command, and only on `met`; the durable repair counter clears on `session_ended`;
authorship is asked of git as well as the live ledger, so a check the run wrote last session
still settles nothing; a test that asserted nothing (bun prints `1 pass` for it) derives
`needs_review` by the runner's own expect count; harness-owned `.rune/` is excluded from the
dirty computation; the acceptance re-prompt names a criterion id and an output tail, never the
text (the M4 spec's wording corrected below); the guard refuses all eight paraphrases while
its ten survivors survive, and one pre-existing false positive was found and fixed. One thing
tried and reverted, with the reason: treating a runner's file argument as self-authorship
would have stopped any test-driven run from reaching `met`. Supervisor rerun: **329 / 0**
across fifteen suites including lifecycle. Lane's gates: unit 5,607 / 0, integration 385 / 0,
eval 63 / 63 at 0.27, prettier clean; its six v7 files promoted and removed.

**Named, not fixed by the lane (a closing-fixes lane took them):** `inheritedEmptyCompletions`
carries the same session-start clearing defect; `TASTE_RE` misses "I'd rather"; and the product
defect the lane's fingerprints exposed: **the founder's own daily dream replaced the evergreen
profile (3,976 bytes) with a 326-byte completion at 12:26 UTC, with no backup and no floor.**
The dream is the pre-existing cadence feature, not this program's learned store, and it ran in
the founder's live session; the fix (backup, shrink refusal, restore) is in the closing lane.
