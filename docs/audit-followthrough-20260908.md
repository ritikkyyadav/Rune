# Audit follow-through — 2026-09-08–09

The eight audit findings now have implementations and regression coverage. That is an
engineering result, not proof that Rune matches OpenCode's cost, speed or capability.
The first completed live pilot found Rune slower and more expensive. Later development,
including the merged Phase 12 and Phase 13.1 changes, requires fresh measurements.

Work began at `8d7c89f` with an extensive shared working patch. The checkout subsequently
advanced through `5b795e4` to `9715b6b` (0.4.0 development). Concurrent work was preserved. This report distinguishes
historical comparisons from verification of the current checkout.
Work resumed September 9 at `4f3e3a1`; the intervening provider, transport and CI changes
were preserved. The checkout subsequently advanced to `ae1847c` (0.4.1). The follow-up below
includes the browser sandbox and command-evidence fixes found by the live pilots.

## Runtime changes and practical limits

| Area                            | Result                                                                                                                                                                                                                                                                                                                                                                                                         | Limit                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto coordination               | Bounded reviewer concurrency, short burst batching, exact duplicate co-review, and separation at user/write epochs reduce duplicate review work. Ordinary actions can proceed under mechanical checks when the background queue is full, with a `supervisor_skipped` receipt.                                                                                                                                  | A skipped background review is visible but was not performed. Offline safety tests do not establish live reviewer accuracy.                                                                                                                                          |
| Workers and containment         | Dispatch snapshots include dirty tracked and untracked source plus installed dependencies. Native verification has timeouts and process cleanup. Integration checks the lead's files against the dispatch snapshot before applying owned changes, preserves the index, and retains recoverable work on conflict. A requested contained background launch refuses both a missing and an unset native tool path. | Worktree creation failure can use an explicitly reported shared edit-only worker; partial snapshots refuse dispatch. Explicit host modes remain available under the configured permission policy. This is not VM isolation or a fully atomic filesystem transaction. |
| Completion evidence             | Implementation needs writes; verification needs a passing check after the latest write. Investigations can report a negative result. Missing evidence and unresolved UI checks remain visible in task progress.                                                                                                                                                                                                | The step classifier uses declared kinds and action wording. Mechanical evidence cannot determine whether the implementation solves every part of the user's intent.                                                                                                  |
| Child continuity                | `task_id` resumes a scoped child checkpoint across parent restart. Provider/model, workspace and ownership are pinned; concurrent resumes are leased; retained worker branches can be recovered.                                                                                                                                                                                                               | Checkpoints occur at tool boundaries, not mid-request. The 256 KiB transcript size is a target: the original prompt and final opaque exchange may exceed it.                                                                                                         |
| Frontend verification           | Built-in browser receipts tie screenshots, desktop/mobile viewports and interaction to a served workspace preview and current code revision. Only images actually delivered to the model count; later edits invalidate receipts.                                                                                                                                                                               | A page fetch is partial evidence and cannot certify visual review. External Playwright scripts do not yet produce the complete trusted receipt sequence. Passing functional browser checks is not an aesthetic assessment.                                           |
| Controlled lessons              | Include/withhold assignment, fixed 20-outcome arms, confidence intervals, cost per verified success, revision reset and cohort exclusions gate promotion. Unpriced and mixed-route sessions do not establish learning lift.                                                                                                                                                                                    | No measured controlled learning benefit is claimed. External pristine/evolved benchmark pairs have not run.                                                                                                                                                          |
| Spend admission                 | Shared request reservations cover lead, delegates and helpers, including fallback attempts. Missing model pricing refuses a capped request before inference. `/config budget 0` explicitly removes the cap.                                                                                                                                                                                                    | Estimated reservations and provider usage are not an invoice guarantee; in-flight requests can overshoot. Search and infrastructure charges are separate.                                                                                                            |
| Configuration and work overhead | `/config` offers model, API/internet keys, browser, budgets, concurrency and other settings without a model call. Settings use one validator and persist across restart. The advertised evidence gate now has a live handler and displays its effective policy. Clear local tasks can skip unnecessary planning and bookkeeping tool calls.                                                                    | Broad work still needs planning and evidence. The Settings picker now accounts for the real footer height and its footnote so selection stays visible on a 24-row terminal.                                                                                          |

Compaction persists the reduced working set across Engine restart, preserves opaque provider
blocks, accounts for fixed prompt overhead, prunes large old tool results incrementally, and
avoids repeatedly compacting the same unchanged set. The mock reclamation check was corrected
to use actual before/after checkpoint tokens: its old denominator omitted newly received tool
results. The 25% reclamation threshold and other fact/tail checks were retained. This is a
measurement correction, not an unchanged instrument or a new baseline.

