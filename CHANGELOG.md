# Changelog

All notable changes to Rune are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Rune adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version a build reports comes from exactly one place — `scripts/version.sh`, injected at compile
time — so a released binary cannot disagree with the tag beside it. Untagged builds report
`<semver>-dev+<sha>`.

## [Unreleased]

## [1.3.4] - 2026-10-08

**A failure that was already there is left alone in a real project, which 1.3.2 promised and
did not do.** A patch on 1.3.3. Full notes: [`docs/releases/v1.3.4.md`](docs/releases/v1.3.4.md).

### Fixed

- **A failure that was already there is recognised in a real project's suite.** Since 1.3.2 Rune
  leaves a failing test alone when it was already failing where the run started. For a Bun suite
  of more than about twenty tests, read in an ordinary terminal or inside GitHub Actions, that
  never happened. Bun closes such a run by listing its failures a second time ("2 tests failed:"),
  Rune counted that list as more failures, and a report with more failures than its totals is one
  Rune will not compare. The run was told its checks had failed and asked to repair tests it had
  not touched; on 2026-10-07 one did, by rewriting the project's own `test` script. The closing
  list is no longer counted. Runs from inside an agent's shell were not affected: Bun prints no
  closing list there, which is why this passed every test until it was run through a real process.

- **`rune upgrade` over a source install no longer leaves Rune telling you to rebuild.** A source
  install keeps a record of the commit it was built from, and the launcher warns when that checkout
  has moved on. `rune upgrade` replaced the binary and left the record, so every start said the
  build was older than its source tree and gave the command to rebuild it. The record is now moved
  aside with the build it described, as `rune-compiled.meta.backup`.

- **A run that ends before its background reviewer answers now says so.** In Auto mode ordinary
  actions run at once and a reviewer reads them in the background. `rune -P` exits when its work is
  done and does not wait for that reviewer, so an action still waiting was never answered for,
  while its audit row went on saying it was allowed under supervision. When Rune closes it now
  writes one `supervisor_skipped` row for each such action, joined to it by its call, with the
  reason "the run ended before the reviewer answered for this action". Quitting a session mid-run
  does the same. Nothing is waited for and no reviewer is called, so exit takes no longer.
  `rune doctor` and `rune audit` now print how many actions ran with no background review; that
  count had been taken and never shown. Still not recorded: a background review that failed —
  reviewer unreachable, timed out, or an answer that could not be read — leaves no row.

