# Changelog

All notable changes to Rune are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Rune adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version a build reports comes from exactly one place — `scripts/version.sh`, injected at compile
time — so a released binary cannot disagree with the tag beside it. Untagged builds report
`<semver>-dev+<sha>`.

## [Unreleased]

## [1.3.0] - 2026-09-28

**Runs that come back.** A headless run stopped by a provider limit can now resume on its own,
within a deadline, a budget and a resume count you set. And Auto's containment, background shells
and `config.toml` each lose a class of silent failure, found by turning another coding agent's
public changelog into tests. Full notes: [`docs/releases/v1.3.0.md`](docs/releases/v1.3.0.md).

### Added

- **Missions: a headless run that comes back after a provider limit.**
  `rune -P "…" --resume-until 8h [--resume-budget 2] [--resume-max 12]` waits for the provider's
  own window, or backs off from 5 minutes to a 4-hour cap, and continues the same session until
  the task is done or a limit is reached. Plans live in `rune.db` and survive a restart:
  `rune missions` lists them, `rune missions run` continues this workspace's due ones (for cron or
  launchd; there is no daemon), and `rune missions cancel <id>` stops one. One plan is resumed by
  one process, and a cancel holds. Without `--resume-until` a headless run is unchanged. See
  [`docs/missions.md`](docs/missions.md).
- **Rune Mono.** Black-and-white chrome, white on dark and black on light, with a matte finish
  (the default) beside the crisp one; one full-width selection bar on every list; a quieter
  header and an empty idle frame; one status line with the gear, the model, and only the keys
  that act now.

### Fixed

- **The fixed frame holds in macOS Terminal.app, and the wheel scrolls the transcript.**
  Terminal.app turns the wheel into arrow keys only for a program in application cursor mode, so
  it scrolled its own window instead: the header slid down and the footer dropped off the bottom.
  Rune now sets that mode while it runs and resets it on exit, and no longer erases the display
  on entry, which gave the window a blank band to scroll into.
- **Recursive deletes are judged by what they reach, however they are spelled.** `rm -fr`,
  `-r -f`, `--recursive --force`, `-R`, `..` escapes, the workspace itself (`.`, `"$(pwd)"`,
  `cd .. && rm -rf <workspace>`), `.git`, and targets only the shell resolves (`$TARGET`,
  `xargs rm -r`) were allowed in Auto with no screening. Outside the workspace now halts; the
  workspace, its history or an unresolved target waits for you with the literal next step; build
  output (`rm -rf ./build`, `node_modules`, `dist/*`) stays ordinary. `git checkout -- .`,
  `git restore .` and `git clean -f` stash uncommitted work first, like a hard reset. Windows
  drive-letter and UNC paths are recognised as paths.
- **`config.toml` is read as TOML.** A list written over several lines was read as the string
  `"["`, so a multi-line `denyRead`, `denyRules` or `excludedCommands` was dropped without a word;
  a quoted value was cut at `#`; a quoted list item was split at its commas; and a path Rune wrote
  read back with doubled backslashes. Bun's TOML parser reads the file now. A file it refuses still
  applies what it can, with a warning naming it, and setting a key written over several lines
  replaces all of it.
- **Background shells end with what started them.** Closing an engine stops the shells its bash
  started. A stop escalates to SIGKILL after a two-second grace, so a shell that ignores SIGTERM
  no longer outlives its engine, its `kill_shell` or Rune. A stop only ever signals a process
  group that is still the shell's, never a number the system has since given to someone else.
- **Self-evolution evidence.** A learned lesson never advises leaving containment. A mock win, an
  unknown cost, an outage or a second look at an answered question cannot count toward a
  promotion, and a task missing from one arm counts against that arm. A lesson trial holds the
  harness still at its release line, so trials start again with this release.

## [1.2.0] - 2026-09-26

**Auto mode stops asking.** Every Auto prompt recorded since the 2026-08-28 redesign was a shell
command with no OS sandbox under it — and none of them was dangerous (`cargo test`,
`make dev-web`, `ps | head`, `test -f` checks). Three causes, all fixed. Full notes:
[`docs/releases/v1.2.0.md`](docs/releases/v1.2.0.md).

### Fixed

- **The macOS sandbox works again on macOS 27.** `MacOsSandbox::is_available()` probed with the
  named `no-network` profile; on macOS 27 `sandbox-exec -n no-network` is SIGKILLed while an inline
  `-p` profile still applies. The probe reported `mechanism: none`, every command ran on the host
  whatever `/sandbox` said, and the live Seatbelt tests — which return early when the probe says
  no — stayed green while testing nothing. The probe now uses the `-p` form `execute` uses, and a
  test fails whenever the probe disagrees with it.
