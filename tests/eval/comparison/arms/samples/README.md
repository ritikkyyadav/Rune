# Recorded captures — every one of them SYNTHETIC

These files are what the Claude Code and Codex arms' parsers are validated
against, and not one of them came out of a live run. **They were written by
hand** from the tools' documented output shapes at the pinned versions
(`claude` 2.1.270, `codex-cli` 0.154.0): the Claude Code envelope from
`--output-format json`, the Codex event stream from `codex exec --json` and the
`TokenUsage` field names carried in the installed binary.

That is a real limitation and it is written here rather than buried: a parser
validated against a shape somebody transcribed is validated against the
transcription. The first authorised live run is also the first test of these
shapes, and any drift belongs here as a re-recorded capture — with the
credentials, session ids, thread ids and paths of a real run removed, which is
why the ids below are obviously fake.

No file here contains a credential, a real session id, or a real path.

| file                                 | what the parser must say                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `claude-code.success.stdout.txt`     | `scored`; 9 turns, $0.4213 reported, usage read                                                       |
| `claude-code.max-turns.stdout.txt`   | `scored` — a turn ceiling is the comparator failing the task, not the provider failing the comparator |
| `claude-code.quota-prose.stdout.txt` | `scored` — the ANSWER discusses 429s; prose is task evidence, not an outage                           |
| `claude-code.quota.stderr.txt`       | `unscored:provider_quota`                                                                             |
| `claude-code.auth.stderr.txt`        | `unscored:provider_authentication`                                                                    |
| `claude-code.malformed.stdout.txt`   | `error` — a truncated envelope is neither a score nor an outage                                       |
| `claude-code.timeout.stdout.txt`     | `unscored:timeout` when the tree was killed on the clock                                              |
| `codex.success.events.txt`           | `scored`; usage summed from `turn.completed`, answer from the `agent_message` item                    |
| `codex.quota.events.txt`             | `unscored:provider_quota`, with the first turn's usage retained                                       |
| `codex.auth.events.txt`              | `unscored:provider_authentication`                                                                    |
| `codex.timeout.events.txt`           | `unscored:timeout` — a stream that stops without `turn.completed`                                     |
| `codex.malformed.events.txt`         | `error`                                                                                               |
| `codex.plain-usage.stdout.txt`       | the non-`--json` fallback: `tokens used:` read as a floor                                             |
