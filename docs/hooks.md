# Hooks

A hook is a shell command Rune runs around a tool call or a session. Formatters,
linters, guards, notifications — anything you want to happen every time, without
asking the model to remember.

Configuration is one file: `<workspace>/.rune/hooks.json`.

---

## Ten-minute version

```bash
mkdir -p .rune
cat > .rune/hooks.json <<'JSON'
{
  "postToolUse": [
    { "match": "*_file", "command": "bun run format:check || true" }
  ]
}
JSON
```

Start a session, let Rune edit a file, and the command's output comes back to
the agent as part of the tool result. That is the whole mechanism.

A worked config with all four events is
[`tests/fixtures/hooks/hooks.json`](../tests/fixtures/hooks/hooks.json); the
scripts it names are beside it, and
`tests/unit/orchestrator/hooks-fixture.test.ts` runs that exact file.

---

## The events

| Event          | When it fires               | `match`   | Non-zero exit                                                                     |
| -------------- | --------------------------- | --------- | --------------------------------------------------------------------------------- |
| `preToolUse`   | before a tool runs          | tool name | vetoes the call **if `"blocking": true`**; otherwise logged and the call proceeds |
| `postToolUse`  | after a tool returns        | tool name | logged, and reported to the agent as a failure line; never blocks                 |
| `sessionStart` | once, when a session begins | ignored   | logged only                                                                       |
| `sessionEnd`   | once, when a session ends   | ignored   | logged only                                                                       |

Every hook gets the same three things: an environment, a JSON payload on stdin,
and a working directory of the workspace root. The command runs through
`/bin/sh -c`, so a pipeline or an `||` is fine.

| Variable           | `preToolUse`               | `postToolUse`           | lifecycle      |
| ------------------ | -------------------------- | ----------------------- | -------------- |
| `RUNE_HOOK_EVENT`  | `preToolUse`               | `postToolUse`           | the event name |
| `RUNE_TOOL_NAME`   | the tool about to run      | the tool that ran       | —              |
| `RUNE_TOOL_ARGS`   | the call's arguments, JSON | —                       | —              |
| `RUNE_TOOL_OUTPUT` | —                          | the tool's result, JSON | —              |

stdin carries the same payload as one JSON object:
`{"event","toolName","args"}`, `{"event","toolName","output"}`, or
`{"event"}` for the lifecycle events. Use whichever is easier; the environment
variables mean a guard needs no JSON parser.

---

## One example per event

### `preToolUse` — refuse a write to something that looks like a secret

`.rune/hooks.json`:

```json
{
  "preToolUse": [
    {
      "match": "write_file",
      "command": "./scripts/no-secrets.sh",
      "blocking": true,
      "timeoutMs": 5000
    }
  ]
}
```

`scripts/no-secrets.sh` (`chmod +x`):

```sh
#!/bin/sh
case "$RUNE_TOOL_ARGS" in
*.env* | *secrets* | *credentials* | *id_rsa*)
  echo "refused: $RUNE_TOOL_NAME targets a secret-looking path" >&2
  exit 1
  ;;
esac
exit 0
```

The tool call never happens, and the agent is told why — the reason it sees is
this script's **stderr**, so make that line say something useful.

### `preToolUse`, non-blocking — record what is about to run

```json
{
  "preToolUse": [{ "match": "bash", "command": "echo \"pre $RUNE_TOOL_NAME\" >> .rune/tools.log" }]
}
```

Without `"blocking": true`, a failure is logged and the call goes ahead. This is
the right shape for anything observational.

### `postToolUse` — feed a linter's findings back to the agent

```json
{
  "postToolUse": [{ "match": "*_file", "command": "./scripts/changed-note.sh" }]
}
```

```sh
#!/bin/sh
printf 'formatting reminder: %s changed a file — run `bun run format:check`\n' "$RUNE_TOOL_NAME"
```

**Whatever a `postToolUse` hook prints on stdout is handed to the model** as
part of the tool result, capped at 2,000 characters. That is the point of the
event: a formatter whose findings only reached a log file was a bystander, and
nothing was ever fixed because of one. A failing hook contributes a line too —
``hook `cmd` exited 2:`` followed by up to 400 characters of its output.

### `sessionStart` — warm something up

```json
{ "sessionStart": [{ "command": "docker compose up -d test-db" }] }
```

### `sessionEnd` — put it away

```json
{ "sessionEnd": [{ "command": "docker compose down" }] }
```

Lifecycle hooks ignore `match` and cannot block anything. A failure is reported
and the session carries on.

---

## Matching

`match` is a tool name with `*` wildcards, matched against the whole name:

| Pattern              | Matches                                   |
| -------------------- | ----------------------------------------- |
| omitted, `""`, `"*"` | every tool                                |
| `write_file`         | exactly that tool                         |
| `edit_*`             | `edit_file`, `edit_files`, …              |
| `*_file`             | `read_file`, `write_file`, `edit_file`, … |

Everything that is not a `*` is literal — a `.` in a pattern is a dot, not a
regex wildcard.

---

## Fields

| Field       | Default    | Meaning                                                                                  |
| ----------- | ---------- | ---------------------------------------------------------------------------------------- |
| `command`   | required   | shell command, run from the workspace root                                               |
| `match`     | everything | tool-name glob; ignored for lifecycle events                                             |
| `blocking`  | `false`    | `preToolUse` only: a non-zero exit vetoes the call                                       |
| `timeoutMs` | `30000`    | hard limit; the whole process group is killed, and a blocking hook that times out vetoes |

Hooks for one event run **in order**, one at a time. A blocking `preToolUse`
hook that vetoes stops the rest of that event's hooks from running.

---

## Failure modes, precisely

- **No `.rune/hooks.json`** — no hooks. Not an error.
- **Malformed JSON, or a bad shape** (`preToolUse` not an array, a `command`
  that is not a non-empty string, a non-boolean `blocking`) — a clear error
  naming the file and the offending entry. Hooks fail loudly rather than
  silently doing nothing.
- **The command cannot be spawned** — treated exactly like a non-zero exit: a
  blocking hook vetoes, anything else is logged.
- **Timeout** — the command's whole process group is killed, so a grandchild
  (`sh -c "sleep 60 &"`) cannot keep the hook hanging. A blocking hook that
  times out vetoes, with the limit named in the reason.

---

## Hooks from plugins

A plugin may ship its own `hooks.json` ([plugins.md](./plugins.md)). Those are
appended **after** yours for each event, so your hooks always run first. A
plugin that declares `permissions.blockingHooks` is telling you it wants to be
able to stop a tool call; `rune plugin list` shows that before and after
installation.

A hook is a shell command you asked Rune to run. It is not sandboxed and it is
not reviewed by Auto mode — installing a plugin with hooks is trusting its
author with your shell. Read them.

---

## What is verified

- `tests/unit/orchestrator/hooks-fixture.test.ts` — 9 tests running
  `tests/fixtures/hooks/hooks.json` itself: the four events load, a blocking
  non-zero exit vetoes with its stderr, an ordinary path is allowed, a
  non-matching tool skips the guard, a non-blocking hook never vetoes,
  `postToolUse` stdout comes back for the model, and a workspace with no config
  is a no-op.
- `tests/unit/orchestrator/hooks.test.ts` — the runner itself: glob matching,
  malformed-config errors, timeouts and process-group kills, spawn failures.
- **Not verified here:** the engine's own wiring of these events into a live
  session is exercised by the engine tests, not by this file's fixtures.
