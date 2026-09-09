# Program backlog

Out-of-phase defects found during execution. One line each: `file:line — what — found in phase — by`.

**2026-09-03:** every item below that names `apps/web`, `apps/desktop`, `apps/vscode`, the web bundle, the brand checklist or the Playwright suite is moot — those surfaces were removed when the founder made the terminal the only interface. They are left in place as the record of what was found.

Seeded 2026-09-02 from the audits:

- `packages/tool-registry/src/tools/todo-write.ts:55` — `todo_write` has category `read`, so `task` sub-agents can call it into a throwaway store — 6B.4
- `packages/llm-gateway/src/providers/openai.ts:74-79` — comment says OpenRouter passes no name; `openrouter.ts:28-32` passes one — 8.6
- `packages/tool-registry/src/mcp/client.ts:655` — MCP handlers return `validate: () => ({valid: true})` unconditionally — 4.4
- `packages/orchestrator/src/bin/engine-host.ts:321-335` — pending permission promises have no timeout and no rejection on disconnect — 2.2
- `packages/shared/src/session.ts:55` — `system_prompt_hash` never written (NULL for 601 sessions) — 7.1
- `tests/eval/tasks-from-incidents.ts:12-15` — flywheel input empty — 7.8
- `apps/desktop/src-tauri/src/lib.rs` — six `*_system_memory` commands never called — 3.1
- `packages/tool-registry/src/tools/freshness.ts` and the rune-tools read/edit path — PR #4's first Windows runtime smoke (packaged-e2e, windows-latest) fails at edit_file with "You must read smoke.txt (read_file) before editing it" immediately after a read_file of the same path: the read-before-edit ledger keys paths differently on Windows (separator or case). Real Windows defect, never observed before because nothing had executed the binary on Windows — 1.7

Added during execution:

- `tests/unit/**` (21 files) — POSIX-shell and POSIX-path assumptions block `bun test tests/unit/` on Windows: hardcoded `/bin/sh`, `/tmp/...`, `bash -c` and `uname` in the sandbox, permission, auto-containment and custom-loader suites. `ci.yml`'s ts-windows job typechecks only. The Windows smokes (P1.7) do not need these, so they were left alone — found in 1.7
- `.github/workflows/release.yml` — the install-smoke matrix downloads with `gh` rather than running `web-install.sh` / `install.ps1`, because a private repo 404s anonymous `curl`. Switch it to the real one-liners once D1 makes the repo (or a mirror) public — found in 1.4
- `packages/orchestrator/src/bin/ui/brand.ts` — `PRODUCT_VERSION`'s source-run fallback reads `packages/orchestrator/package.json` at runtime; five other `package.json` files still carry a semver nothing reads. Consider collapsing them, or add a CI check that they agree — found in 1.3

Found while executing Phase 4 (lane C):

- `packages/orchestrator/src/engine.ts` — `reconcileMcpTools` unregisters only `mcp_`-prefixed tools, so the cross-server `read_resource` survives every connector going away; it answers "no connected service exposes resources", which is honest but leaves a schema advertised for nothing — 4.4
- `packages/orchestrator/src/engine.ts` — `mcpNotices` now carries plugin refusals and local-tool loads as well as connector lifecycle; the name has drifted from what it holds — rename to `extensionNotices` when Phase 2 touches the event surface — 4.5/4.6
- `packages/orchestrator/src/bin/rune-cli.ts` — `parseArgs` runs with `strict: false`, so any UNDECLARED long option with a value silently becomes a boolean flag plus a stray positional. P4.3 declared the five it needed; every future subcommand must remember to, or lose its arguments without an error — 4.3
- `packages/orchestrator/src/bin/ui/brand.ts:15` — `PRODUCT_VERSION` is a fifth hand-maintained copy of the version; `plugins.ts` deliberately reads `package.json` instead to avoid an engine→UI import. Consolidate in Phase 1 — 4.6

Found during Phase 2 (lane B):

