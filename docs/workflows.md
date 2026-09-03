# Workflows — a repeatable shape, written down

`research.ts` was the only DAG in this repository, and it was hardcoded: plan → approve → fan-out →
reflect → synthesize, expressed as control flow around `mapWithConcurrency`. It works. Every
property that makes it good — the fan-out, the bounded concurrency, the fixed shape — was trapped
inside one feature.

Anything else that wanted a repeatable multi-agent shape had to be expressed as a prompt asking the
model to please do these five things in this order. That is the sort of instruction a model follows
four times out of five, and the fifth time is the one you find out about later.

A workflow is that shape as a file.

```json
{
  "name": "review",
  "maxParallel": 4,
  "nodes": [
    { "id": "scope", "kind": "task", "prompt": "List every file the current diff touches." },
    {
      "id": "security",
      "kind": "task",
      "dependsOn": ["scope"],
      "tier": "heavy",
      "prompt": "Review for SECURITY only. Cite file:line.\n\n{{scope}}"
    },
    {
      "id": "report",
      "kind": "task",
      "dependsOn": ["security"],
      "retry": 2,
      "prompt": "Write the review from the confirmed findings below.\n\n{{security}}"
    }
  ]
}
```

## The node

| Field            | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `id`             | Unique within the workflow. Also the cache key and the fleet-view group. |
| `kind`           | `task` (read-only investigation) or `worker` (write-capable).            |
| `prompt`         | The instruction. `{{other_id}}` interpolates that node's output.         |
| `dependsOn[]`    | Ids that must complete first.                                            |
| `files[]`        | Required for a `worker`: the paths it exclusively owns.                  |
| `retry`          | Attempts including the first. Default 1.                                 |
| `tier`, `effort` | Model tier and turn/token budget for this node.                          |
| `label`          | A short name for the live view.                                          |

A node is an ordinary `task` or `worker` call. The executor never talks to a model itself — it calls
back into the registry's own delegation tools — so ownership, budgets, worktree isolation and the
schema-validated result are identical to a hand-written delegation. A second, parallel delegation
path would have drifted from the first one within a month.

## Execution

Nodes are grouped into **topological waves** and each wave runs through the same
`mapWithConcurrency` the research DAG already uses. A dependency cycle is refused before anything
runs, and the error names the nodes involved — "workflow did not finish" is a far worse message than
"a and b depend on each other".

A node whose dependency **failed** is `skipped`, not run. Running it anyway would hand a model a
prompt with a hole where its input should be and get back a confident answer to a question nobody
asked. A node whose dependency merely _does not exist in its prompt_ is different: its output is
appended under a heading, because a node that declares a dependency and never reads it is almost
always a prompt someone forgot to update.

One failure does not stop the world. Independent branches of the graph keep running.

## Resume and caching

Each node's result is cached by a **content hash covering its own definition and the resolved
outputs of everything it depends on.**

That second half is the whole point. Hashing only the node would let a changed dependency reuse a
stale downstream answer — which looks like a working cache right up until it is wrong. With upstream
results in the key, editing one prompt invalidates that node and everything below it, and re-running
an unchanged workflow costs nothing.

State is written to `.gear/workflows/<name>.state.json` **after every node**, not after every wave.
A kill lands between two nodes far more often than between two waves, and the entire value of resume
is not paying twice for the expensive node that already succeeded.

```
gear workflow examples/workflows/review.workflow.json --dry-run   # print the waves
gear workflow examples/workflows/review.workflow.json --mock      # run the graph with no model
gear workflow examples/workflows/review.workflow.json --fresh     # ignore saved state
gear workflow examples/workflows/greenfield.workflow.json --mock --max-parallel 1 \
  --stop-after backend                                            # a kill you can aim
```

`--mock` runs every node through a deterministic stub. It is the honest way to validate a graph, its
resume behaviour and its caching: real delegation needs an engine, a provider and money, none of
which exercises the part the executor is responsible for.

`--stop-after <id>` aborts a mock run the instant that node completes and leaves the state on disk.
Resume is the property a workflow is worth having, and the only way to check it is to stop a run in
the middle and start it again — timing a signal at a run whose nodes return instantly is a race, and
naming the node is not.

