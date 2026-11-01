"""Shared rig for the TUI audit: a scripted loopback model + pty sessions.

Reuses the repo's own capture machinery (capture.py / vtcolor.py) from the
selected worktree. Zero live model calls: the only provider is an
Ollama-shaped server on 127.0.0.1 that answers from a script; every credential-
shaped variable is scrubbed by capture.py's own predicate; HOME and RUNE_HOME
are scratch directories.
"""

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WT = os.environ.get("RIG_WT") or str(Path(__file__).resolve().parents[3])
sys.path.insert(0, WT + "/scripts/tui-capture")

import capture as rig  # noqa: E402
from vtcolor import ColorScreen, ColorStream, html as to_html  # noqa: E402

TOOLS_BIN = os.environ.get("RIG_TOOLS") or os.path.expanduser("~/.rune/bin/rune-tools")
DARK_BG, DARK_FG = (0x0E, 0x10, 0x16), (0xD6, 0xDA, 0xE3)
LIGHT_BG, LIGHT_FG = (0xFF, 0xFF, 0xFF), (0x2E, 0x2E, 0x2E)


def hexrgb(t):
    return "#%02x%02x%02x" % t


class Step:
    def __init__(self, text="", calls=None, stall=0.0, delay=0.06, error=None, cut=False, error_times=10**9, stall_times=10**9):
        self.error_times = error_times
        self.stall_times = stall_times
        self.hits = 0
        self.text = text
        self.calls = calls or []  # list of (tool, args)
        self.stall = stall  # seconds of silence before the first byte
        self.delay = delay  # seconds between streamed word chunks
        self.error = error  # (status, message) -> HTTP error instead of a stream
        self.cut = cut  # drop the connection mid-stream


class Script:
    """steps: {tool_results_seen: Step}; final: Step; children: {name: Script}."""

    def __init__(self, steps, final, children=None, aux="audit scratch session"):
        self.steps = steps
        self.final = final
        self.children = children or {}
        self.aux = aux


def first_user(body):
    for m in body.get("messages", []):
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else json.dumps(c)
    return ""


