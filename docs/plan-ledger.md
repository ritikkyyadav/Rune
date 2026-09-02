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

Other rules applied on every list:

- Exactly one step is in progress. Extras are set back to pending, and the
  tool result says so.
- Unfinished steps that vanish from a re-submitted list are noted in the
  result and logged. A replan is legitimate; a silent shrink is not.

## The step check

When a list closes a step that wrote files no check ever covered, the harness
runs the project's compile-class check (typecheck, `cargo check`, `go build`)
before accepting the list — on a one-minute clock, never the test suite. A
failure refuses the completion with the output; a pass becomes the step's
receipt (`2 writes · check ok`). The model can pre-empt it by running the
check itself during the step. `[verify] perStep = false` turns it off.

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
with their reasons, held steps, harness gates that fired, and cost. It opens
`~/.gear/gear.db` read-only — no engine, no provider, instant.