- **A session that starts in Auto gets the sandbox.** Only Shift+Tab into Auto turned the sandbox
  on; a session that opened in Auto (a remembered gear, `--gear auto`, `gear = "auto"`) kept a
  saved `off`, so every writable command paid an in-path reviewer call. `ensureAutoBoundary` now
  runs at startup and on the shift. The saved `/sandbox` setting is not rewritten, and an `off`
  given for the run itself (`--no-sandbox`, `RUNE_SANDBOX_MODE=off`) still stands.
- **A reviewer outage is never a prompt.** With no sandbox under a command and no reviewer
  reachable, Auto used to put a yes/no card in front of the user — the last modal prompt in default
  Auto, and the source of every recorded one. Now ordinary development work runs, recorded as
  unreviewed, while nothing in the run is under suspicion and the command is low or medium risk on
  its own; background processes, fallback retries and everything else wait in the end-of-turn list
  with a plain reason. An outage no longer counts toward the two-refusal halt, so a timeout followed
  by one genuine refusal cannot end a session. A property test runs every sandbox mode, isolation
  backend and reviewer behaviour over a 28-action stream and fails on any prompt.

### Changed

- **Windows portability for CI.** `cfg` gates for code only Linux and macOS call (the Windows
  clippy job runs `-D warnings`), OS-separator handling in tool-row paths and verification globs,
  LF line endings for every checkout (`.gitattributes`), a capture script that imports its POSIX
  modules lazily, and the eval-baseline test moved to the integration suite, which builds the
  native binary it needs. No behaviour change on macOS or Linux.

## [0.1.1] - 2026-09-16

The provider rosters brought current, the GPT-6 family recognised by the Codex and OpenAI
transports, GitHub Models removed, the header showing the product version and the session tail.
Full notes: [`docs/releases/v0.1.1.md`](docs/releases/v0.1.1.md).

## [0.1.0] - 2026-09-16

**The first public version.** Contract and verdict at intake and close, acceptance decided by the
runtime, recovery of a run killed mid-tool, OS sandboxing on macOS and Linux, budgeted sub-agents,
signed memory, the one-column interface, and Apache-2.0 as the licence. Full notes, with what is
verified, experimental, platform-limited and unresolved:
[`docs/releases/v0.1.0.md`](docs/releases/v0.1.0.md).

### Fixed (recorded late — these shipped in 0.1.0 but sat under Unreleased)

- **`todo_write` accepts the shapes models actually send.** Thirteen of the last twenty-one recorded
  tool failures were plan-ledger calls the validator refused: bare strings with a markdown checkbox,
  items with `content` but no `status`, and the read-back tool's shape sent to the wrong tool. Each
  refusal cost a completion. The tool now normalizes once, in `normalizeTodoItems`: checkbox strings
  become items, a missing status is `pending`, status and kind synonyms map to the canonical words,
  a canonical kind is kept as written, an unknown kind is dropped, and a shape it cannot read is
  refused with what was received and a one-line correct example. A normalizer failure at execution
  returns an error, never an empty plan. Written by Rune itself on `ollama-turbo/gpt-oss:120b`
  (sessions 01a086b0 and 01a086b7) in its own tree, reviewed and finished by hand.
- **A syntax checker that runs out of time reports nothing, not a clean file.** The post-edit
  checkers (`bash -n`, `python3 ast.parse`) get three seconds; one killed at the deadline exits
  non-zero with empty stderr, which was read as "no issues". It now reads as inconclusive, the same
  as a missing interpreter. Found by the v0.4.1 release commit's Windows CI run, where a cold
  `python3` start alone outlasted the budget.

---

**Everything below this line was an internal build.** Berne 0.2.0, Gear 0.3.x and Rune 0.4.x
were cut while the product was being renamed and the harness stabilised; none was announced or
installed by anyone but the author. The public line restarts at 0.1.0 on purpose. The old tags
stay on GitHub, marked as pre-releases, so their history remains readable, and `releases/latest`
never resolves to them.

## [0.4.1] - 2026-09-09

The Windows release, cut from the first fully green CI run on the public repository: 22 of 22
jobs on 2026-09-09, including the Windows unit suite, which had been red on every run since the
repository went public, and the packaged `rune serve --check` on a Windows runner over both host
transports. The v0.4.0 Windows binary installed and answered a prompt but could not host a session.
0.4.1 adds no agent capability.

### Changed

- **Prompts carry only the tool schemas a turn can use.** Core tools (read, write, edit, bash,
  search, the plan tools, `ask_user`, `task`, `web_search`, `skill`) keep full schemas; the rest
  ship as one-line catalog entries that `load_tools` expands, and that promote themselves for the
  session when the conversation names them or the model calls them straight from the catalog.
  Tool results are deliberately not scanned. Advertised schema bytes fall 53%.
