# Session loop mode

`/loop` runs a prompt repeatedly inside the current Gear terminal conversation. It is intended for
short-lived polling: babysitting CI, checking a deployment, watching review comments, or continuing
maintenance while the session stays open.

## Start a loop

```text
/loop 5m check whether the deployment finished and summarize any failure
/loop check CI and address new review comments
/loop
```

- An interval plus a prompt creates a fixed loop. Units are `s`, `m`, `h`, and `d`; intervals under
  one minute round up to one minute.
- A prompt without an interval creates an adaptive loop. Each iteration can choose a delay from one
  minute to one hour based on what it observed, or stop itself when the objective is genuinely done.
- A bare `/loop` uses `.alan/loop.md`, then `~/.alan/loop.md`, then Gear's bounded maintenance prompt.
  A fixed cadence can still use the default prompt, for example `/loop 15m`.
- A custom slash command can be the prompt: `/loop 20m /review-pr 1234` re-expands that command on
  every iteration. Built-in terminal-control commands are delivered as plain text and cannot
  recursively reconfigure the session from a timer.

## Manage loops

```text
/loops
/loop list
/loop cancel a1b2c3d4
/loop clear
```

Each task has an eight-character id. `Esc` with an empty composer stops the newest waiting loop;
`Esc` during a loop iteration stops that loop and interrupts the current turn.

## Runtime and safety model

- Loops are scoped to one conversation. Starting or switching to another conversation stops them
  from firing; resuming the original conversation restores any unexpired tasks.
- A scheduled prompt fires only while the terminal process is open and the agent is idle. If the
  agent is busy, the prompt waits and runs once after the current turn. Missed intervals do not
  create a backlog.
- Every iteration inherits the conversation's current model, tools, sandbox, permission mode, and
  approval prompts. Scheduling a loop does not grant new authority.
- Definitions are stored as append-only session events. They expire after seven days, and a session
  can hold at most 50 active tasks.
- `.alan/loop.md` files are capped at 25,000 bytes. Symlinked prompt files are ignored so a project
  cannot silently redirect the scheduler to instructions outside the expected location.

Loops are local and session-bound. For unattended jobs that must survive the terminal closing, use
an external scheduler or CI workflow instead.
