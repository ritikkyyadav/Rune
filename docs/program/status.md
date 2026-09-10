# Program status

**2026-09-10, night: the TUI, looked at.** Frames captured through a pseudo-terminal at 80×24 and
120×36 for the start screen, `/help`, `/model`, `/config`, a resumed real run, a live free-route
run and the piped `-P` rung, with OpenCode captured the same way. Rune's transcript grammar holds
up: rail, verbs, accent paths, numbered diffs, checks with their exit summary, the agent mark. The
defects were specific and are fixed: tool rows named files by an abbreviated absolute path
(`.../rune-live-gFFS/ws/greet.ts`), now workspace-relative; the native edit tool glued a hunk's
first line onto its header so every diff gutter started one row early, and a trailing newline grew
a phantom row; the harness's own checks printed `✓ $ npm test (ok)` in a third grammar, now
`│ ✓ check  bun run typecheck · bun test`; the live rung said `thinking 6s · down 395 tokens ·
thought for 5.1s`; `/help` dumped 26 rows and scrolled `/model` and `/login` off a 24-row window,
now grouped and two-column on wide windows; the start screen was a memory tip over sixteen blank
rows, now two rows of what to try and which keys matter; and `-P` printed `→ read_file` and nothing
else, now the committed rows without colour. The white diff bands are the founder's 2026-09-05
design and are left alone, with the guide's objection recorded in the backlog beside four smaller
items. Captures and the capture driver live in the session scratchpad; the method is a Python
pseudo-terminal plus the `pyte` emulator, which sees absolute addressing and the alternate screen.

**2026-09-10, later that night: the second look.** The piped rows had been drawn from inside the
headless runner, which is engine-side; the purity test caught it, and the rows now come from the
CLI's event hook with the runner printing nothing. Looked at again on the installed build: a recursive
`list_dir` walked into `.git/` and reported 53 entries for a four-file repo, all of them fed to the
model, so the native tool now names `node_modules`, `.git`, `dist`, `build`, `target` and the rest
without walking them (7 entries, the directory itself still listed, its contents one call away);
`/help` on a 24-row window still scrolled, so a window too short for the full list gets one row per
group; the third start-screen example was cut mid-word at 80 columns, so it appears from 100; the
launch picker, on Enter at "Start a new session", stayed painted on the fixed frame until the next
keystroke and skipped the start rows entirely; and its session rows at 80 columns ended in
`gpt-oss…`, so a hint now yields by whole segments and goes entirely below twelve cells. Verified
frame by frame at 80×24, 100×30 and 120×36, plus a `-P` run whose stderr carries the transcript's
rows. 4392 unit tests, 0 failing, unsandboxed.

**2026-09-10, evening: the first complete free-route series on the new build.** Three tasks by
two runs, each task invoked separately so a provider error could not end the series; all twelve
arms scored. Rune completed **5 of 6**, OpenCode **4 of 6**; on every pair both completed Rune
finished sooner and at a lower estimated list cost (means: Rune 43.0 s and $0.0273 over six arms,
OpenCode 110.6 s and $0.0496). Rune's one failure was a wrong parser after a normal finish, not a
harness stop. This reverses the 2026-09-08 series' cost finding on the same route; it is one series
on one free model and says nothing about the frontier route, where Codex quota stayed exhausted.
[Reports and qualifications](../evidence/comparison-20260910-free-c-notes.json).

**2026-09-10, afternoon: the fold measured, the Linux proof run, and the free route.** Pilot J on the
fold build read 24,320 of 24,882 tokens from cache on its last request (Pilot H: 12,160 frozen);
the two remaining full misses follow just-in-time doctrine injections, recorded in the backlog.
Rune still hit 240 s because `bun -e '…assert…'` probes were not checks and `record_evidence`
refused them twice (fixed: inline assertion scripts count, 9984109). The comparison harness now
forwards the saved-keys file into its isolated profile (it had no ollama key). On the free route
gpt-oss:120b never writes a closing line and once printed a tool's arguments as text: a run that
wrote its work now finishes on silence after one nudge (d18fde0), and a printed call is nudged into
a real one (be0b468). The first Linux containment run in CI (`lane/linux-containment`, 140 / 7)
found writes outside the workspace succeeding under bwrap, toolchains under the home directory
invisible to the sandboxed shell, and plugin tools registering nothing — the backend fixes are in
the Codex session's working tree. Two free-route series stopped on ollama.com 500s on OpenCode's
side: three scored pairs, one run each, [free-a](../evidence/comparison-20260910-free-a.json),
[free-b](../evidence/comparison-20260910-free-b.json),
[qualifications](../evidence/comparison-20260910-free-notes.json). Codex quota stayed exhausted
all afternoon, so the paired frontier run on the new build is still owed. Installed:
`v0.4.1-dev+be0b468`, CLI `afb4c8a1…`.

**2026-09-10, later: the step-count leaks.** Finish gates, nudges and the second wind now tag
what they append and the engine persists it (`user_msg` with a `harness` field); a plan with
every step completed and evidenced stands the execution-evidence and fix-verified gates down;
the check log is written at execution time and serial calls are barriers, so `bash` then
`record_evidence` in one response cites a check already on record (one completion fewer, in
the engine regression); the recurrence detector counts failures and deterministic refusals and
ends the run resumably on the second recurrence; narrate-then-silence is accepted after one
nudge; bookkeeping tools skip the supervisor screen. All five dogfood findings are addressed.
Full-suite confirmation, reinstall and commit wait on the machine: it is in clamshell sleep on
battery, awake for seconds at a time (`pmset -g log`). Details: [harness status](../harness-status.md).

