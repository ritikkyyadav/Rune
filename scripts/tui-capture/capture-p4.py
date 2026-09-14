"""P4-§2.8's frames: the setup wizard across the four regions.

Reuses the Phase 4 pty rig (`capture.py`) and Lane E's loopback provider
(`capture-lane-e.py`) unchanged -- same emulator, same scratch profile, same
zero-model-call construction. The only network any frame here causes is the
key step's listing probe against a `GET /v1/models` on 127.0.0.1 that serves
exactly one route, so a completion cannot happen even by mistake. These frames
answer only the provider and base-URL steps, which touch nothing at all.

  * `120x40-idle`           the frame at rest, for the before/after edge.
  * `120x40-setup-open`     `/setup` at a width with a right column: the ledger
                            is the PANEL, the question is the COMPOSER, and the
                            divider is still on screen. This is the frame
                            `120x40-setup-wizard-no-split.txt` could not draw.
  * `120x40-setup-provider` after `custom`: the receipt is a box in the
                            WORKSPACE and the panel's provider row has ticked.
  * `120x40-setup-url`      after the loopback base URL: two receipts stacked.
  * `120x40-setup-esc`      `esc`: what was saved stays saved, and the
                            abandoned step reads `not set`.
  * the same five at 80x24, where the wizard keeps Lane E's footer block.

    python3 scripts/tui-capture/capture-p4.py OUTDIR
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

os.environ.setdefault(
    "CAPTURE_ROOT",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "rune-p4-capture"),
)

import capture as rig  # noqa: E402

ESC, CR = rig.ESC, rig.CR


def no_provider_profile():
    """A profile that names a provider needing a key, and supplies none.

    `fresh_profile()` names ollama, which registers with no key, so the startup
    gate never runs and `/setup` is reached by typing it. Both paths land in the
    same FirstRun controller; this one is the launch path.
    """
    rig.fresh_profile()
    with open(os.path.join(rig.PROFILE, "config.toml"), "w") as fh:
        fh.write('[update]\ncheck = false\n\n[llm]\ndefaultProvider = "openai"\n')


class MockProvider:
    """A loopback `GET /v1/models`, and nothing else. (Lane E's, verbatim.)"""

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
                    body = b'{"object":"list","data":[{"id":"mock-small"}]}'
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

    @classmethod
    def forget(cls):
        """Take the mock key back out of the OS credential store.

        `RUNE_HOME` scopes the profile, not the keychain: the key step stores
        under service `rune`, account `provider:custom`, which is the machine's
        login keychain and outlives the scratch home. A capture that leaves a
        credential behind has changed the machine it was measuring. Only the
        mock's own value is removed -- a real credential under the same account
        is left exactly where it is.
        """
        import subprocess

        if sys.platform != "darwin":
            return
        args = ["security", "find-generic-password", "-s", "rune", "-a", "provider:custom", "-w"]
        found = subprocess.run(args, capture_output=True, text=True)
        if found.returncode != 0 or found.stdout.strip() != cls.GOOD:
            return
        subprocess.run(
            ["security", "delete-generic-password", "-s", "rune", "-a", "provider:custom"],
            capture_output=True,
        )
        print("  removed the mock key from the login keychain")


def walk(outdir, rows, cols, port):
    tag = "%dx%d" % (cols, rows)
    rig.fresh_profile()
    s = rig.start(rows, cols)
    try:
        # Idle first, at the same size and in the same process, so the two
        # frames differ by exactly one command and nothing else.
        s.snapshot(outdir, "%s-idle" % tag)

        # `/setup` is the reachable door: the launch gate lands in the same
        # FirstRun controller, but it only opens on a profile with no
        # registered provider, and this machine has a local ollama.
        s.send("/setup", settle=0.5)
        s.send(CR, settle=1.6)
        s.wait_for(["setup"], timeout=30)
        assert s.proc.poll() is None, s.proc.returncode
        s.snapshot(outdir, "%s-setup-open" % tag)

        def answer(value, settle=1.4):
            s.send(value, settle=0.4)
            s.send(CR, settle=settle)

        answer("custom")
        s.snapshot(outdir, "%s-setup-provider" % tag)

        answer("http://127.0.0.1:%d/v1" % port)
        s.snapshot(outdir, "%s-setup-url" % tag)

        # The key step, for the one property that matters more than layout: the
        # secret is masked in the live field, in the ledger row and in the
        # receipt. Typed but NOT yet submitted here.
        answer("mock-small")
        s.send(MockProvider.GOOD, settle=0.6)
        s.snapshot(outdir, "%s-setup-key-typed" % tag)
        s.send(CR, settle=2.6)
        s.snapshot(outdir, "%s-setup-key-accepted" % tag)

        # esc leaves everything already saved saved, and the step it walked out
        # of reads `not set` rather than disappearing.
        s.send(ESC, settle=1.0)
        s.snapshot(outdir, "%s-setup-esc" % tag)
    finally:
        s.close()

    # The secret must be nowhere: not in a frame, not in the transcript the
    # frames are taken from, and not in the console sink under the profile.
    leaked = []
    for path in Path(outdir).glob("%s-*.txt" % tag):
        if MockProvider.GOOD in path.read_text() or "0000-7f2a" in path.read_text():
            leaked.append(str(path))
    for root, _dirs, files in os.walk(rig.PROFILE):
        for name in files:
            p = os.path.join(root, name)
            try:
                blob = open(p, "rb").read()
            except OSError:
                continue
            if MockProvider.GOOD.encode() in blob:
                leaked.append(p)
    assert not leaked, "API key leaked into: %s" % leaked
    print("  no key in any %s frame, nor anywhere under the profile" % tag)

    # Proof that `esc` kept what was saved and lost only what was not: a NEW
    # process on the SAME profile, reading the file the wizard wrote. `esc` is
    # terminal for a wizard instance (`cancel()` sets `done()`), so reopening it
    # is a relaunch -- which is also the honest test, since the ledger's `saved`
    # column is defined as what a brand-new process reads.
    s = rig.Session(rows=rows, cols=cols)
    try:
        s.wait_for(["r u n e"], timeout=90)
        s.pump(1.0)
        s.send("/setup", settle=0.5)
        s.send(CR, settle=1.6)
        s.wait_for(["setup"], timeout=30)
        s.snapshot(outdir, "%s-setup-reopened" % tag)
        s.send(ESC, settle=0.6)
    finally:
        s.close()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(rig.REPO / "captures-p4")
    os.makedirs(out, exist_ok=True)
    mock = MockProvider()
    try:
        for rows, cols in ((40, 120), (24, 80)):
            walk(out, rows, cols, mock.port)
    finally:
        mock.stop()
        MockProvider.forget()
    print("done ->", out)