Inside a session the same thing is the `workflow` tool:

```
workflow(file: "examples/workflows/review.workflow.json")
```

A workflow with a failed node still **succeeds as a tool call**: it ran the graph and reported what
happened. Failing the call would throw away every completed node's output on the way back to the
model.

## Watching one run

The fleet view groups a workflow's live nodes **by wave**, in the console and in the web app:

```
  review · wave 2 of 3 · after scope
  > scout  security   grep src/auth.ts · 22s
  . scout  perf       done · 3 steps · 8s
  . scout  style      cached
```

The level is usually the whole explanation for why a node has not started, and the edges into a
level (`after scope`) are the half that makes the level mean something — "wave 2 of 3" says there
is an order without saying what it was waiting for. An ad-hoc `task`/`worker` fan-out keeps its
flat rows: every member of one was dispatched at once and none waits on another, so grouping it
would name a structure it does not have.

Two node states are visible that nothing else could report. A **cache hit** runs no agent at all,
so it shows `cached` and no clock — a duration beside it would claim the work happened this time.
A **skipped** node never started, and is drawn as skipped rather than as a failure: reading a skip
as a failure sends you looking for a defect in the one part of the graph that behaved correctly. A
node on its second attempt says `attempt 2 of 3` while it is retrying, rather than only in the
receipt afterwards.

None of this is parsed from a heartbeat. The executor already knows the topology, so it is carried:
every node's wave, its edges, its attempt, and whether it was cached ride on the typed child event
as `tool_progress.child.node` (`WorkflowNodeContext`). A workflow is **one** tool call, so its nodes
have no `tool_call_start` of their own — the node context is what opens their rows, and it is
complete before a node runs, which is what lets a node queued three waves out be drawn as queued
rather than as an absence.

## The first consumer

`research.ts` runs on this executor. Its investigator fan-out — the DAG this file was extracted
from — is a workflow whose nodes are the round's sub-questions, run through `runWorkflow` with the
same bounded concurrency, the same per-node failure isolation and the same events every other
workflow gets. Its surface is unchanged: `gear research`, `/research` and the research event stream
are what they were, and the research tests are untouched.

A round is one wave of independent nodes. The dependency between _rounds_ is the reflect step, and
that is not a node: its follow-ups are what decide whether there is a next round at all, so it
cannot be an edge in a graph that has to exist before the graph runs. Nothing is persisted —
research has never been resumable, and giving it a state file here would be a new feature wearing a
refactor's clothes.

The one behaviour that changed: an aborted run now stops **dispatching**, instead of starting
investigators it is about to kill. That is the executor's signal check, and it is the better
behaviour.

This is what a second, parallel execution path would have cost. There is one path, so a fix to its
concurrency, its resume or its reporting reaches research and every written-down workflow at the
same time, instead of the two drifting apart the way two implementations of the same thing always
do.

## The two that ship

`examples/workflows/` holds the shapes the feature exists for. Both run against the mock provider,
and `tests/integration/workflow-examples.test.ts` drives them through the real command — an example
that has never run is a JSON file with opinions in it.

**`review.workflow.json`** — scope the change, four **scoped reviewers** in parallel who cannot see
each other's findings, then two **verifiers**, then the report. The verifiers are two different
jobs: `verify` opens every cited `file:line` and decides whether the finding is real (a reviewer's
confidence is not evidence), while `gaps` reads the diff itself rather than the reports, looking for
what falls _between_ four dimension-scoped reviewers — the change that is individually correct,
individually secure and individually tested, and still wrong as a whole.

**`greenfield.workflow.json`** — one heavy pass that decides **the seam** (the exact signatures and
error cases between backend and frontend) and assigns each slice the paths it owns; then backend,
frontend, tests and docs as four `worker` nodes, each in its own git worktree; then `integrate`,
whose real output is the list of places where a slice's own claim stopped holding once it met the
others; then `seams`, which checks the one thing parallel workers structurally cannot — what falls
between the slices nobody owned.

The seam is decided once, in wave 1, precisely because the alternative is four workers negotiating
it four ways in parallel and three of them being wrong. Every worker declares `files`: ownership is
what makes a worker safe, and four workers sharing a tree is the failure the requirement exists for.