**2026-09-10, the Pilot H trace, read from its own database.** Per-completion cost was identical
to OpenCode's; the gap was 13 completions to 9. Three went to the command classifier rejecting
executed compound checks (fixed in the working tree, verified against the exact commands), and
the prompt cache froze at 12,160 tokens for nine completions — about a quarter of the spend —
from the first request that carried the plan-ledger block as a trailing user message. Rune's
request items were a byte-identical prefix of the next request's, so this is the Codex backend's
behaviour, reproduced live with `scripts/verify-codex-tail-cache.ts` on gpt-5.6-sol: the loop
that ends on `function_call_output` extends its cache every turn, the loop that ends on a user
message does not. On `codex` the ephemeral tail now rides inside the last tool output
(`foldsEphemeralTail`); other hosts are unchanged. Unit **4,363 / 0** unsandboxed, the new
integration suites 14 / 14, mock **63 / 63**, typecheck and formatting clean; installed as `v0.4.1-dev+99a22f8`
CLI `a2be4b86…`. Pilot I was unscored (429); the paired re-run on this build is the measurement
that is still owed. Details: [harness status](../harness-status.md).

**2026-09-09, audit follow-through — browser containment and verification receipts.**
The live frontend pilot exposed two connected defects: Chromium crashed under the macOS shell
profile, and a successful `node browser-test.mjs` did not count as verification. Narrow startup
allowances now support foreground/background browser checks with the tested path denials intact.
Command classification now recognizes executed check scripts, and the plan, citation log and
live/replayed lessons share the child exit verdict. Failed commands and echoed test names no
longer acquire positive citations. Working fixes on `ae1847c` are installed as
`v0.4.1-dev+ae1847c`: unit **4,309 / 0**, integration **141 / 0**, Rust **94 / 0**, mock **63 / 63**;
the existing filesystem/toolchain skips remain disclosed. A live verification of the existing
frontend ran its check once, read the screenshots and closed cleanly in 53.4 s / $0.0647 estimated
list cost, six primary calls. This is a targeted regression check, not competitive parity.
Full comparisons, qualifications and artifact hashes: [audit follow-through](../audit-followthrough-20260908.md).

**2026-09-09, the first fully green CI run, and v0.4.1.** Lane P13.3 took the Windows unit job from
about nineteen failures to two using only the CI log: two were product defects — the plugin
integrity digest hashed raw bytes, so a `core.autocrlf` checkout failed every plugin's verification,
and the MCP connector preflight neither found `.cmd`/`.exe` commands nor suggested paths on a drive
— the rest were tests spelling paths one platform's way, and five hook tests now skip on Windows
because `hooks.ts` still spawns `/bin/sh` (backlog P10.2). Two leftovers (an absolute-path check
written as a leading slash, a fixture matching a POSIX suffix) went in b04dff1, and run 34332238432
came back **22 of 22 green** in six minutes, the first fully green run since the repository went
public. **v0.4.1** was tagged at 5a808b4 and the release workflow published all eleven assets with
**13 of 13 jobs green, the Windows fresh-machine install included** — install, `--version`,
`doctor`, `tools-smoke`, a headless prompt and `serve --check`, the step v0.4.0 failed. The release
commit's own CI run then failed one Windows unit test: the Python syntax checker's three-second
budget expired on a cold interpreter start and the runner reported the file _clean_ instead of
_inconclusive_; a timeout now returns null (785de65) and the test warms the interpreter first.
Installed locally from the tagged tree: `Rune v0.4.1`.

**2026-09-08 (night), three unverified cells verified.** The Windows release log, read with a
re-authenticated `gh`: install, `--version`, `doctor`, `tools-smoke` and a real headless prompt all
passed on the fresh Windows runner; only `rune serve --check` failed, at "opening a session over the
websocket", after a 21 s connect timeout — the server talks to its session hosts over a unix socket,
which is the Windows gap; lane P13.2 is on it with the CI Windows job as the only test bed. The
comparison harness in `tests/eval/comparison/` recorded its **first paired free-route series**: Rune (installed binary,
`ollama-turbo`) against OpenCode 1.18.23 (`ollama-cloud`, its own key) on the identical
`gpt-oss:120b`, three tasks × two runs — **Rune 6 / 6, OpenCode 2 / 6**, Rune about twice the
estimated list-equivalent cost across all attempts, similar mean wall time —
[docs/evidence/comparison-live-20260908.md](../evidence/comparison-live-20260908.md). The
sub-agent layer was watched live for the first time: three `task` reviewers fanned out on a free
route, their findings merged into a severity-ordered review, two fixes landed with tests, 11 / 11 —
[docs/evidence/subagents-live-20260908.md](../evidence/subagents-live-20260908.md). The README's
pitch paragraph and verified table carry both. Still unverified: the GitHub MCP connector (needs a
token the founder has not created), vendor OAuth, `worker` sub-agents, the team bus, hours-long runs.

