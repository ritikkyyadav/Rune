# gear-example-skills

The smallest useful plugin: a directory with a manifest and one skill.

```
gear-example-skills/
  plugin.json            name, version, description, gearVersion
  skills/release-notes/
    SKILL.md             discovered automatically, attributed to the plugin
```

Nothing here executes. A skills-only plugin adds playbooks to the catalog the
agent searches; it cannot run a command, reach a host, or read a file on its
own. That is why it declares no `permissions` block and no `tools`.

Install it from this checkout:

```
gear plugin add ./examples/plugins/gear-example-skills
gear skills release-notes
```
