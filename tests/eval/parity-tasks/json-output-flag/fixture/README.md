# logstats

Count the lines of a log file by level.

## Usage

```sh
bun cli.ts app.log                # a table of counts by level
bun cli.ts --level ERROR app.log  # count only the ERROR lines
bun cli.ts --help
```

A line is counted when its second field is `DEBUG`, `INFO`, `WARN` or `ERROR`:

```
2026-09-29T10:00:00Z INFO server started
```

Anything else is skipped.

## Development

```sh
bun test
```