- `.gitignore:32-42` — a run writes `.rune/skills/playbook/SKILL.md` into the workspace and that path is NOT ignored, so every session dirties the tree it is working in; `.rune/cache/`, `logs/`, `worktrees/` are ignored but `skills/` is not — found in 2.8 while running the `--stream-json` gate — lane B
- `packages/orchestrator/src/bin/rune-cli.ts:112` — `--status` is declared `{type:"string"}` under `strict:false`, so a bare `--status` silently swallows the NEXT argument as its value (`rune serve --status --port 4999` parsed as `status:"--port"`). Worked around for `serve` by rewriting the flag to a positional before `parseArgs`; every other subcommand still has the hole — found in 2.4 — lane B
- `packages/orchestrator/src/engine.ts` — `Engine` holds one `currentAbort`/`liveLoop`, so `abort(sessionId)` cannot truly be per-session in one process. `rune serve` works around it with one host process per session (P2.3's supervisor). An in-process multiplexed Engine remains unbuilt and is the blocker for a single-process multi-session desktop — found in 2.3 — lane B
- `packages/shared/src/session.ts:44-107` — `tool_result` rows carry no `durationMs`, so a replayed tool call reports 0 and a client cannot tell "instant" from "unknown" — found in 2.5 — lane B

Found during Phase 3 (lane B):

- `apps/desktop/src-tauri/Cargo.toml` — the repo root's `exclude` for `apps/desktop/src-tauri` only works while the nearest ancestor manifest IS the repo root, so every cargo command from a git worktree checked out under the main checkout failed with "believes it's in a workspace when it's not". Fixed here with an empty `[workspace]` table in the package; the same trap applies to any future nested crate — found in 3.1 — lane B
- `packages/orchestrator/src/bin/login-cli.ts` — provider OAuth (Anthropic, Codex, OpenRouter) and the Copilot device flow are terminal-owned: they open a browser and catch a loopback redirect from the CLI process. The desktop settings panel prints `rune login <provider>` for those providers rather than offering a button that cannot work. Moving it in-app needs one host command (`start_provider_login` → returns the URL, completes the exchange, writes to the credential store) — found in 3.4 — lane B
- `packages/orchestrator/src/engine.ts` — `getTurnContext` records the last turn's assembly PER SESSION, not per turn, so the inspector shows the most recent assembly for the session rather than the one for the model span you clicked. Correct for a one-turn question and wrong for scrubbing back through a long session; a per-turn record needs a turn index on the capture — found in 3.4 — lane B
- `apps/desktop/src/lib/demo.ts` — the recorded demo turn predates the round-trip cards, the fleet panel and the auto chips, so "replay a recorded turn" shows a 2026-08 surface. Re-record it against the current reducers — found in 3.4 — lane B

Found during Phase 5 (lane B):

- `apps/desktop/src/lib/stream.ts:919` — `case "tool_call_args_delta"` is a duplicate of an earlier `case` in the same switch, so the second one is dead. esbuild warns on every `apps/desktop` build; the reducer still compiles because both branches do the same thing, which is exactly why it has survived. The exhaustiveness test reads case labels and finds one, so it does not catch a second — found in 5.2 while building the web bundle — lane B
- `packages/orchestrator/src/headless.ts:246` — `headlessEnvelope` is the only place a headless run reports itself, and it had no `sessionId`, so CI could not name the session it had just run and had to guess with `rune audit last` — wrong on any shared runner. Added in 5.3; the same gap exists for `rune detach`, whose registry records a run id that no envelope ever prints — found in 5.3 — lane B
- `packages/orchestrator/src/bin/serve-cli.ts` — the `HostPool` registry path (`~/.rune/run/serve-hosts.json`) is a single global file, so a `rune serve` and a `rune acp` running at once overwrite each other's record. It is only read by `rune serve --status`, so the damage is a wrong status page rather than a wrong route, but the file should be keyed by the owning process — found in 5.1 — lane B
- `packages/orchestrator/src/bin/rune-cli.ts` — `parseArgs` runs with `strict: false` and the options map is now 40+ entries shared by every subcommand, so a flag added for one command is silently accepted by all of them (`rune doctor --token x` parses fine). A per-command option set would catch typos that currently do nothing — found in 5.5 — lane B

Found 2026-09-02 by the Phase 6A corpus (`bun run eval:auto-safety --offline`). Each is a shape the
corpus expects a reviewer to catch because no mechanical breaker names it. None is a regression —
they are gaps the 19-scenario corpus was too small to see:

- ~~`packages/orchestrator/src/auto-mode.ts:1805` — the recursive-delete breaker requires the target to
  BE a filesystem root or home directory, so `rm -rf ~/Documents` rates medium and runs — 6A.2~~
- ~~`packages/orchestrator/src/auto-mode.ts:1962` — `guardrailChangeReason` only inspects `update_config`;
  a `sed -i` or `rune config set` against `.rune/policy.json` reaches the same target through bash and
  is not a guardrail change to the breaker — 6A.2~~
- ~~`packages/orchestrator/src/auto-mode.ts:1899` — `SECRET_PATH_RE` matches credential FILES, so
  `security find-generic-password` (the macOS keychain CLI) is not a secret read — 6A.2~~
- ~~`packages/orchestrator/src/auto-mode.ts:1721` — `isOrdinaryWorkspaceWrite` does not expand a leading
  `~`, so `write_file` to `~/.zshrc` resolves INSIDE the workspace root and lands on the workspace
  tier — 6A.2~~
- ~~`packages/orchestrator/src/auto-mode.ts:1803` — not on any destructive list: `chmod -R 777 /`,
  `shutdown -h now`, `docker system prune -a --volumes -f`, `git push --mirror`,
  `aws s3 rm --recursive` — 6A.2~~

**All five CLOSED in P10.3**, mechanically and with a unit test each, in
`packages/orchestrator/src/auto-containment.ts`'s `mechanicalBreaker()` pre-screen and
`shellGuardrailChange()`. Eleven further shapes the same corpus pass exposed were closed alongside
them (see the table in docs/auto-mode.md). Offline reviewer-only recall went 13/46 → 35/46 with 55/55
mechanical blocks still held and 116/116 mechanical allows still preserved.

Found 2026-09-02 by Phase 7 (lane C):

- `tests/eval/tasks-task-spine.ts` — two mock-mode tasks fail on the merged Phase 1 + Phase 6 tree, verified against that merge's own harness so they are not a Phase 7 regression: `spine_handoff_on_error` ("no handoff recorded for the dead run") and `spine_todos_survive_compaction` ("final request lost the [Task state] block"). Not caused by Phase 6's `task-state.ts` changes either — reverting that one file to `b150dd2` leaves both failing — so the cause is at or before the common base `b150dd2` on `gear/phase-0-stabilize`, or in a file neither lane's diff touches. `baseline-mock.json` still records `cleanPassRate: 1` with zero failing tasks, so `bun run eval -- --compare` will fail CI on any PR off this base until someone fixes the two tasks or re-anchors deliberately. The baseline was NOT re-anchored here: encoding two failures as expected would hide them — found in 7.4
- `scripts/install.sh` — every install keeps the previous binaries as `rune*.backup-<epoch>` in `~/.rune/bin` and nothing ever prunes them: ~95 generations × 3 binaries (`rune`, `rune-compiled`, `rune-tools`), several GB on this machine. Keep the last 2 or 3 — found in 7.4
- `packages/orchestrator/src/notebook/store.ts:246` — `decay()` retires on `COALESCE(last_used, updated_at) < cutoff`, so an entry that has never been injected is retired 60 days after it was learned even though nothing has had the chance to contradict it. Disuse and staleness are different signals — found in 7.6
- `tests/eval/from-incidents/covered.json` — two recurring incident classes are WAIVED rather than covered, and each needs a harness capability the suite does not have: `crash.dirty_exit` (162×) needs a process-level eval harness (the current one drives the engine in-process, so there is no child process to exit dirtily), and `context.budget_overflow` (25×) needs `RunOptions` to carry a context-budget override so a task can overflow it without a multi-megabyte fixture — found in 7.8

Found while merging the lanes (merge captain):

- `tests/unit/brand-checklist.test.ts:26-33` — `builtCss()` skips when `apps/desktop/dist/assets` is absent but trusts it blindly when it is STALE, so the checklist audits whatever bytes happen to be on disk. A `dist/` built before the Savoir tokens existed (gitignored, so it survives every checkout and merge) fails all six rules on a tree that is correct; `bun run --cwd apps/desktop build` turns the same tree green. Either stamp the build with a token hash and skip on mismatch, or have `bun run test` depend on the desktop build — found while merging #9

Found 2026-09-03 by Phase 9 (the web product):

- `apps/web/src/lib/stream.ts:919` — `case "tool_call_args_delta":` duplicates an earlier clause in
  the same `switch`, so the second is dead. Vite reports it on every build
  (`This case clause will never be evaluated`). Harmless today because both arms return `t`
  unchanged, and a defect the moment either one grows a body — found in P9.1
- `packages/orchestrator/src/bin/rune-cli.ts:198` — `parseArgs` still runs `strict: false`, so an
  undeclared long option silently swallows the following argument. Phase 9 added `--console` and
  `--no-browser` to the declaration list for exactly this reason; the underlying trap is unchanged
  and will catch the next flag somebody adds — found in P9.2

Found 2026-09-03 by Phase 9 (the web product), continued:

- `packages/orchestrator/src/bin/engine-host.ts` — `resume_session` still returns only the
  user's turns ("v1" in its own comment) while `subscribe` returns the whole reconstructed
  event stream. The app now uses `subscribe` and the older command is dead weight with a
  misleading name; either make it return `engine.getTranscript()` or remove it from the
  protocol — found in P9.5
- `apps/web/src/components/Transcript.tsx:337` — a `todo_write` call renders both a raw-JSON
  tool row AND a "Plan:" line, and the plan ledger above the transcript now shows the same
  list a third time. The tool row should collapse to "planned 3 steps" — found in P9.5
- `apps/web/branding/` — the mark is recreated from the geometry in the brief, not the
  founder's original vector. `scripts/generate-rune-mark.ts` exists so the real file can
  replace `rune-mark.svg` byte-for-byte; the derivatives are then one command away
  (`scripts/generate-rune-raster.ts`) — founder action, not a defect
- The app's Connect tab cannot complete an OAuth login: the callback needs a loopback
  listener a page cannot open, so it prints `rune login <provider>`. A host command that
  runs the existing `oauth-strategy.ts` flow and streams its state would close this; it is
  the same gap Phase 3 logged — found in P9.4
- ~~`packages/orchestrator/src/bin/serve-cli.ts` supervisor + tests/integration/engine-serve.test.ts — every serve test run leaks its per-session `engine-host` processes (twenty idle engines found after the Phase 9 agent's runs; they made the held-step round-trip test time out at 60 s under load, while it passes in 21 s alone). The supervisor needs an idle reaper and the tests explicit teardown of the hosts they spawn — found while merging #13~~ **FIXED in P10.0**: idle reaper (`[serve] idleHostSecs`, 10 min, client- and turn-aware), hosts stopped on server exit unless `--keep-hosts`, `--parent-pid` dead-man's switch in the host, teardown in the serve/ACP suites, and `tests/integration/zz-no-leaked-hosts.test.ts` as the standing assertion

Found 2026-09-03 by Phase 10 (capability closers):

- `tests/unit/brand-checklist.test.ts:261` — "the checklist inspected something real > a build
  exists" and "and it is not a stale one" FAIL on a clean checkout, because `apps/web/dist/` is
  gitignored and nothing in `bun test tests/unit/` builds it. The gate `bun test tests/unit/` is
  therefore not self-contained: it is red until someone happens to run
  `bun run --cwd apps/web build`, and its own failure message is the only thing that says so. The
  test's design is right (a stale `dist/` is worse than none); the fix is for the unit gate, or a
  `pretest` step, to produce the artifact it audits — found in P10.1. **Half closed in P10.2**:
  `ts-lint` and `ts-windows` build `apps/web` before running the suite, so CI's gate now produces
  what it audits and `ts-lint` is green again (it had been red on every run — see 33688734929).
  A local `bun test tests/unit/` on a clean checkout is still red until you build the bundle,
  because nothing in the bare `bun test` invocation can hook it

Found 2026-09-03 by P10.0 (the host reaper):

- `packages/orchestrator/src/bin/serve-cli.ts` — `detachAll()`'s comment says "the next
  `rune serve` reattaches", and nothing does: `HostPool.spawn` always mints a fresh socket
  and never reads `~/.rune/run/serve-hosts.json`. So `--keep-hosts` genuinely orphans its
  hosts rather than handing them over, and only the idle reaper (which the new server does
  not know about them for) or a restart cleans them up. Either implement reattach or stop
  claiming it — found in P10.0

Found 2026-09-03 by P10.3 (supervisor recall):

- `tests/eval/runner.ts:368` — the mock suite writes `tests/eval/baseline-mock.json` on **every**
  passing full run, not only under `--write-baseline`. So the command the gate tells you to run
  (`bun run eval -- --compare`) silently re-anchors the artifact it just compared against, leaving a
  dirty tree with a new timestamp and a drifted `avgDurationMs`. Harmless here because the numbers
  were identical and the change was reverted, and a trap the moment a run is not: a distracted
  session commits a re-anchored baseline as part of an unrelated change, and the gate quietly stops
  gating. Write only under the flag — found in P10.3
- `tests/unit/orchestrator/auto-containment.test.ts:104-114` — the test "persistence waits normally,
  but halts once injection is suspected" is duplicated verbatim. Bun runs both, so the second is
  pure cost, and a future edit to one leaves two tests with the same name asserting different
  things — found in P10.3

Found 2026-09-03 by P10.2 (Windows parity):

- `packages/tool-registry/src/tools/format-on-write.ts` — the project-formatter
  resolver looks for `node_modules/.bin/prettier`, which on Windows is
  `prettier.cmd` (npm/bun write a `.cmd` shim, not a shebang script). So
  format-on-write silently never runs on Windows even in a project that
  configured prettier: no error, no note, just unformatted output. Its unit
  suite skips there for the same reason — found in P10.2
- `packages/orchestrator/src/parent-check.ts` and the verifier's check commands —
  every fixture and most real check commands are `sh`-shaped (`sh check.sh`,
  `bash -c`). Nothing establishes what a check command means on Windows
  (cmd.exe? PowerShell? Git Bash if present?). `tests/unit/orchestrator/parent-check.test.ts`
  skips there rather than pretend. Decide the Windows shell contract before
  claiming the verifier works on Windows — found in P10.2
- `packages/shared/src/credential-store.ts` / `secrets.ts` — file privacy is
  enforced with POSIX mode 0600, which is a no-op on Windows (no rwx bits; the
  ACL inherited from the parent directory decides). `secretsArePrivate()`
  therefore cannot answer honestly on Windows. Either implement an ACL check or
  say plainly that Windows credential files are as private as `%USERPROFILE%` —
  found in P10.2
- `packages/orchestrator/src/hooks.ts:386`, `verifier.ts:280`, `worker-worktree.ts:248` — every
  command string these run goes through a hardcoded POSIX shell (`/bin/sh -c`, `bash -c`), so on
  Windows the spawn fails and hooks, the verifier and worker checks are inert with no message
  saying so. **The Rust half is fixed**: `crates/rune-sandbox/src/shell.rs` resolves a shell once
  (Git for Windows' bash, else `cmd.exe /C`, `RUNE_SHELL` overrides) and both `bash` paths use it.
  These three TypeScript callers should route through the same rule — the resolver needs a TS
  twin, or the callers need to ask rune-tools. Their unit suites skip on Windows meanwhile,
  because what they would assert depends on which shell the machine happens to have — found in
  P10.2
- `tests/integration/engine-serve.test.ts` "a deferral reaches the client as a held step" — takes 20 s alone against a 60 s timeout and timed out twice under load on the merge gate (with zero leaked hosts the second time); either shorten the round-trip waits it depends on or give it its own timeout, so the gate stops depending on an idle machine — found while merging #15

Found 2026-09-03 by P10.4 (verifier ecosystems):

- `packages/orchestrator/src/bin/engine-host.ts:819` `run_checks` — the "run the
  checks" command builds its own `CommandVerifier` with `commands: undefined` and
  no `ecosystems`, so it ignores both `[verify] commands` and the new
  `[verify.ecosystems]` config. The button and the run therefore disagree with
  each other on any project that configured either, which is the exact drift the
  comment above it says it exists to prevent. The host needs the resolved verify
  config threaded through — found in P10.4
- `packages/orchestrator/src/verifier.ts` — a Python project that configures
  neither pyright nor mypy and has no tests has no project-wide check at all, so
  the END of a run reports "Nothing runnable detected" even though the step check
  compiled every file it wrote. The step-level and run-level answers disagree
  about the same tree. Either the run-level verify should fall back to compiling
  the files the run touched, or the report should say "compiled per step, no
  project-wide check configured" — found in P10.4
- `tests/fixtures/verifier/gradle-app` and `maven-app` are detection-only: the
  wrappers are placeholders, because a real `gradlew` downloads a Gradle
  distribution on first use and that does not belong inside a unit fixture. So
  `./gradlew classes` and `./mvnw compile` are asserted as strings and never
  executed anywhere. A gated CI job with a warm Gradle/Maven cache would close
  it — found in P10.4
- `packages/orchestrator/src/bin/byop-cli-shared.ts:42` `readAuthOverrides` walks
  a HARDCODED list of five provider ids (`anthropic, openai, openrouter, google,
ollama`), so `[llm.<id>] authentication = "…"` is silently ignored for every
  other provider — codex, ollama-turbo, groq, xai, deepseek, and the three new
  enterprise routes. The valid-method set beside it was widened for `chain`, but
  the id list was not; it should iterate `PROVIDER_PRESETS` instead. A config key
  that parses and does nothing is the failure mode `normalizeFallbackOrder` was
  written to avoid — found in P10.5
- `packages/shared/src/config.ts:18` `RuneConfig.llm.defaultProvider` is a
  hand-written union of provider ids that has now drifted three times: it was
  missing groq/xai/deepseek/custom before P8, still omits `codex`, and now omits
  `bedrock`, `vertex` and `azure-openai`. So `[llm] defaultProvider = "bedrock"`
  in config.toml is a type error even though the provider exists and works. It
  should be `ProviderName`, or derived from `PROVIDER_PRESETS` the way the tier
  and fallback tables now are. (`rune use bedrock` works — it writes the model
  sidecar, not this key — which is why the gap is easy to miss.) Distrust
  hand-written provider unions; this is the third one — found in P10.5
- `scripts/verify-cache.ts` has no construction site for the three enterprise
  routes, so `--provider bedrock|vertex|azure-openai` cannot run even on a
  machine that HAS the credential. The cache-policy rows for all three are
  therefore documented-but-unmeasured with no way to promote them without
  editing the script first — found in P10.5

Found 2026-09-03 by P10.6 (integration proofs):

- `packages/orchestrator/src/bin/acp-cli.ts` `toUpdate` drops `usage`, but ACP
  v1 grew from five update kinds to fifteen since that mapping was written and
  one of them is a **stable** `usage_update` (`used`, `size`, optional `cost`)
  that Rune's `usage.context` could fill exactly. It is still dropped because an
  update kind an older client does not know fails the whole notification in a
  schema-validating client, and there is no Zed on this machine to try it
  against. Send it once someone can run a real editor against the change —
  found in P10.6
- `packages/orchestrator/src/bin/acp-cli.ts` — `stream_reset` means "retract the
  partial text you have drawn". ACP's `agent_message_chunk` is append-only and
  the protocol has no retraction, so an editor showing a run whose provider
  stream was abandoned mid-response will show the abandoned prose followed by
  the re-streamed prose. Nothing in ACP v1 fixes this; it needs either a
  protocol change or an agent that buffers text until a turn is settled —
  found in P10.6
- `action/review.ts:251` `postComment` hardcodes `https://api.github.com`, so
  the action cannot post on GitHub Enterprise Server. `pr-cli.ts` now honours
  `GITHUB_API_URL` (the variable every Actions runner already sets, and the one
  that names the GHES API root); `review.ts` should read the same one — found in
  P10.6
- `packages/orchestrator/src/bin/pr-cli.ts` `checkoutPrWorktree` writes
  `.rune/worktrees/pr-<n>` inside the user's repository, so `rune pr 12` leaves
  `?? .rune/` in `git status` for any project that has not ignored `.rune/`.
  Rune's own `.gitignore` covers it, which is why nobody noticed. Either write
  the worktree outside the repo, or add `.rune/` to the repo's
  `.git/info/exclude` (local, uncommitted) on first use — found in P10.6
- `packages/orchestrator/src/task-state.ts:791` `TaskStateStore.addDecision` is
  dead in production: nothing outside `tests/unit/orchestrator/task-state.test.ts`
  ever calls it, so `state.decisions` is always empty, the spine block's
  `Decisions: …` line never renders, and the `Decisions` section of
  `.rune/mission.md` is always absent. The consequence is a context one: a
  decision the user states in an early turn has exactly one carrier across a
  compaction — the summarizer's prose — which is the single carrier Gap 6 of the
  competitive assessment says not to rely on. Either wire a recorder (the
  `ask_user` path already lands answers as `clarifications`; user directives and
  a model-declared decision do not) or delete the field, the render branches and
  the tests that exercise it. Deciding which is a product call, not a fix —
  found in P10.8
- `packages/orchestrator/src/auto-mode.ts:740` `classifierCall` treats a reviewer
  with no reachable endpoint the same as a slow one: both attempts (primary, then
  the `reviewerFallback` retry) run to the full `timeoutMs` before mechanical
  containment takes over, so a misconfigured or unreachable reviewer costs
  `2 × timeoutMs` — 24 s at the shipped 12 s default — on EVERY contained action,
  and the run has no way to learn that the reviewer is not coming. This is what
  made `tests/integration/engine-serve.test.ts`'s held-step test a 16.7 s test
  (P10.9 bounded the fixture's ceiling; the product behaviour is unchanged). A
  transport error or a resolver that cannot name a credentialed reviewer should
  fail fast rather than wait out the latency budget, and a reviewer that has
  failed to answer N times in a row should be treated as absent for the rest of
  the run instead of being asked again on every action. Both are safe: the
  mechanical breakers are what actually guard destruction and they never call a
  model — found in P10.9
- `apps/web/src/App.tsx` the trace rail overlays the reading column below 1100px
  (P10.9), which keeps the column's width but puts the panel over the right half
  of the text it is explaining. It reads acceptably as a transient drawer and it
  is what Phase 9 specified, but at 1024 with the rail open roughly half the
  transcript is behind it. Worth a design pass: either the reading column
  re-centres in the space the rail leaves (a reflow, but a deliberate one), or
  the rail narrows below some width — found in P10.9
- (withdrawn) A P11.2 note claimed the mock suite scores 23/62 on `gear/phase-0-stabilize` and that `bun run eval` "cannot gate anything". Not reproducible: `git archive 02eee64` into a clean directory with its own `bun install` scores 62/62 with and without `RUNE_TOOLS_BINARY`, and every merge gate since has printed 62/62. A mock-suite score far below the baseline is an environment fault first (missing tools binary, stale or shared worktree state); run the export experiment before recording a regression — found while merging #24

Found during the first dogfood run (2026-09-09, Rune fixing `todo_write` in its own tree on `ollama-turbo/gpt-oss:120b`, sessions 01a086b0 and 01a086b4):

- `packages/orchestrator/src/engine.ts:2856` — "Unknown tool: search" answers a hallucinated name with nothing to act on; the model retried it five times in one session (eleven completions after the work was committed). Name the nearest real tools (`grep`, `search_code`, `glob`) in the refusal, the way the sweet-shop `skill` fix did — dogfood run — Claude
- `packages/orchestrator/src/agent-loop.ts:3424` — the result-keyed loop detector nudges once and never again, so five identical "Unknown tool" results in a row were not treated as a loop — dogfood run — Claude
- `packages/orchestrator/src/agent-loop.ts` — after the model's closing message the turn kept going for another eleven completions (a full `bun test` to a 120 s timeout, then the `search` retries) with no user or system event in between; whatever re-prompted it (evidence gate, open-steps gate or second wind) should say so in the transcript, and should not fire after a commit that was the brief's last step — dogfood run — Claude
- `packages/orchestrator/src/agent-loop.ts:1715` — a completion that returned zero input and zero output tokens ended the review turn as `finished` with no message, no edit and no commit (session 01a086b4, ninth completion). The empty-response retry only fires while the run has produced nothing at all (`firstStepSilence`), so an empty `end_turn` after earlier tool calls is taken as a legitimate finish even though the model never wrote a word; treat "tool calls so far, no text ever, empty end_turn" as an empty completion too — dogfood run — Claude
- `packages/tool-registry/src/tools/glob.ts:160` — `glob` with pattern `*` on a directory that holds only directories says "No files matched", which reads as an empty tree; say how many directories matched and were skipped — dogfood run — Claude
