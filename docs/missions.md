# Missions: runs that come back after a provider limit

A long headless run can stop because the provider says "come back later" — a quota wall, a
plan limit, or a provider that stopped answering. A mission is an opt-in promise to come back:
wait for the provider's window, continue the same session, and keep doing that until the job is
done or a limit you set is reached.

```bash
rune -P "migrate the store to v2 and get the tests green" --resume-until 8h --resume-budget 2
```

| flag              | meaning                                                                              | default            |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------ |
| `--resume-until`  | the deadline: a duration from now (`90m`, `8h`, `2d`) or a time (`2026-09-28T07:00`) | required to opt in |
| `--resume-budget` | a cap on the session's total list-price spend, in dollars, across every resume       | none               |
| `--resume-max`    | how many times it may resume                                                         | 12                 |

Without `--resume-until` a headless run is exactly what it always was: one run, one exit code.

## What it waits for

When the provider names a window (a `Retry-After`, or a plan cap the gateway has recorded), the
mission waits for that window. When it does not, it backs off: 5 minutes, then 15, 45, 2¼ hours,
never more than 4 hours at a time, and never less than a minute. A window that opens after the
deadline is not waited for at all; the mission ends as `expired`.

## What stops it

| status      | when                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`      | the task finished                                                                                                                               |
| `stopped`   | the run ended on its own terms (a turn cap, a halt, a cancel) — waiting would not change it                                                     |
| `expired`   | the deadline passed, or the next window opens after it                                                                                          |
| `exhausted` | the budget is spent, or every allowed resume is used                                                                                            |
| `blocked`   | something only a person can fix: a missing or rejected credential, or a budget set on a model with no list price (its spend cannot be measured) |
| `cancelled` | you cancelled it                                                                                                                                |

Four quantities are kept apart, because each is a different promise: the **deadline** is wall
clock and nothing extends it (a laptop asleep counts as time passing); **spend** only grows —
waiting refunds nothing; **waited** and **active** time are recorded separately.

## After a restart

A mission's state lives in `rune.db` beside its session. If the process that was waiting dies —
the terminal closed, the machine rebooted — nothing is lost:

```bash
rune missions              # every mission: status, next attempt, deadline, spend, history
rune missions run          # continue this workspace's due missions, then exit
rune missions cancel <id>  # stop one; it stays in the list with its history
```

`rune missions run` is a one-shot, meant for a scheduler you already have (cron, launchd): there
is no Rune daemon. A plan is resumed by one process at a time: when the `-P` process that started
it is still waiting and a scheduled run finds it due too, whichever claims it first continues the
session and the other stops. A cancel holds against both. A resumed run uses the configuration in force _now_ — the gear, the sandbox,
`--auto-approve` as passed to `missions run` — not the one the mission was started under.

## Limits, stated

- The transitions are tested on a fake clock (`tests/unit/orchestrator/resume-plan.test.ts`,
  `resume-loop.test.ts`), including a 48-hour night of repeated walls. That proves the logic, not
  that a real machine stays awake or a real provider behaves.
- The TUI's own quota auto-resume is separate and unchanged: it lives in the terminal session and
  ends with it. Missions are the headless, durable path.
