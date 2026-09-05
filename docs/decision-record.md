# The Decision Record

The one artifact a person reads top to bottom when they want to decide whether
to believe the answer.

Everything else Rune produces answers a different question. The transcript says
what happened, in the order it happened. `rune audit` says what the harness did
— which gates fired, what the context cost, which safety decisions were taken
and why. The plan ledger says which steps closed and on what evidence. None of
them says **how the decision was reached**, and that is the thing a reader
actually needs: not the conclusion, but the branches that were tried and
abandoned on the way to it.

```bash
rune audit last --record        # the record as Markdown, and nothing else
rune export <session> --format md --sign
```

## The six sections

| Section             | What it holds                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| **Objective**       | the goal, verbatim — never a paraphrase                                        |
| **Decision**        | what the run committed to, and the evidence under it                           |
| **How we got here** | every hypothesis in order, with its verdict and the reason — refuted ones kept |
| **What changed**    | the artifacts: files, diffs, reports, previews                                 |
| **Checks**          | the evidence ledger: which command, its exit code, its duration, who ran it    |
| **What remains**    | planned steps that never closed, and decisions still waiting on a person       |

Then one line of provenance: the share of planned steps that closed on
evidence, and when the record was generated.

## What makes it trustworthy

**It is generated, not written.** `buildDecisionRecord` is a pure function of
`TaskState`. There is no model call in it, nothing is summarised, and nothing
is paraphrased. A record that a model wrote would be a second account of the
work by the same model that did the work — which is the thing the record exists
to replace.

**The refuted branches stay.** A run that tried three things and reports only
the one that worked has hidden the two that make the third believable, and
hidden what the answer cost. The folded branches are the section that exists
nowhere else in the system.

**A verdict comes from a check.** The model raises a hypothesis with
`note_hypothesis` while it is still a suspicion; the harness settles it at the
plan boundary — a step whose check failed refutes it with the check's own
summary, a step that closed on evidence confirms it. See
[`plan-ledger.md`](plan-ledger.md), "The narrative".

**An absence is stated.** "No decision was recorded for this task", "Nothing
was produced", "No verification-shaped command ran". Each of those is a finding
a reader should see, and a blank section would read as an omission rather than
as the fact it is. Nothing is ever rounded down to zero and presented as data.

## Where it comes from, and where it goes

At task end the engine builds the record from the final spine, persists it as a
`decision_record` session event, and emits it on the event stream. A record
with nothing in it — no hypothesis, no decision, no artifact, no check — is not
written at all: a heading is not a document.

`rune audit --record` and `rune export` both prefer the **persisted** record
over a fresh generation, so what a person reads later is the document the run
itself produced rather than a regeneration that could drift from it. Sessions
that ended before the record existed fall back to building one from their
spine, which still works because the spine is what the record is made of.

The export embeds it above the transcript — the reader wants the account of the
reasoning, and the transcript is the material it was drawn from — and it is
covered by the Ed25519 signature like every other section.

## The event

`decision_record` carries the whole `DecisionRecord` structure, not the
Markdown: a surface that renders it from primitives (Phase 11's task surface)
needs the structure, and the Markdown is one deterministic rendering of it.
The terminal, the trace rail and the headless runner all name the event and
deliberately draw nothing, because printing the record into a turn would repeat
the entire run back at the reader at the moment they can finally stop reading.
See [`protocol.md`](protocol.md), "The narrative".
