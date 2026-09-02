# Gear — The Product Program

**Rev 01 · 2026-09-02 · written at `b1901e9` +53 dirty · for execution by a frontier model (Opus 5) with one developer**

> Gear is a better agent than OpenCode and a far worse product. Capability index 110, maturity 44, blended 84 against OpenCode at 100 (`docs/history` scorecard, 2026-09-02). This program turns the harness into a product without touching the parts that already win.

---

## 0. How to execute this program

You are a frontier model executing on behalf of Savoir. Read this file once. Then open **only** the phase file you were assigned (`docs/program/0N-*.md`). Each phase file is self-contained: goal, evidence, exact seams (file:line, verified 2026-09-02), work items, gates, and what "done" means.

Rules that apply to every phase:

1. **One lane, one worktree.** Work in a dedicated git worktree for your lane (`git worktree add ../Alan-lane-<x> -b lane/<x>` from the main checkout). Never rebase `gear/phase-0-stabilize`. Merge through pull requests to that branch. Concurrent sessions in one tree have swept each other's edits before; this is why.
2. **Stage only what you wrote.** Never `git add -A` at the repo root. Commit per work item with the item id in the subject (`feat(protocol): P2.3 wire the five handlers as round-trips`).
3. **Docs in the same commit.** A stale doc is a defect. `docs/auto-mode.md` describing a fast stage the code removed is the standing example. If a change makes prose wrong, fix the prose in the same commit.
4. **The gate is the definition of done.** Every phase ends with commands that must pass on a clean checkout. Paste their output in the PR. A step without gate output is not done. If a gate fails, report the failure verbatim; do not mark the step complete.
5. **Reinstall and smoke after each phase.** `scripts/install.sh` from the main checkout, then `gear doctor` and `gear tools-smoke`. Never set `GEAR_ALLOW_NON_FF_INSTALL`.
6. **Tests run unsandboxed.** About 40 unit tests bind loopback sockets and fail under a sandbox; that is an environment artifact, not a regression. Run `bun test tests/unit/` outside the sandbox before reporting numbers.
7. **No new UI dialect.** Every surface consumes `@gear/protocol`. No surface reaches into engine internals. The TUI's `ui-grammar.test.ts` stays green and the desktop gets an equivalent.
8. **The evolution store never touches security posture.** Permission broker, sandbox, path guard and network policy never import from notebook/playbook/retro. A dependency-graph test enforces it (Phase 7).
9. **Numbers on screen come from real data.** No invented tokens, costs, or check counts. `null` means "no data", never zero.
10. **Scope discipline.** If you find a defect outside your phase, append it to `docs/program/backlog.md` with file:line and move on.
11. **Ask only for the founder decisions (§8).** Everything else proceeds under the stated assumptions.

Handoff prompt the founder pastes to start a lane:

```
Read docs/program/00-program.md, then docs/program/0N-<phase>.md. You own lane <X>.
Create your worktree per §0. Execute the work items in order. Run the gate after each
item that has one. Open a PR per work item against gear/phase-0-stabilize. Report gate
output verbatim. Do not widen scope; log extras in docs/program/backlog.md.
```

---

## 1. The read

**What the scorecard says.** Gear leads on autonomy and safety (180 vs OpenCode), verification (283), orchestration (131), context (114), observability (158), and is alone on self-improvement. It loses on integration surface (33), extensibility (76), model breadth (84), and the core loop (94). Maturity is 44 because v0.3.0 was never released, one person runs it, and nothing has been validated on another machine. The largest single deficit is integration surface: nothing can drive Gear but a terminal you are sitting at. That axis alone costs 6 weighted points.

**What the code says** (seven read-only audits, 2026-09-02, every claim file:line verified):

