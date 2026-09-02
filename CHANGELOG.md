# Changelog

All notable changes to Gear are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Gear adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version a build reports comes from exactly one place — `scripts/version.sh`, injected at compile
time — so a released binary cannot disagree with the tag beside it. Untagged builds report
`<semver>-dev+<sha>`.

## [Unreleased]

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

[Unreleased]: https://github.com/ritikkyyadav/Alan/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ritikkyyadav/Alan/releases/tag/v0.2.0
