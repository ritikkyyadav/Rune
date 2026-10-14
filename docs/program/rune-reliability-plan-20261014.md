# Rune reliability plan: reaching Claude Code's floor

Proposed 14 October 2026; the founder said "proceed" the same evening. Evidence, probe script and queries: [rune-reliability-probes-20261014](../evidence/rune-reliability-probes-20261014/README.md).

**Progress.** R1 and the contract part of R0 shipped in **v1.4.2** (tag at `24e1503`, with the cost-and-latency lane), installed through `rune upgrade`; the records are the progress ledger's entries of the same date. Each later phase ships as the next 1.4 patch (1.4.3, 1.4.4, …), the founder's numbering. D3 was taken as answered by "proceed". R4, R2 and R3 wait for D1, D2 and D7, and for the evidence-based plan's Stage 1.

## How Claude Code was studied, and what "its level" means here

The request was to reverse-engineer Claude Code with REA and plan Rune up to its reliability. Claude Code was not decompiled: Anthropic's terms bar reverse engineering it and using it to build a competing product, and Rune is one. The plan does not need its source. Claude Code's reliability is written down in unusual detail: its error reference names each failure, what Claude Code does about it automatically, what the person does next, and the version where the behaviour changed. Sources used: the public documentation (fetched today), `claude --help` (2.1.299), the package layout and code signature on this Mac, and same-input probes through Claude Code's own Edit and Write tools from inside a working session.

"Claude Code's level" is therefore a specification, not a score. For each mechanism below, Claude Code's documented or observed behaviour is the expected result, and Rune passes or fails the same scenario. A "Claude Code = 100" number would need a Claude Code arm, which the Codex-only rule for benchmarks excludes. This plan does not need one.

## The finding

Claude Code is reliable mostly by refusing to guess and refusing to quit:

- its tools refuse rather than succeed wrongly;
- its transport decides by how far an answer got, and never re-sends once a tool call has completed;
- a safety block stops an action, never the run;
- its exit code says how the run ended and nothing else;
- the person can always get state back: file checkpoints, resume, and a recovery step for every named error.

Rune's record, measured today:

- **Its file tools succeed wrongly.** All 6 same-input probes silently damage the file (permissions, encoding, line endings, indentation), where Claude Code refused or kept the file intact. Each damaging call reports `success: true`.
- **Its ending never says done, and misnames its commonest failure.** Of 163 recorded runs since 14 September, 0 ended `met`. 44 ended `provider_lost`, and 39 of those 44 were Codex quota walls, not lost providers.
- **Its transport redoes work rather than resuming it.** A failure mid-answer re-streams the whole response from zero. On 12 October that cut a thinking model 10 times in 25 minutes; the fix is installed but uncommitted and has no live proof. Mac sleep is not detected.
- **The August kill chain is mostly fixed.** Since 14 September no run has ended at the loop detector or the barren breaker. What remains are 3 safety halts and 5 runs that hit the 80-turn ceiling.

One part of Claude Code's reliability cannot be copied: Claude is trained against these exact tool contracts, while Rune rents GPT-6 Sol, gpt-oss and whatever is free. That makes deterministic contracts more important for Rune, not less: rent the intelligence, own the guarantees.

## Scorecard