- **The engine is already a server in waiting.** `packages/orchestrator/src/bin/engine-host.ts` is JSON-RPC in all but the envelope: 25 commands, four push streams, over stdio *and* unix sockets. A 146-line `HostClient` exists. The desktop app and `gear detach/attach` both drive the engine through it today. `gear serve` is a transport swap plus four gaps, not a re-architecture. Estimate 8 to 12 engineering days.
- **The desktop app is real and bit-drifting.** `apps/desktop`: Tauri 2 + React 19, 8,386 lines, builds green, CI-gated, 11/11 tests. It has the trace rail, the one surface no rival has. It also cannot launch on this machine: no `gear desktop` command exists, the bootstrap file points at a path that does not exist, `interject_chat` is missing from the Rust bridge, `persist` is silently dropped, and four live engine events are ignored by its reducer.
- **Connectors cannot connect.** The MCP client speaks streamable HTTP but has no OAuth. Every remote server in the vendored catalog (Notion, Slack, Linear, Atlassian) is OAuth-protected and returns a 401 that becomes an error string. A complete OAuth 2.1 + PKCE engine exists in `packages/llm-gateway/src/auth/oauth-strategy.ts` and is not wired to MCP. There is no `gear mcp add`. MCP failures are silent under the TUI. Every MCP tool ships its full schema on every request forever.
- **Auto mode is not what its doc says.** The doc describes a two-stage in-path classifier that fails closed to a prompt. The code is 4th-gear autonomy inside the OS sandbox with an out-of-band supervisor and a mechanical containment broker that never asks. Common work costs zero extra model calls; only high-risk actions pay one reasoned call (about 9 s). It fails *contained*, not closed. The labelled corpus is 19 scenarios across 4 tool types; there is no precision, recall or latency reporting; the supervisor's false-positive kill rate, the risk that now matters, is unmeasured.
- **Sub-agents share one dirty tree.** Workers are isolated by path prefixes, not by filesystem, which is why they have no shell. `worktree.ts` exists and is wired only to detached runs. Results are free text: `outputSchema` is declared and unused; `responseFormat` plumbing exists and is used only by research. There is no cost or wall-clock budget per agent, no workflow API, and the task ledger belongs to the lead alone.
- **The release pipeline is strong and unreachable.** Tag-driven builds for five targets, checksums beside the binaries, an install-smoke job. But the repo is private so the README's `curl | bash` cannot work, nothing is code-signed anywhere, Windows binaries are built and cannot be installed, there is no auto-update, the version string lives in four hand-maintained places, and the only tag is v0.2.0.
- **Caching covers one provider fully.** Anthropic is the reference implementation. OpenAI and Google read cache counters and never write breakpoints. OpenRouter emits breakpoints only for `anthropic/*`. Ollama and Copilot have none, and Copilot streams report zero usage.

**The thesis.** Everything above is release engineering, one integration surface, and closing loops that are 80% built. Nothing on the capability side needs new agent research. The pattern in this repo's history is subsystems landed at 80% and abandoned before integration; this program is the integration.

---

## 2. Positioning

**"The agent that proves its work, on any model."**

Two claims Claude Code structurally cannot make:

1. **Any model.** Fourteen provider ids, OAuth for Anthropic, Codex, OpenRouter and Copilot, a fully local Ollama path. Bring the model you already pay for.
2. **Proof.** Steps close on evidence, not on the model's say-so (0 of 87 completed steps unproven across 30 days). Every answer traces to the tools, prompts, permissions and policy that produced it (`gear audit`, the desktop trace rail). A black box records every failure. Exports are signed.

What Gear declines: a hosted cloud, a proprietary model, a marketplace, a chat toy. It is local-first and auditable, and it says so.

The July 2026 assessment concluded "competing with Claude Code head-on is unwinnable." That remains true on model co-training and distribution scale. It is not the fight. The fight is being the agent a team is *allowed* to run and can *trust*, on whichever model they choose. Both differentiators already exist in the code. This program makes them reachable.

---

## 3. The founder's five questions, answered

**Desktop app or CLI?** Both, because the engine is already a daemon. Make the protocol official (`@gear/protocol`, `gear serve`), then every UI is a client: the terminal, the desktop, the same UI in a browser (`gear web`), editors through ACP, CI through `gear -P --stream-json`. The desktop is the flagship UX investment because the trace rail lives there and because the terminal medium has been through ten UI programs and still reads as "stuck in between." The maintenance-surface worry is answered structurally: one protocol package (no duplicated event unions), a generic passthrough bridge in Rust (no per-command drift), and a web-first UI (Tauri is a wrapper; Linux and remote users get `gear web`). What remains is code signing on two platforms and an updater: three to four days to set up, about a day a month after.