- **When a check fails and Rune cannot tell whether the failures were already there, it says why.**
  Before asking for a repair, Rune compares the failing tests with the tree the run started from,
  and leaves a failure that was already there alone. When that comparison could give no answer the
  reason was computed and thrown away, so a run that repaired a test it had not broken left no
  trace of why it was asked to. The reason is now in the notice ("Whether these failures were
  there before this run could not be told: …"), on the `verification_completed` event as
  `attributionUnknown`, and in the saved task state. What the model is told is unchanged.

## [1.3.3] - 2026-10-07

**The rule for whose failure it is holds in CI and on Windows, and the tests have now run on all
three systems.** A patch on 1.3.2. Full notes: [`docs/releases/v1.3.3.md`](docs/releases/v1.3.3.md).

### Fixed

- **A failing test in a file the run edited is the run's, in GitHub Actions and on Windows too.**
  1.3.2 tells a failure that was already there from one the run made, and a test in a file the run
  changed always counts as the run's. That last rule did not hold in two places. Inside GitHub
  Actions Bun opens each test file with `::group::`, and on Windows it writes `unit\a.test.ts`;
  Rune kept both as part of the file's name, so the name matched no changed file. A failing test
  the run had edited was then called "already failing", and when it was the only failure no repair
  was asked for. The check was still reported red. File names in a test report are now read
  without the prefix and with `/`.

- **The tests hold on Linux and Windows, not only on a Mac.** CI had been red since late September
  on two tests, and 1.3.2 added thirty-nine more that had only ever been run on a Mac. Apart from
  the fault above, none was a fault in Rune: the tests assumed `/` in paths, a file system that can
  clone, a `#!` script, LF line endings, a `rune-tools` on the path, a Chromium in the home folder,
  or a sub-agent list no earlier test file had written to. Each now holds on every platform, or
  says what it needs and is skipped by name where the platform cannot give it.

## [1.3.2] - 2026-10-07

**Checks that tell the truth and leave nothing behind, sub-agents you can open, and runs that stop
cleanly.** A patch on 1.3.1. Full notes: [`docs/releases/v1.3.2.md`](docs/releases/v1.3.2.md).

### Added

- **A sub-agent can be opened and watched while it works.** With the composer empty, the right
  arrow steps onto the agent blocks on the working row; left and right move between them, and
  enter opens the selected agent's transcript in place of the main one:

      ── 1  planner ── running 48s · 12.4k tok · 2 tools ── esc back ──────────────
       Map where settings are defined, validated and persisted.

      ◇ Starting from the config table, then its loader.
      ┌ read  packages/orchestrator/src/config-settings.ts ──────────────────────┐
      │ export const CONFIG_SETTINGS: ConfigSetting[] = [                        │
      └ · observed · lines 1-40 · 240ms ─────────────────────────────────────────┘
        │ › run   bun test tests/unit/orchestrator/config-settings.test.ts

  The transcript opens with what the agent was asked, then its reasoning, what it wrote, and every
  call drawn the way the main transcript draws one — a file read with its contents, an edit with
  its diff, a command with its output and exit code. A call appears the moment it starts and names
  its file or command while it is still running. The transcript keeps filling while it is open.
  Inside it, left and right switch to the next agent, up/down and page keys scroll, and `esc` goes
  back. The working row stays on screen the whole time, with the open agent's block marked.
  `ctrl+f` opens the fuller list, one card per agent with its tokens, tool count and last verdict;
  enter there opens the same transcript. The status line shows the keys for wherever you are.

- **Finished sub-agents stay readable, including after a restart.** When a turn ends, the right
  arrow still selects the agents that came back and enter opens what each one did. Reopening a
  session (`/sessions`, `rune --resume <id>`, or the picker at launch) brings its sub-agents back
  under the names they ran as, read from the session's own record in `~/.rune/rune.db`. A restored
  agent's card says `from the session log` instead of a token count, because this process did not
  measure one, and its transcript is loaded when you open it. Long tool results in a stored
  transcript are cut to their first 1,500 characters and say so.
  `Engine.listDelegations(sessionId)` and `Engine.getDelegationTranscript(sessionId, taskId)`
  expose the same record to the SDK.

### Changed

- **The working row shows where the turn is and how hard it is working.** The row above the
  composer was one bar breathing on a timer beside a phrase with a glow sweeping across it, so a
  fast stream and a stalled call drew the same thing. It now reads:

      ▁▂▅▂▁▁▁▂▄▂▁▁ building · small, steady edits · editing turn.ts · 1m 05s  step 3 of 7

  The mark is the glyph from Say's dictation overlay — twelve columns standing on one base, in
  Say's colour — and it is struck by the turn's own output. What arrives is gathered into beats:
  about 67 a minute for a trickle, up to about 167 when the model is streaming flat out, and none
  when nothing arrives. Each beat lands as evenly spaced strokes that step one column to the right,
  taller the more arrived and more of them the harder the run is working; one tool call opening is
  one stroke. While a turn is in flight and silent — a command running, the model thinking — a
  single low hump sweeps the row. Waiting on you, or finished, it is flat, dim and still.
  The first word is the stage: `starting`, `looking`, `planning`, `building`, `checking`,
  `answering`, `housekeeping` while the context is compacted, `over to you` on a question. After the
  clock the row says where the plan is (`step 3 of 7`) and, when it is true, that the run is
  struggling: `second pass` after a failed check, `2 misses` after calls fail in a row, beside the
  existing `quiet 12s` and `retry 2 of 5`. Nothing but the mark moves. On a narrow window the voice
  line gives way before a file name is shortened. The token count and `thought for 5.1s` left the
  row and are in the `/details` header. A seven-bit terminal draws the mark with `_.,-=+*#`;
  `NO_COLOR` keeps the shapes and drops the colour.

- **Sub-agents are blocks on the working row, under one mark.** Launching sub-agents used to
  replace the working row with a separate agents strip, which hid the mark and gave each agent a
  small bar that rose and fell on a timer whatever the agent was doing. The working row now stays,
  and each agent in flight is a block after it:

      ▂▄▇▃▂▃▆▃▂▄█▄ looking · many hands · 6s  [planner] [builder] [verifier ✓]

  The one mark is struck by every agent's output together — the text each one writes, its
  reasoning, each call it opens and closes — so one agent working is a calm beat and three working
  at once is a faster, taller one. A block does not animate: it is in the normal ink while its
  agent's output is arriving, faint while the agent is queued or has gone quiet, and carries `✓` or
  `✗` once the agent is back. Blocks that do not fit are counted (`+2`), the newest thing any agent
  proved follows them when there is room, and `-> agents` on the right names the key that reaches
  them (see "A sub-agent can be opened and watched" below). In the panel, a running agent's cell is
  one static `◇` rather than a moving bar. After a turn the row says how many came back
  (`3 agents back`).

- **The tab's working mark is a pill, paced by the work.** The four-frame `| / - \` in the tab
  title is now `[⬬  ]`: a small solid pill centred inside a pill, gathering speed to the right and
  coming back in from the left. How fast it crosses follows the run — about once every 4.3
  seconds when little is arriving, down to about 1.4 seconds under heavy output, back-to-back
  tool calls or running sub-agents — and the change between paces is eased. After four seconds of
  silence it parks as a line, `[-  ]`, beside `quiet 12s`. In Terminal.app, iTerm and Ghostty on
  macOS, whose title bars are drawn in the system font, the pill glides about a quarter of a
  space at a time; elsewhere, and inside tmux or screen, it is a square, `[■  ]`, that moves in
  three steps (`RUNE_TITLE_STRIP=smooth|cells` overrides the choice). A seven-bit terminal
  (`RUNE_ASCII=1`, or a locale that is not UTF-8) gets `[#  ]` and `[-  ]`.

- **The Auto-mode reviewer has thirty seconds to answer, not twelve.** A risky command waits for an
  independent review. Its first attempt had ten seconds and ordinarily takes about nine, so on a
  slow evening the review timed out and the command was refused for the reviewer's slowness, not
  for anything it did. `[permissions.autoMode] timeoutMs` now defaults to 30000 (1000 to 60000).
  Who reviews and what is refused are unchanged: a reviewer that never answers still ends in a
  refusal, eighteen seconds later than before.

- **A read-back keeps a rule you stated in your own words.** When Rune restates a task before
  starting, a rule the request states — must, must not, never, keep — now goes into its completion
  criteria as you wrote it. Twice on one task a restated rule had become a narrower one, and the
  run built and tested the narrower one. Whether the change helps has not yet been shown in live
  runs.

- **A session keeps one prompt-cache key.** On Codex the key was made per process and per provider
  instance, so `/model`, `/login` and a resumed session each started cold, and every session in a
  process shared one. It now comes from the session. What that saves has not been measured.

- **Six tool descriptions no longer contradict the instructions.** `read_back`, `record_evidence`,
  `todo_write` and three others told the model to use them more often than Rune's own instructions
  do.

- **The instructions sent with every request are about a third shorter.** Repeated rules were
  consolidated: the full set goes from 7,807 tokens to 5,402, and the opening prompt from 24,220
  bytes to 15,267. What that saves on a real bill has not been measured.

- **A headless run exits 1 when a change did not meet the terms it was held to.** `rune -P` exited
  0 whenever the model stopped by itself, even when Rune's own verdict on the task was `unmet`. It
  now exits 1, with `ok: false` in the JSON envelope, when the verdict is `partial` or `unmet` and
  either the run stated what done means and changed files, or it was held to a criterion from
  outside itself (yours, or an `--acceptance` check). A run that stated no criteria — a greeting, a
  question — and a run that changed nothing, such as a review, are judged by whether they ran, as
  before. The answer and its evidence are printed either way. Details:
  [`docs/ci.md`](docs/ci.md).

### Removed

- **Signing in with a Claude Pro or Max plan.** Anthropic's terms do not permit third-party apps to
  offer Claude.ai login or to send requests through Free, Pro or Max plans. Rune's route did both:
  it used Claude Code's sign-in and presented each request as Claude Code. Claude models still work
  with an Anthropic API key, through Bedrock, and through Vertex. If you signed in with a plan
  before, Rune ignores that token and `rune login` tells you why. Rune never deletes the token
  itself: `rune logout anthropic` removes it, and also removes any stored Anthropic API key, so run
  it before you add a key. `rune login anthropic --method oauth` now says why it is refused.
  Details: [`docs/program/compliance-subscription-routes.md`](docs/program/compliance-subscription-routes.md).

### Fixed

- **`ctrl+f` and `esc` work on the agents while a turn is running.** `ctrl+f` did nothing for the
  whole of a running turn, which is the only time a sub-agent is live, although the working row
  advertised it throughout. `esc` pressed with the agents list focused interrupted the run instead
  of closing the list. Both now behave the same whether or not a turn is running: `ctrl+f` opens
  the list, and `esc` steps back one level and interrupts only from the composer. The status line
  no longer says `esc stop` while `esc` would go back.

- **Enter on an agent's card shows its transcript.** In the default single-column layout the
  transcript opened behind the agents list, so enter appeared to do nothing until the list was
  closed by hand.

- **An agent's transcript shows what its calls did.** Each tool call was drawn as the tool's verb
  alone — `read`, with no file and no result — and a failed call looked the same as a successful
  one.

- **An agent writing a large file is no longer reported as quiet.** The time an agent spent
  writing a tool call's arguments was not counted as activity, so its card read `quiet 12s` while
  it was working.

- **The working row no longer ends on a stray `·` in a colour terminal** when sub-agents are
  running and none has reported a verdict yet.

- **A closed transcript is no longer marked `OPEN` on its card** after `ctrl+w` or `esc`.

- **A failed Anthropic request is no longer retried behind Rune's back.** The Anthropic SDK
  retried twice on its own under each of Rune's retries, so one overloaded response could turn into
  a dozen requests before Rune saw a failure. Rune's own retries and fallback now handle it alone,
  as they already did for OpenAI-compatible providers.

- **Rune's own checks no longer leave build output in your repository.** At the end of a turn Rune
  runs the project's checks, and in a turbo workspace `typecheck` builds every package: one run
  left 129 git-ignored files behind (`.turbo/`, a `dist/` in each package). When a pass of checks
  Rune chose ends — passed, failed, timed out or cancelled — the git-ignored paths it created are
  removed again. Only those: a folder that was already there keeps what the check put in it, a new
  file git does not ignore is left for you to see, and `node_modules`, virtualenvs, `.env*` and
  editor folders are never taken. A command you wrote in `[verify] commands` keeps what it builds.
  `[verify] keepGenerated = true` turns the removal off. Details:
  [`docs/verification.md`](docs/verification.md).

- **`bun add` works in the sandbox once a call has network.** Bun's install cache is under your
  home directory, which a sandboxed command may not write, and Bun reported that as "unable to
  write files to tempdir" — so an install failed even with `network: true`. A sandboxed shell now
  keeps Bun's cache inside the project, at `node_modules/.cache/bun`. Nothing is written outside
  the project. npm's, pip's and cargo's caches are not moved yet.

- **A check that ran out of time is not a failed check.** Verification has three outcomes now:
  passed, failed, or inconclusive (timed out, cancelled, no runner on this machine, nothing to
  run). An inconclusive check no longer sends Rune to repair working code, and a slow suite is no
  longer reported as red. The time limit also stops the whole command, not only its shell:
  `cd api && go test ./...` used to run on past its deadline.

- **A project's own `test` script is what runs.** For a Bun project Rune ran `bun test` — Bun's own
  runner, over every test file — instead of the script the project declares. It now runs
  `bun run test`.

- **A test that was already failing is not the run's to fix.** When a check goes red, Rune runs the
  same command on the tree the run started from. A failure that was already there, with the same
  assertion, is named and left alone; only new failures are repaired.

- **Editing TypeScript does not run the Rust checks beside it.** A change confined to JS, TS or
  Python no longer selects a Rust or JVM project in the same folder unless its build files call
  that toolchain, and a documentation-only change runs only the checks that read documentation.

- **"Explain", "review" and "change no code" are held.** When a request says not to change code, or
  names the one file to write, edits and shell writes outside that are refused.

- **Rune's mission file is no longer written into your project.** It lives under Rune's home, one
  per session. Cargo's and Python's generated state from Rune's own checks also stays out of a
  project that had none.

- **A regression test the run wrote can prove the fix.** It is replayed on the tree the run
  started from, your uncommitted work included, and counts as verified only if it failed there and
  passes now. Editing the test afterwards takes that back.

- **A provider that stops answering ends the run after ten minutes, with the work kept.** A
  provider that stalled instead of failing could hold a run through about eighteen minutes of
  retries. `[reliability] providerDeadlineSecs` (default 600, 0 turns it off) bounds it, and
  `rune resume` continues from where it stopped.

- **`kill`, a closed terminal and a shutdown stop a run cleanly.** On SIGTERM and SIGHUP — and on
  Ctrl-C in a headless run — Rune stops the commands it started, records that the run was
  interrupted, removes what its checks had laid out, and exits with the signal's code. The next
  run of that session continues it.

- **A run killed in the middle of a command resumes knowing the command may have run.** The call
  is recorded before it starts. On resume the model is told that its result is unknown, and to
  check before repeating it.

- **A provider cap waits until the moment the provider named.** A Codex plan limit now says what
  it is and when it lifts ("resume this session in ~2h 42m (at 14:08)") instead of a guessed
  fifteen minutes, and Rune does not walk back into the same wall an hour later.

- **Google's metadata server is asked only when Vertex is in use.** The startup credential scan
  used to send a request to `metadata.google.internal` on any machine without a key file,
  including one whose only provider is Codex.

## [1.3.1] - 2026-09-28

**No more keychain prompt, and the models your account actually has.** A patch on 1.3.0. Full
notes: [`docs/releases/v1.3.1.md`](docs/releases/v1.3.1.md).

### Fixed

- **macOS no longer asks for your login password every time Rune starts.** Rune's memory key was
  stored with an access list that locked out even Rune itself, so every read opened the "security
  wants to use your confidential information stored in "rune"" dialog. That happened in every
  release from v0.1.0 to v1.3.0. The key moves to a new keychain item with the default access
  list. The first launch after upgrading asks one last time, with a line saying why, and then
  never again. A read that fails no longer asks again on every check or replaces the real key
  with a new one.
- **gpt-6-astra was metered at about an eighth of its cost.** It carried an estimated $1.25/$10
  per million tokens; the published rate is $10/$50.

### Added

- **The latest models.** GPT-6 Sol and GPT-6 Luna become Codex's standard and light tiers under
  GPT-6 Astra. Claude Opus 5.5 is the new Anthropic default, and grok-4.7 is added. Published
  prices replace estimates for the GPT-5.6 and grok lines. On OpenRouter, Qwen3.8 27B is added
  to the free models and GLM-5.2's free listing is removed.
- **`/model` shows what your account can use.** Rune reads the model list a signed-in account
  publishes, Codex and the OpenAI API included, and merges it into the built-in one. A model
  released after this version still shows up.

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

[Unreleased]: https://github.com/ritikkyyadav/Rune/compare/v1.3.4...HEAD
[1.3.4]: https://github.com/ritikkyyadav/Rune/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/ritikkyyadav/Rune/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/ritikkyyadav/Rune/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/ritikkyyadav/Rune/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ritikkyyadav/Rune/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ritikkyyadav/Rune/compare/v0.1.1...v1.2.0
[0.4.1]: https://github.com/ritikkyyadav/Rune/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ritikkyyadav/Rune/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ritikkyyadav/Rune/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ritikkyyadav/Rune/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ritikkyyadav/Rune/releases/tag/v0.2.0