Phase 12 additionally introduced completion-role and prompt-composition meters and an opt-in
helper route. See [run economics](run-economics.md) and [program status](program/status.md).
Byte composition is a useful proxy for token overhead, not proof that their ratios are identical.

## Live comparison evidence

The pilot uses isolated fixtures and profiles, the same primary model (`gpt-5.6-sol`) with
high reasoning, independent acceptance checks, bounded process trees and recorded provenance.
OpenCode was 1.18.23. Costs below are **estimated list-equivalent token costs**, normalized by
Rune's versioned table, including recorded helpers and children. They are not subscription
invoices. One sample per task is too small for a reliable general ranking.

### Pilot B — 2026-09-06, before local-task overhead reduction

| Task                         | Rune completed    | Rune time / estimate | OpenCode completed | OpenCode time / estimate |
| ---------------------------- | ----------------- | -------------------- | ------------------ | ------------------------ |
| CSV state machine            | Yes               | 156.1 s / $0.2529    | Yes                | 99.4 s / $0.0653         |
| Working-tree API integration | Yes               | 164.6 s / $0.2675    | Yes                | 71.1 s / $0.0493         |
| Dependent migration          | No: 240 s timeout | 240.0 s / $0.3401    | Yes                | 132.0 s / $0.1005        |

All three Rune artifacts passed acceptance, but the migration did not finish within the run
limit. Completed runs were **Rune 2/3, OpenCode 3/3**. On the two mutually completed tasks,
Rune used approximately 3.9–5.4 times the estimated cost and 1.6–2.3 times the wall time.
These results do not establish parity. The simple CSV run exposed unnecessary planning,
bookkeeping and unavailable-LSP attempts; the task-scaled guidance addresses that mechanism.

Aggregate source record: [Pilot B](evidence/comparison-20260906-b.json). The prior unsupported
model probe (Pilot A) performed no valid comparison and is not included in these scores.

### Pilot C — 2026-09-07, frontend, interrupted

The compiled Rune artifact was `33025ce8db824f2959d6deccb24b849364c5ad24bb9ca52057b0bdd3df6fd73e`.
Rune consumed eight model requests before a quota error; OpenCode encountered quota before
any model usage. The CSV rerun therefore never started. This is an infrastructure-interrupted
attempt, not a frontend head-to-head result.

The original frontend grader incorrectly selected only the `textbox` role. A correctly
labelled native `type=search` field has the `searchbox` role. Selecting its required accessible
label fixes the grader without changing the task's behavioral requirements. Regrading the
unchanged Rune artifact passes search, combined filters, favorite persistence, keyboard
interaction and desktop/mobile layout checks. Human screenshot inspection still found
loading placeholders left above the cards. The run remains incomplete and visual quality
remains separate from functional acceptance.

The [original aggregate](evidence/comparison-20260907-c.json) is preserved byte-for-byte.
[Corrections and the regrade receipt](evidence/comparison-corrections-20260908.json) explain
both the grading mistake and the old `scored` field's failure to account for a mid-run quota
interruption. New runs record a sanitized infrastructure category while retaining actual usage.
Raw provider logs and databases remain private because error payloads may contain credentials.

### Pilot D — 2026-09-08, fresh CSV repeat

Both runs completed and passed independent acceptance. Rune used 12 completions, 262.8 seconds
and an estimated $0.1689. OpenCode used the same task/model/reasoning and completed in 164.2
seconds at an estimated $0.0815. [Full aggregate](evidence/comparison-20260908-d.json).

Rune's request count fell from 21 to 12 and its estimate fell from $0.2529 to $0.1689 compared
with Pilot B. Its wall time increased. This is a single repeat across several changes and a
different provider time window, not an isolated causal A/B. Rune still used about twice
OpenCode's estimated cost on this task; no price or speed parity is claimed.

The new meter attributes 11 completions to primary work and one to supervision, with a 72%
cache-read ratio. The reviewer represented approximately $0.0028 of the estimate. The larger
remaining overhead was the advertised schemas and doctrine, not background review alone.

The first deferral change used the existing `load_tools` mechanism for `interactive_dashboard`
and `update_config`. Their names and summaries stay visible, and loading restores the exact
full schemas. Direct `/config` requires no loading or inference. An offline Engine probe reduced advertised
schema bytes from **41,875 to 30,022 (28.3%)** without removing capabilities. This measures schema
bytes, not total tokens, wall time or invoice savings. The probe and its configuration are
[recorded separately](evidence/schema-measurement-20260908.json). Pilot D predates this
deferral change and the last settings/background-launch fixes.

