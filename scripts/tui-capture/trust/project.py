"""The scratch project every run scenario works on (a tiny node CLI)."""

CLI_JS = '''#!/usr/bin/env node
// lantern -- a very small task runner.

function parseArgs(argv) {
  const args = { command: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--json") args.json = true;
    else if (!args.command) args.command = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.command) {
    console.log("usage: lantern <command> [--json]");
    process.exit(1);
  }
  const result = { command: args.command, ok: true };
  console.log(args.json ? JSON.stringify(result) : `ran ${result.command}`);
}

if (require.main === module) main();
module.exports = { parseArgs };
'''

README_MD = """# lantern

A very small task runner.

    lantern build --json

## Usage

    lantern <command> [--json]
"""

PACKAGE_JSON = """{
  "name": "lantern",
  "version": "0.3.2",
  "bin": { "lantern": "src/cli.js" },
  "scripts": { "test": "node --test test/" }
}
"""

STORE_JS = '''// session store
const sessions = new Map();
function save(id, data) { sessions.set(id, { ...data, updatedAt: Date.now() }); }
function load(id) { return sessions.get(id) ?? null; }
module.exports = { save, load };
'''

PROJECT = {
    "src/cli.js": CLI_JS,
    "src/store.js": STORE_JS,
    "README.md": README_MD,
    "package.json": PACKAGE_JSON,
}

TEST_BAD = '''const { test } = require("node:test");
const assert = require("node:assert");
const { parseArgs } = require("../src/cli.js");

test("--version sets the version flag", () => {
  assert.equal(parseArgs(["node", "cli", "--version"]).version, true);
  assert.equal(parseArgs(["node", "cli", "-v"]).version, true);
});

test("a command without --version is unaffected", () => {
  const args = parseArgs(["node", "cli", "build"]);
  assert.equal(args.version, false);
  assert.equal(args.command, "build");
});

test("--json survives alongside --version", () => {
  const args = parseArgs(["node", "cli", "--version", "--json"]);
  assert.deepEqual(args, { command: null, json: true, version: true, verbose: false });
});
'''

TEST_GOOD = TEST_BAD.replace(", verbose: false });", " });")

EDITS_OK = [
    {
        "old_text": '  const args = { command: null, json: false };\n'
        '  for (const arg of argv.slice(2)) {\n'
        '    if (arg === "--json") args.json = true;',
        "new_text": '  const args = { command: null, json: false, version: false };\n'
        '  for (const arg of argv.slice(2)) {\n'
        '    if (arg === "--version" || arg === "-v") args.version = true;\n'
        '    else if (arg === "--json") args.json = true;',
    },
    {
        "old_text": "  const args = parseArgs(process.argv);\n  if (!args.command) {",
        "new_text": "  const args = parseArgs(process.argv);\n"
        "  if (args.version) {\n"
        '    console.log(require("../package.json").version);\n'
        "    return;\n"
        "  }\n"
        "  if (!args.command) {",
    },
]

FINAL_MD = """`--version` and `-v` now print the version from `package.json`.

## What changed

- **`src/cli.js`** — `parseArgs` recognises `--version` / `-v`, and `main` prints the version and exits before the usage check.
- **`test/cli.test.js`** — three tests: the flag, a command without it, and `--json` beside it.

| File | Change | Lines |
| --- | --- | ---: |
| `src/cli.js` | flag parsed, version printed | +6 −1 |
| `test/cli.test.js` | new | +19 |

The first test run failed because my third test expected a `verbose` field that does not exist; I removed it from the expectation rather than adding the field.

```js
if (args.version) {
  console.log(require("../package.json").version);
  return;
}
```

Run it with `node src/cli.js --version` — it prints `0.3.2`. One thing I did not do: the README still documents only `--json`; say if you want the flag added there."""
