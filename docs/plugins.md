# Plugins

A plugin is one installable directory shipping any of the four declarative
extension kinds: skills, slash commands, MCP connectors, hooks.

```
.gear/plugins/<name>/
  plugin.json            manifest; its `name` must equal the directory name
  skills/<s>/SKILL.md    auto-discovered, attributed to <name>
  commands/<c>.md        slash commands, tagged with the plugin
  mcp.json               connectors ({ "mcpServers": { … } })
  hooks.json             hooks, merged after the user's own
```

Install is "get the directory there"; uninstall is `rm -r`. Everything below is
about making the first half of that sentence safe.

---

## The index

`gear plugin add ./path` has always worked. What did not exist was a way to
**ask what exists** — so the index is one versioned JSON document, served raw
from the repository, that `gear plugin search` reads and `gear plugin add
<name>` resolves through.

```
gear plugin search                    everything
gear plugin search fmt                name, description and capability match
gear plugin add gear-example-skills    resolved through the index, digest-checked
```

### The entry

```json
{
  "name": "gear-example-skills",
  "description": "A skills-only plugin: one release-notes playbook.",
  "source": "../examples/plugins/gear-example-skills",
  "version": "0.1.0",
  "gearVersion": ">=0.2.0",
  "capabilities": ["skills"],
  "integrity": "sha256-dbe7a944…",
  "maintainer": "Savoir <gear@savoir.dev>",
  "homepage": "https://github.com/…"
}
```

| Field          | What it is                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`         | letters, digits, `-`, `_`; unique across the index                                                                          |
| `description`  | one line, shown by `search`                                                                                                 |
| `source`       | a git URL, or a path **relative to the index file**. A relative source from a _remote_ index is refused rather than guessed |
| `version`      | the bundle's own version                                                                                                    |
| `gearVersion`  | semver range; an entry this build does not satisfy is refused by name, before anything is fetched                           |
| `capabilities` | a closed vocabulary (below) — what the bundle is allowed to do, visible **before** you download it                          |
| `integrity`    | `sha256-…` over the pristine tree; verified against the staged bundle before installation                                   |
| `maintainer`   | who to blame                                                                                                                |

Capabilities: `skills`, `commands`, `hooks`, `mcp`, `tools:none`,
`tools:workspace-read`, `tools:workspace-write`, `tools:network`. The `tools:*`
entries name the OS-sandbox capability an executable tool runs under; they are
in the index rather than only in the manifest because "this bundle wants to
reach the network" is the fact you need _before_ you download it, not after.

### Validation

The index is fetched over the network, so its shape is untrusted input. A
malformed document is refused with **every** problem listed — not the first —
and nothing is half-loaded. Duplicate names, unknown capabilities, a version
other than `1`, an `integrity` that is not a sha256 digest: each is an error
naming the entry.

### Integrity

`integrity` is the same digest `computeIntegrity()` writes into an installed
manifest: sha256 over every file's workspace-relative path and bytes, sorted,
with `plugin.json`'s own `integrity` field blanked first.

It is verified against the **staged** tree, before installation. That timing is
not incidental: `gear plugin add` stamps `name` and `source` into the manifest
and then recomputes the digest, so an installed tree legitimately hashes
differently from the published one. There is exactly one moment where the two
are comparable, and the check happens there. A mismatch prints both digests and
refuses to install.

Keeping the published digests true to the trees in this repository is
mechanical:

```
bun run scripts/plugin-index.ts            # report drift, exit 1 if any
bun run scripts/plugin-index.ts --write    # recompute
```

A unit test asserts the same thing, so a drifted digest fails the gate rather
than someone's install.

### Where the index comes from

Resolution order, first hit wins:

1. `--index <url|path>`
2. `GEAR_PLUGIN_INDEX`
3. `[extensions] index` in `.gear/config.toml`
4. the public URL

A network index that answers is cached at `~/.gear/plugin-index.json`. When the
fetch fails, the cached copy is used and **said to be** a cached copy; with no
cache, the copy that shipped with this build (`plugins/index.json` beside the
code) is used and said to be that. The three states are named separately on
purpose — "your network is down" and "this build has never reached the index"
are different facts, and a plugin list that hides which one you are looking at
is worse than no list.

Point it at your own:

```toml
[extensions]
index = "https://intranet.example.com/gear-plugins.json"
```

### What `add` does with a name

A **bare name** is a question for the index. A path, a git URL or an npm spec
is not — those already say where they come from, and re-resolving them through
a list would let the list redirect an install the user had fully specified. If
the index has no such name, the old npm path still applies.

---

## The manifest

```json
{
  "name": "acme-tools",
  "version": "0.2.0",
  "description": "…",
  "gearVersion": ">=0.3.0",
  "hooks": "hooks.json",
  "mcp": "mcp.json",
  "commands": "commands",
  "permissions": { "hosts": ["api.acme.com"], "paths": ["src"], "blockingHooks": true },
  "integrity": "sha256-…",
  "source": "acme-tools",
  "enabled": true
}
```

`permissions` is **disclosure, not enforcement**, and the CLI says so when it
prints it: it tells you a bundle's hooks want to block tool calls and its
connectors want three hosts, before you enable it. A hook is a shell command
the plugin asked Gear to run and an MCP server is a process it asked Gear to
start; neither is contained, and a declaration is not a sandbox.

Every declared path must stay inside the plugin directory. A manifest pointing
at `../../` is either broken or hostile, and is refused either way.

---

## The examples

| Example                                                                                 | What it shows                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`examples/plugins/gear-example-skills`](../examples/plugins/gear-example-skills)       | a skills-only bundle: one `SKILL.md`, no code     |
| [`examples/plugins/gear-example-connector`](../examples/plugins/gear-example-connector) | an MCP server plus the slash command that uses it |

Each installs from a local path and is listed in `plugins/index.json`:

```
gear plugin add ./examples/plugins/gear-example-skills
gear plugin add ./examples/plugins/gear-example-connector
```

---

## Housekeeping

`gear plugin list` prints what loaded **and what was refused**. Refusals used to
be computed on every scan and shown nowhere, so an installed-but-refused plugin
looked exactly like one nobody had installed.

`gear plugin disable <name>` keeps the bundle and stops its contributions.
Because the manifest is part of the hashed tree, toggling recomputes the digest.

`invalidatePlugins()` re-scans and re-runs every loader without a restart. All
the latches clear together on purpose: a plugin contributes across them, and a
partial refresh leaves a bundle half-installed.