**2026-09-08 (evening), P13.1 prompt overhead — landed, measured, one gate reverted.** The Opus
lane merged at `ccfaec3`: a request carries full schemas only for the core tools and one-line catalog
entries for the rest (advertised schema bytes −53%), the dashboard charter is delivered when a
dashboard enters play, and the read-back, ambiguity and greenfield sections leave after the first
completion. Gates: unit 4,231 / 0, integration 130 / 0, mock evals 63 / 63, governance 0.26.
Three detached runs of the same task on `ollama-turbo/gpt-oss:120b`, one per build, in
[docs/evidence/live-run-long-20260908.md](../evidence/live-run-long-20260908.md): per call, fresh
input tokens −15% to −23%, doctrine −32%, schemas −33%, every run finished with independently
passing tests. The lane had also gated `# Plan and track` after the first completion; malformed
`todo_write` calls went 1 → 7 on that build and back to 3 with the section restored, so `cdfb475`
keeps it on every completion, with a test that says why. Per-task completions varied 29 / 28 / 60
across the three runs — the model's route choice, not the prompt — so per-task cost at one run per
arm is noise; the comparison harness with several runs per arm is the next measurement. OpenRouter's
seeded free models were re-probed: `minimax-m3:free` is gone, `nemotron-3-ultra:free` is the seed.
Installed `v0.4.0-dev+cdfb475`.

