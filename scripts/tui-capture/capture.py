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
  * every provider key in the parent environment is scrubbed from the child --
    by SHAPE, not by a hand-written roster (see SCRUB below);
  * the child's cwd is the scratch workspace, never the checkout, so the
    repo-level `.env` that `bun` auto-loads from its CURRENT DIRECTORY is not
    loaded into the child. (Measured, not assumed: the same entrypoint run with
    cwd inside the checkout does get `GOOGLE_API_KEY`/`OPENROUTER_API_KEY` from
    that file, and run from anywhere else does not. `WORK` is under $TMPDIR.)
  * the only bytes ever written are local slash commands, picker navigation and
    Escape -- nothing is typed into the composer and submitted.

    python3 scripts/tui-capture/capture.py OUTDIR [--label before]
"""

import atexit
import codecs
import os
import re
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path

# The pty rig needs these four and they exist only on POSIX. `secret_names`
# below is imported by a unit test on every platform, so their absence must
# not stop the module from loading — it stops the rig, with a plain message.
try:
    import fcntl
    import pty
    import select
    import termios
except ImportError:  # Windows
    fcntl = pty = select = termios = None

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

# Variables that steer the child without being secrets: a terminal size the pty
# already owns, and the profile/model overrides that would make a frame a
# picture of this machine rather than of the product.
SCRUB = "COLUMNS LINES RUNE_CONFIG_PATH RUNE_DB_PATH GEAR_HOME RUNE_MODEL RUNE_PROVIDER".split()

# Credentials are scrubbed by a PREDICATE, stated here in full.
#
# A hand-written roster goes stale: the one this replaced named ten providers
# and missed OLLAMA_API_KEY, GEMINI_API_KEY and BRAVE_API_KEY. Its replacement
# was a roster too — two suffixes — and the registry already held a provider it
# could not see (`SCW_SECRET_KEY`), while bedrock and vertex authenticate from
# the machine's AWS/GCP credential CHAIN, whose names end in no secret suffix at
# all. The guard below used the same two suffixes, so it could not catch its own
# blind spot.
#
# A name is credential-shaped when ANY of these is true:
#   1. it ends in one of the secret suffixes below, or
#   2. it is a credential-chain variable bedrock/vertex read, or
#   3. the provider or search registry declares it as a preset's `envVar`
#      (read from the source, never retyped, so a preset added tomorrow is
#      covered the day it lands).
SECRET_SUFFIXES = (
    "_API_KEY",
    "_KEY",
    "_TOKEN",
    "_SECRET",
    "_PASSWORD",
    "_CREDENTIAL",
    "_CREDENTIALS",
    "_AUTH",
)

# bedrock: "AWS signs each request from the machine's own credential chain";
# vertex reads the ambient GCP credentials. Neither ends in a secret suffix.
CREDENTIAL_CHAIN = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_VERTEX_LOCATION",
)

# What the rig itself puts in the child. Named so the shape rule can never eat
# one of them, even if a future variable of the rig's own ends in a suffix.
RIG_SET = {"RUNE_HOME", "TERM", "LANG", "RUNE_TOOLS_BIN", "RUNE_TOOLS_BINARY"}


def registry_env_vars():
    """Every `envVar:` a preset declares, read from the registry's source.

    Generated, not retyped: the roster this replaces was wrong the day a preset
    was added. A parse failure is a scrub that got SMALLER, so it raises rather
    than quietly returning an empty set.
    """
    import re

    names = set()
    for source in (
        REPO / "packages" / "shared" / "src" / "providers.ts",
        REPO / "packages" / "shared" / "src" / "search-providers.ts",
    ):
        text = source.read_text(encoding="utf-8")
        found = re.findall(r'envVar:\s*"([A-Z0-9_]+)"', text)
        if not found:
            raise AssertionError("no envVar declarations found in %s" % source)
        names.update(found)
    return names


def is_credential_shaped(name, declared=None):
    """The predicate, in one place, used by the scrub and by its own guard."""
    if name in RIG_SET:
        return False
    if name.endswith(SECRET_SUFFIXES) or name in CREDENTIAL_CHAIN:
        return True
    return name in (registry_env_vars() if declared is None else declared)


def secret_names(env):
    """Every credential-shaped name in `env`, minus the rig's own variables."""
    declared = registry_env_vars()
    return sorted(k for k in env if is_credential_shaped(k, declared))