**Is Auto mode comparable to Claude Code's?** Structurally it is a different and in some ways stronger design: zero in-path calls for ordinary work, mechanical containment instead of prompts an attacker can summon, fails contained rather than closed. What it lacks is evidence. Phase 6 builds a 200-scenario labelled corpus from the decisions already recorded in 601 sessions, publishes precision, recall, latency and cost per decision source, and makes it a CI gate. Until that report exists, "comparable" is a belief.

**Self-improving versus self-mutating.** A self-improving system changes behaviour only through a measured win on a fixed fitness function, with lineage (why does it believe this), reversibility, blast-radius scoping (repo-scoped may promote on live signal; global and policy changes need an offline A/B), and a permanent control group. A mutating system changes itself without those. The 2026-07 evolution plan already specified the gates (§2.4, §2.5); the code measured 128 runs and acted on none of them. Phase 7 closes the loop and adds the tests that distinguish the two.

**Sub-agents and parallelism.** Give workers their own worktree (the machinery exists), a sandboxed shell so they can verify their own slice, a schema-validated result, a cost and wall-clock budget, and a shared task ledger. Add a deterministic workflow API by generalizing `research.ts`, the one hardcoded DAG in the repo. Phase 6B.

**Tooling and connectors.** `gear mcp add notion` with OAuth 2.1, a seed catalog from the 20 vendored connector templates plus the public MCP registry, deferred tool schemas so a 40-tool server does not cost 40 schemas per request, and plugin install from a URL. Phase 4.

**The UX.** Three visual identities exist today: the terminal customizer contract (five accents × two bases), the desktop's own CSS, and now the Savoir rebrand. Phase 3 collapses them to one token source derived from the Savoir brand DNA: one accent, light and ink, Inter/Söhne and Plex/Berkeley Mono. The five-accent picker goes. The terminal is frozen as "the console": fast, minimal, consistent, no new panels. The desktop is where UX investment goes.

---

## 4. Target architecture

```
                         ┌──────────────────────────────────┐
   packages/orchestrator │  ENGINE  (unchanged core)        │  crates/gear-sandbox
   packages/tool-registry│  agent loop · context · gears    │  crates/gear-tools
   packages/llm-gateway  │  verifier · ledger · black box   │  crates/gear-index
                         └───────────────┬──────────────────┘
                                         │ AgentTurnEvent (22) · ResearchEvent (9)
                                         │ 25 commands · 5 handler round-trips
                         ┌───────────────┴──────────────────┐
                         │  @gear/protocol  (Phase 2)       │
                         │  JSON-RPC 2.0 · versioned        │
                         │  stdio │ unix socket │ websocket │
                         └───────────────┬──────────────────┘
          ┌──────────┬──────────┬────────┴───────┬──────────┬──────────┐
       gear (TUI)  Gear Desktop  gear web      editors    gear -P     @gear/sdk
       the console  Tauri, 3 OS  same bundle   via ACP    --stream-json
       (frozen)     flagship     remote/Linux  (Phase 5)  CI (Phase 5)
```

Invariant: the engine never imports a UI module (today it does, once: `engine.ts:162`). Every client is replaceable. The desktop and the web client are the same React bundle with a different transport.

---

## 5. Phases

| # | Phase | Lane | Days | Gate in one line |
|---|---|---|---|---|
| 1 | [Ship](01-ship.md) | A | 6–9 | Fresh machine, one command, three OSes, `gear doctor` clean; `gh release view v0.3.0` |
| 2 | [One protocol](02-protocol.md) | B | 10–14 | WS client runs a turn with permission + ask_user + held-step round-trips; reconnect replays |
| 3 | [The flagship surface](03-desktop.md) | B | 15–20 | First-time-user script passes on three OSes; one accent, zero shadows, brand checklist test green |
| 4 | [Connect anything](04-connectors.md) | C | 12–16 | `gear mcp add notion` → browser OAuth → tool call in a session; schema tokens/request reported |
| 5 | [Everywhere the work happens](05-surfaces.md) | B | 8–12 | Zed drives a session over ACP; a GitHub workflow in this repo runs Gear on a PR |
| 6 | [Trust you can measure](06-trust.md) | C | 14–18 | Auto-mode P/R/latency table on ≥200 rows; 4-worker worktree build merges clean |
| 7 | [Self-improving, not self-mutating](07-evolution.md) | C | 10–14 | One lesson active with lineage, one retired; lift measured vs `--pristine`; red-team tests green |
| 8 | [Cheaper per task](08-economics.md) | A | 5–8 | Cache hit rate non-null on ≥5 providers; cost/task on the eval suite down vs baseline |

