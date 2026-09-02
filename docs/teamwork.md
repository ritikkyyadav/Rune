# Teamwork — many sub-agents, and many Gear instances

Two different kinds of parallelism, one doctrine: **the model provides intelligence, the
harness provides reliability.**

- **Delegation** — one Gear session fanning work out to sub-agents it spawns (`task`, `worker`).
- **Teamwork** — several independent Gear processes working in the same repository, seeing
  each other through a shared local bus (`team`, `/team`).

This is not a distributed system, and it is not agents "talking" to each other over a network.
Every mechanism here is a local file, a local SQLite database, and a nested in-process agent
loop. Nothing leaves your machine, and nothing here is a claim that concurrent agents are safe
to point at production infrastructure.

---

## Part 1 — Delegation (sub-agents)

### The two sub-agent kinds

|                      | `task`                  | `worker`                                      |
| -------------------- | ----------------------- | --------------------------------------------- |
| Purpose              | read-only investigation | implementation                                |
| Tools                | read-only set           | reads anything; writes **only** files it owns |
| Shell / network      | none                    | none                                          |
| Default model tier   | `light`                 | `standard`                                    |
| Default budget       | 16 turns / 8k tokens    | 24 turns / 12k tokens                         |
| Concurrency          | parallel                | parallel (ownership-checked)                  |
| Can spawn sub-agents | no                      | no                                            |

Recursion is prevented by construction, not by instruction: a sub-agent's registry does not
contain the delegation tools, and its permission gate refuses every tool outside its category.

### Per-call routing

Both tools accept two optional arguments so the lead agent can match cost to difficulty:

- **`tier`** — `light` · `standard` · `heavy`. Resolved through the same `[tiers]` table the
  rest of Gear uses (`resolveModelTier`), so `[tiers] heavy = "anthropic/claude-opus-4-8"`
  routes heavy sub-agents there while light scouts stay on a cheap model. Resolution happens at
  **call** time, so a `/model` switch or a key edit mid-session is picked up.
- **`effort`** — `quick` · `standard` · `thorough`. A budget preset (turns + output tokens):

  | effort     | `task`         | `worker`       |
  | ---------- | -------------- | -------------- |
  | `quick`    | 8 turns / 4k   | 12 turns / 8k  |
  | `standard` | 16 turns / 8k  | 24 turns / 12k |
  | `thorough` | 32 turns / 16k | 48 turns / 24k |

Omitting both keeps the previous defaults exactly, so existing behavior is unchanged.

### How many sub-agents can run at once

The lead issues as many delegation calls in one response as the work needs. The agent loop
executes parallel-safe calls through a bounded pool — `maxParallelTools`, default **8** — so a
fan-out larger than the pool queues and drains rather than opening 200 sockets at once. A
1000-way fan-out is therefore _safe_, not _simultaneous_: it runs 8 at a time.

Two things bound it, honestly:

- Every concurrent sub-agent is a real model call against your provider's rate limits.
- Only `worker` writes files, and two workers may never own the same path (below).

Wide fan-out is a real cost. The doctrine tells the model to calibrate — implement directly
when the task fits in a few files, delegate when genuine parallelism exists.

### Ownership: why parallel writers do not corrupt each other

Each `worker` call declares `files` — the paths it exclusively owns (a trailing `/` owns a
subtree). Two mechanisms enforce it:

1. **The claims table.** Ownership is claimed atomically for the run's duration. Overlapping
   ownership with a running worker is refused instantly, before any model call.
2. **The write guard.** The worker's write tools are wrapped: a write outside its ownership
   returns an error to the worker, whatever its prompt says. Ownership is mechanical.

The lead remains the integrator: it designs the seams, dispatches workers, then reads their
reports and wires the pieces together. It still runs the checks on the integrated result — but it is
no longer the first thing to run them, because each worker now verifies its own slice in its own
worktree before merging (below).

### What a sub-agent returns