| #   | Mechanism                    | Claude Code 2.1.299                                                                                                                                                                                           | Rune today                                                                                                                                                                                                                                                              | Gap                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | Edit matching                | Exact string only; unique, or `replace_all`                                                                                                                                                                   | Exact, then whitespace-, then indentation-insensitive tiers. The indentation tier applied a syntax-breaking Python edit with `success: true` (P6). Loose tiers were used 3 times in 1,448 recorded edit_file and multi_edit edits (apply_patch never recorded its tier) | Critical               |
| 2   | File metadata and encoding   | Keeps mode (P1, P2); new file 644 (P3); refuses non-UTF-8 and writes nothing (P4); keeps CRLF (P5)                                                                                                            | Every write leaves mode 600 (P1–P3); a Latin-1 byte becomes U+FFFD (P4); CRLF becomes mixed (P5)                                                                                                                                                                        | Critical               |
| 3   | Edit after an outside change | Applied if `old_string` still matches exactly; the result says the file changed                                                                                                                               | Refused on any hash change; 19 of 788 edits paid a re-read                                                                                                                                                                                                              | Minor                  |
| 4   | Long commands                | 2 min default, 10 min max; a timeout moves the command to the background, output kept in a file                                                                                                               | 120 s default; a timeout SIGKILLs the process group and the work is lost                                                                                                                                                                                                | Major                  |
| 5   | Large output                 | Over ~30k chars: saved to a file, path plus 2k preview; the model reads the file                                                                                                                              | Over 30k chars: head and tail kept, middle dropped, model told to re-run                                                                                                                                                                                                | Moderate               |
| 6   | Retry before any output      | One budget: 10 tries, 529 backoff 0.5 s → 32 s, `Retry-After` honoured; TLS and policy errors not retried; opt-in watchdog waits out 429/529 when unattended                                                  | Two stacked budgets: gateway 3 retries with waits ≤ 30 s (`provider-registry.ts:118`); loop 3 consecutive errors plus a 10 min clock (`agent-loop.ts:456,491`)                                                                                                          | Moderate               |
| 7   | Failure mid-answer           | Keeps completed blocks, runs completed tool calls, never re-sends (a re-send could run a tool twice); headless asks the model to continue up to 3 times                                                       | `stream_reset`, then the whole response is re-streamed from zero (`gateway.ts:641`)                                                                                                                                                                                     | Major                  |
| 8   | Stalls                       | First-byte deadline; a stalled stream re-sent at most once, then a named end                                                                                                                                  | Per-provider watchdogs; the Codex phase fix is installed but uncommitted and unproven live                                                                                                                                                                              | Major                  |
| 9   | Computer asleep              | Detected; counted as a dropped connection and named as sleep                                                                                                                                                  | Not detected; Mac sleep has voided live runs and slow gates more than once                                                                                                                                                                                              | Moderate               |
| 10  | Usage limits                 | Distinct messages: plan limit with reset time, temporary throttle (retried), spend limit (fails at once); requests wait for the reset                                                                         | Stops rather than switching to a weaker model, and auto-resume exists; but the ending is `provider_lost` with a failed verdict, and today 13 runs in two sessions each met the same Codex wall                                                                          | Major                  |
| 11  | Context overflow             | Shrinks `max_tokens`, then compacts; a thrash detector stops auto-compaction that keeps refilling                                                                                                             | Forced compaction on overflow; no thrash guard                                                                                                                                                                                                                          | Moderate               |
| 12  | Safety block                 | Blocks the action. After 3 in a row or 20 in a session it asks the person; headless skips the action and keeps working. Reads and in-workspace edits are never reviewed; the reviewer never sees tool results | A supervisor halt ends the run (`agent-loop.ts:3722`; 3 since 14 September). The reviewer is 12–29% of a run's cost and flagged an ordinary test command on 14 October ($0.114)                                                                                         | Major (decision D1)    |
| 13  | Turn ceiling                 | None by default; `--max-turns` and `--max-budget-usd` are the person's to set                                                                                                                                 | 80 turns plus two second winds; 5 runs since 14 September ended there; evolab7's plan collapsed at the ceiling                                                                                                                                                          | Moderate (decision D7) |
| 14  | How a run ends               | Exit 0 means the loop finished, non-zero that the run failed; a `subtype` says why; SIGTERM exits 143; cost and session id on every result                                                                    | Exit 1 unless the self-verdict is `met`, which no recorded run has reached. Endings are otherwise named (10 kinds; mislabels fixed in `0ede69d`)                                                                                                                        | Critical (decision D2) |
| 15  | Resume after a crash         | A tool cut off by the crash is marked, never re-run                                                                                                                                                           | Same (`session-replay.ts:46`), and orphaned children are reaped (`engine.ts:1801`)                                                                                                                                                                                      | Parity                 |
| 16  | Undo                         | Per-prompt file checkpoints (100), separate from git, kept across resume; rewind code, conversation or both                                                                                                   | `/rewind` rolls back the conversation only; `/undo` needs opt-in git auto-commit                                                                                                                                                                                        | Moderate               |
| 17  | Transcript health            | A persistent warning when transcript writes fail                                                                                                                                                              | SQLite WAL plus busy timeout; a failed write is not surfaced                                                                                                                                                                                                            | Minor                  |
| 18  | Install, upgrade, rollback   | Versions directory behind a symlink; stable channel about a week behind that skips regressions; `minimumVersion`; `claude install <version>`; Developer-ID signed, hardened runtime                           | One slot; ad-hoc signature (a copied binary is SIGKILLed, exit 137); 250 backups = 5.4 GB; the launcher reads the source tree on every start                                                                                                                            | Moderate               |
| 19  | Error reference              | Every message, what happens automatically, what to do, and a version note                                                                                                                                     | Incident classes in `blackbox.db`; no reference a person can read                                                                                                                                                                                                       | Moderate               |

