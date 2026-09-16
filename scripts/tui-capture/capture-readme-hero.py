"""The README hero: a real frame of Rune working, captured through a pty.

The founder asked for "a beautiful panel" at the top of the GitHub README, and
the one thing that cannot be faked in it is the frame: every screenshot of
"Rune" filed before 2026-09-05 turned out to be a picture of another product.
So this rig drives the REAL CLI, through a real pseudo-terminal, over a real
task, and photographs what the real renderer painted.

  * a scratch workspace holds a small node project (`lantern`) with a README
    and a `src/cli.js` -- files that exist on disk, so the reads, the grep, the
    edit and the check all run for real against real bytes;
  * the prompt is the founder's example, "add a --version flag and a test for
    it", typed into the composer and submitted;
  * the MODEL is a loopback mock: an Ollama-shaped server on 127.0.0.1 that
    answers `/api/chat` with a scripted sequence of tool calls, keyed on how
    many tool results the transcript already carries. Every tool CALL is the
    mock's; every tool RUN, every row, every glyph on the screen is the
    product's.

Zero live model calls, by construction -- the same argument `capture-pulse.py`
makes and for the same reasons:

  * the profile names `ollama` as the only provider with `baseUrl` on the mock
    port; ollama is the one preset that registers with no key at all;
  * every credential-shaped variable is scrubbed from the child by
    `capture.py`'s own predicate (imported, not copied);
  * the mock serves `/api/tags`, `/api/show` and `/api/chat` and 404s
    everything else, so there is no route to a real endpoint;
  * the child's cwd is the scratch workspace, never the checkout, so the
    repo-root `.env` bun would auto-load is not loaded.

    python3 scripts/tui-capture/capture-readme-hero.py OUTDIR
"""

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture as rig  # noqa: E402
from vtcolor import ColorScreen, ColorStream, html as to_html  # noqa: E402

CR = rig.CR

# The terminal this frame is photographed in: a dark ground and a soft ink.
GROUND = (0x0E, 0x10, 0x16)
INK = (0xD6, 0xDA, 0xE3)
GROUND_HEX = "#%02x%02x%02x" % GROUND
INK_HEX = "#%02x%02x%02x" % INK

PROMPT = "add a --version flag to the cli and a test for it"

