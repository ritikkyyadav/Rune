---
name: release-checklist
description: Walk the pre-release checklist for this repository — gates, changelog, version, working tree. Use before cutting a release, or when asked what still blocks one.
argument-hint: <version, e.g. 0.4.0>
---

# Release checklist

Target version: $ARGUMENTS

Work these in order and report each one as done or blocked. Do not skip a step
because it "looks fine" — run it.

1. **Gates.** `bun run typecheck`, `bun run lint`, `bun run format:check`, then
   `bun run test:unit`. Report the failure count, not a verdict.
2. **Changelog.** Confirm `CHANGELOG.md` has an entry for $ARGUMENTS and that
   every line in it names a change a user can observe.
3. **Version.** `scripts/version.sh` and the package manifests must all agree
   on $ARGUMENTS. Name any that disagree.
4. **Working tree.** `git status --porcelain` must be empty. List anything
   uncommitted rather than committing it yourself.
5. **Report.** One paragraph: what is ready, what blocks the release, and the
   single next action.

Stop and ask before tagging or pushing anything.
