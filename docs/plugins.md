# Plugins

A plugin is one installable directory. It ships any of the four declarative
extension kinds — skills, slash commands, MCP connectors, hooks — and, since
D6 v2, **executable tools** that run as subprocesses under the OS sandbox.

```
.gear/plugins/<name>/
  plugin.json            manifest; its `name` must equal the directory name
  skills/<s>/SKILL.md    auto-discovered, attributed to <name>
  commands/<c>.md        slash commands, tagged with the plugin
  mcp.json               connectors ({ "mcpServers": { … } })
  hooks.json             hooks, merged after the user's own
  tools/<program>        executable tool servers, sandboxed
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

`tools` is the exception, and the whole point of D6 v2: those declarations
**are** enforced, because the programs run inside one.

Every declared path must stay inside the plugin directory. A manifest pointing
at `../../` is either broken or hostile, and is refused either way.

---

## Executable tools

D6 v1 said plugins are declarative, "because a declaration is not a sandbox."
This is the other half of that sentence: a plugin may ship executable tools
once they run under one.

A declared tool is a **program** — any language — spawned as a subprocess,
wrapped by Seatbelt (macOS) or bubblewrap (Linux) with exactly the capability
its manifest entry declares, speaking line-delimited JSON on stdio. Nothing is
loaded into the Gear process; there is no path from a plugin's bytes to this
process's heap.

```json
"tools": [
  {
    "id": "files",
    "description": "Read and write files.",
    "command": ["python3", "-u", "tools/files.py"],
    "capability": "workspace-write"
  },
  {
    "id": "net",
    "description": "HTTP GET.",
    "command": ["python3", "-u", "tools/net.py"],
    "capability": "network",
    "hosts": ["127.0.0.1:8787", "api.example.com:443"],
    "timeoutMs": 30000
  }
]
```

`command` is an argv. Its first element is either a **bare interpreter name**
resolved on `PATH` (`python3`, `node`, `deno` — a plugin cannot ship a runtime
and should not have to) or a path **inside the plugin**, which is resolved to
an absolute one. An absolute or escaping path refuses the bundle: containment
is the sandbox's job, but provenance is the loader's. The remaining elements
pass through verbatim, and the child's working directory is always the plugin
root, so a relative script path means exactly one thing.

### The capability manifest

| capability        | reads                              | writes             | network                 |
| ----------------- | ---------------------------------- | ------------------ | ----------------------- |
| `none`            | system; the plugin's own directory | scratch only       | denied                  |
| `workspace-read`  | system + workspace                 | scratch only       | denied                  |
| `workspace-write` | system + workspace                 | scratch, workspace | denied                  |
| `network`         | system; the plugin's own directory | scratch only       | declared endpoints only |

System reads are broad in every row for the same reason the bash sandbox makes
them broad: an allowlist-only read policy makes `dyld` abort before `main`, so
nothing runs at all. Credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.gear/secrets.json`, …) are carved out by explicit deny in every row, from
the same list the bash sandbox uses.

Every capability gets a **private scratch directory** — created per process,
`TMPDIR` points at it, deleted on stop. Real runtimes need somewhere to write
or they die on startup, and "somewhere" must not be the user's workspace.

**What "declared endpoints" means, exactly.** Seatbelt's `remote ip` filter
accepts a port and either `*` or `localhost`; it rejects a literal address
outright ("host must be \* or localhost"). So on macOS `api.example.com:443` is
enforced as _outbound to port 443, denied everywhere else_, and
`127.0.0.1:8787` as _loopback port 8787 only_. That is kernel-enforced and much
narrower than "the network", but it is not per-host, and the plan reports
`host_enforcement: "port"` rather than letting anything claim otherwise. On
Linux, bubblewrap's isolation is all-or-nothing (`--unshare-net`), reported as
`all-or-nothing`: there, the host list is disclosure. A host with no port is
accepted and reported as widening to every port.

### The protocol

One JSON object per line, both directions. `stdout` is the channel; `stderr` is
a diagnostic that Gear drains and keeps the tail of, never a result.

**Tool → Gear**

