"""Capture Rune's TUI frames from the SOURCE entrypoint through a real pty.

Why a pty: the fixed frame paints on the alternate screen with absolute
addressing, so the only honest picture of it is a terminal emulator's own
buffer. `vtscreen.py` is that emulator (copied from the Phase 1c driver).

Zero model calls, by construction:
  * the child is `bun packages/orchestrator/src/bin/rune-cli.ts --new
    --no-browser --pristine` -- no `-p`, no `-P`, no `-m`, no positional
    prompt, i.e. none of the flags that can reach a provider;
  * `RUNE_HOME` is a scratch profile with no credentials index, so there is no
    keychain lookup and no key to find;
  * every provider key in the parent environment is scrubbed from the child;
  * the only bytes ever written are local slash commands, picker navigation and
    Escape -- nothing is typed into the composer and submitted.

    python3 scripts/tui-capture/capture.py OUTDIR [--label before]
"""

import atexit
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
from vtscreen import Screen, Stream  # noqa: E402

ANSI = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#%].|\x1b[0-9A-Za-z]"
)
LIVE = []

SCRATCH = os.environ.get("CAPTURE_ROOT") or os.path.join(
    os.environ.get("TMPDIR", "/tmp"), "rune-phase4-capture"
)
PROFILE = os.path.join(SCRATCH, "profile")
WORK = os.path.join(SCRATCH, "workspace")

ENTRY = str(REPO / "packages" / "orchestrator" / "src" / "bin" / "rune-cli.ts")
ARGV = ["bun", ENTRY, "--new", "--no-browser", "--pristine"]

SCRUB = (
    "COLUMNS LINES RUNE_CONFIG_PATH RUNE_DB_PATH GEAR_HOME RUNE_MODEL RUNE_PROVIDER "
    "OPENROUTER_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY GROQ_API_KEY "
    "XAI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY TOGETHER_API_KEY CEREBRAS_API_KEY"
).split()


def child_env():
    e = dict(os.environ)
    e.update(
        RUNE_HOME=PROFILE,
        TERM="xterm-256color",
        LANG="en_US.UTF-8",
        RUNE_TOOLS_BIN=str(REPO / "target" / "debug" / "rune-tools"),
        RUNE_TOOLS_BINARY=str(REPO / "target" / "debug" / "rune-tools"),
    )
    for k in SCRUB:
        e.pop(k, None)
    return e


def fresh_profile():
    import shutil

    shutil.rmtree(SCRATCH, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    # The one provider that cannot cost anything: ollama is the only preset
    # marked `local`, it registers with no key at all, and its base URL is
    # localhost:11434 -- so there is no remote endpoint to reach even by
    # accident. `[update] check = false` closes the one network path startup
    # would otherwise take.
    with open(os.path.join(PROFILE, "config.toml"), "w") as fh:
        fh.write(
            "[update]\ncheck = false\n\n"
            "[llm]\ndefaultProvider = \"ollama\"\n\n"
            "[llm.ollama]\nmodel = \"gpt-oss:20b\"\n\n"
            "[cost]\nmaxSessionUsd = 7.25\n"
        )
    # decision "denied" so the first-run consent question can never be asked.
    with open(os.path.join(PROFILE, "telemetry.json"), "w") as fh:
        fh.write(
            '{"v":1,"installId":null,"decision":"denied",'
            '"decidedAt":"2026-09-10T00:00:00.000Z","lastHeartbeat":null}\n'
        )


class Session:
    def __init__(self, rows=24, cols=80):
        self.rows, self.cols = rows, cols
        self.screen = Screen(rows, cols)
        self.stream = Stream(self.screen)
        self.plain = ""
        LIVE.append(self)
        self.master, slave = pty.openpty()
        self._winsize(rows, cols)
        self.proc = subprocess.Popen(
            ARGV, cwd=WORK, env=child_env(), stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

    def _winsize(self, rows, cols):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            r, _, _ = select.select(
                [self.master], [], [], min(0.1, max(0.01, end - time.monotonic()))
            )
            if not r:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            data = chunk.decode("utf-8", errors="replace")
            self.plain += ANSI.sub("", data)
            self.stream.feed(data)
        return True

    def wait_for(self, needles, timeout=60):
        needles = [n.lower() for n in needles]
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            hay = self.screen.text().lower()
            if all(n in hay for n in needles):
                self.pump(0.4)
                return self.screen.text()
            if not self.pump(0.25):
                break
        raise AssertionError(
            "timed out waiting for %r\n--- screen ---\n%s" % (needles, self.screen.text())
        )

    def send(self, data, settle=0.6):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())
        self.pump(settle)

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        self._winsize(rows, cols)
        try:
            os.killpg(self.proc.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass
        self.screen.resize(rows, cols)
        self.pump(1.4)

    def snapshot(self, outdir, name):
        """The frame, and nothing about when or where it was taken.

        A capture that carries a timestamp or a path can never be compared
        byte-for-byte against the same capture taken an hour later, which is
        the whole point of taking it twice.
        """
        path = Path(outdir) / (name + ".txt")
        body = self.screen.text().split("\n")
        ruler = "".join(str((i // 10) % 10) if i % 10 == 0 else "." for i in range(self.cols))
        head = [
            "# frame: %s" % name,
            "# terminal: %d rows x %d cols (real pty, %s screen)"
            % (self.rows, self.cols, "alt" if self.screen.in_alt else "primary"),
            "# " + "-" * 60,
            "#" + ruler,
        ]
        lines = head + ["%2d|%s" % (i + 1, r) for i, r in enumerate(body)]
        path.write_text("\n".join(lines) + "\n")
        print("  frame -> %s" % path)
        return path

    def close(self):
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
        try:
            os.close(self.master)
        except OSError:
            pass
        return self.proc.returncode


def _reap():
    for s in LIVE:
        try:
            if s.proc.poll() is None:
                os.killpg(s.proc.pid, signal.SIGKILL)
        except Exception:
            pass


atexit.register(_reap)

ESC = b"\x1b"
CR = b"\r"


def start(rows, cols):
    s = Session(rows=rows, cols=cols)
    s.wait_for(["r u n e"], timeout=90)
    s.pump(1.0)
    return s


def capture_all(outdir):
    os.makedirs(outdir, exist_ok=True)
    for rows, cols in ((24, 80), (40, 120)):
        tag = "%dx%d" % (cols, rows)
        s = start(rows, cols)
        try:
            s.snapshot(outdir, "%s-start" % tag)

            s.send("/help", settle=0.4)
            s.send(CR, settle=1.6)
            s.snapshot(outdir, "%s-help" % tag)

            s.send("/", settle=1.0)
            s.snapshot(outdir, "%s-picker" % tag)
            s.send(ESC, settle=0.6)
            s.send(ESC, settle=0.6)
        finally:
            s.close()

    # One session, resized 80 -> 120 -> 80: the round trip must land on the
    # same frame it started from, or a resize is losing state.
    s = start(24, 80)
    try:
        s.snapshot(outdir, "resize-80-before")
        s.resize(40, 120)
        s.snapshot(outdir, "resize-120")
        s.resize(24, 80)
        s.snapshot(outdir, "resize-80-after")
    finally:
        s.close()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(REPO / "captures")
    fresh_profile()
    capture_all(out)
    print("done ->", out)
