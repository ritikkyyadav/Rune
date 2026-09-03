# The plan is a ledger

Gear keeps a task spine outside the conversation: the goal, the plan, the
files touched, the verification state. It is re-shown to the model every
request, survives compaction and resume, and is rendered to
`.gear/mission.md` in the workspace. This page describes the rules that make a
step on that plan mean something.

## A step is completed by evidence

`todo_write` is the plan's only write API, and it used to be a pure echo: the
model sent `status: "completed"` and the harness stored it. Nothing checked
that anything had happened. On long runs that is the dominant failure —
steps closed to keep moving, "run the tests" marked done with no command run.

Now the harness measures each step. While a step is in progress (or, for a
step never marked in progress, since the last accepted list) it counts:

| effect      | what counts                                                 |
| ----------- | ----------------------------------------------------------- |
| writes      | files written or edited, worker output                      |
| runs        | non-trivial commands (`ls`, `cat`, `echo`… do not count)    |
| checks      | verification-shaped commands: tests, typecheck, lint, build |
| reads       | files, listings, searches, symbol lookups, web fetches      |
| answers     | `ask_user` rounds                                           |
| delegations | sub-agents dispatched                                       |
| looks       | browser drives, images the model was actually shown         |

A completion with **nothing** behind it is refused once. The tool result
names the step and the reason, and the plan does not move. Re-submitting the
same completion is accepted, but the step is marked **unproven** — in the
task-state block the model reads, in the live checklist (a `~` where a tick
would be), in `mission.md`, and in `gear audit`. The harness cannot know
whether a thinking-only step needed a tool, so it never deadlocks the model;
it makes the claim visible instead of green.

A completion right after a **failing check** is refused the same way. A fix
after the failure (any further write) reopens the question rather than
carrying the failure forward.

A check fails when its **exit code** says so. That is worth stating because it
was not true for two weeks: `bash` reports success for any command that _ran_,
so a failing test suite arrived as a successful tool call carrying
`exit_code: 1`, and the spine recorded it as a pass. The rule above therefore
could not fire at all for checks the model ran itself — only for the ones the
harness ran, where the verifier reads the code directly. The exit code (and a
timeout, which is also a failure) now decides, and the receipt quotes stdout,
where a test runner writes its verdict.

Other rules applied on every list:

- Exactly one step is in progress. Extras are set back to pending, and the
  tool result says so.
- Unfinished steps that vanish from a re-submitted list are noted in the
  result and logged. A replan is legitimate; a silent shrink is not.

## The step check

When a list closes a step that wrote files no check ever covered, the harness
runs the project's compile-class check before accepting the list — on a
one-minute clock, never the test suite. A failure refuses the completion with
the output; a pass becomes the step's receipt (`2 writes · check ok`). The model
can pre-empt it by running the check itself during the step.
`[verify] perStep = false` turns it off.

The compile-class check is whatever the project's stack provides: a `typecheck`
script or `tsc --noEmit`, `go build`, `cargo check`, `./gradlew classes`,
`./mvnw compile`, `pyright` or `mypy` — and, where an ecosystem has no cheap
project-wide check, one built from the files the step wrote
(`python -m py_compile`, `javac` into a throwaway directory). In a workspace
holding several projects, the check runs the one whose files the step touched.
A toolchain that is not installed is recorded as skipped, not as a failure. See
[`docs/verification.md`](verification.md).

The receipt names the command, its exit code and its duration, and `gear audit`
prints them under **Checks**. The counter used to be all there was, so a page
whose purpose is evidence could say a step had been checked without being able
to say by what.

## The boundary follows the plan

A follow-up message never replaces the goal. Mid-task, it is steering. After
a finished task, a substantive follow-up is recorded as a **candidate** goal
and becomes the goal — with the outgoing goal archived as lineage — only when
the model writes a fresh plan against it. A follow-up that never earns a plan
("I can't see the preview, can you show me") costs nothing; a genuine new
mission rolls the goal on its first `todo_write`.

This replaces a rule that decided from the message alone, patched with lists
of push-words. Vocabularies rot: a 57-character question with no question
mark replaced a six-hour build's specification as the goal and emptied its
plan.

## Finishing with steps open

No finish-time gate used to look at the plan. A run could abandon twelve of
fifteen steps, end clean, and have its resume note deleted on the way out.

