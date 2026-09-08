#!/bin/sh
# A BLOCKING preToolUse hook: a non-zero exit vetoes the tool call.
#
# The tool's arguments arrive two ways — as JSON on stdin, and as the same JSON
# in $RUNE_TOOL_ARGS. This reads the environment variable so the guard needs no
# JSON parser and runs anywhere /bin/sh does.
#
# What lands in the agent's transcript on a refusal is this script's stderr, so
# say why in one line.
case "$RUNE_TOOL_ARGS" in
*.env* | *secrets* | *credentials* | *id_rsa*)
  echo "refused: $RUNE_TOOL_NAME targets a secret-looking path" >&2
  exit 1
  ;;
esac
exit 0
