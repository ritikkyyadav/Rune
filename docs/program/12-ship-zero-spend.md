# Phase 12 — Ship v0.4.0 at zero spend

**Written 2026-09-08.** The founder is one person with no API credits, an exhausted
ChatGPT quota, and a GitHub account whose Actions are blocked on billing. This phase
ships what exists, on free routes, with every claim in the README stated as verified
or not. It adds no agent research. Anything not on this page is frozen.

## The record this phase answers

Measured on 2026-09-07 from `~/.rune/rune.db` (666 sessions) and `~/.rune/blackbox.db`
(3,160 incidents):

| Signal                                              | Value                                   |
| --------------------------------------------------- | --------------------------------------- |
| Turns that ended in error, halt, max-turns or abort | 40 of 120 retro'd turns                 |
| Tool calls that failed                              | 83 of 1,055                             |
| Provider rate-limit incidents                       | 1,414 of 3,160 (45%)                    |
| Hard crashes (dirty exit)                           | 162 total, 0 in September               |
| Sessions that used sub-agents                       | 17 of 666                               |
| Team-bus messages ever sent                         | 0                                       |
| Completions since the meter                         | 2,494 — $0.47 paid, $30 list-equivalent |
| Fresh input tokens per completion                   | ~34k                                    |
| Uncommitted tree at the start of the phase          | 202 files, +10,780 / −2,444             |

Two conclusions drive the plan. **Free tiers break on Rune's own completion count**:
classifier, reviewer, verifier, summarizer and retro are separate calls, each carrying
the doctrine, plan ledger and task state. **Every long run to date was the first live test
of new code**: the mock evals pass at 63/63 and the live gates have never run.

## Constraints

- No paid model calls. Live validation runs on free routes only: OpenRouter
  `minimax/minimax-m3:free`, ollama.com `gpt-oss:120b`, Google's free tier, and Codex
  when its window resets.
- No new agent capability. Self-evolution A/B, the team bus and workflows stay behind
  their flags, labelled experimental in the README.
- No TUI layout change. Defects only.
- Nothing is installed into `~/.rune` or the founder's `~/.alan/bin` by a lane; the
  main session installs once at the end.
- No tag, no push, no visibility change from a lane. The founder decides the public flip.

## Sequencing

```
P12.0  commit the tree, gates green            main session, serial      ← done first
P12.1  run economics on free tiers             lane, worktree, Opus 5    ┐
P12.2  MCP live + /mcp                          lane, worktree, Opus 5    │ parallel
P12.3  skills, plugins, hooks as a user layer   lane, worktree, Opus 5    │
P12.4  onboarding, truthful README, 0.4.0 prep  lane, worktree, Opus 5    │
P12.5  UI freeze + defect pass                  lane, worktree, Opus 5    ┘
P12.6  merge, gates, install, live run, tag     main session, serial
P12.7  founder: repo public, CI green, release  founder
```

Lanes own disjoint files. Shared hot files (`bin/rune-cli.ts`, `engine.ts`,
`packages/shared/src/config.ts`) are touched minimally and merged by the main session.
`README.md` and `CHANGELOG.md` belong to P12.4 only; every other lane hands its changelog
lines back in its report.

## P12.0 — Commit the tree

The 202 uncommitted files are the 5–7 September landings: the UI overhaul and fixed
frame, the six-phase transcript work, the GPT-6 audit response, the provider roster and
search login, and the sandbox policy. They are committed in those groups by pathspec,
never `git add -A`, after typecheck, lint, format and the unit suite (unsandboxed) are
green.

## P12.1 — Run economics on free tiers

**Goal.** Fewer completions per task and fewer fresh tokens per completion, measured.

- A `[routing] helper` model for governance calls (classifier, reviewer fallback,
  summarizer, retro, verifier prompts) distinct from the session model, defaulting to
  the cheapest healthy free route; the primary model is untouched.
- The reviewer is not called when the classifier is confident; the safe tier and
  workspace tier already skip it — extend the skip to `classifier_reasoned` allows
  above a confidence threshold, with the corpus recall gate unchanged.
- Measure what is sent per call: doctrine bytes, plan-ledger bytes, task-state bytes,
  tool schemas. Trim what the retro shows is never read. The JIT doctrine is the
  default; make its effect visible.
- `/cost` and `rune cost` print, per task: completions split primary vs governance,
  fresh tokens per completion, cache-read ratio, and a list-price estimate.
- A retro metric `completions.governance` and a mock eval gate that fails when
  governance completions per task rise above the recorded baseline.

