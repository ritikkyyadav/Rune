"""Lane E's frames: settings, the no-provider gate, and the setup ledger.

Reuses the Phase 4 pty rig (`capture.py`) unchanged -- same emulator, same
scratch profile, same zero-model-call construction -- and drives only the
surfaces lane E owns:

  * `120x40-config`      `/config` at a width that has a right column. The
                         picker now opens INSIDE the workspace, so the panel,
                         the divider and the composer are still on screen.
  * `80x24-config-open`  `/config` collapsed: the heading carries the total.
  * `80x24-config-end`   one `up` from the first row wraps to the last, which
                         is the proof every row is reachable.
  * `80x24-config-saved` the change confirmation, in the transcript gutter.
  * `80x24-no-keys`      the reachable setup flow on a fresh no-key launch.

    python3 scripts/tui-capture/capture-lane-e.py OUTDIR
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

os.environ.setdefault(
    "CAPTURE_ROOT",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "rune-lane-e-capture"),
)

import capture as rig  # noqa: E402

ESC, CR, UP = rig.ESC, rig.CR, b"\x1b[A"


def no_provider_profile():
    """A profile with no provider at all, for the startup gate.

    `fresh_profile()` names ollama, which registers with no key; this one names
    a provider that needs one and supplies none, so `getRegisteredProviders()`
    is empty and rune-cli's gate is what runs.
    """
    rig.fresh_profile()
    with open(os.path.join(rig.PROFILE, "config.toml"), "w") as fh:
        fh.write('[update]\ncheck = false\n\n[llm]\ndefaultProvider = "openai"\n')


def settings_frames(outdir):
    for rows, cols in ((40, 120), (24, 80)):
        tag = "%dx%d" % (cols, rows)
        s = rig.start(rows, cols)
        try:
            s.send("/config", settle=0.4)
            s.send(CR, settle=1.6)
            s.snapshot(outdir, "%s-config" % tag)

            # `up` from the first row wraps to the last. If the list windows
            # correctly, the final settings are on screen here -- and they are
            # the five the 2026-09-10 capture could not reach.
            s.send(UP, settle=0.8)
            s.snapshot(outdir, "%s-config-end" % tag)
            s.send(ESC, settle=0.6)

            # The text form: one confirmation row, which used to start at
            # column 0 while every row around it kept the two-cell gutter.
            s.send("/config playbook on", settle=0.4)
            s.send(CR, settle=1.4)
            s.snapshot(outdir, "%s-config-saved" % tag)

            # And the list form, which had the same shape.
            s.send("/config list", settle=0.4)
            s.send(CR, settle=1.4)
            s.snapshot(outdir, "%s-config-list" % tag)
        finally:
            s.close()


def no_keys_frame(outdir):
    no_provider_profile()
    s = rig.Session(rows=24, cols=80)
    try:
        # Interactive no-key launch enters the same FirstRun controller `/setup`
        # uses. It must stay alive: the old pre-surface validation exited 1 and
        # made setup impossible from the terminal it was meant to configure.
        text = s.wait_for(["setup", "which provider?"], timeout=90)
        assert s.proc.poll() is None, s.proc.returncode
        assert "no api keys configured" not in text.lower(), text
        s.snapshot(outdir, "80x24-no-keys")
        s.send(ESC, settle=0.4)
    finally:
        s.close()


class MockProvider:
    """A loopback `GET /v1/models`, and nothing else.

    The key step probes a listing endpoint -- the smallest request that proves
    the host is reachable and the key accepted. It is NOT a completion: this
    server has no other route, so a model call cannot happen even by mistake.
    One key is accepted and every other is 401, which is how the rejected-key
    frame is taken without a real provider.
    """

    GOOD = "sk-capture-key-0000-0000-7f2a"

    def __init__(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        good = self.GOOD

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                auth = self.headers.get("authorization", "")
                if auth != "Bearer %s" % good:
                    body = b'{"error":{"message":"Incorrect API key provided: sk-\u2026beef"}}'
                    self.send_response(401, "Unauthorized")
                else:
                    body = b'{"object":"list","data":[{"id":"mock-small"},{"id":"mock-large"}]}'
                    self.send_response(200, "OK")
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


def first_run_frames(outdir):
    """The six steps, walked on a clean profile with no credential anywhere.

    Nothing is ever submitted to a model: every Enter here lands in the setup
    controller, and the only network call any of them makes is the listing
    probe against the loopback server above.
    """
    mock = MockProvider()
    try:
        no_provider_profile()
        s = rig.Session(rows=40, cols=120)
        try:
            s.wait_for(["setup", "which provider?"], timeout=90)
            s.snapshot(outdir, "120x40-first-run-step1")

            def answer(value, settle=1.2):
                s.send(value, settle=0.4)
                s.send(CR, settle=settle)

            answer("custom")
            answer("http://127.0.0.1:%d/v1" % mock.port)
            answer("mock-small")

            # A key the provider refuses: a receipt, and nothing saved.
            answer("sk-wrong-key-3333-beef", settle=2.0)
            s.snapshot(outdir, "120x40-first-run-key-rejected")

            # …and the one it accepts.
            answer(MockProvider.GOOD, settle=2.4)
            s.snapshot(outdir, "120x40-first-run-key-accepted")

            answer("off")
            answer("2.5")
            answer("regular", settle=1.6)
            s.snapshot(outdir, "120x40-first-run-complete")
            s.send(ESC, settle=0.8)
            s.snapshot(outdir, "120x40-first-run-closed")
        finally:
            s.close()
    finally:
        mock.stop()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(rig.REPO / "captures-lane-e")
    os.makedirs(out, exist_ok=True)
    no_keys_frame(out)
    first_run_frames(out)
    rig.fresh_profile()
    settings_frames(out)
    print("done ->", out)