Rune already matches or passes Claude Code on several things. It cleans up process groups, marks crash-interrupted calls, writes files atomically with fsync, prunes retired models, and honours a provider's reported reset in its cooldowns. It refuses to hand a capped task to a weaker model, keeps an audit trail, and finishes runs reliably on free models: in the 3 September same-model head-to-head Rune finished 5 of 5, while OpenCode hung on 2 of 7 attempts.

## The program

Order: measured damage per unit of work. Everything through R7 is deterministic and spends nothing. Sizes assume one focused session: S ≤ 1 day, M 2–3 days, L about a week.

Rules for every card, inherited from the evidence-based plan:

- one behavioural card per patch, with a failing test before the fix and the actual counts in the closing note;
- no new guard in `agent-loop.ts`: a card that needs a decision moves it into `arbiter.ts` or deletes one.

### R0 — The yardstick (S, alongside R1)

- **R0.1** `tests/reliability/` with three suites, each red today where Rune fails, and `bun run reliability` to run them (CI on all three systems):
  - **contract:** `edit-probes.sh` as a Bun test, driving both the real `rune-tools` binary and the TypeScript `multi-edit` path with the same table;
  - **transport:** `tests/helpers/mock-model-server.ts` gains five faults (cut after event N, stall in a named phase, a malformed event, a 529 with `Retry-After`, a clock jump), driven through `spawnRun` so the real process runs;
  - **process:** SIGINT, SIGTERM and SIGKILL at four points (mid-stream, mid-tool, mid-compaction, mid-check), then resume.
- **R0.2** `docs/errors.md`, seeded from `blackbox.db`'s incident classes. Each row gives the message the person sees, what Rune does automatically, what to do, and the test that pins it. Every later card adds or corrects rows. Claude Code organises its reliability around this kind of page; Rune has the data but not the page.
- **R0.3** Re-run the evidence README's queries and record them in the progress ledger as "before".

### R1 — Tools fail loudly, never wrongly (M; `crates/rune-tools`, `packages/tool-registry`)

R1 goes first for three reasons: it is the one gap where Rune reports success on damage, it touches no file the other two plans own, and it can be proved entirely offline.

- **R1.1 Keep metadata on every write.** Copy the original's mode onto the temporary file before `persist`; a new file gets `0666 & ~umask`. A hard-linked file (`nlink > 1`) keeps the rename, and the result says the other links kept the old content. Writing it in place, as first proposed here, would edit a package manager's shared store through one project's link. `edit_file` keeps writing a symlink's target (under a test now); `write_file` used to replace the link itself and now writes through it too, refusing a link that points out of the workspace.
- **R1.2 Encoding.** Decode strict UTF-8 and keep a UTF-8 BOM if one is present. Refuse anything else, naming the cause and the shell route ("edit it with a command that keeps its encoding, or ask whether to convert"). Never write a U+FFFD the file did not already contain.
- **R1.3 Line endings.** Detect the file's convention and normalise `old_text` and `new_text` to it before matching and writing. A mixed file keeps its mix outside the edited range.
- **R1.4 Remove the loose tiers (D3).** Delete the indentation tier. Once R1.3 lands the whitespace tier has nothing left to do (0 uses in 1,448 edit_file and multi_edit edits), so delete it too. `apply_patch` never recorded which tier its 125 calls used, so it now reports how each hunk matched. Replace both with a better miss message, giving the closest candidate's lines and what differs, e.g. "lines 2–3 match after trimming; the file indents 8 spaces, old_text 4". A loud, specific miss is what makes exact matching workable on weaker models.
- **R1.5 Unrelated outside changes don't block an edit.** If the hash differs but `old_text` still matches exactly once in the current content, apply the edit and say the file changed since it was read, returning the new hash. `write_file` over an existing file keeps the strict rule, because an overwrite would destroy the outside change.
- **R1.6 One conformance table for both implementations.** Run the same table against Rust `edit_file`/`write_file` and TypeScript `multi-edit`/`apply-patch`, so the twins cannot drift again.

