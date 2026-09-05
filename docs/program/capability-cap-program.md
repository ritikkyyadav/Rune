# The capability-cap program

**Started 2026-09-05 at `927205d` on `gear/phase-0-stabilize`.** Response to the "Rune at 72" scorecard
(artifact `286cefa1`) and the audit that checked it against `~/.rune/rune.db` and `~/.rune/blackbox.db`.
The scorecard's climb is ordered by rubric points, so "publish it" comes first. That changes the score,
not the agent. This program is ordered by what the run record shows actually stops runs.

## What the record says (all sessions, measured 2026-09-05)

| Signal                                       | Value                                      | Source                                          |
| -------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Runs ended at the 80-turn ceiling unfinished | 9 (three on 09-03 alone)                   | blackbox `loop.max_turns`                       |
| Second wind fired                            | 0 times ever                               | blackbox has no `loop.second_wind` row          |
| Tool calls per tool-bearing turn             | 1.25 across 6,744 calls                    | rune.db `assistant_msg.toolUses`                |
| Engine refused reads for its own rate limit  | 29 on 09-03 ("Retry after 88ms")           | blackbox `tool.exec_failure` / `tool:read_file` |
| Delegation share of tool wall time           | 59% (worker avg 9.2 min)                   | rune.db, batch deltas                           |
| Retros written → lessons produced            | 68 → 0                                     | rune.db `retro.payload.retro.lessons`           |
| Notebook tactics                             | 5, titled `prefer:cd:cd`, `prefer:sed:sed` | notebook.db                                     |
| Rate-limit incidents                         | 1,022 (798 free-tier daily, 172 Codex 429) | blackbox `provider.rate_limit`                  |

Two audit claims did NOT survive verification and are not in this program:

- "The retro is turn-scoped and under-counts." Every one of the 68 retros matches the tool calls of its
  own run (user message → handoff). The 16 zero-tool retros were greeting turns. `scope: "turn"` is a label.
- "Sub-agents fail 29% of the time with no summary." Fixed before this program (`subagent.ts`, the
  partial-result path); zero `tool:task` / `tool:worker` incidents since 2026-09-01. Pinned by
  `tests/unit/orchestrator/subagent-no-summary.test.ts`.

Also already in place and only verified here: the blackbox pitfalls note (`Engine.knownPitfallsNote`), the
quota cap stop with persistence (`tests/unit/gateway/quota-stop.test.ts`), the malformed-call answer
(`tool.malformed_call`), the write-aware loop detector, concurrent execution of read-only calls.

## The program

Each item names the defect, the mechanism that removes it, and the test that keeps it removed. The rule
for "never comes back": a unit test pins the behaviour, and where a whole class of future code could
reintroduce it, the pin is on the funnel (one place), not on each call site.

### A. The harness stops eating its own turn budget

**Defect.** `MAX_TURNS = 80` is a constant in `engine.ts` with no configuration. Every gate refusal and
nudge costs a completion that counts against that ceiling, and a struggle nudge in the window vetoes the
second wind — so the more the harness polices a run, the more certain it is to end at the ceiling. Sweet-shop
turn 2 (`01a067b8`): art-direction nudge, barren nudge, two step refusals, replan nudge, wrap-up at 68,
product-sight refusal, ceiling at 80, 4 of 4 steps open. Second wind has never fired.

**Mechanism.**

1. `[reliability] maxTurns` (default 80) and `[reliability] secondWinds` (default 2), through
   `ReliabilityPolicy` like every other loop bound. Conversational budgets are unchanged (8 turns, 0 winds).
2. Second wind extends on one criterion — the plan is open AND moved (a step closed with evidence since the
   window began). A struggle in the window no longer vetoes it; an abort or a sighted quota wall still does.
   The runaway guards (loop bail, barren breaker, consecutive errors) remain the things that end a stuck run.
