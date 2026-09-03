# gear-example-connector

An MCP-server plugin. It contributes one connector and one slash command that
uses it, and nothing else:

```
gear-example-connector/
  plugin.json       declares mcp.json and commands/
  mcp.json          { "mcpServers": { "example-docs": { … } } }
  commands/
    example-docs.md a slash command, tagged with this plugin
```

The `permissions.hosts` block is **disclosure**: it tells you, before you
install, which hosts the connector is expected to reach. It is not enforced —
an MCP server is a process the plugin asked Gear to start, and a declaration is
not a sandbox. Read it, then decide whether you trust the server it names.

Two plugins may not claim the same MCP server name; the second one is refused
with the name of the first, rather than silently shadowing it.

```
gear plugin add ./examples/plugins/gear-example-connector
gear mcp list
```