**2026-09-08 (afternoon), public and released.** The founder made the repository public and
renamed it `ritikkyyadav/Rune`. The remote and all 33 in-repo references follow; the stale `main`
(a July merge) was merged in and `main` now carries the shipped tree, so the README's one-line
installers fetch current scripts. The `v0.4.0` tag was re-pointed at `5046b61` and pushed; the
Release workflow ran on the public repository and **published the release with all eleven
`rune-*` assets** (https://github.com/ritikkyyadav/Rune/releases/tag/v0.4.0). Twelve of thirteen
jobs green; the **Windows fresh-machine smoke failed** at "version, doctor, tools, and a real
prompt" — the log needs an authenticated `gh`, which this machine's keyring no longer has, so the
Windows install of 0.4.0 is unverified. The published one-liner was run into a throwaway `HOME` on
macOS: assets verified against `SHA256SUMS`, `Rune v0.4.0`, doctor green.

Then the long live check found a defect: `rune detach` parsed `-p`, `-m` and `--gear` and forwarded
none, so a detached run always booted on the pinned model — that day a free model OpenRouter had
retired, and the run died at its first completion after printing "detached run started". Fixed in
`a93731f` (session-scoped route env that beats the pin; the host says when a named provider has no
credential); installed `v0.4.0-dev+a93731f`; the retry completed a nine-file CLI project with tests
on `ollama-turbo/gpt-oss:120b`, 28 tool calls, 29 completions, `finished`, and the project passes
its own tests outside the agent —
[docs/evidence/live-run-long-20260908.md](../evidence/live-run-long-20260908.md). 96 KB per call
on that run: doctrine 40%, tool schemas 31%, conversation 28%. Lane P13.1 (prompt overhead) is in
flight. Housekeeping: installer backups 11 GB → 84 MB, the lane worktrees removed, the collision
stash dropped. Six untracked files under `docs/` belong to a concurrent session's audit
follow-through and were left alone.

**2026-09-08, Phase 12 — merged, gated, installed, run live.** The five lanes of
[12-ship-zero-spend.md](12-ship-zero-spend.md) landed on `gear/phase-0-stabilize`: P12.4 at
`5db254d`, P12.3 at `b178922`, P12.5 at `4e84c4f`, P12.2 at `dd1acb2` (one conflict, the doctor
command, where the provider-health and MCP sections met; both kept), P12.1 at `25c7268`. Final gates
with the outer sandbox off: unit **4,199 / 0**, integration **129 / 0** (5 skips are missing
Go/Java toolchains), mock evals **63 / 63** with governance at 0.26 completions per task, safety corpus
**P 90.0 / R 89.1**. Installed `v0.4.0-dev+d0c33e5` (checksum `54a3c6e0…`); `rune doctor` and
`rune tools-smoke` green; one headless task on the free ollama.com route completed and its tests pass
outside the agent — [docs/evidence/live-run-20260908.md](../evidence/live-run-20260908.md).

Three things the gate found that the lanes' own reports had read differently:

- **Two false regressions.** A mock-eval score of 25 / 63 and five unit-suite timeouts were the
  outer sandbox (rune-tools' Seatbelt cannot nest) and three suites running at once; idle and
  unsandboxed, both are clean. The safety corpus at P 65.0 was the eval process never probing
  sandbox capability, so the 2026-09-07 policy routed every writable shell command to the
  reviewer that `--offline` kills. `5eab2da`: the harness states the machine it models, and
  `--uncontained` measures the host-shell path on purpose.
- **One real defect.** `[routing] helper` meant `auto` when unset, and `auto` crosses providers: an
  integration test's compaction summary was written by a live free model because the engine's
  gateway also held this machine's credentials. `d0c33e5`: unset is off; `auto` is opted into.
- **The economics number.** On the live run, 84 KB per prompt: doctrine 46%, tool schemas 50%,
  conversation 4%, cache read 0% on that route. The fixed overhead is the next target, and it is
  measured now.

Open for the founder: make the repository public (GitHub Actions is free there; the release
workflow cannot run until then), then confirm CI on the `v0.4.0` tag and the `rune-*` assets. Not
done in this phase: the GitHub MCP connector and vendor OAuth (no credentials), long-horizon live
validation, the helper route's live effect.

**2026-09-08, Phase 12 — P12.4 (onboarding, a truthful README, 0.4.0 prep).** Landed on
`lane/p12.4-onboarding-readme-040` off `6452981`. The main session extends this entry with the
other four lanes.

- **First run.** `/login` now leads with the routes someone with no budget can start on — OpenRouter,
  Google, ollama.com, GitHub Models, local Ollama — each marked in its label, with the free tiers
  named at level 1 before the roster count. The sort is stable, so the frontier labs still lead the
  paid block in their old order, and the marker is a suffix on a string the picker already renders:
  no layout change. `FREE_TIER` is deliberately its own small table rather than a reuse of
  `PROVIDER_CAPACITY`, which answers a different question (what to fall back to mid-task, where
  Google is `funded`).
- **Measured.** `tests/integration/fresh-home-onboarding.test.ts` walks the headless equivalent of
  the first run against an empty `RUNE_HOME` — doctor, connect a route, `rune use`, one prompt,
  doctor again — against a local stub speaking the OpenAI wire. **0.8 s end to end** on this
  machine; the assertion is a 180 s budget. It binds a port, so it needs the unsandboxed run.
- **`rune doctor` reads `provider-health.json`.** The file is pruned only on write, so a machine that
  stopped calling keeps records nothing believes. Doctor now prints each route's window — in force
  with time left, or expired with how long ago and marked STALE — and names a retirement filed
  against the wrong route. The founder's own record has one of each: a Codex cap that expired
  2026-09-07 19:34, and a `google` retirement for `gpt-5.6-sol`, which is a Codex model id.
- **README rewritten** around a three-column "What is verified" table (verified live · verified by
  tests or mocks only · unverified), with the experimental features named as such and the pitch
  stated as completion rate and auditability on free and rotting lineups — explicitly not parity.
  Placeholders are left in the table for P12.1–P12.3.
- **0.4.0 prep.** `[Unreleased]` became `## [0.4.0] - 2026-09-08` with an empty Unreleased above and
  marked placeholders for the four sibling lanes; eight package manifests and the Cargo workspace
  are at 0.4.0, and `bash scripts/version.sh` reports it. **No tag.**
- **Two rename leftovers fixed**, both found by auditing the release path in both directions:
  `web-install.sh` ended with `Then run: gear`, and `release.yml` staged its verified download into
  `$HOME/gearbin`. The four asset-name paths (`targets.sh`, `release.yml`, `web-install.sh`,
  `install.ps1`) already agreed on `rune-*` and are now pinned by a test. The mismatch this
  program recorded is on the other side and cannot be fixed here: **every published release up to
  v0.3.1 carries `gear-*` assets**, so the one-line install works only from v0.4.0 onward.
- **One defect outside the lane's scope, fixed because it is what a new user reads:** `rune --help`
  printed a hand-written `-p` union of six providers against a 37-preset roster. Derived now.

Still open after this lane: the tag and the release (founder), the repository is still
`ritikkyyadav/Alan` and private, no mark, and nothing here is measured on a live long run.

**2026-09-05, the capability-cap program.** The "Rune at 72" scorecard was checked against `~/.rune/rune.db` and `~/.rune/blackbox.db` (three of its claims did not survive: the retro is per-run correct, the sub-agent empty-summary failure was already fixed, the pitfalls read-back already existed) and the record's real limiters were fixed the same day — see `docs/program/capability-cap-program.md`. Landed: `[reliability] maxTurns` / `secondWinds` (the 80-turn constant is gone), second wind no longer vetoed by a struggle nudge (it had fired zero times in a month), turn refunds for completions the harness discards (`turn-refunds.ts`, `loop.turn_refunded`), the tool rate limiter turned into a pacer (reads exempt, short waits absorbed, `[tools] rateLimit`), the loop detector keyed on results with a `loop.result_loop` nudge, `steer` remedy lessons so retros stop producing nothing, tactic titles that name runners, a search-backend cooldown, and a test for the malformed-call answer. Gates green; mock evals 63/63 **with the outer sandbox off** (rune-tools' Seatbelt cannot nest — inside it four bash-check tasks fail and read as a false regression); integration 107 + 5 skips + the known LSP failure; binary installed.

**2026-09-03 (evening), the product is the terminal.** The founder's direction: the CLI/TUI interface only, and a new name. Removed: `apps/web` and the bundle embedded in the binary, `rune web` / `rune open` / the bare-command browser entry, `apps/vscode` (a webview around that bundle), `tests/e2e` (Playwright), the brand-checklist and web unit suites, the token-CSS, mark and primitives generators, and the web design docs. Kept: `rune serve` (the WebSocket engine for `rune attach ws://` and the SDK, now without a static-page branch), `rune serve --check` (trimmed to the host-spawn proof: one session over the socket, no host left behind), ACP, headless `-P --stream-json`, and P11.1's task state, narrative events and Decision Record. **Renamed Gear → Rune** everywhere a name appears — packages `@rune/*`, crates `rune-*`, the `rune` binary and `rune-tools`, `~/.rune` and `rune.db`, `RUNE_*` env, `.rune/` in a workspace, `RUNE.md` — with one generation of read-through for existing data: the first start moves `~/.gear` to `~/.rune` (symlink left behind) and renames `gear.db` and `GEAR.md`; `GEAR_*` variables are adopted; the `gear` keychain service, `gear:` auto-commits, the playbook and evolve markers, `/etc/gear` org policies and `gearVersion` manifests are still read. The permission ladder keeps its vocabulary (`--gear 1..4`, `/gear`, "4th gear"). **The accent is the founder's violet `#A28CF3`**, exact on the dark ground and derived to `#9682E1` on paper for a 3:1 floor. Open: a v0.4.0 release (the installers now look for `rune-*` assets that no published release carries yet), the GitHub repository is still `ritikkyyadav/Alan`, and the eight-tooth gear glyph in the wordmark no longer matches the name.

**2026-09-03, shipped.** v0.3.0 is published with eleven assets (https://github.com/ritikkyyadav/Alan/releases/tag/v0.3.0); its Windows binaries carry the edit-after-read defect, fixed in v0.3.1 (P10.1 + P10.2 merged). v0.3.1 is published too, with the Windows fresh-machine install green. Base after Phase 10.1, 10.2 and 10.3: `4c1fd9c` (P10.3: reviewer-only blocks caught 13/46 → 35/46 with precision unchanged; corpus in CI). P10.4 merged at `4c76ddd`: the verifier detects Go, Python, Rust, JVM and JS/TS projects, runs only the project a step touched, records command, exit code and duration as evidence, and the mock eval baseline is immutable unless `--write-baseline` is passed (55 of 55). P10.5 merged at `74d38fd`: AWS Bedrock, Google Vertex AI and Azure OpenAI as auth-and-endpoint variants over the existing adapters (no cloud SDKs; SigV4 proven on AWS test vectors; ADC JWT verified), the model tables one generated source, `rune models` live discovery cached an hour; live cloud acceptance unverified for lack of credentials. P10.6 merged at `cb4e09b`: all five integration proofs verified locally (a real VS Code loaded the extension; ACP conformance through the protocol's own client; the review workflow's mock path; `rune pr`; remote attach as two processes), fixing four defects only a live load could find. **GitHub Actions is blocked at the account level** ("recent account payments have failed or your spending limit needs to be increased"): no CI or release run executes until Billing is fixed; merges since #19 rely on the local gate. P10.7 merged at `8d09770`: a schema-validated plugin index behind `rune plugin search` and `add`, and executable plugin tools as sandboxed subprocesses whose declared capabilities become their permission category; the two refusals (out-of-workspace write, undeclared port) are made by Seatbelt itself. Known gaps stated in the threat model: per-host egress is port-level on macOS and absent on Linux; plugins are integrity-checked, not signed. P10.8 merged at `b7d4af4`: a context eval family driven by a faithful mock summarizer (4/7 → 7/7; mock suite 62/62) and four compaction fixes, the largest turning a compaction that freed 1.2% of the window into one that frees half. **Found in the founder's first live preview (installed binary):** the compiled build cannot find its web bundle and cannot spawn session hosts (`/$bunfs/root/engine-host.ts`), so `rune serve` from the release binaries cannot serve the product; repaired in P10.9a, merged at `cc487aa`: the bundle is embedded in the binary, hosts spawn from the binary itself, and `rune serve --check` proves a compiled artifact serves a page, delivers its assets and completes a session; it now runs inside the installer, the release build and the packaged smoke on all three OSes. The installed binary on this machine passed it (`v0.3.0-dev+cc487aa`). A v0.3.2 tag waits for GitHub Actions to be unblocked. P10.9 merged at `92f3f37`: fleet grouped by workflow wave, research on the workflow executor, two example workflows with a kill-and-resume test, the trace rail closed by default, a responsive shell, and the held-step test explained (two reviewer timeouts in a fixture with no reviewer; 16.7 s → 3.8 s).

**Phase 10 is complete.** Gates at the last merge: typecheck, lint and format clean; 3,587 unit tests; 108 integration tests (5 skips are live cloud-provider tests without credentials); 62 of 62 mock evals; the safety corpus at 35 of 46 reviewer-only blocks with no model call; zero leaked hosts. Bench re-score (judgment, same weights as 2026-09-02): capability about 128, maturity about 51, blended about 97. The remaining points are the founder's: a public install link, an external user, GitHub Actions unblocked, provider credits for the live gates. Phase 9 (the web product, PR #13) merged at `b7d6a59`; the base is `70da8c7`; **v0.3.0 is tagged** and the release workflow is building. `rune` starts the engine and opens the app in the browser; the installed binary reports `v0.3.0-dev+70da8c7` because it was compiled before the tag (a rebuild after the tag reports `0.3.0`). Gates at the merge: typecheck 16/16, lint 9/9, format clean, unit 3,112/0, web + brand 86/0, integration 60/60 (one test needs the machine free of leaked hosts; see backlog), mock evals 48/48.

Next: P11.3, the shell (the deck, the intent strip, Active work / Needs you, the task surface), held until the founder answers the four questions at the end of [11-intent-layer.md](11-intent-layer.md).

**Earlier: the merges.** All nine pull requests are merged into `gear/phase-0-stabilize` at `aedca56`; every gate was green after the last merge (typecheck, lint, format, 3,069 unit tests, 60 integration tests, 48 of 48 mock evals, desktop typecheck). The binary is installed from that commit (`v0.3.0-dev+aedca56`); `rune doctor`, `rune tools-smoke` and a headless prompt pass. No tag yet: the founder corrected the product surface the same evening, and the tag waits for [Phase 9](09-web-product.md), the web product in the current identity, so the release does not carry the dropped theme.

## Merge record

| #   | PR                  | Merge     | Conflicts resolved                                                                                                                  |
| --- | ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | #12 spine evals     | `5db0545` | none; eval gate 43/43 from here on                                                                                                  |
| 2   | #4 Ship             | `daf2bed` | backlog (both lists)                                                                                                                |
| 3   | #5 Connect anything | `019ef0c` | backlog; `config.ts` kept `update?` and `mcp?`/`extensions?`                                                                        |
| 4   | #7 Cheaper per task | `3115801` | `registry.ts` kept the deferred catalog and per-family descriptions                                                                 |
| 5   | #6 One protocol     | `4caaab1` | `rune-cli.ts` kept all option declarations; `engine.ts` one import of `isVerificationCommand` from `./brief`                        |
| 6   | #9 Flagship surface | `30ec53c` | none (retargeted first)                                                                                                             |
| 7   | #11 Surfaces        | `4803004` | backlog                                                                                                                             |
| 8   | #8 Trust            | `71fab59` | `owner`/`claimedAt`/`structured` moved onto the `@rune/protocol` types; `worker.ts` kept `workRoot` and the typed `onEvent` channel |
| 9   | #10 Self-improving  | `aedca56` | backlog rebuilt as the union                                                                                                        |

Fix commits: `a464234` (the `custom` provider was rejected by the sticky-model preset gate in both entry points, so Phase 8's replacement for the dropped local provider never survived a restart; two tests, doc updated), `84b665e` (lane B fixtures repointed from `lmstudio` to `custom`), `030efb6` (backlog: a stale gitignored `apps/desktop/dist/` makes the brand-checklist test audit old bytes; rebuild first).

## What is true now

- `rune doctor` reports supervisor false-positive kills at 0.98 per 100 runs, with the caveat that the new per-verdict rows have no denominator yet.
- A run writes `.rune/skills/playbook/PENDING.md` into the workspace and `.gitignore` does not cover it (backlog).
- The founder's own `filesystem` MCP server points at `/Users/ritikyadav890/Projects/Alan` (typo), so `rune -P` prints a connector-down notice; fix in the user's `mcp.json`.

## Pull requests

| PR              | Phase                         | Lane | Head → base                                                        | Landed                                                                                                                                                                                         | Open items                                                                                                                                                         |
| --------------- | ----------------------------- | ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #4              | 1 Ship                        | A    | `lane/a-phase-1` → base                                            | 6 of 7 items; Apache-2.0 LICENSE in its own commit (D1)                                                                                                                                        | signing steps guarded but never run (no Apple / Authenticode certs); public install host (D1); Windows runtime smoke found a real edit-after-read defect (backlog) |
| #5              | 4 Connect anything            | C    | `lane/c-phase-4` → base                                            | 7 of 7; schema tokens/request −89.9%; OAuth 2.1 proven against a local mock server                                                                                                             | live vendor OAuth (Notion, Slack, Linear) unverified: no credentials                                                                                               |
| #6              | 2 One protocol                | B    | `lane/b-phase-2` → base                                            | 9 of 9; `@rune/protocol`, `rune serve`, replay, typed child events, `--stream-json`, SDK seed                                                                                                  | in-process concurrency stays one turn per host process (by design)                                                                                                 |
| #7              | 8 Cheaper per task            | A    | `lane/a-phase-8` → base                                            | 8 of 8; copilot removed (D5, zero sessions), lmstudio dropped, explicit cache policy, effort dial wire tests                                                                                   | cost-per-task drop unmeasured: OpenRouter has no credits, Codex quota exhausted                                                                                    |
| #8              | 6 Trust you can measure       | C    | `lane/c-phase-6` → base                                            | 11 of 11; 227-row corpus, per-source P/R, supervisor false-positive rate 30.6%, worktree workers with shell, schema results, budgets, shared ledger, `rune workflow`                           | 38 corpus labels need a human; second-tier reviewer report blocked on Codex quota; fleet-view grouping waits for #6                                                |
| #9              | 3 The flagship surface        | B    | `lane/b-phase-3` → `lane/b-phase-2`                                | 7 of 7; `rune desktop` launches, one passthrough bridge, `rune serve --web`, Savoir tokens as the single source, contract M2–M4, console frozen, review tab, 4-platform Tauri matrix + updater | in-app OAuth prints `rune login <provider>`; installed app 80 MB (sidecar embeds Bun); updater keypair, certs, icon, download host are founder actions             |
| #10             | 7 Self-improving              | C    | `lane/c-phase-7` → `lane/c-phase-6` (also merges `lane/a-phase-1`) | 10 of 10 + corpus review sheet; attribution hashes, variants allowlist, paired A/B, promote/revert ledger, lifecycle, flywheel, anchors, 21 invariant tests                                    | real A/B arm never run (Codex 429): the loop is closed, not yet measured                                                                                           |
| #11             | 5 Everywhere the work happens | B    | `lane/b-phase-5` → `lane/b-phase-3`                                | 5 of 5; `@rune/sdk` packable, `rune attach ws://`, `docs/ci.md` + `action/` + gated review workflow + `rune pr`, `rune acp` with harness, `apps/vscode` .vsix                                  | Zed and a live VS Code load unverified; npm, marketplace and action publishing are founder actions                                                                 |
| fix/spine-evals | repair                        | —    | → base                                                             | in progress                                                                                                                                                                                    | two spine mock evals regressed with the landing commit `b150dd2` (pass at `b1901e9`)                                                                               |

## Base branch repairs made during execution

`gear/phase-0-stabilize` had been red in CI for days, and each red job hid the next, because `build`, `eval` and `integration` are skipped whenever `ts-lint` fails:

1. `2ceba19` — CI ran only on pull requests to `main`; added the base and `lane/**`.
2. `ede10e9` — a Linux-only unit failure: the shared token counter leaks calibration across test files and bun's file order differs by platform; reset per test.
3. `e4fea93` — Prettier over the files landed by `b150dd2`.
4. `e5253e0` — eight `rune-tools` shell tests gated `#[cfg(unix)]` (fail on windows-latest).
5. `1a9babb` — `bun audit`: two high advisories in `browserslist` via `@vitejs/plugin-react`; root override to a patched release.

Lane branches received `style: prettier pass` commits and, where needed, an empty commit to fire CI (`reopened` does not create a run; `synchronize` does).

## Merge order

1. **`fix/spine-evals`** first, so the eval gate is green on the base before anything else lands.
2. **#4** (ship). Decide the LICENSE commit (D1) at merge time.
3. **#5** (connectors) and **#7** (economics), independent of everything else. Expect small conflicts in `rune-cli.ts` (dispatch hooks) and `README.md`.
4. **#6** (protocol) → retarget **#9** to the base → merge → retarget **#11** → merge.
5. **#8** (trust) → retarget **#10** to the base → merge. #10 already merged `lane/a-phase-1`; after #4 is in, its merge commit is redundant and harmless.
6. Expected conflict hot spots across lanes: `packages/orchestrator/src/bin/rune-cli.ts`, `engine.ts`, `packages/shared/src/config.ts`, `docs/auto-mode.md` (#4 rewrote sections; #8 and #10 appended), `docs/program/backlog.md` (append-only, keep both).
7. After the last merge, from the main checkout: `scripts/install.sh`, `rune doctor`, `rune tools-smoke`, then tag `v0.3.0` (the release workflow is tag-driven and refuses a tag that does not match the reported version).

## Phase 9, 2026-09-03

The correction landed. There is no native desktop application: `apps/desktop`
is `apps/web`, `src-tauri` and every `@tauri-apps` dependency are gone, and
`rune` with no arguments starts the engine as a local server and opens a
browser tab on it. `rune --console` (alias `rune tui`) is the terminal.

The Savoir visual system applied in Phase 3.3 is deleted — tokens, stylesheet,
mark, fonts and the console's palette — and replaced by the solid
electric-blue eight-tooth rune on a near-white ground. The mark is generated
from eight numbers so the founder's vector can replace it byte-for-byte.

Two defects found by the phase's own gate and fixed in it:

- **The engine host truncated any response larger than the socket buffer.**
  Bun's `write` reports the bytes it took and queues nothing; the host ignored
  the number, so `get_turn_context` (the whole assembled system prompt) went
  out cut in half and the caller waited fifteen minutes for a line that never
  ended — wedging every later request on the same connection. Present since
  `rune serve` shipped, and reachable from the trace rail with one click.
- **The session list was never fetched after the transport opened**, so a page
  reload came back to an empty sidebar. Invisible until a reload had to restore
  something, which is the case the whole URL product rests on.

## Phase 11, 2026-09-03

The founder's second correction: after using the Phase 9 app he called it a chat interface, and the product is an intent layer ([11-intent-layer.md](11-intent-layer.md)): a static left deck, an intent strip, a task surface the agent composes from a closed catalogue of primitives, experimentation shown live with refuted branches folded, and every task ending in one Decision Record. Two of five items are merged; the shell waits on four founder answers.

- **P11.2 (#24) merged at `b00e56b`.** Thirty primitives, each with ready, empty, loading and error states on both grounds; the projection schema; six persona composers (investigate, build, analyze, research, operate, write); the `applyModelChoice` fallback that keeps a bad model choice from breaking the surface; and `/gallery`, the whole vocabulary on one screen. Its claim that the mock suite scored 23/62 on the base was not reproducible in a clean export of `02eee64` (62/62 with and without `RUNE_TOOLS_BINARY`) and is withdrawn in `760cf12`.
- **P11.1 (#25) merged at `82f7504`.** Eight narrative events (protocol 22 → 30) reduced in all six reducers and the ACP table; the task state's `kind`, `narrative`, `artifacts`, `pendingDecisions` and `progress`; the `note_hypothesis` and `record_decision` tools with refutation inferred from a failing check; the Decision Record generator, `rune audit --record` and its export; a narrative eval family with its baseline row. Two engine defects found by that eval and fixed in the PR: the spine judged a check by the tool's success flag rather than its exit code, so "no completion right after a failing check" (documented since `b150dd2`) never fired for a model-run check; and a refuted branch's reason was the runner's version banner, because `bun test` writes its verdict to stderr. The Intent Interpreter's model call is off by default (`[intent] interpreter`): scripted providers hand out responses in order, so a hidden call at task start consumed one, and in production it is a round trip before the first token to decide a layout; the deterministic reader is always on.

Gate at `82f7504`: typecheck 16/16, lint 9/9, format clean, unit 3,861 / 0, integration 108 pass / 5 skip (live cloud providers without credentials), mock suite 63/63 with no regression and the baseline unchanged, the safety corpus offline unchanged, zero leaked hosts.

Held: P11.3 (the shell), P11.4 (narrative in motion and the Decision Record surface) and P11.5 (proof) wait on the founder's answers: the wireframe, the name for connected applications ("Apps" is the placeholder; not "plugins", not "connectors"), what "teams" means in Settings, and the mark (the shipped rune is provisional; the founder called it terrible).

## Founder actions the agents could not take

- **D1**: public repo or a public releases mirror + install host; the LICENSE decision; npm scope for `@rune/sdk`; the VS Code marketplace publisher; whether `savoir/rune-action` gets its own repo.
- **D2**: ~~confirm the Savoir DNA~~ **answered and executed in Phase 9.** Still wanted: the ORIGINAL vector of the blue rune (the shipped mark is recreated from the brief's geometry and lives at `apps/web/branding/rune-mark.svg`), the story copy for first-run and the download page, and the ruling on "Rune" vs "Savoir Rune".
- **Certificates and keys**: Apple Developer ID + notarization, Windows Authenticode, the Tauri updater keypair, `RUNE_SIGNING_PRIVATE_KEY` for Linux signatures (`bun scripts/keygen.ts`), `RUNE_REVIEW_API_KEY` for the PR review workflow.
- **Live capacity**: OpenRouter credits or a Codex quota reset unblock four gates at once: Phase 7's real A/B arm (`rune evolve ab doctrine_full --real`), Phase 8's cost-per-task comparison (`bun run eval -- --real --compare`), Phase 6's second-tier reviewer report, and the anchor benchmarks.
- **Labels**: review the 38 inferred corpus rows listed by `bun run eval:auto-safety --list` (the review sheet from Phase 7 recommends a label for each).
- **Validation**: two people on two other machines (Phase 1.8), recorded in `docs/validation.md`.

## Open defects found by execution

- ~~Windows: `edit_file` refuses right after `read_file` of the same path (path-key mismatch in the read-before-edit ledger). First Windows runtime smoke ever.~~ **Closed by P10.2.** The executor echoed `\\?\C:\…` (Rust's `canonicalize` is verbatim on Windows) while the ledger looked up `C:\Users\RUNNER~1\…` (`%TEMP%` is an 8.3 short name). Four more Windows defects fell out of turning `ts-windows` into a real test run: `startsWith(root + "/")` as a containment test in three places, shell unescaping that ate every pasted Windows path, and `/bin/sh` as the only shell. `ts-windows` now runs the unit suite; what is genuinely POSIX-only skips with a stated reason.
- ~~Auto mode: supervisor false-positive rate 30.6%; the cheap reviewer catches 13 of 46 reviewer-only blocks; five breaker gaps with file:line in the backlog.~~ **Closed by P10.3.** All five breaker gaps are closed mechanically with a unit test each, plus eleven more shapes the same corpus pass exposed; reviewer-only blocks caught went 13/46 → 35/46 offline, all 35 with no model reachable at all. The fast screen was rewritten against measurement rather than argument: on the 97 supervised-tier rows it actually sees it now fires on 3 of 86 ordinary rows (3.5%, was 14.0%) while catching 9 of 11 blocks. The corpus now runs in CI offline on every change. What is left is genuinely semantic — eleven rows where the same action is authorized or not depending only on what the user said — and one of them has an identical twin on the allow side.
- Two flywheel classes waived with dated reasons (`crash.dirty_exit`, `context.budget_overflow`).
- `scripts/install.sh` never prunes binary backups (~95 generations in `~/.rune/bin`).
- `notebook/store.ts` `decay()` conflates disuse with staleness.
- `parseArgs` runs `strict: false` in `rune-cli.ts`, so undeclared long options silently lose their values.

## Operating notes for the next executing session

- The worktree tool forks from `main`'s tip; every agent must branch explicitly from the current tip of `gear/phase-0-stabilize` (or its lane parent).
- Three Opus agents in parallel exhaust the account's five-hour session limit; two at a time held. Killed agents resume with their context; per-item commits bound the loss.
- Agent gates must include `bun run lint && bun run format:check` and `bun run eval -- --compare` with a freshly built `rune-tools` (`RUNE_TOOLS_BINARY`), not only typecheck and unit tests.
