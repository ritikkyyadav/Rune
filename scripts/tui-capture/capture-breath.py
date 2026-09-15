"""Five consecutive frames, 700ms apart, of the working indicator breathing.

The breath is COLOUR, not shape (founder, 2026-09-15: "soothing and calm ...
the whole text and a pulse"), and `vtscreen.py` models a character grid with no
SGR state -- so a plain screen snapshot cannot show it. This rig therefore
records two things per frame:

  * the PHRASE row, from the emulator's grid, exactly as a reader sees it;
  * the SGR sequence the mark was actually painted with, lifted out of the raw
    bytes the child wrote for that frame.

Together those are the claim: the phrase names what the run is doing, and the
mark's colour advances one step per 700ms while its shape never changes.

ZERO LIVE MODEL CALLS, and this script types a prompt, so the argument has to
be stronger than "we never press Enter":

  * the profile names `ollama` as the only provider, with `baseUrl` pointed at
    a loopback server this process started on 127.0.0.1 -- ollama is the one
    preset that registers with no key at all, so no credential is consulted;
  * every credential-shaped variable is scrubbed from the child by
    `capture.py`'s own predicate, which this file imports rather than copies;
  * the mock serves `/api/tags` and `/api/chat` and NOTHING else, so there is
    no route to a real endpoint even by misconfiguration;
  * the reply is prose only -- no tool calls -- so nothing runs on the machine.

    python3 scripts/tui-capture/capture-breath.py OUTDIR
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

CR = rig.CR

# The mark, by codepoint: this file must stay seven-bit like the rest of the rig.
MARK = "✻"
# The colour the mark was painted with: the SGR immediately before it, or an
# empty match where the theme's `text` tint is the terminal's own foreground
# and emits no escape at all. Both are steps of the breath, and a regex that
# demanded an escape would silently drop a third of the ramp.
PAINTED = re.compile(r"(\x1b\[[0-9;]*m)?" + MARK)

# Long enough that five 700ms frames land inside one turn, slow enough that the
# rung is not replaced by a finished answer halfway through.
CHUNKS = [
    "Reading the frame code now. ",
    "The band is composed in viewport.ts, ",
    "and the composer takes its rows from the panel. ",
    "That is the whole of the layout decision. ",
    "Nothing else in the file depends on it.",
]
CHUNK_DELAY = 1.6

# How the `text` step of the ramp shows up on the wire in a theme that keeps the
# host's own foreground for body copy: as no escape at all.
NO_SGR = "(terminal default foreground)"


class MockOllama:
    """`/api/tags` and a slow NDJSON `/api/chat`. No other route exists."""

    def __init__(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if not self.path.startswith("/api/tags"):
                    self.send_error(404)
                    return
                body = json.dumps(
                    {"models": [{"name": "mock-small", "model": "mock-small"}]}
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802
                if not self.path.startswith("/api/chat"):
                    self.send_error(404)
                    return
                length = int(self.headers.get("content-length") or 0)
                self.rfile.read(length)
                self.send_response(200)
                self.send_header("content-type", "application/x-ndjson")
                self.end_headers()
                # A deliberate silence first: the turn opens on `Thinking`, and
                # that is the frame the founder was looking at when they asked
                # for this. Then prose, slowly, so the phrase changes once on
                # camera and the reader can see it do it.
                time.sleep(3.2)
                for chunk in CHUNKS:
                    line = json.dumps(
                        {"model": "mock-small", "message": {"role": "assistant", "content": chunk}}
                    )
                    try:
                        self.wfile.write((line + "\n").encode())
                        self.wfile.flush()
                    except BrokenPipeError:
                        return
                    time.sleep(CHUNK_DELAY)
                done = json.dumps({"model": "mock-small", "done": True, "done_reason": "stop"})
                try:
                    self.wfile.write((done + "\n").encode())
                    self.wfile.flush()
                except BrokenPipeError:
                    pass

            def log_message(self, *_args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


def mock_profile(port):
    rig.fresh_profile()
    with open(os.path.join(rig.PROFILE, "config.toml"), "w") as fh:
        fh.write(
            "[update]\ncheck = false\n\n"
            '[llm]\ndefaultProvider = "ollama"\n\n'
            "[llm.ollama]\n"
            'baseUrl = "http://127.0.0.1:%d"\n'
            'model = "mock-small"\n\n'
            # 0 = no cap. A mock model has no price list, and the dollar cap
            # refuses to run what it cannot meter -- correctly, and it is the
            # first thing this capture hit.
            "[cost]\nmaxSessionUsd = 0\n" % port
        )
    with open(os.path.join(rig.PROFILE, "telemetry.json"), "w") as fh:
        fh.write(
            '{"v":1,"installId":null,"decision":"denied",'
            '"decidedAt":"2026-09-10T00:00:00.000Z","lastHeartbeat":null}\n'
        )


def indicator_row(screen_text):
    """The row carrying the mark, trimmed. Empty when it is not on screen."""
    for line in screen_text.split("\n"):
        if MARK in line:
            return line.strip()
    return ""


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    mock = MockOllama()
    frames = []
    try:
        mock_profile(mock.port)
        s = rig.Session(rows=40, cols=120)
        try:
            s.wait_for(["r u n e"], timeout=90)
            s.pump(1.0)
            s.send("explain how the frame is composed", settle=0.6)
            s.send(CR, settle=0.8)
            for i in range(5):
                seen = len(s.raw)
                s.pump(0.7)
                delta = s.raw[seen:]
                paints = PAINTED.findall(delta)
                frames.append(
                    {
                        "frame": i + 1,
                        "at_ms": i * 700,
                        "row": indicator_row(s.screen.text()),
                        # EVERY colour the mark was painted with inside this
                        # 700ms window, in order. One entry is a step that did
                        # not move; two is the step landing mid-window. The
                        # last one is what was on screen when the frame closed.
                        "paints": paints,
                        "mark_sgr": paints[-1] if paints else "",
                    }
                )
            s.snapshot(outdir, "breath-last-frame")
        finally:
            s.close()
    finally:
        mock.stop()

    path = Path(outdir) / "breath-5-frames.txt"
    lines = [
        "# the working indicator, five consecutive frames 700ms apart",
        "# terminal: 40 rows x 120 cols (real pty, alt screen)",
        "# provider: loopback mock ollama -- no live model call",
        "# the mark is U+273B in every frame; only the SGR before it moves.",
        "# " + "-" * 60,
    ]
    seen_all = []
    for f in frames:
        sgr = f["mark_sgr"].replace("\x1b", "ESC") or NO_SGR
        lines.append("")
        lines.append("frame %d  (+%dms)" % (f["frame"], f["at_ms"]))
        lines.append("  row        %s" % (f["row"] or "(indicator not on screen)"))
        lines.append("  mark sgr   %s" % sgr)
        lines.append(
            "  painted    %s"
            % (
                " -> ".join(p.replace("\x1b", "ESC") or NO_SGR for p in f["paints"])
                or "(not repainted this frame)"
            )
        )
        seen_all.extend(f["paints"])
    distinct = sorted(set(seen_all))
    lines.append("")
    lines.append("distinct mark colours across the five frames: %d" % len(distinct))
    for sgr in distinct:
        lines.append("  %s" % (sgr.replace("\x1b", "ESC") or NO_SGR))
    Path(path).write_text("\n".join(lines) + "\n")
    print("  frames -> %s" % path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "out-breath"))