Both delegation tools declare an `outputSchema` and return a typed object beside the text:

| Field | Who fills it |
|---|---|
| `summary` | the model — one paragraph the parent can act on |
| `findings[]` | the model — discrete, independently checkable conclusions |
| `filesExamined[]` | the model, falling back to the observed tool trail |
| `filesChanged[]` | **the harness** — what was actually written, never what was claimed |
| `checks` | **the harness** — `passed` / `failed` / `not_run` from the worker's own run |
| `confidence` | the model |
| `unresolved[]` | the model — what it could not settle |
| `stopReason`, `toolCallCount` | **the harness** |
| `servedBy` | **the harness** — the model that actually answered, if it changed mid-run |

The split is the design. A model has an incentive to be wrong about what it changed and whether
checks passed, so those fields come from observation; the model contributes prose and judgement.

`result` remains the rendered text the model reads, so nothing downstream had to change. The
rendered form is now produced *from* the object — the old `partialReport` and `buildManifest`
became renderers — which is what stops the prose and the object from disagreeing.

If the sub-agent answers in prose rather than in the schema, exactly one extra tool-less call
converts its own text into the object, constrained by `responseFormat`. That call is deliberately
outside the agent loop: a JSON schema on a turn that still offers tools makes providers choose
between structured output and tool calling, and they choose differently. A sub-agent that already
answers in shape costs nothing extra, and a failed conversion falls back to observation rather
than failing the delegation — throwing away real work over the shape of its report was the
original defect, and it discarded 33 of 68 recorded `task` results.

A structured result that fails its schema is dropped (the parent reads the prose) and filed as a
`loop.schema_violation` incident, so a provider that quietly stops honouring structured output is
visible rather than merely disappointing.

### Each worker gets a filesystem

Every worker runs in its own git worktree at `.gear/worktrees/<workerId>`, on a `gear/worker-<id>`
branch.

The two isolation mechanisms compose rather than compete: **ownership governs which paths a worker
may touch; the worktree governs which filesystem it touches them in.**

The worktree is seeded from the lead's **working tree**, not from HEAD. Branching from the last
commit would hide the lead's uncommitted work, which is exactly the context a worker was dispatched
to build on — a worker that cannot see the interface the lead just wrote will re-invent it. The seed
is `git diff HEAD --binary` applied into the new checkout, deliberately **not** `git stash`: a stash
is repository-global state shared with every other worktree and every other Gear session on the
machine, so a stash/pop pair here would race anything else running, and a crash between the two
would strand the user's work in a stash entry they never made. Untracked files are not carried —
that set is unbounded (build output, `node_modules`, caches) and a worker that needs one can be told
about it in its prompt.

Because the collision is gone, **workers now have a shell.** `bash` is registered for a worker only
when it has a worktree AND the machine provides OS isolation, with the network forced off and the
cwd pinned to the worktree. On a machine without isolation a worker goes back to having no shell
rather than getting an uncontained one — that is the difference between a requirement and a
preference. The reason `bash` was absent was never that running commands is dangerous; it was that
two parallel builds in one tree collide on `node_modules`, `dist/` and every other unowned artifact.

**The worker verifies its own slice** before anything merges. The project's compile-class checks run
inside the worktree; a worker whose checks fail returns `checks: failed`, its branch is **kept and
not merged**, and its changes never reach the lead's tree — merging code that does not compile turns
one worker's failure into everyone's.

Merge-back takes **only the owned paths**. Because ownership is exclusive, `git checkout <branch> --
<path>` is a copy rather than a merge, and that is correct: nobody else was allowed to write those
paths. A path the lead changed anyway (a manual edit, a hook) is a genuine conflict, reported as a
typed `conflicts[]` field rather than as prose, with the branch kept for inspection. The manifest is
`git diff --name-only`, not the model's claim.

The checkout is always removed in the `finally`. The branch survives only when the work did not
land, because then it is the only copy of it.

### Budgets

Every delegated call is bounded by money and by wall clock, not only by turns:

