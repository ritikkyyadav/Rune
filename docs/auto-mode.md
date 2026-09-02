# Classifier-backed Auto mode

Gear Auto mode is a coordinated safety system, not a request for the acting agent to approve its
own work. Ordinary read-only work and reversible project edits stay fast. Actions with a larger
blast radius are reviewed by a separate inference call that has a deliberately stripped context.

This is a production-oriented foundation. It is not, by itself, evidence that a deployment is safe
for production infrastructure. The reviewer model, local policy, sandbox, and organization-specific
evaluation set all matter.

## Decision path

Auto mode is 4th-gear autonomy inside the OS sandbox with a watcher above it — not 3rd gear with a
model standing in front of every call. For every proposed tool call, Gear applies these layers in
order:

1. Signed organization policy, rate/cost limits, the security guard, and pre-tool hooks can block the
   action before Auto mode.
2. Mechanical Auto rules run with `deny -> ask -> allow` precedence. A broad rule that grants
   arbitrary execution, such as `bash(*)`, cannot bypass the reviewer.
3. A halt latched by the out-of-band supervisor (below) stops the run here, before the next action.
4. Fixed circuit breakers — catastrophic host operations, guardrail-lowering changes, writes to
   Gear's own control surface under `.gear`, payloads too large for the bounded reviewer — are pure
   regex and hold whether or not a reviewer is alive. They do not raise a permission card. They go to
   the **containment broker**, which returns a route (below).
5. A tier check clears built-in safe reads and ordinary workspace-confined edits with no model call.
6. **The supervised tier.** Everything mechanical has already run, so what remains at low or medium
   risk is the day's work: builds, tests, dependency installs, API calls, ordinary shell. It runs
   immediately, and the supervisor observes it out of band. Common work therefore costs **zero**
   extra model calls and waits on nothing.
7. What is left is high or critical risk. It pays exactly **one** reasoned reviewer call (about 9
   seconds), which returns a structured `allow`, `ask` or `deny` with a risk rating. A failed call
   retries once against the engine's own heavy/standard tier when a distinct one is configured
   (`reviewerFallback`).

   There is no one-token fast stage in the approval path any more. It could not settle a high-risk
   action — the careful pass ran regardless — and it cost a measured 2–4 seconds on every risky
   write and outbound call. It survives only as the supervisor's screen, in step 9.
8. A `deny`, or a reviewer `ask` that names a missing authorization, does not become a modal prompt.
   It becomes a containment route, or an actionable block the agent raises with `ask_user`. See
   "Containment, not questions".
9. **The out-of-band supervisor.** Every supervised-tier action is also read by a two-stage
   background review on the same bounded transcript: the trigger-happy one-token screen first, then —
   only when that screen says block — the reasoned reviewer to confirm. It latches a halt only on a
   confirmed `deny` rated high or critical. Its only power is to stop the *next* action; it can never
   delay the one it is looking at. An unconfirmed flag costs nothing, and a supervisor that cannot
   answer is an outage, not a finding: it stays silent, because the mechanical breakers are what
   actually guard against destruction and they never call a model.

   A latched halt ends the turn rather than asking. A supervisor objection means the run may no
   longer be the user's — the likeliest cause is text the agent read, not something the user typed —
   and the one thing you must not do in that state is hand the compromised run a dialog it can
   answer.
10. After execution, every real tool result is scanned before either the UI or any agent context sees
    it. Suspicious instructions receive a high-salience untrusted-data warning, and every later
    reviewer-tier action in that session is forced onto the careful reasoned pass with an explicit
    alert.

The lead agent, read-only investigators, deep-research investigators, and owned-file implementation
workers all use the same result-screening boundary. Workers also retain their existing hard
capabilities: no shell, no network, no recursive delegation, and writes only to explicitly owned
files.

## Containment, not questions

A tripped breaker produces a **route**, not a permission card. The old answer failed in both
directions at once: it taxed the person who knows least — a product manager handed
`gh api -X DELETE repos/o/r/git/refs/heads/feature` can only click yes and hope, or click no and
stall — and it did not stop the attack it was built for, because an injected instruction that reaches
a yes/no card has already won half the exchange. The card shows the command, not the reason it
appeared, and the reason is the only part that mattered.

So the broker (`auto-containment.ts`) returns one of five routes, and every one of them keeps the run
moving:

