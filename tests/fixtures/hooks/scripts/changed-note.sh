#!/bin/sh
# A postToolUse hook. Whatever it prints on stdout is fed back to the AGENT as
# the tool's hook output — that is the whole point of the event: a formatter or
# a linter that only wrote to a log would be a silent bystander.
#
# $RUNE_TOOL_OUTPUT holds the tool's result as JSON; $RUNE_TOOL_NAME the tool.
# A non-zero exit here does NOT block anything: it is reported and the run
# continues.
printf 'formatting reminder: %s changed a file — run `bun run format:check`\n' "$RUNE_TOOL_NAME"