Total: 80 to 110 engineering days. With three lanes running as three model sessions in three worktrees, twelve calendar weeks.

### Calendar (three lanes)

```
week   1    2    3    4    5    6    7    8    9   10   11   12
A    [ P1 ship  ][ P8 econ ][ validation users, point releases ..... ][ v0.4.0 ]
B    [ P2 protocol   ][ P3 desktop                 ][ P5 surfaces ][ v0.4.0 ]
C    [ P4 connectors      ][ P6 trust               ][ P7 evolution][ v0.4.0 ]
                        ▲ cut line (week 6)
```

Dependencies: 3 and 5 need 2. 6B's fleet view needs 2.6. 4.1 (deferred tools) precedes 4.3 (connectors). 7 needs the retro fix (1.1) and the eval harness; it does not need 6.

**Cut line at week 6.** If the program stops there, the world has: v0.3.x installable on three OSes, `gear serve`, a desktop that launches and consumes the protocol (3.1–3.3), and connectors that authenticate (4.1–4.3). That is already a product.

**Versions.** v0.3.0 at the end of week 1 is "ship what exists." v0.4.0 at week 12 is the product release: desktop, web, connectors, serve, ACP. Point releases every two weeks between.

---

## 6. What this moves, honestly

On the existing bench the projection is capability about 120 to 125 and maturity about 80 to 85, blended **105 to 110**. Not 180. The bench saturates: OpenCode already scores 8.5 to 9.5 on four axes, so no amount of work doubles those ratios. The number that matters is a product scorecard, below. "Rival Claude Code" is measured there, not on the index.

### Product scorecard (north stars)

| Measure | Today | Week 12 target |
|---|---|---|
| Install: one command, three OSes, under 5 minutes to first response | 0 of 3 (private repo) | 3 of 3 |
| People running it on machines that are not the author's | 1 | 10, with ≥3 written reports |
| Surfaces that can drive a session | 1 (terminal) | 5 (terminal, desktop, web, editor, CI) |
| Connectors that authenticate in one command | 0 | Notion, GitHub, Linear, Slack |
| Completed steps without evidence | 0 / 87 | 0 / n (hold) |
| Auto-mode labelled corpus with published precision/recall | 19 rows, no report | ≥200 rows, per-source P/R, p50/p95 latency, cost |
| Supervisor false-positive session kills | unmeasured | measured, < 1 per 100 runs |
| Parallel workers in isolated worktrees, merge clean | 0 | 4-worker build passes its own checks |
| Lessons active with lineage / lift vs pristine | 0 / unmeasured | ≥1 / measured monthly |
| Cache hit rate visible on metered providers | 1 of 5 | 5 of 5; cost per eval task −20% |
| Release cadence | 1 tag (v0.2.0) | tag every 2 weeks, CHANGELOG, auto-update |

---

## 7. Claude Code parity ledger

What Claude Code has, and what Gear does about each. "Have" means it exists and works; "build" names the phase.