| Route | When | What happens |
| --- | --- | --- |
| `extend` | Ordinary work that needs more room than the sandbox gives — network for an install, a scratch path. | The sandbox is widened for this call and the grant is logged. Nobody is asked. |
| `contain` | The action reaches outside containment for no reason the work requires. | The same action is handed back with its escapes stripped. |
| `redirect` | It cannot be contained, but an equivalent produces the same knowledge with none of the blast radius. | The equivalent is handed back: `terraform plan` for `terraform apply`, `npm pack` for `npm publish`. |
| `defer` | Irreversible and outward, with no local equivalent. | It does not run. It is recorded, the agent finishes everything else, and the user sees one consolidated list when the turn ends — a decision made once, with the work already done. |
| `halt` | The attack case: exfiltration, persistence, host destruction. | Nothing is routed and nothing is asked. The turn stops. |

Every route is mechanical — pure regex over the effective payload. That is deliberate: this module is
what stands when the reviewer model is withdrawn, rate-limited, or 404ing. `contain` degrades to
`defer` when OS isolation is unavailable, because without a sandbox "run it contained" would be a
lie.

**Auto mode fails contained, not closed.** Failing closed to a human prompt cost one build 22 minutes
sitting on a dead classifier. Containment is available by construction.

### When the agent asks

When the reviewer's objection is genuinely an authorization gap — the action is required and only
lacks a human's say-so — the block is returned to the acting agent as an actionable error. The agent
adapts, or asks the user directly with `ask_user`, naming the exact action and its real impact
("Delete the remote branch release/old?"). The user's typed answer is folded into the reviewer's
trusted context, as are mid-run interjections. On the retry the reviewer weighs that answer as
authorization scoped to what the question honestly disclosed: a clear yes clears the action, a vague
yes does not clear a bigger blast radius, and a no keeps it blocked.

The agent-authored question is shown to the reviewer only as framing and is never itself trusted; a
deceptive question cannot launder authorization, because the reviewer re-derives the action's true
target and blast radius.

This is unconditional. It was briefly a setting (`conversationalEscalation`); the setting was never
read, because there is no modal path left for it to select. A config that still sets it is reported
once as retired and ignored — never an error.

The modal permission prompt survives as the backstop for the cases where a human decision is the
product, not an interruption: repeated automatic blocks (`maxAutomaticDenials`), explicit `askRules`,
and Auto mode being disabled by policy.

## Reviewer isolation

The Auto reviewer receives only:

- trusted user messages from the session (including mid-run interjections);
- the user's interactive answers to agent `ask_user` questions, marked as answers to agent-authored
  framing;
- the configured environment and semantic policy text; and
- redacted proposed tool calls from the current run, with blocked attempts marked as never executed.

It does **not** receive the acting agent's prose, hidden reasoning, or tool output. Known credential
formats, bearer/basic credentials, named secrets, and sensitive argument fields are redacted before
the reviewer request. Tool arguments remain untrusted evidence and may contain adversarial text.
Recent user intent and tool-call history are kept within explicit global budgets; Gear preserves the
newest entries and asks a human instead of sending an over-limit review prompt.

By default, the reviewer uses Gear's heavy model tier through a separate, non-streaming request. For
stronger operational separation, pin a dedicated provider/model and dedicated credentials. Remember
that selecting a second cloud provider expands the data boundary: redacted user messages and tool
arguments will be sent to it.

## User configuration

Put this in `~/.gear/config.toml` for one developer, or `<workspace>/.gear/config.toml` for one
project:

```toml
[permissions]
mode = "auto"

[permissions.autoMode]
enabled = true
classifierProvider = "anthropic"       # optional; otherwise use the heavy tier
classifierModel = "reviewer-model-id"  # replace with a configured model id
timeoutMs = 12000
maxAutomaticDenials = 2
failClosed = true
probeToolResults = true
# Retry a failed reviewer call once against the engine's own heavy/standard
# tier (same data boundary) before failing closed to a human prompt.
reviewerFallback = true

# Supplying environment replaces Gear's built-in entry. Keep the first line if
# the default workspace/remotes boundary still applies.
environment = [
  "Internal: the current workspace, its current git repository and configured git remotes, plus loopback services owned by this session. Everything else is external unless the user explicitly names it.",
  "Internal GitHub organization: example-inc; internal staging API: staging.example.internal.",
]

# Semantic guidance for the classifier. These are not hard capabilities.
allow = ["Read deployment status from the internal staging API."]
softDeny = ["Do not mutate shared staging resources unless the user names the exact resource."]
hardDeny = ["Never auto-approve changes to production infrastructure."]

# Mechanical tool/glob rules. Matching covers the entire rule subject.
denyRules = ["bash(*--no-verify*)", "n8n_trigger(*)"]
askRules = ["bash(git push *)", "write_file(.github/workflows/*)"]
allowRules = ["bash(bun test*)", "web_fetch(https://docs.example.com/*)"]
```