| Argument | Default | Meaning |
|---|---|---|
| `costCapUsd` | 0.5 / 2 / 6 by effort | list-price ceiling for the sub-agent's own inference |
| `deadlineMs` | 3 / 10 / 25 min by effort | wall clock from dispatch |

Both are checked **between turns**, never mid-call — aborting a request already in flight pays for
it and loses the reply. A breach is a **stop, not a failure**: the loop ends, the sub-agent returns
what it has exactly as it does on a turn limit, and `unresolved[]` names the budget and the number
so "re-dispatch with more" is actionable rather than a guess. A budget that destroyed work would
be worse than no budget.

Config sets the defaults for a workspace:

```toml
[subagents]
maxParallel = 4      # concurrent sub-agents; default 8, clamped 1-16
costCapUsd = 3.0
deadlineMs = 900000
```

`maxParallel` was a hard 8 in the agent loop with no key at all — a reasonable default and an
unreasonable ceiling, since eight concurrent heavy workers is a lot of money at once and eight
worktrees is a lot of disk on a small machine.

An unpriced model contributes 0 to the cost meter, so its effective budget is the deadline. That is
the correct behaviour: a price nobody knows cannot be capped, and inventing one would be worse.

`todo_write` is no longer in a `task` sub-agent's registry. Its category is "read", so it was
reachable, and a scout that called it wrote a plan into a throwaway store nobody read while leaving
the lead's real ledger untouched — a scout that believes it is keeping a plan is worse than one
that knows it is not.

### What you see while a fleet runs

Each sub-agent's nested tool calls are reported to the parent as progress notes. The status
line aggregates a fleet into one steady sentence — `4 workers running · w2 edit_file src/api.ts`
— rather than a line per agent or (as before) collapsing to "thinking" the moment the first of
five finished.

---

## Part 2 — Teamwork (multiple Gear instances)

Running `gear` twice in one repository used to produce two blind processes: worker ownership
lived in memory, so two instances could write the same file, and neither could tell the other
anything. The team layer is that gap closed.

### The bus

Every instance registers in a shared SQLite ledger at `~/.gear/team.db` (WAL, 5s busy timeout —
the same pattern as `gear.db`). It holds four things per repository: **presence**, **claims**,
**messages**, and **recent writes**.

Repository identity is the git **common dir**, so all worktrees of one repository share a bus —
an instance in `.gear/worktrees/run-x` and one in the main checkout see each other. Claims,
however, only conflict within the **same working tree**, because separate checkouts cannot race
on a file.

Coordination never breaks a session: every bus operation degrades to a safe default rather than
throwing, and a bus that cannot open leaves the session running solo.

### Liveness

An instance is live when its **pid is alive** and its **heartbeat is recent** (15s beat, 45s
stale window). A crashed instance's presence, claims, and write records are swept by the next
instance to look — no cooperation needed from the dead process. This is the same pid-scoped
liveness discipline the crash sentinels use.

### What the agent sees

When peers are present, a `[Team]` block is injected as an **ephemeral tail message** — rebuilt
every request, never stored in the transcript. A peer that exited two turns ago disappears
instead of haunting the conversation. It lists each peer's id, its stated intent, whether it
shares this working tree, and any paths it has claimed.

Each session advertises an intent automatically — derived from the goal when a new task starts
— and mid-task steering leaves it alone.

### The `team` tool and `/team` command

The model drives the bus with the `team` tool; you drive the same bus with `/team`:

```text
/team                       peers, claims, and unread mail in this repository
/team send <id|all> <msg>   message one instance or everyone
/team claim <path...>       lease paths you're about to change (dirs end with /)
/team release               drop this session's claims
/team intent <text>         set the one-line status peers see
```

**Messages are turn-boundary mail, not a live channel.** A message is queued and folded into
the receiving session's next turn as a harness note; the sender is told exactly that and told
not to wait for a reply. Mail sent before an instance joined is never delivered to it.