```jsonc
// first, immediately on start — before anything is asked of it
{"type":"schema","protocol":1,"tools":[
  {"name":"write_text","description":"…","inputSchema":{"type":"object","properties":{…},"required":["path"]}}
]}

{"type":"result","id":"c1","ok":true,"result":{"path":"/ws/a.txt","bytes":12}}
{"type":"result","id":"c1","ok":false,"error":"PermissionError: [Errno 1] Operation not permitted"}
{"type":"log","level":"info","message":"…"}          // debug log, never model context
```

**Gear → tool**

```jsonc
{"type":"hello","protocol":1,"gear":"0.3.0","plugin":"acme","workspaceRoot":"/ws"}
{"type":"call","id":"c1","tool":"write_text","args":{"path":"a.txt","text":"…"}}
{"type":"shutdown"}
```

The schema frame comes first and is not a reply to anything: schemas have to be
known before the model is offered the tool, so a server that never advertises
one within 15s is stopped and its refusal reported, rather than registered as a
tool nobody can describe. `GEAR_WORKSPACE`, `GEAR_PLUGIN`, `GEAR_PLUGIN_ROOT`
and `GEAR_TOOL_CAPABILITY` are in the child's environment for programs that
prefer variables to frames.

Each advertised tool becomes `plugin_<plugin>_<tool>` to the model.

### No sandbox, no tool

A machine with no isolation backend — Windows, or a mac without `sandbox-exec`
— **refuses to start a plugin tool at all**, and the refusal names the escape:

```toml
[extensions]
allowUnsandboxedTools = ["acme-tools"]   # or true, for every plugin
```

Turning it on means a third party's program runs with your full access and its
declared capability is not enforced. Gear says so three times over: a
`[SECURITY]` log line, a startup notice, and the words "NOT sandboxed" in the
tool description the model reads. A plan that could not be determined at all
(no `gear-tools`, a parse failure) lands on the same side as "there is no
sandbox" — the direction that fails safe.

### Permissions, the classifier, and org policy

The declared capability **is** the permission category. There is no
plugin-specific permission path and no tier a manifest can grant itself:

- `workspace-write` → a `write` tool. Not auto-approved in 1st gear.
- `network` → a `network` tool. It reaches the Auto classifier the way
  `web_fetch` does, and `networkDefaultDeny` covers it by category.
- `permissionLevel` is never `auto`. It is `sandbox` when OS isolation is
  actually wrapping the process and `confirm` when it is not, so the level
  tracks the containment rather than the request.
- Every plugin tool's output crosses the prompt-injection probe: it is a third
  party's program, and its output is no more the user's own content than a
  connector's is.

Org policy names them with `plugin:<plugin>:<tool>`, and `toolsDeny` /
`toolsAllow` take `*` anywhere in an entry:

```json
{ "version": 1, "toolsDeny": ["plugin:acme-tools:*"] }
```

A wildcard covers the tools a bundle's next version adds, which listing them by
hand does not.

### What this is not

`custom-loader.ts` (`[extensions] localTools`) still loads in-process
TypeScript from `<workspace>/.gear/tools`. That is code the **user** wrote in
their own workspace, off by default, and a plugin can never point at it. The
two mechanisms are deliberately separate: one runs your code, the other runs a
stranger's, and only the second one gets a sandbox because only the second one
needs to earn its trust.

---

## The three examples

| Example                                                                                 | What it shows                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`examples/plugins/gear-example-skills`](../examples/plugins/gear-example-skills)       | a skills-only bundle: one `SKILL.md`, no code     |
| [`examples/plugins/gear-example-connector`](../examples/plugins/gear-example-connector) | an MCP server plus the slash command that uses it |
| [`examples/plugins/gear-example-tools`](../examples/plugins/gear-example-tools)         | two sandboxed executable tools, in Python         |

Each installs from a local path and is listed in `plugins/index.json`:

```
gear plugin add ./examples/plugins/gear-example-skills
gear plugin add ./examples/plugins/gear-example-connector
gear plugin add ./examples/plugins/gear-example-tools
```

The third one's programs deliberately validate **nothing** — `files.py` opens
the path it is given, `net.py` connects to the URL it is given — so that every
refusal is attributable to the kernel rather than to the tool's good manners.
`tests/integration/plugin-tools-sandbox.test.ts` runs them under the real
sandbox and asserts both refusals come back as `[Errno 1] Operation not
permitted` while the same tools succeed inside their declared scope.

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