**Acceptance.** A before/after table on the mock suite in `docs/run-economics.md`;
unit tests for the routing decision and the gate; safety corpus recall unchanged.

## P12.2 — MCP live

**Goal.** The 4,000-line MCP client proven against real servers, and a surface to see it.

- Live against `@modelcontextprotocol/server-filesystem`, `server-memory` and
  `server-everything` over stdio, and `server-everything` over streamable HTTP, all
  free and local. Fix what breaks. An integration test spawns them via `npx` and skips
  when offline.
- `/mcp`: servers, health, tool count, last error, reconnect. `rune mcp doctor` for the
  headless path.
- The founder's `~/.rune/mcp.json` points at a path with a typo (`Projects/Alan`);
  doctor must say so in one line and offer the fix.
- `docs/mcp.md`: three configs — filesystem (verified), GitHub with a personal token
  (verified if a token is present, else marked unverified), a remote OAuth vendor
  (unverified, no credentials).

**Acceptance.** The integration test green locally; a screenshot-free transcript of a
session that lists and calls a tool from each server, saved under `docs/evidence/`.

## P12.3 — Skills, plugins and hooks as a user layer

**Goal.** A stranger can add a skill, a plugin and a hook from the docs in ten minutes.

- User skills: `.rune/skills/<name>/SKILL.md` in the workspace and `~/.rune/skills/`
  for the user, frontmatter `name` and `description`, `/skills` to list, `/<name>` to
  invoke, `rune skill add <path>`. Loaded just-in-time the way the playbook skill is.
- Hooks: the event matrix from `hooks.ts` documented with one example per event;
  a `tests/fixtures/hooks/` config exercised by a test.
- Plugins: two working examples under `examples/plugins/`, installed with
  `rune plugin add ./path`, exercised by an integration test that runs their tools.
- `docs/skills.md`, `docs/plugins.md`, `docs/hooks.md`.

**Acceptance.** The three docs, the tests, and a session transcript under
`docs/evidence/` showing a user skill invoked.

## P12.4 — Onboarding, truthful README, 0.4.0 prep

**Goal.** Fresh machine to first task in under three minutes, and a README that says
what is verified.

- First run with no config: login picker with the free routes named first, model
  choice, first prompt. A scripted fresh-`HOME` test measures the path.
- `rune doctor` reports each configured route's health and quota window from
  `provider-health.json`, and names the stale entries.
- README: a "What is verified" section derived from `docs/program/status.md` and the
  audit docs, three columns — verified live, verified by mock/test only, unverified.
  Experimental features named as such. The pitch is completion rate and auditability
  on free and rotting model lineups, not parity with anyone.
- CHANGELOG: `[Unreleased]` becomes `0.4.0`. Version `0.4.0` in `scripts/version.sh`
  and the manifests. The installers and the release workflow agree on `rune-*` asset
  names. No tag.

**Acceptance.** The fresh-HOME test green; README and CHANGELOG reviewed against the
status record; `scripts/install.sh` dry-run finds the expected asset names.

## P12.5 — UI freeze and defect pass

**Goal.** No layout change. Defects found by rendering real sessions, fixed with tests.

- Render the five largest September sessions from `rune.db` through the stored-events
  → `TurnRenderer` method (`render-live.ts`) and inspect for: broken folds, lost diffs,
  stray harness rows, duplicated rows, jitter on resize.
- Fix defects only. Each fix carries a regression test.
- `docs/ui-freeze.md`: the frozen decisions (fixed frame, footer pinned, arrow-burst
  scroll, speaker band, ◇ mark) and the rule that changing them needs a founder
  decision.

**Acceptance.** The rendered transcripts under `docs/evidence/` before and after, and
the tests.

## P12.6 — Merge, gates, install, live run, tag

Main session, serial: merge the five lanes; typecheck, lint, format; unit and
integration unsandboxed; mock evals with the outer sandbox off; `scripts/install.sh`
in place; `rune doctor` and `rune tools-smoke`; one long headless task on a free route
(`gpt-oss:120b`) with the retro saved under `docs/evidence/`; fix only what that run
breaks; commit; tag `v0.4.0`.

## P12.7 — Founder actions

1. Make `ritikkyyadav/Alan` public. GitHub Actions is free for public repositories;
   the billing block ends there. Rename to `rune` when convenient.
2. Confirm CI green on the tag and the release assets present.
3. Put the install link in front of one other person.

## Not in this phase

Self-evolution A/B arms, the team bus, workflow authoring, any TUI layout change, any
new provider, the mark, the repository rename, paid-model validation.