3. Turn refunds: a turn the harness spent on itself — a refused step completion, an evidence / product-sight /
   fix-verified / delegation / open-steps refusal, a stuck / barren / batch / plan / replan / struggle /
   art-direction / greenfield / stale nudge — extends the ceiling by one, up to 25% of the base ceiling.
   Implemented in the incident funnel (`AgentLoop.report`) against an exported `REFUNDABLE_INCIDENTS` set,
   so a new gate that reports one of those classes is refunded without touching the loop.

**Pins.** `agent-loop-second-wind.test.ts` (struggle no longer blocks a moving plan; not-moving still has no
wind), new `agent-loop-turn-refund.test.ts` (a refunded turn does not count; the cap holds; the set is the
funnel), `reliability-policy.test.ts` (config → policy), a source pin that `engine.ts` builds the loop from
the policy, not the constant.

### B. The engine stops throttling its own tools

**Defect.** `ToolRateLimiter` defaults were 20 calls per tool per minute, 10 bash, 60 global. A refusal
reaches the model as an error ("Rate limit exceeded … Retry after 88ms") and costs a completion. The batch
nudge asks for parallel reads; the limiter punishes them.

**Mechanism.** The limiter becomes a pacer: read-category tools are exempt; the engine waits out a short
window (≤ 5 s) instead of refusing, and only refuses when the wait would exceed that. Defaults: 600 global,
120 per tool, 60 bash, 60 write per minute, all under `[tools] rateLimit`. The decision is a pure function
(`resolveRateLimit`) the engine calls.

**Pins.** `rate-limiter.test.ts` (exemption, pacing, refusal beyond the wait, defaults).

### C. The loop detector watches results, not just arguments

**Defect.** `batchSignature` keys on tool name + arguments (+ writes since the last try). A polling call
whose result changes (`bash_output`, a test run after a fix) can still read as a loop; and a run that varies
its calls while getting the identical result back 29 times (evolab3 `team status`) is invisible.

**Mechanism.** `resultSignature(text)` (volatile tokens and durations folded, hashed). The repeated-batch
detector trips only when the repeated call also returned the same result the last two times. A result
recurrence detector nudges once — never bails — when the same substantive successful result comes back four
times with no writes between, whatever the calls looked like.

**Pins.** `call-signature.test.ts` (result signatures), new `agent-loop-loop-detector.test.ts` (changing
results never trip; identical results still trip; result recurrence nudges and never kills).

### D. The evolution loop produces lessons

**Defect.** `retroLessons` only names bash commands that fail twice with one error and never pass. In 68
retros it produced nothing. The failover-tactic title uses the first token of each command, so
`cd x && npm test` → `cd x && bun test` is stored as `prefer:cd:cd`.

**Mechanism.** A curated remedy table: a tool failure shape seen twice in one run yields a `steer` lesson
whose body is the remedy, never the raw error (edit old_text missing / ambiguous, guessed paths, sandboxed
network, ask_user shape, fetch 404, refused step completions). Tactic titles name the differing runner;
degenerate pairs are skipped. The pitfalls note rendering moves to a pure module and gets a test.

**Pins.** `retro.test.ts` (remedies, threshold, transient exclusion, unnamed tools stay unnamed),
`notebook.test.ts` (titles), new `known-pitfalls.test.ts`.

### E. Search backends cool down after a 429

**Defect.** `web_search` retries Brave on every call while it is returning 429; 15 "all backends failed"
incidents on 09-03.

**Mechanism.** A backend that rate-limits is skipped for ten minutes; the next backend is tried in the same
call. **Pin.** `search.test.ts`.

### F. Not in scope, stated plainly

- Quota is procurement. The harness side (cap persistence, stop-not-degrade, auto-resume) exists and is
  pinned; only credits change the 1,022 number.
- Delegation wall time is inherent to delegating whole features; the failure mode is fixed. What remains is
  the model's choice to delegate, governed by `[subagents] mode`.
- The A/B arm needs a live provider budget to run. The machinery is built; it is not exercised here.
- Per-request harness-state narration was tried twice and reverted with a recorded reason; not reopened.