# --- the scratch project the task is performed on ---

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
  "scripts": { "test": "node --test test/cli.test.js" }
}
"""

TEST_JS = '''const { test } = require("node:test");
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
'''

# --- the scripted model ---
#
# One entry per assistant turn, chosen by how many tool results the request
# already carries -- not by a call counter, so an extra round trip (a title, a
# retry) cannot shift the script under the run.
SCRIPT = [
    {
        "tool": "read_file",
        "args": {"path": "src/cli.js"},
        "text": "Reading the CLI to see how arguments are parsed.",
    },
    {
        "tool": "grep",
        "args": {"pattern": "version", "path": ".", "regex": False},
        "text": "Checking whether a version is declared anywhere already.",
    },
    {
        "tool": "write_file",
        "args": {"path": "test/cli.test.js", "content": TEST_JS},
        "text": "Now the test, against the parser rather than the process.",
    },
    {
        "tool": "multi_edit",
        "args": {
            "path": "src/cli.js",
            "edits": [
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
                    "old_text": "  const args = parseArgs(process.argv);\n"
                    "  if (!args.command) {",
                    "new_text": "  const args = parseArgs(process.argv);\n"
                    "  if (args.version) {\n"
                    '    console.log(require("../package.json").version);\n'
                    "    return;\n"
                    "  }\n"
                    "  if (!args.command) {",
                },
            ],
        },
        "text": "`package.json` carries the version, so the flag reads it from there.",
    },
    {
        "tool": "bash",
        "args": {"command": "node --test test/cli.test.js && node src/cli.js --version"},
        "text": "Running the suite and the flag itself.",
    },
]

FINAL = (
    "`--version` and `-v` now print the version from `package.json`, and two tests cover "
    "the parser. Both tests pass and the flag prints `0.3.2`."
)


class MockOllama:
    """`/api/tags`, `/api/show` and a scripted `/api/chat`. No other route."""

    def __init__(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _json(self, obj):
                body = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                if not self.path.startswith("/api/tags"):
                    self.send_error(404)
                    return
                self._json({"models": [{"name": "mock-small", "model": "mock-small"}]})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length)
                if self.path.startswith("/api/show"):
                    self._json({"model_info": {"mock.context_length": 32768}})
                    return
                if not self.path.startswith("/api/chat"):
                    self.send_error(404)
                    return
                body = json.loads(raw or b"{}")
                outer.requests.append(body)
                step = outer.step_for(body)
                self.send_response(200)
                self.send_header("content-type", "application/x-ndjson")
                self.end_headers()
                for line in outer.stream_for(step):
                    try:
                        self.wfile.write((json.dumps(line) + "\n").encode())
                        self.wfile.flush()
                    except BrokenPipeError:
                        return
                    time.sleep(0.12)

            def log_message(self, *_args):
                pass

        self.requests = []
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def step_for(self, body):
        """Which scripted turn this request is asking for.

        A request with no `tools` is not an agent turn at all -- it is a title
        or a summary -- and gets prose, so it can never consume a step.
        """
        if not body.get("tools"):
            return "aux"
        done = sum(1 for m in body.get("messages", []) if m.get("role") == "tool")
        return done if done < len(SCRIPT) else "final"

    def stream_for(self, step):
        if step == "aux":
            return [
                {"model": "mock-small", "message": {"role": "assistant", "content": "add a --version flag"}},
                {"model": "mock-small", "done": True, "done_reason": "stop"},
            ]
        if step == "final":
            out = []
            for piece in re.findall(r"\S+\s*", FINAL):
                out.append({"model": "mock-small", "message": {"role": "assistant", "content": piece}})
            out.append({"model": "mock-small", "done": True, "done_reason": "stop"})
            return out
        entry = SCRIPT[step]
        out = []
        for piece in re.findall(r"\S+\s*", entry["text"]):
            out.append({"model": "mock-small", "message": {"role": "assistant", "content": piece}})
        out.append(
            {
                "model": "mock-small",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"function": {"name": entry["tool"], "arguments": entry["args"]}}],
                },
            }
        )
        out.append({"model": "mock-small", "done": True, "done_reason": "stop"})
        return out

    def stop(self):
        self.server.shutdown()


def scratch_project(port):
    """A fresh profile pointed at the mock, and the little project on disk."""
    # HOME is the scratch root too, so the masthead shortens the workspace to
    # `~/code/lantern` -- the frame says where the run was, and nothing about
    # whose machine it was on.
    rig.WORK = os.path.join(rig.SCRATCH, "code", "lantern")
    rig.fresh_profile()
    with open(os.path.join(rig.PROFILE, "config.toml"), "w") as fh:
        fh.write(
            "[update]\ncheck = false\n\n"
            '[llm]\ndefaultProvider = "ollama"\n\n'
            "[llm.ollama]\n"
            'baseUrl = "http://127.0.0.1:%d"\n'
            'model = "mock-small"\n\n'
            # 3rd gear: workspace edits and sandboxed commands proceed, which
            # is the gear the frame should show a run being done in.
            '[permissions]\ngear = 3\n\n'
            # 0 = no cap: a mock model has no price list, and the dollar cap
            # refuses to run what it cannot meter.
            "[cost]\nmaxSessionUsd = 0\n" % port
        )
    with open(os.path.join(rig.PROFILE, "telemetry.json"), "w") as fh:
        fh.write(
            '{"v":1,"installId":null,"decision":"denied",'
            '"decidedAt":"2026-09-10T00:00:00.000Z","lastHeartbeat":null}\n'
        )
    os.makedirs(os.path.join(rig.WORK, "src"), exist_ok=True)
    os.makedirs(os.path.join(rig.WORK, "test"), exist_ok=True)
    Path(rig.WORK, "src", "cli.js").write_text(CLI_JS)
    Path(rig.WORK, "README.md").write_text(README_MD)
    Path(rig.WORK, "package.json").write_text(PACKAGE_JSON)


def colour_session(rows, cols):
    # The terminal's own colours, declared rather than probed: a pty answers no
    # OSC 11 query, and without an answer the product assumes a light terminal
    # and paints its light palette -- which is not what the founder's terminal
    # (or this picture) is. GROUND/INK are the exact colours `vtcolor.html`
    # paints the page in, so the frame and its picture agree.
    s = rig.Session(
        rows=rows,
        cols=cols,
        COLORTERM="truecolor",
        HOME=os.path.realpath(rig.SCRATCH),
        RUNE_TERMINAL_BACKGROUND=GROUND_HEX,
        RUNE_TERMINAL_FOREGROUND=INK_HEX,
    )
    # Swap in the colour-carrying model before a single byte has been pumped.
    s.screen = ColorScreen(rows, cols)
    s.stream = ColorStream(s.screen)
    return s


def save(s, outdir, name, title):
    s.snapshot(outdir, name)
    page = to_html(s.screen, ground=GROUND, foreground=INK, title=title)
    Path(outdir, name + ".html").write_text(page)
    print("  html  -> %s" % Path(outdir, name + ".html"))


def run(outdir, rows, cols, tag, title):
    s = colour_session(rows, cols)
    marks = []
    try:
        s.wait_for(["rune"], timeout=90)
        s.pump(1.0)
        s.send(PROMPT, settle=0.6)
        save(s, outdir, "%s-typed" % tag, title)
        s.send(CR, settle=0.5)
        # Follow the run: snapshot whenever a new tool name has appeared, and
        # stop once the closing prose has landed.
        deadline = time.time() + 180
        wanted = ["read", "grep", "edit", "write", "node"]
        while time.time() < deadline:
            s.pump(0.5)
            screen = s.screen.text().lower()
            for w in list(wanted):
                if w in screen:
                    wanted.remove(w)
                    marks.append(("%s-during-%s" % (tag, w), s.screen.text()))
                    save(s, outdir, "%s-during-%s" % (tag, w), title)
            if "0.3.2" in screen and "--version" in screen:
                break
        s.pump(2.0)
        save(s, outdir, "%s-final" % tag, title)
        # And once more after the turn has fully settled: the same run with the
        # closing verdict on it rather than the pulse.
        s.pump(12.0)
        save(s, outdir, "%s-settled" % tag, title)
    finally:
        s.close()
    return marks


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    mock = MockOllama()
    try:
        scratch_project(mock.port)
        run(outdir, 40, 120, "hero-120x40", "rune — ~/code/lantern")
        run(outdir, 24, 80, "hero-80x24", "rune — ~/code/lantern")
        edited = Path(rig.WORK, "src", "cli.js").read_text()
        wrote = Path(rig.WORK, "test", "cli.test.js")
        print("\n--- what actually happened on disk ---")
        print("  src/cli.js contains --version:", "--version" in edited)
        print("  test/cli.test.js written:     ", wrote.exists())
        print("  model requests served:        ", len(mock.requests))
    finally:
        mock.stop()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "out-hero"))