The subsequent Phase 13.1 merge extends deferral to workers and other specialist tools,
warms tools after observed calls, and supplies selected doctrine sections when needed.
`Plan and track` remains in every request after the separate live development run exposed
malformed planning calls when it was gated. The two-tool byte measurement above is a historical
milestone, not a measurement of the final schema set. See [program status](program/status.md)
for that development lane's separate measurements.

### Pilot E — 2026-09-08, morning frontend attempt, interrupted

This attempt ran from 07:52 to 07:58 UTC, before the user's later notice that limits were
restored. Rune used five recorded requests, 343.7 seconds and an estimated $0.1209 before
a provider quota error. The unchanged partial artifact passes the independent browser
acceptance checks. Desktop/mobile screenshots no longer contain Pilot C's loading placeholders,
but the agent did not complete its own verification. OpenCode was not started after the
infrastructure interruption. This remains unscored; it is not a completed comparison or
evidence of the account's later availability. [Original aggregate](evidence/comparison-20260908-e.json).

### Pilot F — 2026-09-08, evening frontend attempt

Rune reached the 600-second timeout after 20 recorded requests and an estimated $0.4538.
Its artifact passed the independent browser checks. The agent's own Chromium launch crashed
inside the native macOS sandbox, however, and Auto refused the unsandboxed retry. This is a
real incomplete run, not a quota exclusion or a completed success. The observed roles were
15 primary, one supervisor and four classifier requests.

The process began the OpenCode arm, but its final result was not observed before the interruption.
At resumption the temporary run directory had been cleared. The [partial record](evidence/comparison-20260908-f-partial.json)
explicitly reconstructs only the values already observed in tool output; it is not an original
aggregate and supplies no OpenCode outcome. New private logs are kept under the ignored
`.codex/audit-20260909` directory so temporary-directory cleanup does not erase them.

The separate development lane also reports a [paired free-route series](evidence/comparison-live-20260908.md)
on `gpt-oss:120b`. Its different model, route and repetitions must not be pooled with these
`gpt-5.6-sol` pilots into an overall harness score.

### Pilot G — 2026-09-09, frontend with the sandbox fix

Rune's frozen installed build launched Chromium inside containment, passed its own browser
checks, and delivered desktop/mobile screenshots to the model. The independent acceptance
also passed. The source artifact remained unchanged during the comparison. Rune nevertheless
hit the 600.1-second deadline after 25 usage entries and an estimated **$0.6409**; this remains
an incomplete run. Screenshot inspection found a coherent cream/green project index with
working controls and no loading placeholders, but this is not a general design-quality score.

The trace exposed a coordination defect: `node browser-test.mjs` returned exit 0, but the
command classifier did not recognize the script as verification. `todo_write` therefore
reported no passing check, causing repeated attempts to satisfy the ledger. This prompted
the command-evidence fix below. The cost figure is not retroactively treated as a success.

OpenCode produced three usage entries, an estimated $0.0245 and no implementation patch. Its
recorded timeout arrived after **1,131.6 seconds despite the configured 600-second limit**.
The cause of the delayed deadline was not established. That arm cannot support a fair timing
or completion comparison; the pair is excluded from competitive conclusions. The original
[Pilot G aggregate](evidence/comparison-20260909-g.json) is preserved, including its original
`scored` fields. [Separate qualifications](evidence/comparison-20260909-g-notes.json) record
the timer anomaly instead of silently editing the result. The frozen CLI/native hashes are
recorded in the morning verification manifest.

## Verification and delivery — September 8

Fresh checks at `9715b6b` plus this pass's pricing correction:

| Check                          | Result                            | Qualification                                                                                                                  |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unit suite                     | 4,232 passed; 0 failed; 1 skipped | The skip needs a case-sensitive filesystem.                                                                                    |
| Integration suite              | 130 passed; 0 failed; 5 skipped   | The skips need Go/Java toolchains absent on this machine. Real macOS containment, engine restart and settings persistence ran. |
| Typecheck                      | 14 tasks passed, cache bypassed   | Repeated after the pricing correction.                                                                                         |
| Lint and repository formatting | Passed                            | Seven lint tasks, cache bypassed.                                                                                              |
| Offline evaluations            | 63/63 passed                      | Governance 0.26 completions/task; baseline unchanged. These use a mock provider.                                               |
| Rust suite                     | 94 passed; 0 failed               | Run earlier on September 8; Rust sources, manifests and lockfile are unchanged at this revision.                               |