Peer messages arrive framed as **peer coordination information, not instructions** — the
receiving session's own user still takes precedence. Because the bus is same-machine,
same-user, and local, `team` is classified as a mechanical action in Auto mode.

### Conflict handling

Set by `[team] claimEnforcement`:

| mode             | a write into a live peer's claimed scope                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| `warn` (default) | proceeds, with a `[TEAM]` warning prepended to the tool result naming the peer |
| `block`          | refused before it executes, with the peer and lease expiry named               |
| `off`            | no claim checking                                                              |

There is a second, softer signal in `warn` and `block` alike: when a live peer wrote the same
path within the last 10 minutes, your write comes back with a note saying so. That catches the
common case — two sessions editing one area with no claims taken at all.

`worker` sub-agents lease their owned files repo-wide for the duration of the run, so one
instance's workers stay off another instance's workers' files. The lease is released when the
worker finishes, whatever the outcome.

### Configuration

```toml
[team]
enabled = true            # default; false disables the bus entirely
claimEnforcement = "warn" # "warn" | "block" | "off"
heartbeatSecs = 15
```

Environment overrides: `GEAR_TEAM=false` disables it, `GEAR_TEAM_ENFORCEMENT=block` raises
enforcement. The engine defaults to **off** for embedders and unit tests; the CLI passes your
config through, which defaults to on.

### What this is not

- **Not a lock.** `warn` mode is advisory by design — Gear does not stop you editing your own
  repository. `block` is available where you want a hard refusal.
- **Not remote.** The bus is a local file. Instances on different machines do not see each other.
- **Not a scheduler.** There IS a task queue now (see The shared ledger, below): an instance can
  post work and any instance can claim it. What no instance can do is make another instance take a
  particular task — work is pulled, never pushed.
- **Not shared context.** Instances exchange messages and claims, not conversation history.
  Each session's transcript stays its own.


---

## The shared ledger

The plan was the lead's alone. `TaskState` was passed to the lead's loop and to nothing else, so a
fleet of four workers building four slices of one feature appeared in the plan as a single
in-progress item with no way to say which worker held it.

**In-process**, a todo item now carries an `owner` and a `claimedAt`, and the store has `claimNext`:

```
store.claimNext("w2")        // takes the oldest unowned pending step, marks it in_progress
store.claimsOf("w2")         // the scoped view a sub-agent is given
store.releaseClaim("w2")     // a worker that could not finish it hands it back
```

`claimNext` is what turns a plan into a queue. The alternative — every worker reading the plan and
picking what looks unclaimed — is a race with no arbiter, and two workers building the same slice is
the specific failure the ownership model exists to prevent one layer down.

A step whose owner has been silent past a reclaim window can be taken by someone else. Without that,
a crashed worker strands its step forever and the fleet deadlocks on an item nobody is doing and
nobody may take. Items written before the ledger became multi-writer simply have no owner, which
means the lead.

**Across instances**, the bus gains a `tasks` table beside `claims`, with the same TTL and the same
liveness sweep:

```
bus.postTask("write the parser")
bus.claimNextTask()          // atomic: UPDATE … WHERE status='pending' is the arbiter
bus.completeTask(id, evidence)
bus.releaseTask(id)
bus.tasks("pending")
```

The distinction between the two tables is the point. A **claim** says "these paths are mine, stay
off them". A **task** says "this needs doing, whoever is free". The bus carried the first and not
the second, which is why this document previously listed a task queue among what the bus is not.

The atomicity is the `UPDATE … WHERE status = 'pending'`: two instances racing for the same row
means one UPDATE changes a row and the other changes none, and the loser asks again. A
read-then-write would let both believe they won.

When an instance dies, the sweep **releases** its tasks rather than deleting them. Deleting — the
obvious symmetry with `claims` and `writes`, which are advisory and worthless once their owner is
gone — would silently drop work at exactly the moment it matters most. The same release happens when
a claim's TTL expires.
