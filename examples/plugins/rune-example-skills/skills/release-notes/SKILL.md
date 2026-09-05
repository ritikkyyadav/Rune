---
name: release-notes
description: Draft release notes from the commits between two git refs. Use when preparing a changelog entry, summarising what shipped in a release, or turning a merge range into prose a user can read.
---

# Release notes from a commit range

A worked routine, not a command. It exists to show what a skills-only plugin
contributes: text the agent can follow, discovered from `skills/`, attributed
to the plugin that shipped it.

## Steps

1. Establish the range. `git describe --tags --abbrev=0` gives the previous
   tag; the head of the branch gives the other end. Confirm both with the user
   before writing anything — a wrong range produces confident, wrong notes.
2. Read the commits: `git log --no-merges --pretty=format:'%h %s' <from>..<to>`.
3. Group by what changed for a **user**, not by the subsystem the commit
   touched. "Editing survives whitespace drift" beats "refactor edit matcher".
4. Drop anything with no user-visible effect (formatting, CI, internal
   renames) unless it changes how the thing is installed or run.
5. Lead each entry with the verb: added, fixed, changed, removed.
6. Close with the upgrade note — anything a user must do by hand.

## Shape

```markdown
## v<version> — <date>

**Added** …
**Fixed** …
**Changed** …

### Upgrading
…
```

## What not to do

Do not invent a benefit a commit does not deliver. If a change is a fix for a
bug that never shipped, it does not belong in the notes at all.