- **The just-in-time doctrine is now genuinely just-in-time.** The 4.9 KB dashboard design charter
  is delivered when a dashboard enters play instead of on every request; the opening rituals
  (read-back, ambiguity, greenfield) leave the prompt from the second completion of a request, and
  "Finishing a task" leaves the opening one. "Plan and track" stays on every completion: dropping it
  was tried and measured on the same task and route — malformed `todo_write` calls went from one to
  seven, each a wasted completion, because the ledger-keeping rules govern the whole run, not its
  opening. The prefix changes once per request,
  never per completion. Safety guidance is never phase-gated; no doctrine wording changed, and
  `/config doctrine full` still ships one prompt per turn. Measured on the same free route and task
  as the morning baseline: **18.2k → 12.8k fresh input tokens per completion (−30%)**, 84.3 KB →
  62.8 KB per prompt. The doctrine row of that live comparison is not controlled (per-user memory
  grew between the runs); the offline arm is −33% on ordinary turns. The read-back leaving after the first completion has
  not shown a cost on the two live runs so far; the plan section was put back on measurement, above.
- **CI runs on pushes to `lane/**`** — the workflow only listened for pull requests against those
  branches, so a lane push never ran — and gates `rune serve --check` on Windows from source as
  well as from the packaged binary, plus once per host transport on every platform.
- **OpenRouter's seeded free models re-probed.** `minimax/minimax-m3:free` was withdrawn to paid
  and answered 404 on release day; the seeds and the fallback tiers now name
  `nvidia/nemotron-3-ultra-550b-a55b:free`, which answered a live call the same day.

### Added

