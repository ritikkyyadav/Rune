# Language servers

Rune talks to real language servers over LSP, for two things: the on-demand
`lsp` tool the model calls itself, and **post-edit diagnostics** — the language
server's verdict on the file the model just wrote, delivered in the same tool
result.

| Language              | Server                       | Install                                            |
| --------------------- | ---------------------------- | -------------------------------------------------- |
| TypeScript/JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript@5` |
| Python                | `pyright-langserver`         | `npm i -g pyright`                                 |
| Rust                  | `rust-analyzer`              | `rustup component add rust-analyzer`               |
| Go                    | `gopls`                      | `go install golang.org/x/tools/gopls@latest`       |

Servers are spawned lazily, one per (language, workspace), on first use. They
are killed with the engine — gracefully on shutdown, `SIGKILL` from a
process-exit hook on a hard exit. Nothing is left running.

## The `lsp` tool

Read-only, auto-permission, four actions: `definition`, `references`, `hover`,
`diagnostics`. Positions are 1-based line/column, on the symbol. If a server
is not installed, the error names the exact install command so the model can
install it and retry.

## Post-edit diagnostics

After every successful `write_file`, `edit_file`, `multi_edit` and
`apply_patch`, the tool result carries the server's errors and warnings for
the files it touched:

```json
{
  "path": "src/total.ts",
  "hash": "…",
  "diagnostics": "src/total.ts:4:9 error Type 'string' is not assignable to type 'number'.\nsrc/total.ts:9:7 warning 'unused' is declared but its value is never read."
}
```

The point is the turn boundary. Without it, a type error introduced by an edit
is discovered when the verifier runs — several turns and several more edits
later, on top of the mistake. With it, the model sees the compiler's own words
while the edit is still the thing it is thinking about. The system prompt says
in one line that the block is authoritative evidence, not a suggestion.

**The bounds, and why each one is where it is.**

- **2 s, hard.** The manager's readiness gate may lawfully wait 10 s for a cold
  server's first publish — right for the on-demand tool, far too slow per edit.
  On timeout the result ships with no block and the server keeps warming in the
  background, so the next edit is fast. An edit is never slowed by more than
  two seconds. A multi-file `apply_patch` shares ONE budget, not one per file.
- **Readiness-gated.** The manager only claims an answer once the first
  `publishDiagnostics` for that document has arrived. Before that, servers
  answer from a syntax-only fallback and are confidently wrong. So "no block"
  never means "the file is clean" — silence means the server had nothing to say
  yet, and the syntax pass still stands.
- **20 lines, errors before warnings**, then a `+N more` tail. Errors first
  because a model reads the top of a block; 20 lines because a whole file's
  warning list is a wall it learns to skip. Format is
  `file:line:col severity message`, workspace-relative, one line per
  diagnostic, stably sorted so a repeated edit yields the same block.
- **Errors and warnings only.** Hints and information are dropped: feedback
  noise trains the model to ignore the channel.
- **Best-effort, always.** A missing server, a dead connection, a crash — none
  of it can fail a write that already landed on disk.

### The syntax pass is still the fallback

`diagnostics.ts` syntax-checks every written file with a native checker (the
TypeScript compiler's syntactic pass, `JSON.parse`, `bash -n`, `ast.parse`) and
reports under `syntax_check`. That needs no server and always runs. When a real
language server has spoken about a file, its `diagnostics` block supersedes
`syntax_check` for that file — a syntax error is reported by both, and two
blocks about one file is noise. With no server installed, nothing changes from
before: the syntax pass is what you get.

### When it is on

`[lsp] autoFeedback` in `config.toml`. **Unset is not "off"** — it means
"decide from the workspace":

- **on** for a TypeScript workspace (`tsconfig.json`, `jsconfig.json`,
  `package.json`, `deno.json`) when `typescript-language-server` is on `PATH`;
- **on** for a Python workspace (`pyproject.toml`, `setup.py`, `setup.cfg`,
  `requirements.txt`, `Pipfile`) when `pyright-langserver` is on `PATH`;
- **off** everywhere else.

Rust and Go are excluded from the default on purpose: `rust-analyzer` and
`gopls` index a whole crate or module graph before their first publish, so the
2 s budget would usually expire and the feature would cost latency for no
feedback. They still work when you turn it on explicitly.

Two escapes:

```toml
[lsp]
autoFeedback = false   # off for this project whatever is installed
```

or, live in a session, `/config lsp off` (`true` forces it on, Rust and Go
included). `rune audit` reports how many edits carried a diagnostics block and
how many of those were fixed before the verifier ran.

### `RUNE_LSP_SERVERS`

A process-wide override of the server table, as JSON:

```
RUNE_LSP_SERVERS='[{"id":"fake","extensions":[".ts"],"command":["bun","server.ts"]}]'
```

It exists so post-edit diagnostics can be _measured_ without a language server
installed — the benchmark suite points it at the fake stdio server in
`tests/fixtures/lsp/fake-lsp-server.ts` so the measurement is deterministic on
any machine. It is also the escape hatch for a language whose server is not in
the built-in table. Malformed JSON is ignored and the built-in table stands: a
typo in an env var must never silently disable code intelligence.