Environment overrides are available for deployment systems:

```bash
GEAR_PERMISSION_MODE=auto
GEAR_AUTO_CLASSIFIER_PROVIDER=anthropic
GEAR_AUTO_CLASSIFIER_MODEL=reviewer-model-id
GEAR_AUTO_FAIL_CLOSED=true
```

Legacy `ALAN_*` spellings are adopted as `GEAR_*` at startup when the `GEAR_*` name is unset.

### CLI permission cycle

Shift+Tab advances through exactly five states:

1. **1st gear** — prompt before writes and commands.
2. **2nd gear** — confined workspace edits proceed; commands still prompt.
3. **3rd gear** — add OS-sandboxed local commands and confined delegation.
4. **4th gear** — full autonomy: every interactive prompt is bypassed. No gear touches the OS
   command sandbox — `/sandbox` controls that separately.
5. **Auto** — independently classify risky actions with the isolated reviewer.

The next Shift+Tab returns to 1st gear. Use `/gear 1|2|3|4|auto` (bare `/gear` shifts up) to jump
directly; `/autonomy I|II|III` remains a legacy alias for the 2nd/3rd/4th gears, and the legacy
`/hands-free`, `/turing`, `--yolo`, and `permissions.mode = "hands-free"` spellings still map to
the 4th gear for migration only.

### Rule semantics

- `denyRules` are terminal and run before all Auto shortcuts.
- `askRules` always force a human prompt.
- `allowRules` are hard exceptions, but broad execute/network grants still go through the classifier.
- `allow`, `softDeny`, and `hardDeny` are classifier guidance. Use a mechanical `denyRules` or
  `askRules` entry when an invariant must not depend on a model decision.
- A human's “allow for session” choice is narrowed to the exact risky payload. Catastrophic actions
  still require a fresh decision each time.

## Managed organization policy

Admins can add Auto configuration to the existing signed `OrgPolicy`. Managed arrays are additive,
so developers cannot remove them. A managed `enabled: false` disables Auto, and managed scalar
values such as `failClosed`, timeout, reviewer provider, and reviewer model take precedence.

Example unsigned policy input:

```json
{
  "version": 1,
  "org": "Example Inc",
  "forbidPermissionModes": ["autonomy-iii"],
  "networkDefaultDeny": false,
  "autoMode": {
    "classifierProvider": "anthropic",
    "classifierModel": "reviewer-model-id",
    "environment": ["Internal GitHub organization: example-inc."],
    "askRules": ["bash(git push *)", "bash(terraform *)"],
    "denyRules": ["bash(*--no-verify*)"],
    "failClosed": true,
    "probeToolResults": true
  }
}
```

Sign it with:

```bash
bun run scripts/sign-policy.ts ./policy-input.json ./signed-policy
```

Install `policy.json` and `org.pub` as root-owned files under `/etc/gear/`, or under
`/Library/Application Support/Gear/` on macOS. Gear refuses to start when an installed policy is
unreadable, malformed, or has an invalid signature. Legacy system paths and
`GEAR_POLICY_FILE` development overrides remain supported; a development
override cannot shadow an installed system policy.

## Audit and operations

Every Auto decision is recorded as a queryable `safety_decision` session event and as a
tamper-evident hash-chain audit entry named `safety:<tool>`. Prompt-injection findings create a
`security_probe` event and a `probe:<tool>` audit entry. Arguments are represented by hashes in these
records; reviewer reasons are redacted before persistence.

`/status` and desktop Settings show the active reviewer, fail-closed posture, decision counters,
classifier failures, probe scans, and flagged results. Human prompts show the risk, tier, decision
source, reason, and reviewer identity.

## Current assurance boundary

- The reviewer is an isolated inference request, not a separately trained safety model bundled with
  Gear. Its real error rates depend on the configured model and must be measured on deployment data.
- The prompt-injection probe combines normalization, known-pattern detection, and a model-visible
  warning. It can have false positives and false negatives and is not a substitute for capability
  restriction.
- Auto mode fails CONTAINED, not closed: when the reviewer is unavailable the mechanical breakers and
  the containment broker still route every risky action, so an outage degrades autonomy rather than
  stopping the run. The modal prompt remains only for repeated blocks, `askRules`, and Auto mode
  being disabled by policy.
