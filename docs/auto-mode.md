# Classifier-backed Auto mode

Gear Auto mode is a coordinated safety system, not a request for the acting agent to approve its
own work. Ordinary read-only work and reversible project edits stay fast. Actions with a larger
blast radius are reviewed by a separate inference call that has a deliberately stripped context.

This is a production-oriented foundation. It is not, by itself, evidence that a deployment is safe
for production infrastructure. The reviewer model, local policy, sandbox, and organization-specific
evaluation set all matter.

## Decision path

For every proposed tool call, Gear applies these layers in order:

1. Signed organization policy, rate/cost limits, the security guard, and pre-tool hooks can block the
   action before Auto mode.
2. Mechanical Auto rules run with `deny -> ask -> allow` precedence. A broad rule that grants
   arbitrary execution, such as `bash(*)`, cannot bypass the classifier.
3. Fixed catastrophic-operation circuit breakers require a fresh human decision. They cannot be
   bypassed by a reusable session grant or by the probabilistic reviewer. Guardrail-lowering
   changes, writes to Gear's own control surface, and risky payloads too large for the bounded
   reviewer input also require a human.
4. A tier check permits built-in safe reads and ordinary, workspace-confined edits without a model
   call.
5. Shell commands, network/MCP actions, external or protected writes (including `.github/` CI
   surfaces), and agent delegation reach the independent classifier.
6. The fast reviewer returns only `ALLOW` or `BLOCK`. A block, or any deterministically high-risk
   action, receives a second careful review that returns a structured `allow`, `ask`, or `deny`
   decision. A failed reviewer call retries once — against the engine's own heavy/standard tier when
   a distinct one is configured — before failing closed.
7. A denial — and, under the default conversational escalation, an `ask` — is returned to the acting
   agent so it can choose a safer path or ask the user a direct plain-language question via
   `ask_user`. The user's typed answer joins the reviewer's trusted context and can authorize the
   retry. Repeated automatic blocks still pause Auto mode with a real prompt instead of looping.
8. After execution, every real tool result is scanned before either the UI or any agent context sees
   it. Suspicious instructions receive a high-salience untrusted-data warning, and every later
   classifier-tier action in that session gets the careful reasoned pass with an explicit alert.

The lead agent, read-only investigators, deep-research investigators, and
owned-file implementation workers all use the same result-screening boundary. Workers also retain
their existing hard capabilities: no shell, no network, no recursive delegation, and writes only to
explicitly owned files.

## Conversational escalation

The reason other tools feel interruption-free in their auto modes is that a blocked action almost
never becomes a modal permission prompt: it becomes a short conversation. Gear implements the same
loop, on by default (`conversationalEscalation = true`):

1. The reviewer returns `ask` (only a human can resolve the ambiguity) or `deny`.
2. The acting agent receives the block as an actionable error: adapt the approach, or — when the
   action is genuinely required and only lacks authorization — ask the user directly with
   `ask_user`, naming the exact action and its real impact ("Delete the remote branch
   release/old?").
3. The user's typed answer is folded into the reviewer's trusted context (as are mid-run
   interjections). On the retry, the reviewer weighs the answer as authorization scoped to what the
   question honestly disclosed — a clear yes clears the action, a vague yes does not clear a bigger
   blast radius, and a no keeps it blocked.
4. The modal permission prompt remains the hard backstop: repeated automatic blocks
   (`maxAutomaticDenials`), catastrophic circuit breakers, guardrail changes, reviewer outages, and
   explicit `askRules` always pause for a real human decision.

The agent-authored question is shown to the reviewer only as framing and is never itself trusted;
a deceptive question cannot launder authorization because the reviewer re-derives the action's true
target and blast radius. Set `conversationalEscalation = false` (user config or signed policy) to
restore prompt-first behavior for every reviewer `ask`.

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
# Reviewer "ask" verdicts go to the agent for a conversational check (ask_user)
# instead of an immediate modal prompt; the modal remains the backstop.
conversationalEscalation = true
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

1. **Confirm** — prompt before writes and commands.
2. **Autonomy I** — confined workspace edits proceed; commands still prompt.
3. **Autonomy II** — add OS-sandboxed local commands and confined delegation.
4. **Autonomy III** — full system access: disable the command sandbox and bypass prompts.
5. **Auto** — restore the prior sandbox posture and independently classify risky actions.

The next Shift+Tab returns to Confirm. Use `/autonomy I|II|III` to jump to a level or `/mode auto`
to jump directly to classifier-backed Auto. The legacy `/hands-free`, `/turing`, `--yolo`, and
`permissions.mode = "hands-free"` spellings still map to Autonomy III for migration only.

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
- The reviewer timeout bounds Gear's decision wait and fails closed, but the current non-streaming
  gateway API cannot cancel an already in-flight provider request. That late response is ignored,
  although the provider may still record latency or token usage.
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

1. Keep `failClosed = true`, OS sandboxing on, network default-deny where practical, and Autonomy III
   forbidden on managed machines.
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

Gear includes a small labeled live-model gate as a starting point:

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

Use `--json` for CI ingestion. Extend the labeled corpus with organization-specific actions before
treating its result as a rollout gate; ten generic scenarios are a smoke test, not statistical
evidence of production safety.

## Design basis

The architecture follows the public design principles in Anthropic's
[Claude Code Auto Mode engineering article](https://www.anthropic.com/engineering/claude-code-auto-mode)
and [permissions documentation](https://code.claude.com/docs/en/permissions), while retaining Gear's
existing local sandbox, signed policy, worker ownership, and audit controls. The separation-of-duties
and least-privilege posture also follows the direction of
[NIST IR 8596](https://nvlpubs.nist.gov/nistpubs/ir/2025/NIST.IR.8596.iprd.pdf). Anthropic's
[containment write-up](https://www.anthropic.com/engineering/how-we-contain-claude) is an important
reminder that model-side screening should not be treated as a perfect security boundary.