Now finishing with steps open is refused once: do them, or rewrite the plan
so it says what is cut and why. The second time the run may end, but on the
record — the transcript says "ended with planned steps still open", the
mission file keeps a resume note, and the next message resumes instead of
forgetting.

## When nothing changes

The request-side loop detector catches the same tool batch repeated with no
write between. It cannot see differently-shaped calls that keep returning the
same thing — a status page read thirty times, five patterns that all match
nothing. The results-side breaker can: a turn whose every tool result was
already seen this run, with nothing written and no plan change, is stale. Six
stale turns earn one nudge; twelve end the run with a resumable handoff that
says why. Lead loop only — sub-agents run on small turn budgets already.

## The narrative: how the decision was reached

The ledger above says what was done and on what evidence. It cannot say why one
approach was taken and two abandoned — and that is the half a person reads when
they want to trust the answer. A run that tried three things and reports only
the one that worked has hidden the part that makes the answer checkable.

So the spine carries a narrative beside the plan:

| field              | what it holds                                                                 |
| ------------------ | ----------------------------------------------------------------------------- |
| `kind`             | `investigate · build · analyze · research · operate · write`                  |
| `narrative`        | hypotheses (`proposed/testing/refuted/confirmed`, with reasons) and decisions |
| `artifacts`        | files, diffs, reports, charts, tables, previews the run produced              |
| `pendingDecisions` | held steps, `ask_user` questions, approvals and reviews, as ONE list          |
| `progress`         | steps closed on evidence over steps — derived, never guessed                  |

**The kind is read once.** At task start, from the first message and the
workspace: deterministically when the ask names its own verb ("why is X slow"
is an investigation, "build me X" is a build), and with one small model call
only when nothing in the ask decides it. A classifier in front of every task
start is a tax on every task; behind an ambiguity gate it is paid only by the
asks that are genuinely ambiguous. The model may revise it once, through
`read_back`'s `kind` field. A wrong reading costs a layout, never a capability.

**A hypothesis is named before it is tested.** `note_hypothesis` records the
suspicion while it is still a suspicion. That ordering is the whole feature: a
hypothesis recorded after its own refutation is a story told backwards, and one
recorded only when it turns out to be right is a record of the answer rather
than of the investigation.

**The verdict comes from a check, not from confidence.** The harness infers it:
a plan step whose verification FAILS marks the hypothesis it was testing
`refuted`, with the check's own summary as the reason; a step that closes on
evidence marks it `confirmed` and attaches that evidence. The model can report a
verdict too, and the reason is recorded either way — but it never has to be
believed for the record to say what happened.

**A decision is bound to its evidence.** `record_decision` writes the
commitment and the `EvidenceRef`s behind it. It also revives the spine's
`decisions` list, which existed from the first version and had exactly one
writer in the repository — a test — so the injected block's "Decisions" line was
permanently empty and every commitment was forgotten at the first compaction.
A decision with nothing behind it is recorded as unbacked rather than refused:
the harness cannot know whether a commitment needed a citation, so it makes the
absence visible instead of arguing about it.

**Progress is derived.** Completed steps that carry measured evidence and are
not marked unproven, over total steps. A step the model closed with nothing
behind it does not move it. No plan means no progress — absent, not zero.

**The narrative belongs to the mission.** When the goal rolls, the hypotheses,
decisions and kind go with it. The file and check ledgers stay, because they are
true of the workspace and a new goal does not un-write a file.

All of it persists in the `task_state` snapshot, renders into `mission.md`
under **How we got here**, and reconstructs on replay — ids included, so a
resumed run cannot mint an `h1` that already exists. See
[`decision-record.md`](decision-record.md) for the artifact it all ends in.

## The log and `gear audit`

The spine now carries its own log: plans recorded, steps closed (with their
receipts), steps closed unproven, steps dropped, checks run, boundaries
crossed, gates that refused a finish, handoffs. It renders into
`.gear/mission.md` under **Log**.

```bash
gear audit last
```

prints one page for a session: goal, plan with receipts and unproven marks,
the log, runs and early terminations, tools and failures, safety decisions
with their reasons, held steps, harness gates that fired, context utilization
per turn with every compaction, and cost. It opens `~/.gear/gear.db` read-only
— no engine, no provider, instant. See [`context.md`](context.md) for what the
**Context** section means.