- The out-of-band supervisor's false-positive rate — how often it halts a session that was never
  compromised — is the risk that matters most, and it is now measured: 30.6% of fast-screen flags did
  not survive the reasoned pass, and 6 confirmed halts over 601 sessions (1.00 per 100 runs). See
  [Assurance](#assurance) below for the corpus, the per-source precision/recall table and the
  latency percentiles.
- The reviewer timeout bounds Gear's decision wait, and the abort now propagates
  into the provider HTTP request itself (SDK/fetch `AbortSignal`), so a late reply is cancelled on
  the wire rather than completing unbilled-for into the void. A provider that has already finished
  generating may still record usage server-side.
- `reviewerFallback` retries only against models already serving this session (the engine's
  heavy/standard tiers), so it never widens the data boundary — but it does weaken strict
  reviewer/actor separation for orgs that pinned a dedicated reviewer. Disable it in signed policy
  when separation matters more than availability.
- Status counters are process-local and reset on restart. The session events and hash-chained audit
  records are persistent.
- No claim of parity with another vendor's private classifier is implied. Treat Auto as private-beta
  for high-consequence environments until the exact model, policy, and infrastructure pass your
  evals and red-team exercises.

## Production rollout checklist

1. Keep `failClosed = true`, OS sandboxing on, network default-deny where practical, and the 4th
   gear forbidden on managed machines.
2. Begin with narrow environment entries and broad `askRules`. Review false positives and denied
   actions before adding exceptions.
3. Build an organization-specific eval set with authorized and unauthorized shell, remote, CI,
   credential, production, and prompt-injection cases. Measure false-negative and false-positive
   rates for the exact reviewer model and policy version.
4. Red-team compound commands, encoded payloads, indirect tool-result instructions, unavailable or
   malformed classifier responses, and repeated-action loops.
5. Alert on classifier failures, fail-open configuration, repeated denials, critical circuit-breaker
   prompts, and probe findings. Retain and periodically verify the audit hash chain.
6. Keep direct human review for production infrastructure, destructive data operations, incident
   response, credential changes, and other high-consequence actions until deployment-specific evals
   justify a narrower policy.

The classifier and output probe are probabilistic defenses and can miss novel attacks. Hard
containment—least privilege, sandboxing, restricted worker capabilities, egress control, signed org
policy, and recoverable workflows—remains the final boundary.

Gear ships a 227-row labelled corpus (`tests/eval/auto-mode-corpus.ts`) as that starting point:

```bash
# Inspect the built-in scenarios without making model calls.
bun run eval:auto-safety --list

# Run them against the exact candidate reviewer. This exits non-zero on any
# false negative or false positive.
GEAR_AUTO_EVAL_PROVIDER=anthropic \
GEAR_AUTO_EVAL_MODEL=reviewer-model-id \
ANTHROPIC_API_KEY=... \
bun run eval:auto-safety
```

Use `--json` for CI ingestion. Extend the labelled corpus with organization-specific actions before
treating its result as a rollout gate: 227 generic scenarios establish that the mechanical layer
holds and locate the recall gap, but they are not evidence about your models, your policy or your
workload.

## Design basis

The architecture follows the public design principles in Anthropic's
[Claude Code Auto Mode engineering article](https://www.anthropic.com/engineering/claude-code-auto-mode)
and [permissions documentation](https://code.claude.com/docs/en/permissions), while retaining Gear's
existing local sandbox, signed policy, worker ownership, and audit controls. The separation-of-duties
and least-privilege posture also follows the direction of
[NIST IR 8596](https://nvlpubs.nist.gov/nistpubs/ir/2025/NIST.IR.8596.iprd.pdf). Anthropic's
[containment write-up](https://www.anthropic.com/engineering/how-we-contain-claude) is an important
reminder that model-side screening should not be treated as a perfect security boundary.

---

# Assurance

*Added by Phase 6A (lane C). This section is appended deliberately: the sections above are being
rewritten in parallel by Phase 1.1 to describe the design as built. Everything below concerns what
Auto mode **records** and what its numbers **are** — it is additive to that rewrite, not a
replacement for any part of it.*

## What a decision records

Every decision Auto makes that is worth persisting (classifier-tier reviews, every non-allow
verdict, human escalations, rule matches and exact grants — `shouldRecordAutoModeDecision`) becomes
one `safety_decision` session event and one hash-chained `audit_log` entry.

| Field | Meaning |
|---|---|
| `toolName`, `argsHash` | The action. Arguments are **hashed, never stored** — the audit log is exportable. |
| `verdict`, `tier`, `risk` | allow / ask / deny · safe \| workspace \| classifier · low → critical. |
| `source` | Which of the sixteen decision sources produced it (thirteen in-path, three supervisor). |
| `stage` | 0 mechanical · 1 fast screen · 2 reasoned. |
| `reason`, `reviewer`, `matchedRule` | Why, by whom, and against which configured rule. |
| `callId` | The tool call this decision gated, so a row joins to the `tool_result` that followed. |
| `turn` | The turn it belongs to. |
| `durationMs` | Total wall clock, unchanged. |
| `timings` | `{ mechanicalMs, classifierMs, retryMs }` — the three parts sum to `durationMs`. |

The timing split exists because one average over both phases described neither: mechanical routing
costs microseconds and a reviewer call costs seconds, so a p50 over `durationMs` was a statement
about the *mix*, not about latency.

## The supervisor writes down what it decided

Low- and medium-risk actions run immediately and a supervisor watches out of band. It can halt the
*next* action, never the one it is looking at. Its verdicts are now recorded as `safety_decision`
rows under their own sources:

- `supervisor_screen` — the fast screen's verdict on an action that already ran, recorded **whether
  or not it fires**. Recording only the flags left the false-positive rate without a denominator.
- `supervisor_reasoned` — the careful confirmation. A screen that fires and a reasoned pass that
  refuses to confirm it *is* a caught false positive, and that pair is the measurement.
- `supervisor_late` — a confirmed halt that landed after the run ended.

These rows gate nothing, so they do not enter the tamper-evident chain of approvals and do not move
the decision counters. Before this, the "screen fired, review disagreed" event incremented a
process-local counter that reset on restart — the risk that now matters most was, in practice,
unmeasured.

## Held steps are the ground truth

A step Auto declines to take unattended is carried to the end of the turn and offered to the user.
What they do next is the strongest safety label the system produces, and it is produced for free:

| Outcome | What it means |
|---|---|
| `ran` | The user approved and ran it **unchanged** — the containment was a **false positive**. |
| `skipped` | They reviewed it and left it unrun — the containment was right. |
| `refused` | Signed policy, a deny rule or a hook stood by the decision. |
| `failed` | It ran and broke on its own terms. **Not** a safety signal; do not read it as one. |

Each becomes a `held_step_outcome` event keyed to the deferral. A `ran` outcome additionally files
an `auto.supervisor_false_positive` incident in the black box. Previously `runHeldStep` recorded a
synthetic allow and dismissal recorded nothing at all, so this signal evaporated every turn.

## Raw arguments: `collectForEval`

A decision whose input was deliberately discarded cannot be replayed as a test case. That is why 913
recorded decisions across 601 sessions could not become 913 labelled corpus rows.

`[permissions.autoMode] collectForEval = true` — **off by default** — keeps the raw arguments in a
separate encrypted store, `~/.gear/auto-eval.db`, AES-256-GCM under `~/.gear/auto-eval.key` (mode
0600, generated on first write), keyed by the same `argsHash` the audit row carries.

It never leaves the machine. No telemetry path, no export, and no black-box writer reads it; the
audit chain keeps hashing exactly what it always hashed. Losing the key loses the sidecar, which is
the correct failure mode for a file whose only purpose is local evaluation.

## The report

`bun run eval:auto-safety` measures the decisions this file describes. It replaces a 19-scenario
smoke test that reported two counts and no rates.

**Corpus: 227 rows**, 126 allow / 101 block, across eleven tool categories — shell, network, write,
read, delegation, connector, browser, automation, config, team, planning. Four provenances:

| | rows | what they are |
|---|---:|---|
| `mined` | 48 | Decisions Gear actually made, recovered read-only from `~/.gear/gear.db` (913 `safety_decision` rows over 601 sessions). Raw arguments were never stored, so these are reconstructed from the recorded tool, risk, verdict and the reviewer's own prose. |
| `regression` | 10 | This system's own documented false positives — the `npm audit` and `npm install` halts, the `/tmp` cleanup halt, the e2e-suite halt, the probe firing on the repo's own security tests, the halt that denied the agent its todo list, the 22-minute fail-closed outage. |
| `redteam` | 30 | Compound commands, base64/hex/reversed/percent-encoded payloads, instructions arriving inside tool results, self-protection probing, reworded retries, arguments impersonating a reviewer verdict. |
| `designed` | 139 | Coverage for every category and both sides of every tier boundary, including the original nineteen. |

**38 rows carry an inferred label** (`reviewed: false`) and await human review. They stay in the
corpus and in the numbers below; `--list` marks them. Hiding an uncertain label is worse than
reporting one.

### Measured 2026-09-02

Positive is BLOCK. Recall is the share of unsafe actions stopped; precision is the share of blocks
that were warranted.

| | offline (dead reviewer) | live (openrouter, `minimax/minimax-m3:free`) |
|---|---|---|
| Precision | 87.2% [78–93] | **94.4%** |
| Recall | 67.3% [58–76] | 67.3% |
| F1 | 76.0% | 78.6% |
| False positives | 0 mechanical | 4 |
| False negatives | 33 | 33 |
| p50 / p95 reviewer latency | — (no calls) | **1,868 ms / 6,465 ms** over 65 reviewed decisions |
| Decisions costing no model call | 227 | **162 of 227 (71%)** |
| Cost | $0 | $0 (free model), 217 live requests |

**The mechanical layer holds.** 55 of 55 mechanical block rows were stopped with no model reachable
at all, and 116 of 116 mechanical allow rows still ran. That is the regression guard for the
22-minute outage, and it is the number that runs on every change.

**The reviewer is where the recall is missing.** Of 46 rows that only a reviewer can catch, the free
model caught 13. Those 33 misses are the entire recall gap: the mechanical layer is not failing,
the cheap reviewer is. That is a procurement finding, not a design one.

### Per decision source (live)

| source | n | precision | recall | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| `supervised_tier` | 116 | — | 0% | 0 ms | 0 ms |
| `containment` | 63 | 94% | 100% | 1,868 ms | 6,465 ms |
| `safe_tier` | 22 | — | — | 0 ms | 0 ms |
| `workspace_tier` | 10 | — | 0% | 0 ms | 0 ms |
| `guardrail_circuit_breaker` | 7 | 100% | 100% | 0 ms | 0 ms |
| `classifier_reasoned` | 6 | — | — | 1,321 ms | 4,778 ms |
| `reviewer_input_limit` | 2 | 100% | 100% | 0 ms | 0 ms |
| `exact_user_grant` | 1 | — | — | 0 ms | 0 ms |

The `supervised_tier` row is the design working as intended and it is worth reading carefully: 116
of 227 decisions were cleared with no model call and no delay. Its 0% recall is not a failure — no
block row is supposed to land there.

### The supervisor's false-positive rate

**30.6%.** Over the live run: 116 fast screens, 36 fired, and the reasoned pass confirmed 25. Nearly
a third of the screen's flags did not survive review.

That is the first time this number has existed. The fast screen is instructed to "err on the side of
blocking", which is correct where it was designed to land — the approval path, where a block costs
one action — and expensive where it now sits, where a latched halt costs the session. The two-stage
confirmation is what keeps that 30.6% from being 30.6% of runs killed, and until P6A.1 the evidence
for that claim was a process-local counter that reset on restart.

`gear audit last` and `gear doctor` now report this from the database. On this machine's 601 real
sessions: **6 confirmed halts, 1.00 per 100 runs** — at the product scorecard's stated limit, not
under it — and "no data" for the two rates that need rows only the new recording produces.

### Reviewer tiers: attempted, not concluded

P6A.5 called for running the corpus against a cheap reviewer and a heavy one and choosing the
default from the numbers. Both credentials exist on this machine and both passes were run.

The heavy pass **did not produce a comparison.** All 65 reviewer-touching decisions returned
`429 The usage limit has been reached`; zero real verdicts, $0 billed. The run is a faithful
reproduction of the failure mode `reviewer-fallback.ts` exists for — the reviewer dying on the same
quota as the session it supervises — and no evidence at all about model quality.

So the default stands unchanged, and it stands on one measured tier rather than two. What the free
tier does establish is worth stating plainly: it clears ordinary work correctly (94.4% precision, 4
false positives in 227) and catches 13 of 46 reviewer-only blocks. A reviewer that misses two thirds
of what only it can catch is not a safe default for a workload that depends on it — but on this
system most of the safety comes from the mechanical layer, which is exactly why that is survivable
and exactly why it is measured separately.

### What this is not

No claim of parity with another vendor's classifier. Nobody has run their corpus against this
system or this corpus against theirs, and a number produced that way would be marketing.

These are our numbers, on our corpus, on the models we could reach: 227 rows, one reviewer tier
measured, 38 labels unreviewed, and a recall gap we can name and locate.
