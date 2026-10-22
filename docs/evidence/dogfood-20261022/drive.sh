#!/bin/bash
# The dogfood driver: runs the given modes of run.ts in order, each under
# `caffeinate -i` (idle sleep only; the lid still sleeps the Mac), reading the
# Codex windows after each agent arm. Started detached (its own session), so it
# outlives the Claude session that launched it. Log: drive-<n>.log.
#
#   drive.sh baseline codex rune
#
# The rune arm waits (up to 2 h) for bin-1.4.12/READY, written once the
# released binary's checksum matches the release's SHA256SUMS.
set -u
cd /Users/ritikyadav890/Project/Alan/.claude/worktrees/reliability-r1-20261014 || exit 2
R=$HOME/rune-evidence/dogfood-20261021
echo "=== driver pid $$ $(date -u +%FT%TZ)"
bash "$R/window.sh"
for m in "$@"; do
  if [ "$m" = rune ]; then
    n=0
    until [ -f "$R/bin-1.4.12/READY" ] || [ $n -ge 720 ]; do sleep 10; n=$((n + 1)); done
    if [ ! -f "$R/bin-1.4.12/READY" ]; then echo "=== rune: no READY after 2 h, stopping"; exit 3; fi
  fi
  echo "=== $m start $(date -u +%FT%TZ)"
  caffeinate -i bun run "$R/run.ts" "$m"
  echo "=== $m exit=$? $(date -u +%FT%TZ)"
  [ "$m" = baseline ] || bash "$R/window.sh"
done
echo "=== driver done $(date -u +%FT%TZ)"
