# rune-example-tools

An executable-tool plugin (D6 v2). Two subprocess tool servers, written in
Python to make the point that the language does not matter — the contract is a
line-delimited JSON protocol on stdio, and the containment is the OS sandbox.

```
rune-example-tools/
  plugin.json      declares two `tools` entries with their capabilities
  tools/files.py   capability: workspace-write
  tools/net.py     capability: network, hosts: [127.0.0.1:8787, example.com:443]
```

Neither program is loaded into the Rune process. Each is spawned under
Seatbelt (macOS) or bubblewrap (Linux) with exactly the capability its manifest
entry declares, and Rune refuses to start either one on a machine with no
sandbox unless you opt in per plugin.

**Neither program validates anything.** `files.py` opens the path it is given;
`net.py` connects to the URL it is given. That is deliberate: it makes every
refusal attributable to the kernel rather than to the tool's good manners, and
it is what the integration test asserts — a write outside the workspace and a
connection to an undeclared port both come back as `[Errno 1] Operation not
permitted`, from the OS.

```
rune plugin add ./examples/plugins/rune-example-tools
```

The tools then appear as `plugin_rune-example-tools_write_text`,
`plugin_rune-example-tools_read_text` and `plugin_rune-example-tools_http_get`.
The write tools are never auto-approved in 1st gear; the network tool reaches
the Auto classifier the way `web_fetch` does. Org policy can turn the whole
bundle off with `plugin:rune-example-tools:*`.

Full protocol and capability reference: [docs/plugins.md](../../../docs/plugins.md).