## Status

Filled in as items land. See the bottom of this file.

## Status — 2026-09-05, landed (commit 876f114, on top of the rename generation 38ecdd5)

| Item               | Landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Pinned by                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Turn governance | `[reliability] maxTurns` (80) + `secondWinds` (2) through `ReliabilityPolicy`; the engine builds the loop from the policy, the `MAX_TURNS` constant is gone. Second wind extends on progress alone — a struggle in the window no longer vetoes it; an abort or a sighted quota wall still does. `turn-refunds.ts`: a completion the harness discarded (refused step or finish, skipped batch, barren turns) moves the ceiling up by one in the incident funnel, once per turn, up to a quarter of the base ceiling; a clocked sub-agent gets none. New incident `loop.turn_refunded`. | `turn-refunds.test.ts`, `agent-loop-turn-refund.test.ts` (incl. the sub-agent clock), `agent-loop-second-wind.test.ts` (rewritten struggle cases), `reliability-turns.test.ts` (config → policy, source pin on engine.ts) |
| B. Tool pacer      | Read-category tools exempt; a call over a limit is held for the remainder of its window (`tool.rate_paced`) and refused only past `maxWaitMs`; defaults 600 global / 120 per tool / 60 bash / 60 write per minute, 5 s; `[tools] rateLimit` in config; `resolveRateLimit` is the pure decision the engine calls.                                                                                                                                                                                                                                                                      | `rate-limiter.test.ts` (exemption, wait vs refuse with an injected clock, config mapping, source pin on the engine hook)                                                                                                  |
| C. Loop detector   | `resultSignature()`; a repeated batch trips only when the last two identical calls also returned identical answers; `loop.result_loop` nudges once, never bails, when the same substantive answer recurs four times across varying calls.                                                                                                                                                                                                                                                                                                                                             | `call-signature.test.ts`, `agent-loop-loop-detector.test.ts` (changing poll never trips; identical answers still trip then bail; recurrence nudges and finishes)                                                          |
| D. Lessons         | `TOOL_REMEDIES` + `steer` lessons: a known failure shape twice in one run yields the remedy, never the raw error (edit old_text missing / ambiguous, guessed paths, sandboxed network, ask_user shape, fetch 404, refused completions). `tacticTitle()` names runners, not `cd`. `known-pitfalls.ts` extracted from the engine.                                                                                                                                                                                                                                                       | `retro.test.ts` (the old "non-bash tools are never named" rule rewritten deliberately), `notebook.test.ts`, `known-pitfalls.test.ts`                                                                                      |
| E. Search cooldown | A backend that rate-limits sits out ten minutes; the next backend answers in the same call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `search.test.ts`                                                                                                                                                                                                          |
| F. Verification    | The malformed-call answer had no test despite the record saying it did; one added. Sub-agent partial results and the quota cap stop were already pinned.                                                                                                                                                                                                                                                                                                                                                                                                                              | `agent-loop-malformed-call.test.ts`                                                                                                                                                                                       |

Gates at landing: typecheck clean (shared, tool-registry, orchestrator); lint and format clean; the touched suites 150+ tests green; full unit 3,569 pass with only the known sandbox socket failures; mock evals **63 of 63, no regression** — measured with the Claude Code sandbox off, because rune-tools applies its own Seatbelt profile and `sandbox-exec` cannot nest (four bash-check tasks fail inside the outer sandbox and read as a false 6-point regression); integration 107 pass, 5 skips, the one known LSP failure. Binary compiled in place and installed (`rune-compiled` sha256 `8163c3c7…`, hosted a session in the staged check).

Not done, stated plainly: the A/B arm still needs a live provider budget; quota is procurement; delegation share is a modelling choice under `[subagents] mode`. The evidence for this program is a month of runs before it; the evidence that it worked is the next month of runs — watch `loop.turn_refunded`, `loop.second_wind`, `tool.rate_paced`, `loop.result_loop`, and `steer:` entries in the notebook.
