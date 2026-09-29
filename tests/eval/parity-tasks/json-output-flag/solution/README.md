# logstats

Count the lines of a log file by level.

## Usage

```sh
bun cli.ts app.log                # a table of counts by level
bun cli.ts --level ERROR app.log  # count only the ERROR lines
bun cli.ts --json app.log         # the counts as one JSON object
bun cli.ts --help
```

`--json` prints `{"total": <lines counted>, "levels": {"DEBUG": n, "INFO": n, "WARN": n, "ERROR": n}}`
instead of the table, and combines with `--level`.

A line is counted when its second field is `DEBUG`, `INFO`, `WARN` or `ERROR`:

```
2026-09-29T10:00:00Z INFO server started
```

Anything else is skipped.

## Development

```sh
bun test
```