Exit:

- `edit-probes.sh` passes 6/6 against a build from the branch;
- the conformance table is green in `cargo test` and `bun test`;
- a property test shows that exact, unique edits on LF UTF-8 files produce byte-identical output to today's;
- the 19 recorded stale-hash cases, rebuilt from their `rune.db` shapes, now apply or fail with the right message.

### R4 — Name how a run ended (M; `headless.ts`, the engine's terminal seam, `protocol`)

R4 runs before R2 because every later measurement reads it. It is the execution half of the evidence-based plan's Stage 2 ("keep distinct facts … how execution ended"); the verdict half stays with that plan.

- **R4.1 A quota wall is not a lost provider.** Split `provider_lost` into:
  - `quota_wall`, carrying the reported reset time;
  - `provider_unreachable` (network, DNS, TLS);
  - `provider_error` (the provider answered with a failure).

  A quota wall pauses the run rather than failing it. The verdict says "paused at the Codex limit until 18:21". When the wall is already known, a new message is queued for the reset instead of starting a run that fails at once. That is Claude Code's "requests wait for the reset", and Rune's own auto-resume already does the waiting.

  Test: each kind, driven through the real loop by the mock server, records its own label, and 13 messages sent at a known wall produce no failed run.

- **R4.2 The exit code says how the run ended (D2).** 0: the loop finished. 2: a permission was needed. 3: a turn or budget limit. 4: the environment (provider, network). 5: a quota wall, with the reset time in the JSON. 130: aborted. 143: SIGTERM. The verdict (`met / partial / unverified / failed`, with reasons) moves into the JSON envelope and the summary line, its content unchanged. `--strict-verdict` restores today's "exit 1 unless met" for anyone who wants it.
- **R4.3 Result subtypes on every envelope, crashes included.** `success`, `error_max_turns`, `error_budget`, `error_quota`, `error_environment`, `error_halted`, `error_during_execution`, each carrying cost, turns and session id.
- **R4.4 Signals, tested.** SIGINT ends the turn and writes the result. SIGTERM and SIGHUP record the turn as interrupted and exit 143. No child process survives either (the process suite).

Exit: the exit-code table passes through the real headless executable with the scripted provider, and a test lists every `this.terminal(` site with its named ending, so a new site cannot appear unnamed.

### R2 — Transport by phase (L; `packages/llm-gateway`, the transport branch of `agent-loop.ts`)

