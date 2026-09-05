# Skills

Bundled **skills** — reusable expert playbooks Rune can load on demand. Each skill
is a `SKILL.md` file with YAML frontmatter (`name`, `description`, optional
`argument-hint`) and a Markdown body of step-by-step instructions, optionally with
bundled `references/`, `examples/`, and `RUNBOOK.md` files.

## Provenance

These plugins are vendored verbatim from Anthropic's open **knowledge-work-plugins**
marketplace (21 plugins, 181 skills). The directory layout is preserved exactly so
each skill's relative links resolve — e.g. a skill at
`engineering/skills/code-review/SKILL.md` referencing `../../CONNECTORS.md` finds
`engineering/CONNECTORS.md`, and `references/*.md` resolve inside the skill folder.

The only files dropped during vendoring were the marketplace `manifest.json`
(Rune builds its own index) and `.DS_Store` noise.

## How Rune uses them (progressive disclosure)

1. **Catalog (always in context).** At session start Rune injects a compact,
   plugin-grouped index — *plugin → skill names* — into the system prompt. This is
   bounded (names, not full descriptions), so the standing token cost stays flat as
   the catalog grows.
2. **Load on demand.** When a request matches a skill, the model calls the `skill`
   tool — `skill(name: "engineering:code-review")` — which injects that skill's full
   `SKILL.md` body plus a manifest of its bundled reference files (each with an
   absolute path the model can open with `read_file`).
3. **Search / list.** `skill(search: "review my PR")` ranks matching skills;
   `skill()` with no arguments returns the full catalog.

Skill ids are namespaced **`<plugin>:<name>`** because some names (`start`,
`prospect`, `call-prep`, …) appear in more than one plugin.

Discovery, the catalog, and the `skill` tool live in
`packages/tool-registry/src/skills/`; the engine wires them in lazily (mirroring MCP)
in `packages/orchestrator/src/engine.ts`.

## Adding your own skills

Drop a folder containing a `SKILL.md` into either:

- `skills/<plugin>/skills/<name>/SKILL.md` — bundled, shipped with Rune, or
- `<workspace>/.alan/skills/<name>/SKILL.md` — per-project (attributed to the
  `user` plugin).

Both roots are scanned automatically. `<workspace>/.alan/skills` wins on id
collisions. Set `ALAN_SKILLS_DIR` to override the bundled catalog location, or
pass `skillRoots` in the engine config to scan an explicit set of directories.

## Connectors

Many skills are "supercharged" when connected to external tools. The per-plugin
`.mcp.json` files list the relevant MCP servers (Slack, Linear, GitHub, …) as
public endpoint **templates** — they contain no credentials. To enable one, copy the
server entry into your `<workspace>/.alan/mcp.json` (Rune's MCP config) and supply
auth via `${ENV_VAR}` headers. See each plugin's `CONNECTORS.md`. Skills still work
standalone without any connector.
