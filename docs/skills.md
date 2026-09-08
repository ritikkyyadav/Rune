# Skills

A skill is a folder with a `SKILL.md` in it. The file holds instructions you
want Rune to follow — a checklist, a house style, a runbook — and Rune loads it
only when it is needed.

A skill is **not** a program. Nothing in it is executed by installing it or by
listing it. Invoking one puts its text into the conversation; every command in
it still goes through the same permission ladder as any other turn.

---

## Ten-minute version

```bash
mkdir -p .rune/skills/release-checklist
$EDITOR .rune/skills/release-checklist/SKILL.md
```

```markdown
---
name: release-checklist
description: Walk the pre-release checklist — gates, changelog, version, working tree. Use before cutting a release.
argument-hint: <version, e.g. 0.4.0>
---

# Release checklist

Target version: $ARGUMENTS

1. Run `bun run typecheck`, `bun run lint`, then `bun run test:unit`. Report the
   failure count, not a verdict.
2. Confirm `CHANGELOG.md` has an entry for $ARGUMENTS.
3. `git status --porcelain` must be empty. List anything uncommitted rather
   than committing it yourself.

Stop and ask before tagging or pushing anything.
```

Then, in a session:

```
/skills                       what is installed, and where it came from
/release-checklist 0.4.0      run it
```

That is the whole mechanism. A copy of the file above ships at
[`examples/skills/release-checklist`](../examples/skills/release-checklist), so
`rune skill add ./examples/skills/release-checklist` gets you a working one
without any typing.

---

## Where skills live

| Location                                   | Who it is for                                        |
| ------------------------------------------ | ---------------------------------------------------- |
| `<workspace>/.rune/skills/<name>/SKILL.md` | this repository — commit it, and your team gets it   |
| `~/.rune/skills/<name>/SKILL.md`           | you — available in every workspace                   |
| `<workspace>/.rune/plugins/<p>/skills/…`   | shipped by a plugin (see [plugins.md](./plugins.md)) |
| the bundled catalog                        | ships with Rune                                      |

A name present in both your workspace and your home resolves to the
**workspace** copy: a repository's own instructions beat your personal default.

`.rune/skills/playbook/SKILL.md` is written by Rune itself from what it has
learned in this repository, using exactly the format above. It is one more
skill; you can read it, edit it, delete it or commit it. See
[self-evolution.md](./self-evolution.md).

---

## The file

```markdown
---
name: release-checklist # optional; the folder name is used when it is absent
description: One line. This is what Rune reads to decide the skill applies. # required by `rune skill add`
argument-hint: <version> # optional; shown in the command palette
---

The body. Markdown. As long as it needs to be.
```

Only `name` and `description` matter. The **description is the routing
signal** — it is the line that sits in the system prompt and the only thing the
model sees before deciding to load the body. "Use before cutting a release, or
when asked what still blocks one" routes; "release stuff" does not.

Arguments are substituted into the body when the skill is invoked:

| Placeholder               | Becomes                           |
| ------------------------- | --------------------------------- |
| `$ARGUMENTS` / `{{args}}` | everything after the command name |
| `$1`, `$2`, …             | whitespace-separated tokens       |

A body with no placeholder still gets its arguments — they are appended as an
`Arguments:` line rather than dropped.

Files next to `SKILL.md` (`references/`, `examples/`, a `RUNBOOK.md`) are listed
to the agent as bundled resources it can open with `read_file`. They are not
loaded into the prompt.

---

## Commands

```
rune skill add <path> [--user] [--name N] [--force]   copy a skill folder into place
rune skill list                                        what is installed, and from where
rune skill remove <name> [--user]                      delete one
```

`add` takes the folder or the `SKILL.md` inside it. Without `--user` it installs
into `<workspace>/.rune/skills/<name>`; with `--user`, into `~/.rune/skills/<name>`.
`--name` renames the skill for real — it rewrites the `name:` in the installed
copy's frontmatter, so the folder and the skill never disagree.

`add` refuses a folder with no `SKILL.md`, a `SKILL.md` with no `description`,
and a name that could not be typed as a command (lowercase letters, digits, `-`
and `_`). It never overwrites without `--force`, and it does not copy `.git`,
`node_modules`, `dist` or `.turbo`.

In a session:

```
/skills              every skill, with your own listed by /name, description and origin
/skills <keywords>   search
/<name> [args]       load one now
```

---

## Two ways a skill gets used

**Rune chooses it.** Every skill's name and description ride in the system
prompt. When a request matches, the model calls the `skill` tool, which returns
the body. This is the ordinary path, and it costs one catalog line per skill
until something matches.

**You choose it.** `/<name>` reads the `SKILL.md` at that moment — not at
startup — substitutes your arguments, and starts a turn with it. Editing a
skill takes effect on the next invocation; no restart.

Built-in commands win a name collision (`/status` is always `/status`), and a
`.rune/commands/<name>.md` file wins over a skill of the same name. A skill that
loses a name is still listed by `/skills` and still loadable by the agent.

---

## What Rune will and will not do to a skill

Reading a skill is ordinary work: Auto mode treats a `read_file` of a `SKILL.md`
like any other read, because reading the instructions you gave it is how it
finds out what you asked for.

**Writing** one is not. `.rune/skills` is part of Rune's own control surface, so
a model-authored write there trips the guardrail breaker and needs your explicit
confirmation — the same treatment as `.rune/hooks.json` or `.rune/config.toml`.
That is deliberate: a skill can direct multi-step behaviour, so an agent that
could write one silently could grant itself a standing instruction.

The playbook Rune writes for itself goes to `PENDING.md`, which the loader does
not read, until you enable learned skills once.

---

## What is verified

- `tests/unit/orchestrator/skills-user.test.ts` — 21 tests: discovery from both
  locations with origin and precedence, argument substitution, just-in-time body
  reads, `/<name>` command construction and name collisions, and every refusal
  the installer makes. Runs against a temporary `RUNE_HOME`.
- `tests/unit/orchestrator/auto-mode.test.ts` — reading a user skill is not a
  guardrail change; writing one still is.
- Run by hand on 2026-09-08: add, `--user --name`, list, the duplicate refusal
  and remove, against a temporary workspace and home. Transcript in
  [`evidence/skills-20260908.md`](./evidence/skills-20260908.md).
- **Not verified live:** a `/<name>` invocation against a paid model. The
  evidence transcript drives the same code path with the repository's scripted
  mock provider, because this work was done with no API credits.