- **R2.0 Commit the Codex stall fix as its own card first.** It has sat uncommitted in the shared tree since 13 October, and R2.2 builds on it.
- **R2.1 One ladder, in the gateway.** Ten attempts (Claude Code's default), exponential backoff 0.5 s → 32 s with jitter, `Retry-After` honoured up to the cap. Treat three 429 classes differently:
  - throttle: retry;
  - plan cap: hand over to R4.1;
  - spend limit: fail now.

  The loop's `consecutiveErrors` then counts turns whose ladder was spent, not attempts, so the two budgets stop multiplying. Every attempt emits a `retry` event with "attempt x of y" and a reason class.

- **R2.2 Track each stream's phase** (`awaiting_headers / thinking / text / tool_call / complete`) and the blocks it has completed:
  - **before any completed block:** re-send within the ladder;
  - **a stall in the same phase:** re-send once more, then end with a named error ("the response stalled before any answer");
  - **after a completed tool call or text block:** never re-send. Keep the completed blocks, drop the partial one, run the completed calls, and continue the turn from their results. A headless turn that ended in text only is told to continue, at most 3 times.

  This generalises the Codex fix to every provider and retires the `stream_reset`-and-redo path.

- **R2.3 Sleep.** Compare wall-clock and monotonic time around each wait. A gap over 30 s marks the dropped connection as `slept`; it is re-sent without spending the error budget, and the log says so.
- **R2.4 Overflow.** On a context-limit 400, shrink `max_tokens` if that fits, compact if it does not, and end with a named error if neither works. Never re-send an unchanged oversized prompt.

Exit, from the transport suite:

- each injected fault reaches its documented state;
- the audit log shows **no tool call executed twice** and no completed call lost;
- a stall is re-sent at most once per phase;
- a clock jump costs no error budget.

### R3 — Safety stops an action, not the run (M; `auto-mode.ts`, `arbiter.ts`; decisions D1 and D7)

- **R3.1 A block denies one action.** A safety block denies the action and tells the model why. After 3 blocks in a row or 20 in a run, an interactive run asks the person; a headless run keeps denying, keeps working, and lists the denials in its result. A terminal halt remains only for the narrow case the founder kept it for on 1 September: evidence the run itself is captured, judged on that evidence rather than "err on the side of blocking".
- **R3.2 Review input hygiene.** The reviewer sees the person's messages and the tool calls, never tool results, so an injected file cannot argue with it. Reads and workspace edits skip review, except protected paths (`.git`, `.rune`, configs, shell rc files, credential files), which a deterministic check covers first. This also attacks the reviewer's 12–29% share of run cost.
- **R3.3 The turn ceiling belongs to the person (D7).** Interactive runs have no ceiling: the person has Esc, and the no-progress nudge never ends a run. Headless runs take `--max-turns` and `--max-budget`. `loop_detected` and `barren` (one site each, neither fired since 14 September) become advisory through the arbiter.

Exit:

- zero non-safety terminations across the 63-task mock corpus and the F7 replays;
- the offline auto-mode eval's false-flag count and reviewer calls per run, recorded before and after;
- a guard-count line in the ledger that goes down.

### R5 — State you can get back (M)

- **R5.1 File checkpoints.** Before a turn's first write to a file, store the file's content (content-addressed, under the session). Keep 100 turns for 30 days. `/rewind` offers code, conversation, or both, and works after resume. It says plainly that changes made through bash are not tracked.
- **R5.2 Output spill.** A result over 30,000 characters is saved under the session, and the result carries its path plus a head and tail preview. The model reads the file rather than re-running a 228 s suite to see the middle.
- **R5.3 Compaction thrash.** If the context refills past the threshold within two turns of a compaction three times running, stop auto-compacting. End the turn with a named error and the fix: read in pages, or delegate the large output.
- **R5.4 Transcript health.** When a `rune.db` write fails (`SQLITE_FULL`, `IOERR`, `READONLY`), show one persistent line, "recent messages may not be saved for resume", until a write succeeds.

### R6 — Long commands keep their work (S)

- **R6.1** A foreground command that reaches its timeout moves to a background shell instead of being SIGKILLed; its process group stays alive and its output goes to a file. `sleep` is the exception. The result gives the shell id and the file.
- **R6.2** Unattended runs give background commands a limit (30 min default, 2 h maximum) and reap them at exit. The process suite checks that no orphan survives.
- **R6.3** The result says when a `cd` inside a backgrounded command does not carry over.

### R7 — Ship like a product (M; `scripts/install.sh`, `rune upgrade`, the launcher, `rune doctor`)

- **R7.1 Versions directory.** `~/.rune/versions/<version>/` holds the compiled pair and its meta, and `~/.rune/bin/rune` resolves a `current` symlink. An install compiles into the new version directory (so the signature stays valid), smoke-tests it, then swaps the symlink atomically. Keep three versions; `rune install <version>` rolls back.
- **R7.2 Backups (D5).** Prune the 250 backups (5.4 GB). This is a founder decision because it is their disk, and some backups may be wanted.
- **R7.3 Channels.** `latest` is the newest tag; `stable` is the newest tag that has been out for seven days with no regression filed. Add a `minimumVersion` floor and `rune upgrade --channel`.
- **R7.4 Launcher.** A release build's launcher reads no source tree; the git and find checks move behind `RUNE_DEV_SOURCE`. Measure launch time before and after.
- **R7.5 Signing (D4).** Signing stays ad hoc at zero budget, and an install never `cp`s a binary: compile in place, or run `codesign --force -s -` after a copy. Developer ID and notarisation wait for D4.
- **R7.6 `rune doctor` checks:**
  - binary hashes against the meta, and that the signature is valid;
  - the version layout and `~/.rune` disk use;
  - `rune.db` `integrity_check`;
  - that the sandbox mechanism really works (the macOS 27 named-profile trap);
  - provider reachability, without a paid call.

Exit: in an install matrix (`kill -9` mid-install, disk full mid-install, a copied binary), the previous version keeps running every time, and a rollback takes under five seconds.

### R8 — Live proof (founder-approved runs, Codex subscription)

One sitting after R1–R4 land. Size it by the standing rule: about 12 points of the five-hour window per serious pair, nothing else running, the Mac on power under `caffeinate -dimsu`, and the window and any other active session checked first.

- **Tasks:** the three kept F7 tasks and three small corpus tasks, each once on the current build and once on the candidate.
- **Read from each run's own `rune.db`:**
  - transport endings backed by an incident, per run;
  - re-sends per call;
  - runs the harness ended;
  - tool calls executed twice (must be 0);
  - corrupted edits (must be 0);
  - exit codes that agree with the hidden-test outcome.
- **Sleep test:** one long run with the lid closed for five minutes in the middle. It resumes and finishes, and the record says it slept.

## Decisions for the founder

|     | Decision                                                                                 | Recommendation                                                                                       |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| D1  | Should a safety block stop the action (Claude Code) or the run (Rune today)?             | Stop the action. Keep a terminal halt only on evidence that the run is captured                      |
| D2  | Should the exit code say how the run ended, with the verdict in the JSON? (A3, reframed) | Yes, with `--strict-verdict` for the old meaning                                                     |
| D3  | Delete the whitespace and indentation edit tiers?                                        | Yes: 3 uses in 1,448 edits, and each risks silent damage. Taken as answered by "proceed"; done in R1 |
| D4  | Developer ID signing ($99 a year), or ad hoc?                                            | Ad hoc for now, and never `cp` a binary                                                              |
| D5  | Delete the 250 backup binaries (5.4 GB) and keep three versions?                         | Yes, after you look over the list                                                                    |
| D6  | Ever run a Claude Code arm?                                                              | No, under the standing rule; Claude Code's documentation is the spec                                 |
| D7  | No turn ceiling for interactive runs; a person-set ceiling for headless runs?            | Yes. The ceiling ended 5 runs in a month and collapsed evolab7's plan                                |

## What not to copy

- **Model co-training.** Rune's answer is stricter tools and louder errors, not more prompting.
- **Anthropic-only machinery:** server-side safety review, its caching rules, its fallback-model list.
- **Claude Code's wider surface** (agent teams, remote control, cloud sessions): none of it is reliability.

## How this fits today's two plans

- **Evidence-based 90 plan.** R4 is the execution half of its Stage 2. R2, R5, R6 and the process suite are the concrete content of its Stage 5 ("prove long-running reliability"). R1 and R7 cover ground it does not, and feed its "Permissions and workspace integrity" and "Recovery and sustained execution" dimensions. Its rule that Stage 1 lands first stands; R1 can run beside Stage 1 because they share no files.
- **End-to-end plan.** Its arbiter migration and refusal cap (II.2) are the vehicle for R3. Its audit found two P1 regressions, so take nothing from that work without the audit's repairs.
- **The shared tree.** R1 (crates and tool-registry) and R7 (scripts) touch no god file, so start there. R4, R2 and R3 touch `agent-loop.ts` and `engine.ts`: run them one at a time after Stage 1 lands, in a lane, and never with `git add -A`.

## Done means

- `bun run reliability` is green on macOS, Linux and Windows CI:
  - the contract suite at 100%;
  - the transport suite at 100% on "no tool executed twice" and "no completed call lost", and at least 95% on recovery states;
  - the process suite leaves no orphans.
- `docs/errors.md` covers every incident class, with a test for each.
- The R8 sitting shows zero corrupted edits and zero double executions, quota walls named with their reset time, `provider_lost` only where an incident backs it, and exit codes that agree with outcomes.
- No scorecard row is still marked Critical or Major.

That is Claude Code's reliability floor, as its own documentation defines it. It claims nothing about whether Rune's answers are as good as Claude Code's. That is the model's work, and a separate measurement.