class MockModel:
    def __init__(self, script, log=None):
        self.script = script
        self.requests = []
        self.log = log
        self.errors_served = {}
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _json(self, obj, status=200):
                b = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):  # noqa: N802
                if self.path.startswith("/api/tags"):
                    self._json({"models": [{"name": "mock-small", "model": "mock-small"}]})
                elif self.path.startswith("/api/version"):
                    self._json({"version": "0.12.0"})
                else:
                    self.send_error(404)

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(n)
                if self.path.startswith("/api/show"):
                    self._json({"model_info": {"mock.context_length": 32768}, "capabilities": ["tools"]})
                    return
                if not self.path.startswith("/api/chat"):
                    self.send_error(404)
                    return
                body = json.loads(raw or b"{}")
                outer.requests.append(body)
                step = outer.pick(body)
                if outer.log:
                    with open(outer.log, "a") as fh:
                        fh.write(json.dumps({"t": time.time(), "who": step[0], "tools": bool(body.get("tools")),
                                             "done": sum(1 for m in body.get("messages", []) if m.get("role") == "tool")}) + "\n")
                who, st = step
                st.hits += 1
                if st.stall and st.hits <= st.stall_times:
                    time.sleep(st.stall)
                if st.error and st.hits <= st.error_times:
                    key = (who, id(st))
                    outer.errors_served[key] = outer.errors_served.get(key, 0) + 1
                    status, msg = st.error
                    self._json({"error": msg}, status=status)
                    return
                self.send_response(200)
                self.send_header("content-type", "application/x-ndjson")
                self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                chunks = outer.stream(st)
                try:
                    for i, line in enumerate(chunks):
                        if st.cut and st.hits <= st.error_times and i == max(1, len(chunks) // 2):
                            self.wfile.flush()
                            self.connection.shutdown(2)
                            return
                        data = (json.dumps(line) + "\n").encode()
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                        self.wfile.flush()
                        time.sleep(st.delay)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def pick(self, body):
        if not body.get("tools"):
            return ("aux", Step(text=self.script.aux, delay=0.0))
        done = sum(1 for m in body.get("messages", []) if m.get("role") == "tool")
        fu = first_user(body)
        m = re.search(r"\[child:([a-z]+)\]", fu)
        sc = self.script
        who = "lead"
        if m and m.group(1) in sc.children:
            who = m.group(1)
            sc = sc.children[who]
        st = sc.steps.get(done)
        return (who, st if st is not None else sc.final)

    def stream(self, st):
        out = []
        if st.text:
            for piece in re.findall(r"\S+\s*|\n+", st.text):
                out.append({"model": "mock-small", "message": {"role": "assistant", "content": piece}})
        if st.calls:
            out.append({"model": "mock-small", "message": {"role": "assistant", "content": "",
                        "tool_calls": [{"function": {"name": t, "arguments": a}} for t, a in st.calls]}})
        out.append({"model": "mock-small", "done": True, "done_reason": "stop",
                    "prompt_eval_count": 1200, "eval_count": 80})
        return out

    def stop(self):
        self.server.shutdown()


def setup(scratch, port, theme="rune-dark", gear=3, extra="", project=None, home_name="code/lantern"):
    """Fresh profile + workspace under `scratch`; returns (profile, work)."""
    if Path(scratch).exists() and any(Path(scratch).iterdir()):
        raise ValueError("scratch must be a new or empty directory")
    rig.SCRATCH = scratch
    rig.PROFILE = os.path.join(scratch, "profile")
    rig.WORK = os.path.join(scratch, home_name)
    os.makedirs(rig.PROFILE, exist_ok=True)
    os.makedirs(rig.WORK, exist_ok=True)
    with open(os.path.join(rig.PROFILE, "config.toml"), "w") as fh:
        fh.write(
            "[update]\ncheck = false\n\n"
            '[ui]\ntheme = "%s"\nfinish = "matte"\n\n'
            '[llm]\ndefaultProvider = "ollama"\n\n'
            '[llm.ollama]\nbaseUrl = "http://127.0.0.1:%d"\nmodel = "mock-small"\n\n'
            "[permissions]\ngear = %d\n\n"
            "[cost]\nmaxSessionUsd = 0\n%s" % (theme, port, gear, extra)
        )
    with open(os.path.join(rig.PROFILE, "telemetry.json"), "w") as fh:
        fh.write('{"v":1,"installId":null,"decision":"denied","decidedAt":"2026-09-10T00:00:00.000Z","lastHeartbeat":null}\n')
    for rel, content in (project or {}).items():
        p = Path(rig.WORK, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    # a git repo so the header shows a branch, like a real project
    os.system("cd '%s' && git init -q -b main && git -c user.email=a@b -c user.name=audit add -A >/dev/null 2>&1 && "
              "git -c user.email=a@b -c user.name=audit commit -qm init >/dev/null 2>&1" % rig.WORK)
    return rig.PROFILE, rig.WORK


def session(rows, cols, dark=True, argv=None, **env):
    bg, fg = (DARK_BG, DARK_FG) if dark else (LIGHT_BG, LIGHT_FG)
    if argv is not None:
        rig.ARGV = argv
    elif os.environ.get("RIG_CLI"):
        rig.ARGV = [os.environ["RIG_CLI"], "--new", "--no-browser", "--pristine"]
    e = dict(
        COLORTERM="truecolor", NO_COLOR="", FORCE_COLOR="3",
        HOME=os.path.realpath(rig.SCRATCH),
        RUNE_TERMINAL_BACKGROUND=hexrgb(bg), RUNE_TERMINAL_FOREGROUND=hexrgb(fg),
        RUNE_TOOLS_BIN=TOOLS_BIN, RUNE_TOOLS_BINARY=TOOLS_BIN,
    )
    e.update(env)
    if e.get("NO_COLOR"):
        e.pop("FORCE_COLOR", None)
        e.pop("COLORTERM", None)
    s = rig.Session(rows=rows, cols=cols, **e)
    s.screen = ColorScreen(rows, cols)
    s.stream = ColorStream(s.screen)
    s._dark = dark
    return s


def save(s, outdir, name):
    os.makedirs(outdir, exist_ok=True)
    s.snapshot(outdir, name)
    bg, fg = (DARK_BG, DARK_FG) if getattr(s, "_dark", True) else (LIGHT_BG, LIGHT_FG)
    Path(outdir, name + ".html").write_text(
        '<meta charset="utf-8">' + to_html(s.screen, ground=bg, foreground=fg, title=name))
    return Path(outdir, name + ".txt")


def text(s):
    return s.screen.text()


def wait_text(s, needle, timeout=60, gone=False):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        t = s.screen.text()
        hit = (needle.lower() in t.lower())
        if hit != gone:
            return True
        if not s.pump(0.25):
            return False
    return False


def follow(s, outdir, tag, seconds, every=2.0, until=None, until_gone=None):
    """Snapshot every `every` seconds for up to `seconds`; stop on `until` text."""
    end = time.monotonic() + seconds
    i = 0
    last = None
    while time.monotonic() < end:
        s.pump(every)
        t = s.screen.text()
        if t != last:
            save(s, outdir, "%s-%02d" % (tag, i))
            i += 1
            last = t
        if until and until.lower() in t.lower():
            if until_gone is None or until_gone.lower() not in t.lower():
                break
    return i