The initial current unit run exposed one new catalog entry missing from `MODEL_PRICING`:
`nvidia/nemotron-3-super-120b-a12b:free`. The explicit zero-rate entry now matches the
[provider's published rate](https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free),
verified September 8. This prevents a selected free model being refused as unpriced under
a session cap. The existing coverage assertion caught the defect; the full unit suite
passed after the correction.

The earlier offline Auto corpus passed its unchanged baseline (227 cases, precision 90.0%,
recall 89.1%, F1 89.6%). Thirty-eight labels remain inferred and need review; these numbers do
not establish the live model reviewer's accuracy. The three Harbor interface tests ran against
0.22.0, and the comparison TypeScript entrypoints passed their separate strict typecheck.

The historical 3,946-unit/115-integration result belongs to the earlier 0.3.0 working build;
it is not validation of the later 0.4.0 checkout.

`bash scripts/install.sh` rebuilt and atomically installed **Rune v0.4.0-dev+9715b6b**, with
the pricing correction in the working tree. No guard override was used. SHA-256:

- CLI: `dcd380f39be23d77e666dc8e8f5e1b1ab34d1b2abf61ab7cf87f8d8051501478`
- Native tools: `1362fd5eaecba42a7412e002b07f793ccc8e274239f9f4ebf791a46b7365c666`

A fresh minimal shell resolves `~/.rune/bin/rune`, reports the expected version/current build,
and passes native write/read/edit/bash round trips. A normal login shell resolves the
compatible `~/.alan/bin/rune` path to the same version. Doctor identifies the intentionally
stripped minimal PATH's missing `npx`; the normal login environment has no misconfigured MCP
entries. This checks configuration, not a live MCP connection. Historical provider retirement
records remain diagnostic output, not fresh provider availability probes.

The installed TUI was exercised in a real 80×24 PTY with an isolated profile. The Settings
title and selected first row remain visible; existing budget/concurrency values appear;
changing the evidence gate persists after a new process starts; both processes exit cleanly.
The profile records **zero model usage events**. The [verification manifest](evidence/verification-20260908.json)
contains build provenance, gate results and private-log hashes.

## September 9 morning: browser sandbox fix and delivery

The browser failure was reproduced independently of any model. Both foreground and background
launch profiles crashed Chromium. Two narrow macOS grants fix startup: opening
`RootDomainUserClient` for the power observer and registering the PID-qualified
`org.chromium.Chromium.MachPortRendezvousServer` service. The power-client allowance also appears
in [Chromium's own renderer policy](https://chromium.googlesource.com/chromium/src/%2B/refs/tags/141.0.7360.13/sandbox/policy/mac/renderer.sb).
There is no general IOKit or Mach-registration allowance, and file/network rules are unchanged.

The real [browser regression](../tests/integration/browser-sandbox.test.ts) fails against the
previous installed native artifact and passes against the rebuilt one. It serves a local page,
clicks its button, captures desktop/mobile screenshots, and verifies that a synthetic secret
read, sibling write, protected workspace write and secret environment variable remain unavailable.
It exercises both shell execution paths. This verifies Chromium on this macOS machine, not
every browser/OS combination or VM-grade isolation.

Morning checks at `4f3e3a1` plus the sandbox change:

- **4,252 unit tests passed**, zero failed, one case-sensitive-filesystem skip.
- **137 integration tests passed**, zero failed, five missing Go/Java-toolchain skips.
  The Chromium tests were explicitly enabled with the existing Playwright runtime.
- **94 Rust tests passed**; Rust formatting and the new integration test's separate strict
  TypeScript check passed.
- **14 typecheck tasks and seven lint tasks passed**, with caches bypassed.
- **63/63 offline evaluations passed**, governance 0.26 completions/task, baseline unchanged.

The guarded installer rebuilt and delivered **Rune v0.4.0-dev+4f3e3a1** with the working sandbox
fix, without an override. Both browser tests passed again against the installed native binary.
The installed 80×24 TUI also passes the settings/edit/restart/clean-exit flow, with zero model
usage events. This delivery supersedes the September 8 binary above.

- CLI SHA-256: `a0014668e3bf6591db8830de9141a6813f7aadb4d002c43aef03573c8f8dfe28`
- Native tools SHA-256: `7d9171836f3e70dc96e32e19acd63fca279ffca2f4946f583f16c842b44d26f6`

The [September 9 verification manifest](evidence/verification-20260909.json) records both
artifacts, before/after browser checks, the settings receipt and gate-log hashes. Unlike the
September 8 temporary logs, these private receipts are retained in the checkout's ignored
audit directory.

## September 9 follow-up: consistent command evidence

The same command classifier now recognizes executed test/check scripts, including Node,
Bun, Python and shell entry points, across plan steps, citations, retro summaries and the TUI.
It reads command positions and quoting instead of looking for any occurrence of `test`.
An echoed command, an inspected test file, a pipe or an `|| true` fallback cannot become a
passing check just because the final shell process returned zero. Conventional script names
are still a heuristic for intent; they do not prove the script contains adequate assertions.
Unsupported shell syntax remains unclassified.

The Engine's separate citation log and live/replayed notebook observations now share the
plan's child-exit-code verdict. Previously, a failing native command could be cited as observed
and learned as working because the outer tool's `success` only meant it launched. A native
failure or timeout now stays a failure through these paths, with its concrete error summary.

The [Engine regression](../tests/integration/engine-command-evidence.test.ts) runs real native
shell checks through a scripted provider, then reads the persisted plan and retro. It verifies
passing custom scripts, failed process exits, writes after a passing check, and `echo test`.
Before the fix, custom checks had no receipt and failed or echoed checks could receive a positive
citation. All four regression scenarios now pass. Separate
command-shape and replay tests cover quoting, package runners, redirection, stale checks and
masked exits. These deterministic checks consume no paid model calls.

### Delivered and verified on `ae1847c` plus the working fixes

- **4,309 unit tests passed**, zero failed, one case-sensitive-filesystem skip.
- **141 integration tests passed**, zero failed, five missing Go/Java-toolchain skips.
  Both actual Chromium sandbox tests were explicitly enabled.
- **94 Rust tests passed**; **14 typecheck tasks and seven lint tasks passed** without cache.
  Repository formatting, Rust formatting and the new tests' standalone strict TypeScript check passed.
- **63/63 mock evaluations passed**, governance 0.26 completions/task, baseline unchanged.

The guarded installer delivered **Rune v0.4.1-dev+ae1847c** without an override. A fresh minimal
shell resolves the installed launcher, reports a current build, and passes native write/read/edit/bash
round trips. Its deliberately minimal PATH still lacks `npx`, which doctor correctly reports;
this is not a fully green MCP diagnostic or a live connector test.

- CLI SHA-256: `1321e88060a9c60d3f943393b819fe83ea566fd0544866eb775c046a6b8ed791`
- Native tools SHA-256: `4aedd8ed0b215ff04a308d884d2d6caa75684f43d4006ccac78414a349e3c287`

Both Chromium regressions pass against that installed native binary. The installed 80×24 TUI
again shows the Settings title/selection, preserves budget/concurrency, saves the evidence gate,
restores it in a new process and exits cleanly, with **zero model usage events**. The
[final verification manifest](evidence/verification-20260909-final.json) records this delivery
separately from the morning build used for Pilot G.

A [targeted live verification](evidence/verification-live-20260909.json) then used the installed
CLI on a copy of Pilot G's existing frontend, with the same `gpt-5.6-sol` primary model and high
reasoning. It ran the browser test **once**, inside containment, read both screenshot attachments,
recorded the successful citation and closed the step with one passing check and no unproven flag.
It finished normally in **53.4 seconds**, using **six primary calls** and an estimated **$0.0647**.
The implementation, data and test script remained byte-identical. This was an explicitly
instructed verification smoke, not a new build, a paired benchmark, or evidence of an overall
speed/cost improvement. It closes the observed receipt-loss regression without rewriting Pilot G's timeout.

## Remaining evidence before a competitive claim

- Repeated paired live tasks on the delivered version, including long-horizon restarts,
  dependent migrations, sandbox failures, real frontend review and completed-task cost.
- Official SWE-bench and Terminal-Bench results. Executable adapters and offline interface
  checks now exist; official evaluations have not run. Both adapters currently automate only
  the pristine arm. See the [reproduction guide](../tests/eval/comparison/README.md).
- A measured benefit from controlled lesson trials, not just working promotion logic.
- Linux runtime containment and release verification, and independent user/CI evidence.
  A native macOS test does not prove Linux or Windows isolation.

The license remains `LicenseRef-Proprietary` at the user's request. This audit pass did not
change repository visibility, publish a release or tag a version. Separate project release
activity is recorded in [program status](program/status.md); its publication claims are outside
this report's local verification. A public repository alone does not change its license.