| Surface | Gear | Action |
|---|---|---|
| Terminal CLI | have | freeze as the console (3.7) |
| Desktop app (macOS, Windows) | have, cannot launch | build, plus Linux (3) |
| Web app | none | build `gear web` from the same bundle (3.2) |
| Cloud-hosted sessions | none | **decline** (local-first positioning) |
| VS Code / JetBrains | none | build VS Code thin client (5.2); JetBrains defer |
| GitHub Actions | none | build `gear-action` (5.3) |
| Agent SDK | 80% (`HostClient`) | build `@gear/sdk` (5.4) |
| MCP client, OAuth, registry install | HTTP only, no OAuth | build (4.2–4.4) |
| Hooks | have | keep |
| Plugins, marketplace | directory only | build install from URL (4.6); marketplace defer |
| Skills | have (181 bundled) | keep |
| Subagents, teammates | have (task/worker, team bus) | isolate + schema + budgets (6B) |
| Deterministic workflows | none (research.ts is hardcoded) | build (6B.6) |
| Worktree isolation | detach only | per worker (6B.1) |
| Background / scheduled / loop | detach, loop-mode | keep; cron routines defer |
| Memory | project + system + notebook | keep; close the loop (7) |
| Auto mode with classifier + sandbox | have, different design | measure (6A) |
| Sandbox on Windows | none (noop) | **defer**; honesty banner (D4) |
| Plan mode | have (plan ledger) | keep |
| Multi-agent code review | pattern exists | defer; a `gear review` workflow is a 6B stretch |
| Remote control | serve `--host` | build (5.5); cloud decline |
| Multi-provider, local models | have | Gear-only differentiator |
| Audit page, trace rail, black box, signed export, org policy | have | Gear-only differentiator; make them reachable (3) |

---

## 8. Decisions for the founder

The program proceeds under the recommendation in bold unless told otherwise.

- **D1 License and distribution.** The repo is private, so the install script cannot serve itself and external validation (25% of maturity, scored 0.5) cannot move. **Recommend open-core:** engine and clients under Apache-2.0; the compliance layer (signed policy tooling, the collector, any hosted service) commercial. If it stays private, Phase 1 ships through a public releases-only mirror and a hosted installer, and the external-validation target drops to 3.
- **D2 Brand.** The Savoir brand DNA (drafting-paper ground, cool ink, one petrol-teal datum, Inter/Söhne, IBM Plex Mono/Berkeley Mono, the block-cursor wordmark) is assumed to be the rebrand. Confirm, and provide: the Gear product mark or the ruling that Gear is set as a Savoir sub-wordmark, the app icon source, the story copy for first-run and the download page. Also: is the product "Gear" or "Savoir Gear"?
- **D3 Default surface.** **Recommend:** `gear` stays the terminal; `gear app` opens the desktop; the download page leads with the desktop.
- **D4 Windows.** **Recommend:** ship the CLI, desktop and web client for Windows with an honest banner ("no OS sandbox on Windows; 1st and 2nd gear only, or run under WSL2"). A native Windows sandbox is deferred.
- **D5 Providers to cut.** **Recommend:** drop `lmstudio` (placeholder model, duplicates Ollama); drop `copilot` unless the founder uses it (undocumented endpoint, VS Code impersonation, zero usage on streams, stale catalog); fold `ollama-turbo`'s three tables into one and reconcile its capacity/billing mismatch.
- **D6 Third-party executable tools.** **Recommend:** plugins are declarative in v1 (skills, commands, MCP servers, hooks). Executable tools stay first-party until they run under the sandbox as subprocesses.

Assumptions in force until answered: D1 open-core, D2 Savoir DNA as given, D3, D4, D5 and D6 as recommended.

---

## 9. Phase index

- `01-ship.md` — ship v0.3.0; Day-0 defects; one version source; signed builds; installers for three OSes; auto-update; two external users.
- `02-protocol.md` — `@gear/protocol`; `gear serve`; all five handlers as round-trips; replay; sub-agent event fidelity; `--stream-json`.
- `03-desktop.md` — revive and finish the desktop; `gear web`; the Savoir design system as the one token source; packaging and updater; the TUI freeze.
- `04-connectors.md` — deferred tool loading; MCP OAuth 2.1; `gear mcp`; resources/prompts/elicitation; failure surfacing; plugin install.
- `05-surfaces.md` — ACP; VS Code; GitHub Action; SDK; remote.
- `06-trust.md` — Auto-mode evidence (corpus, P/R, latency, supervisor FP); worktree workers; schema results; budgets; shared ledger; workflows.
- `07-evolution.md` — run-scoped retro; outcome signal; lifecycle with A/B promotion; gardener; flywheel from incidents; external anchors; the invariants that keep it self-improving.
- `08-economics.md` — caching on every provider; provider consolidation; model-family adapters; cost in the product.
- `backlog.md` — out-of-phase defects found during execution.