- **`rune cost` and `/cost` show the fixed overhead at both ends of a run** ("fixed overhead
  62.4KB → 56.0KB"), so a prompt that shrinks or grows mid-run is visible instead of averaged
  away. `docs/run-economics.md` gains the prompt-overhead section and the per-provider caching
  truth: which routes mark and measure a cache, which are documented but unmeasured here, and
  that ollama.com reports none on a byte-identical prefix.

### Fixed

- **`rune serve` can host a session on Windows.** Each session host was reached over a unix domain
  socket on every platform, with no Windows branch anywhere; Windows now listens on a loopback port
  and publishes it with a per-host token in a 0600 rendezvous file, and a host serves nothing —
  not even `ready` — until a connection presents that token. POSIX is byte-for-byte unchanged, and
  `RUNE_HOST_TRANSPORT=tcp|unix` forces either transport anywhere so the Windows path is testable
  on a Mac. The v0.4.0 Windows binary installed, ran doctor and tools, answered a real prompt, and
  then failed `rune serve --check` with "Failed to connect"; the packaged Windows gate in CI had
  been red on every recent run, so the tag went out past a red gate, not a missing one. A second
  candidate cause is fixed alongside: the blackbox and notebook databases now wait for a lock
  (`busy_timeout`) instead of throwing, since one host per session opens them concurrently.
- **`rune serve --check` no longer fails a passed check on Windows cleanup.** The first public CI
  run proved the loopback transport on the Windows runner — a session hosted in 1.8 s, zero leaked
  hosts — and then exited 1 removing its scratch directory, because Windows keeps a just-exited
  host's working directory open for a moment and `rmSync` answers EBUSY. The removal retries and
  never fails the check; the eval harness and the comparison test retry the same way.
- **Plugin verification works on a Windows checkout.** A plugin's integrity digest hashed the
  bytes on disk, so a tree git checked out with `core.autocrlf=true` produced a different digest
  from the published one, and every plugin carrying a text file would have failed `rune plugin add`
  on Windows. The digest now folds CRLF to LF before hashing — as a byte filter, never a decode, so
  invalid UTF-8 is not mangled, and a file containing NUL is hashed verbatim as binary. Published
  digests are unchanged. Reproduced from macOS: the LF and CRLF digests of one plugin file are
  exactly the pair the Windows CI job printed.
- **The MCP connector preflight tells the truth on Windows.** It looked for a command by its literal
  name on `PATH`, where `npx` is `npx.cmd` and `uvx` is `uvx.exe`, so a working connector was
  reported missing with an install line for something already installed; it now tries each
  `PATHEXT` suffix and reads a name containing a slash as a path. Its "did you mean" suggestion
  walked up from the path separator, which on a Windows drive stops at `C:` and answered "create
  it" where macOS names the directory; it now starts from the parsed root, right for a drive
  letter and a UNC share.
- **A host that fails to start names itself**, says whether it is still running, and prints the
  tail of its own log, instead of a bare four-word socket error.
- **`rune detach` runs on the route you gave it.** `-p`, `-m` and `--gear` were parsed and
  forwarded nowhere, so a detached run always booted on the pinned model — on release day that
  pin was a free model OpenRouter had retired, and the run died at its first completion after
  printing "detached run started". The launcher now hands the flags to the host as a
  session-scoped route that beats the pin, prints the route and gear it used, and the host says
  when a named provider has no credential on the machine instead of booting one that cannot
  answer. Found by the first detached live run after the release; the retry completed a nine-file
  project with tests on `ollama-turbo/gpt-oss:120b` (`docs/evidence/live-run-long-20260908.md`).

## [0.4.0] - 2026-09-08

Phase 12 ships what exists, on free model routes, with every claim in the README marked verified
live, verified against tests or mocks only, or unverified. It adds no agent capability.

### Added

- **`[routing] helper` (`/config helper`): a separate model for Rune's own calls** — the
  compaction summarizer, the intent read, the system-memory dream. `auto` picks the cheapest
  healthy connected route by capacity (`local → free → subscription → funded`) against the live
  gateway and the health store, never a hand-written list, and refuses a route dearer than the
  session's. The default is `off`: an automatic pick may cross providers, and the saving is
  unmeasured live, so it is opted into. The session model is untouched; the Auto-mode safety reviewer is not rerouted by
  default, because a free model wrongly allowing is worse than mechanical containment.
  `/config helper` reads back the resolved route, not the setting.
- **Every completion records what it was for and what its prompt was made of** — a `role` and a
  byte composition (doctrine, plan ledger, task state, tool schemas, conversation) on each `cost`
  row — so the JIT doctrine's effect is measurable rather than asserted. A meter that cannot
  measure emits no row rather than a wrong one, and is never the reason a request fails.
- **`rune cost [session|last]`** prints run economics from the session log, headless, and `/cost`
  now also reports completions split work vs governance and by role, fresh tokens per completion,
  cache-read ratio, a list-price estimate with governance's share, and the prompt composition per
  call. The money readout is unchanged and printed first.
- **The mock eval suite fails when governance completions per task rise more than 20% above the
  recorded baseline** (`callsByRole` on the retro; 0.25 per task at this release). What is not
  measured, stated in `docs/run-economics.md`: whether the helper reduces live rate-limit incidents,
  and the reviewer recall's live hit rate — both need a live free-route run.
- **The MCP client was driven live against real servers, and two defects fell out.**
  `@modelcontextprotocol/server-filesystem`, `server-memory` and `server-everything` over stdio,
  streamable HTTP and the 2024-11-05 SSE protocol: tools, resources, prompts, progress and image
  attachments all answered on 2026-09-08 (record: `docs/evidence/mcp-live-20260908.md`;
  `tests/integration/mcp-live-servers.test.ts` repeats it and skips offline). The GitHub connector
  and OAuth against a real vendor remain unverified: no credentials on this machine.
- **`/mcp` shows connector health, protocol dialect, tool count and the command that fixes each
  one that is down**; `/mcp reconnect <server>` re-handshakes one connector without restarting the
  session, including one that never started. One builder serves the TUI and the readline fallback.
- **`rune mcp doctor` checks the config before spawning anything.** A command that is not on PATH,
  or a directory that does not exist, is reported with the corrected path when a sibling within a
  typo's distance exists. `rune doctor` carries the same in one line and still starts no server.
- **`docs/mcp.md`** — the quickstart: three configs, each marked verified or not.
- **`scripts/render-live.ts` replays any stored session through the real `TurnRenderer`** at any
  width, read-only against `rune.db`, so the terminal UI can be inspected outside a live terminal;
  `docs/ui-freeze.md` records the frozen layout, scrolling model, key bindings, marks and palette,
  and the rule that changing one needs a founder decision recorded in `docs/program/`.
- **User skills.** `.rune/skills/<name>/SKILL.md` in a repository and
  `~/.rune/skills/<name>/SKILL.md` for you, the same frontmatter the playbook already writes, so
  both load through one path (the workspace wins a name collision). `/skills` lists them one per
  line with description and origin instead of a comma-separated list; `/<name> [args]` loads one
  into the turn, substituting `$ARGUMENTS`, `$1` or `{{args}}`; `rune skill add <path> [--user]
[--name N] [--force]`, `rune skill list` and `rune skill remove <name>` manage them. A skill is
  instructions, never a program. `examples/skills/release-checklist` installs with `rune skill add`.
  Verified by running the CLI against a temp workspace and a temp `RUNE_HOME`; the `/skills` render
  and the `/<name>` invocation were exercised with the scripted mock provider, not a live model.
- **Hooks and plugins as a user layer.** `docs/skills.md`, `docs/hooks.md` — the hook event matrix
  derived from `hooks.ts`, one worked example per event, and `tests/fixtures/hooks/hooks.json` as
  the exact file the doc prints, driven by a test — and a ten-minute version plus a verified
  section in `docs/plugins.md`. `rune plugin add ./path` of the two example plugins is covered by
  an integration test that installs them through the real CLI, re-verifies integrity, and runs
  their tools under Seatbelt. Nothing in the sandboxing or integrity checks was weakened.
- **The free routes lead `/login`, and say they are free.** The key list inherited the roster's
  order, which opens with four providers that all need a funded account — on a machine with no
  budget, the four rows that cannot answer a prompt tonight. Free tiers now sort to the top of the
  API-key list (the sort is stable, so the frontier labs still lead the paid block in their old
  order), each carries its marker in the label, and level 1 names them before the count. No layout
  changed: the marker is a suffix on a string the picker already renders.
- **`rune doctor` reports each route's health and quota window.** `~/.rune/provider-health.json` is
  pruned only when something writes it, so a machine that stopped making calls keeps records
  nothing believes and there was no way to ask "is my cap over?" without starting a session.
  Doctor now says, offline: a cap in force with how long is left, or expired with how long ago and
  marked **stale**; a retired model with its window; and — where the retired id is not one that
  provider offers but is one another preset offers — that the retirement was filed against the
  route a misdirected call went to, not a real failure of that provider.
- **A fresh-`HOME` onboarding test.** The headless equivalent of the first run — empty home,
  doctor, connect a route, choose a model, first prompt, doctor again — against a local stub
  speaking the OpenAI wire. It completes in **0.8 s** on the machine it was written on, against a
  180 s budget.
- **The version source and the release asset names are pinned by tests.** Eight package manifests
  and the Cargo workspace must agree with `scripts/version.sh`; `targets.sh`, `release.yml`,
  `web-install.sh` and `install.ps1` must agree on `rune-*`. Both pin the agreement, never a
  literal.
- **The sandbox is a policy, not a switch.** `/sandbox` opens three tabs — **Mode**
  (`auto-allow` · `regular` · `off`), **Overrides** (allow an unsandboxed retry · strict) and
  **Config** (excluded commands, filesystem read/write rules) — with text forms for each
  (`/sandbox mode regular`, `/sandbox override strict`, `/sandbox exclude adb *`,
  `/sandbox config`) and config keys under `[sandbox]` and `[sandbox.filesystem]`. `regular`
  keeps commands contained but still prompted; an excluded command runs on the host under the
  gear's ordinary permission decision; a sandboxed command that fails on a permission error now
  carries a `sandbox_hint` and may retry once with `unsandboxed: true` (refused under strict).
  The kernel profile enforces the new lists: Rune's own control surface inside the workspace and
  `.git/hooks` are denied for writing in every gear, and the path lists reach `rune-tools` from
  trusted config only. `/config sandbox`, `sandbox_fallback`, `supervisor` and
  `unsandboxed_shell` are live settings. See `docs/sandbox.md`.
- **Auto mode has a safe tier for read-only shell commands.** `ls`, `cat`, `grep`, `git status`,
  `cargo tree`, pipelines of those and `--version`/`--help` of anything run with no reviewer call
  and no supervisor screen, whatever the sandbox state; a read the risk patterns flag (`cat .env`)
  keeps the classifier tier, and once injection is suspected reads stop being free.
  `[permissions.autoMode] safeCommands` extends the set.

### Changed

- **Auto mode's reviewer is no longer re-asked about an action it already allowed in the same run
  at high confidence.** The reasoned contract gained `confidence`; a `"high"` allow is cached under
  the conservative canonical signature and recalled as `classifier_recall`, cleared on any injection
  finding, reviewer denial or supervisor flag, bounded at 128, and never for a mechanically stopped
  action. Offline safety corpus recall unchanged at 92.1%.
- **Auto mode no longer prompts for every shell command when the sandbox is off.** The engine
  used to rewrite every allowed bash call into a high-risk "explicit approval required" prompt the
  moment the sandbox was off or the machine could not isolate — `ls` included — which is what made
  "sandbox off + Auto" unusable. A command with no sandbox under it now follows
  `[permissions.autoMode] unsandboxedShell`: `review` (default) pays one in-path reasoned reviewer
  call (a reviewer outage becomes a question for an ordinary command, never a deferral of
  `bun test`; an exfiltration still halts and a publish still comes back as its dry run, whatever
  the policy), `ask` prompts, `allow` leaves it to the breakers. Excluded commands and fallback
  retries take the same path.
- **A denied read inside the workspace is now actually denied.** The Seatbelt profile emitted the
  read-deny block before the workspace allow, and Seatbelt takes the last matching rule, so
  `[sandbox.filesystem] denyRead` held for credential stores but not for a path under the
  workspace. The block now follows every allow; a live test reads a denied file and fails.
- **The supervisor's scope is a setting, and the default is narrower.**
  `[permissions.autoMode] supervisor = "unusual"` skips recognized ordinary development work —
  builds, tests, installs, linters, local git, containers — which the mechanical breakers have
  already read; `"all"` restores screening everything; `"off"` disables the watcher. On a
  rate-capped reviewer the supervisor competed with the acting agent for the same quota on every
  `npm audit`, and nearly a third of its flags did not survive the reasoned pass.
- **Reading one of Rune's own control files is no longer refused as a guardrail change.** The
  self-protection breaker fired on `read_file` of a `SKILL.md`; it now applies to writes only.
- **The product is named Rune.** Every name moves with it: the `rune` command and the `rune-tools`
  executor, `~/.rune` and `rune.db`, `RUNE_*` environment variables, `.rune/` in a workspace,
  `@rune/*` packages and `rune-*` crates, `RUNE.md` instructions, `rune:` auto-commits and the
  `rune` keychain service. An installed Gear keeps working through one generation of read-through:
  the first start moves `~/.gear` to `~/.rune` (leaving a symlink), renames `gear.db` and `GEAR.md`,
  adopts `GEAR_*` variables, reads the `gear` keychain service, undoes `gear:` commits, recognises
  the playbook and `rune evolve` markers under either name, loads `gearVersion` plugin manifests and
  binds `/etc/gear` org policies. The permission ladder keeps its vocabulary (`--gear 1..4`, `/gear`,
  "4th gear"). Terminals that key behaviour on the process name (Warp's CLI-agent channel) see a
  new name.
- **The terminal is the only interface.** The web app, the bundle embedded in the binary,
  `rune web`, `rune open`, the bare-command browser entry, the VS Code extension and the Playwright
  suite are removed. `rune serve` keeps the WebSocket engine for `rune attach ws://` and the SDK and
  no longer serves a page; `rune serve --check` proves the compiled binary can spawn its own session
  hosts. A bare `rune` starts the console.
- **The accent is violet.** `#A28CF3`, exact on the dark ground and derived to `#9682E1` on paper so
  it clears a 3:1 floor; the electric blue and the web token pipeline are gone.

### Fixed

- **MCP connectors on the 2024-11-05 SSE protocol now connect.** The fallback from streamable HTTP
  to SSE was described in a comment and never implemented, so a URL pointing at an older server
  failed permanently with a 404. The client now retries once as SSE on 404, 405 or 406 only.
- **A connector that never started can be reconnected without restarting the session.**
  `reconnect` returned false for any name with no client, which is exactly the fixed-typo case.
- **A parallel tool batch no longer leaves orphaned rows in the transcript.** The renderer kept one
  slot for the call in flight while the loop dispatches a message's calls together, so a burst of
  four reads opened four rows and kept the fourth; the other three stood as `› read` forever and
  the finished rows were appended underneath them. 500 rows across the five largest September
  sessions; `scripts/render-live.ts` found them.
- **A run that ended before finishing shows its whole state of work.** The handoff block was set
  down verbatim — up to 346 columns on an 80-column window — and the fixed frame clips rather than
  reflows, so goal, open steps and next step were cut off mid-sentence.
- **A row that overflows sacrifices its argument, not its receipt.** A long path used to eat its
  own outcome, leaving rows ending `0…`.
- **Verification and step-check rows are clipped by the window, not by a hard-coded 100 columns.**
- **A command in an answer is no longer split mid-token** — `python3 -m http.server 8765` came out
  as `http.serv` / `er 8765`.
- **An edit whose result carries no diff says what it did** instead of rendering as a bare path.
- **`rune --help` no longer prints a provider list from six presets ago.** The `-p` line said
  `anthropic|openai|openrouter|google|ollama-turbo|ollama` long after the roster reached 37, so the
  installed binary's own help told people that thirty-one of their options did not exist. It is
  derived from `PROVIDER_PRESETS` and points at `rune providers`.
- **The installer stopped telling people to run `gear`.** The last line of `web-install.sh` named
  a command that has not existed since the rename; the release workflow staged its verified
  download into `$HOME/gearbin`.
- **The README says what is verified.** A three-column table — verified live, verified by tests or
  mocks only, unverified — replaces a feature list that stated designs as results. Claims removed
  because the record does not support them: a stale "latest release v0.2.0", parity-shaped framing,
  measured-sounding sub-agent, teamwork, self-evolution and research claims (17 of 666 sessions used
  sub-agents, the team bus has sent zero live messages, no A/B arm has ever run), and the implication
  that the published one-line install works today. It does not: every release up to v0.3.1 carries
  `gear-*` assets and the installers look for `rune-*`, so it works from v0.4.0 onward.
- **End-of-turn verification grades what the run wrote, not the whole workspace.** Started in a
  folder of unrelated projects, Rune used to run every sibling's checks after a build and then
  chase their failures — a Python suite wanting pandas, a Gradle build with no JDK — in code it had
  never opened. Each written file is now attributed to its innermost project (every ecosystem at
  that directory), files that belong to no project report "nothing runnable detected", and the
  step check's own scoping, which compared absolute paths to relative project directories and had
  silently widened to the whole tree, matches again. An explicit `[verify] commands` override is
  never narrowed.
- **A tool call that arrives empty is answered by the loop, not reviewed by the safety
  classifier.** A response cut at the output-token limit mid-call lands as `write_file {}`; that
  shell went to reasoned review twice at ten seconds each and became held steps the model
  re-narrated for the rest of the session. It is now told the true cause and to write a large file
  in sections. Only the empty call is intercepted; partial and well-formed calls go through the
  gate unchanged.
- **A plan step that is the report closes with the report.** "Hand the user the one command…" was
  refused five times in one run as "nothing ran". A step whose verb addresses the user, or that is
  the final report, now closes as `closed by report`; and a refusal for missing evidence no longer
  pins reasoning effort to its ceiling for the rest of the run.
- **The task-state block says it is not a message.** Re-sent as a trailing user message on every
  request, it was answered on every request by a weak model; it now states that it is harness
  state and must not be acknowledged, restated or summarized, and the team block says the same.
  Sending less of it between changes was tried and reverted: across a long run with compaction
  the block is the only surviving copy of the mission, and a summary of it is not.
- **Art direction is asked when the plan names a screen, before the first page is written**, not
  after it (which threw the page away), and the note carries six directions of its own instead of
  pointing at a `skill` tool that is not registered in every session.
- **Loopback stays open inside the macOS sandbox.** A local dev server on 127.0.0.1, and a `curl`
  against it, no longer fail with "operation not permitted", so a page the run just built can
  actually be served and read back. Egress and DNS stay denied, and the sandboxed-bash preflight
  lets a loopback URL through instead of claiming it would hang. Seatbelt's `localhost` filter also
  admits a `0.0.0.0` bind, which `auto-containment` already refuses as a mechanical breaker; the
  threat model states this rather than claiming "loopback only".

### Removed

- `apps/web`, `apps/vscode`, `tests/e2e`, `tests/unit/web`, the brand checklist, the token-CSS,
  mark and primitives generators, and the web design documents.

## [0.3.1] - 2026-09-03

### Added

- **Post-edit diagnostics in the same turn.** Every `edit_file`, `multi_edit`, `write_file` and
  `apply_patch` result carries the language server's errors and warnings for the touched file
  (TypeScript, Python, Rust, Go), capped at 2 s and 20 lines, so type errors are fixed before the
  verifier ever runs. One language-server manager per process, stopped on engine close.
- **`gear serve` reaps its session hosts.** Idle hosts exit after a configurable window, every host
  stops on server exit unless `--keep-hosts`, and a host orphaned by a dead supervisor exits on its
  own.

### Fixed

- **Windows.** The compiled binary's first real run on Windows exposed a path-key mismatch (verbatim
  `\\?\` paths from the native executor against 8.3 short temp names) that refused every edit after a
  read; a containment test that never matched on Windows and refused every sub-agent finish; shell
  unescaping that ate pasted Windows paths; no shell but `/bin/sh`; and empty worktree listings. The
  unit suite now runs on Windows in CI. Still open on Windows: hooks, the verifier and worker checks
  spawn `/bin/sh`; no OS sandbox.

## [0.3.0] - 2026-09-03

Everything since `v0.2.0` (2026-07-14). This is a large release: the harness was rebuilt around
evidence, the terminal was rewritten, and the cost and safety subsystems were made honest.

### Added

- **The plan ledger.** Steps close on evidence the harness measured, not on the model's say-so. An
  open-steps gate keeps the resume note, a step check refuses an unproven completion, and the mission
  dossier survives compaction on disk where the model can read it back.
- **The self-evolution organ.** A zero-model-call retro per run feeds notebook lessons and a
  repository playbook; `gear evolve` reports status, scorecard, lessons, tuning proposals and the
  gardener. Every promotion is proposal-only or human-gated.
- **`gear audit`** — one page on a session and the evidence behind it: tools, prompts, permissions,
  policy, cost.
- **The Read-Back interface.** The agent says what it understood before touching anything, and the
  screen is derived from a typed log rather than drawn by the model.
- **The transcript reads like the work** — chambers, click/ctrl+o folds, streak rollup, banded syntax
  diffs, story narration.
- **Fixed chrome and a fleet panel.** Header and footer pinned, only the transcript scrolls; one row
  per parallel sub-agent with real lifecycle markers.
- **The held step** — Auto's deferrals become an approve-exactly-this decision instead of prose.
- **Art direction is a question**, not a silent default: a 20-genre catalogue and a mandatory ask
  before frontend work.
- **The team layer** — a multi-instance bus and per-call tier/effort routing.
- **Headless mode** (`gear -P`) that a benchmark or CI job can actually call.
- **Run economics** — `read_many`, just-in-time doctrine, and effort routing that latches on
  difficulty.
- **A cost meter that is installed.** The ledger reported \$0.07 for \$55.81 of work; it now reports
  what was spent, with a spend cap that arms.
- **Warp integration** — Gear announces itself on Warp's CLI-agent channel.
- **CI: the packaged binary must execute real tools**, not merely start.

### Changed

- **Auto mode is 4th gear with a watcher above it.** Low- and medium-risk work runs immediately at
  zero extra model calls; a two-stage supervisor observes out of band and can halt the next action;
  a tripped breaker returns a containment route (extend, contain, redirect, defer, halt) instead of a
  permission card. Auto mode fails contained, not closed.
- **The model that starts a task finishes it** — model-integrity pinning by default, a decorrelated
  reviewer fallback, turn budgets, a single-pass classifier and latch release.
- **One UI grammar.** Four dialects that bypassed `flow.ts` were unified behind `flowRow`, enforced by
  `ui-grammar.test.ts`.
- **Context economics** — real context windows for 12 models, tiered and bounded compaction, and
  prompt caching where the provider supports it.
- **The research pipeline** gained an analyst stage between evidence and prose.
- **`/login` and the command surface** — a three-step connect flow in product names; the catalogue cut
  from 31 commands to 25 with `/model` first.
- **One version source.** The version was maintained by hand in four places (`brand.ts`, six
  `package.json` files, `install.sh`, `web-install.sh`); it is now computed once and injected at build
  time, and the release workflow refuses to publish when the tag and the binary disagree.

### Fixed

- **OAuth login for Claude** — the redirect style, not the query string, was corrupting the
  authorization request.
- **`reasoning.effort` was never sent.** Codex ran at the server default with `max` unreachable.
- **Sticky model lost on startup** — two rotted provider-id lists rejected a valid pick and reset
  sessions to a default.
- **Model rot** — dead models and capped plans are remembered across sessions, and the summarizer runs
  on the session model with free-first live recovery.
- **The three-kill chain** — false-positive halts that let the loop detector terminate its own runs.
- **Turn collapse** — gathering bursts collapse, approval chips are gone, check output is clipped by
  relevance.
- **A timed-out prompt is not a decline**, and there is a way back in.
- **Paste fidelity, console hygiene, quota auto-resume** — the first three ship blockers.
- **The OpenRouter adapter stopped identifying as first-party OpenAI.**
- **Legacy databases are no longer stranded in silence** on the `~/.alan` → `~/.gear` path migration.
- **The engine no longer imports a terminal module**, so no UI stack rides into a non-terminal
  consumer's dependency graph. A test enforces it.
- **The retro is scoped.** It is written per turn but used to report the session's cumulative steps
  and goal, so a two-word greeting scored as a whole run. Work counters are now a delta over the
  window and N turn retros fold into one session sample.

### Removed

- **The episodic-memory subsystem**, which never ran.
- **`permissions.autoMode.conversationalEscalation`**, a switch nothing read — conversational
  escalation is unconditional. A config that still sets it is warned about once and ignored, never
  rejected.

## [0.2.0] — 2026-07-14

Version bump, installer polish, and install-from-GitHub documentation.

[Unreleased]: https://github.com/ritikkyyadav/Rune/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/ritikkyyadav/Rune/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ritikkyyadav/Rune/compare/v0.1.1...v1.2.0
[0.4.1]: https://github.com/ritikkyyadav/Rune/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ritikkyyadav/Rune/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ritikkyyadav/Rune/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ritikkyyadav/Rune/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ritikkyyadav/Rune/releases/tag/v0.2.0
