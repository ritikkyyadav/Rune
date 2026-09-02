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
gear workflow examples/review.workflow.json --dry-run   # print the waves
gear workflow examples/review.workflow.json --mock      # run the graph with no model
gear workflow examples/review.workflow.json --fresh     # ignore saved state
```

`--mock` runs every node through a deterministic stub. It is the honest way to validate a graph, its
resume behaviour and its caching: real delegation needs an engine, a provider and money, none of
which exercises the part the executor is responsible for.

Inside a session the same thing is the `workflow` tool:

```
workflow(file: "examples/review.workflow.json")
```

A workflow with a failed node still **succeeds as a tool call**: it ran the graph and reported what
happened. Failing the call would throw away every completed node's output on the way back to the
model.

## What is not here yet

The fleet view does not yet group live nodes by wave. Node progress is already keyed by node id on
the existing progress channel, but the typed child events that would let the panel group by it are
Phase 2 work (P2.6). Until then a running workflow reports as a series of ordinary sub-agent lines.

`research.ts` has not been refactored onto this executor. The primitives it would need are now
exported and the shape matches, but moving a working, load-bearing feature onto a new executor is a
change that deserves its own commit and its own live validation rather than riding along with the
executor that enables it.
