# Changelog

All notable changes to Rune are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Rune adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version a build reports comes from exactly one place — `scripts/version.sh`, injected at compile
time — so a released binary cannot disagree with the tag beside it. Untagged builds report
`<semver>-dev+<sha>`.

## [Unreleased]

_Nothing yet._

## [0.4.0] - 2026-09-08

Phase 12 ships what exists, on free model routes, with every claim in the README marked verified
live, verified against tests or mocks only, or unverified. It adds no agent capability.

<!-- P12.1 — run economics on free tiers. The lane hands its CHANGELOG lines back in its report; paste them into the sections below and delete this comment. -->
<!-- P12.2 — MCP live and /mcp. Same: lane report lines go here. -->
<!-- P12.3 — skills, plugins and hooks as a user layer. Same: lane report lines go here. -->
<!-- P12.5 — UI freeze and the defect pass. Same: lane report lines go here. -->

### Added

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

[Unreleased]: https://github.com/ritikkyyadav/Alan/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/ritikkyyadav/Alan/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ritikkyyadav/Alan/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ritikkyyadav/Alan/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ritikkyyadav/Alan/releases/tag/v0.2.0