def child_env(**extra):
    e = dict(os.environ)
    e.update(
        RUNE_HOME=PROFILE,
        TERM="xterm-256color",
        LANG="en_US.UTF-8",
        RUNE_TOOLS_BIN=str(REPO / "target" / "debug" / "rune-tools"),
        RUNE_TOOLS_BINARY=str(REPO / "target" / "debug" / "rune-tools"),
    )
    for k in SCRUB + secret_names(e):
        e.pop(k, None)
    e.update(extra)
    # The claim, checked rather than asserted in prose. A caller that passes a
    # credential in `extra` means it (no capture does today); anything else
    # credential-shaped surviving this function is a key the child can spend.
    leaked = [k for k in secret_names(e) if k not in extra]
    assert not leaked, "credential-shaped variables reached the child: %s" % leaked
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
    def __init__(self, rows=24, cols=80, **env_extra):
        if pty is None:
            sys.exit("capture.py drives a pty, which this platform does not have")
        self.rows, self.cols = rows, cols
        self.screen = Screen(rows, cols)
        self.stream = Stream(self.screen)
        self.plain = ""
        self.raw = ""
        # A 3-byte box-drawing character straddling two reads decodes as two
        # replacement chars if each read is decoded on its own -- which shows up
        # in a capture as a hole in a rule that is not in the product.
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        LIVE.append(self)
        self.master, slave = pty.openpty()
        self._winsize(rows, cols)
        self.proc = subprocess.Popen(
            ARGV, cwd=WORK, env=child_env(**env_extra), stdin=slave, stdout=slave, stderr=slave,
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
            data = self.decoder.decode(chunk)
            self.raw += data
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

    def wait_exit(self, timeout=12):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.proc.poll() is not None:
                self.pump(0.3)
                return self.proc.returncode
            self.pump(0.25)
        return None

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


def start(rows, cols, **env_extra):
    s = Session(rows=rows, cols=cols, **env_extra)
    s.wait_for(["r u n e"], timeout=90)
    s.pump(1.0)
    return s


CTRL_F = b"\x06"


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

            # Typed, never submitted: the field, the caret and the hint row
            # at the composer's own width.
            s.send("rework the first-run wizard so the provider step", settle=0.8)
            s.snapshot(outdir, "%s-typed" % tag)
            for _ in range(48):
                s.send(b"\x7f", settle=0.0)
            s.pump(0.6)

            # The focus ring, and -- at a collapsed width -- the overlay.
            s.send(CTRL_F, settle=0.8)
            s.snapshot(outdir, "%s-ctrl-f" % tag)
            s.send(ESC, settle=0.8)
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

    # The collapse threshold, from both sides, in one session so the only
    # variable is the width.
    s = start(30, 100)
    try:
        s.snapshot(outdir, "100x30-panel")
        s.resize(30, 99)
        s.snapshot(outdir, "99x30-collapsed")
    finally:
        s.close()

    # Seven-bit, no colour: the layout has to carry the meaning on its own.
    for rows, cols, tag in ((24, 80, "80x24"), (40, 120, "120x40")):
        s = start(rows, cols, NO_COLOR="1", RUNE_ASCII="1")
        try:
            s.snapshot(outdir, "%s-ascii-nocolor" % tag)
        finally:
            s.close()

    # SIGTERM mid-session, with the overlay open: the terminal must come back
    # exactly as it was found. The restore is state-independent by
    # construction (VIEWPORT_RESTORE on process exit), and this is the proof
    # that it holds with the frame in its split state too.
    s = start(24, 80)
    try:
        s.send(CTRL_F, settle=0.8)  # the overlay, over the workspace
        assert "esc close" in s.screen.text(), "overlay did not open"
        os.killpg(s.proc.pid, signal.SIGTERM)
        s.wait_exit(10)
        tail = s.raw[-400:]
        receipt = [
            "# SIGTERM with the panel overlay open, at 80x24",
            "# exit code: %r (SIGTERM handler exits 143)" % s.proc.returncode,
            "# alt screen left  (ESC[?1049l): %s" % ("\x1b[?1049l" in tail),
            "# autowrap restored (ESC[?7h):   %s" % ("\x1b[?7h" in tail),
            "# cursor shown      (ESC[?25h):  %s" % ("\x1b[?25h" in tail),
            "# mouse off      (ESC[?1000l):   %s" % ("\x1b[?1000l" in tail),
            "#",
            "# the last 400 characters written, escapes made visible:",
            repr(tail),
        ]
        (Path(outdir) / "sigterm-restore.txt").write_text("\n".join(receipt) + "\n")
        print("  frame -> %s" % (Path(outdir) / "sigterm-restore.txt"))
    finally:
        s.close()

    # The window that is too small to be told the truth in.
    s = start(24, 80)
    try:
        s.resize(16, 59)
        s.snapshot(outdir, "59x16-refused")
        s.resize(15, 60)
        s.snapshot(outdir, "60x15-refused")
        s.resize(24, 80)
        s.snapshot(outdir, "refusal-recovered")
    finally:
        s.close()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(REPO / "captures")
    fresh_profile()
    capture_all(out)
    print("done ->", out)
