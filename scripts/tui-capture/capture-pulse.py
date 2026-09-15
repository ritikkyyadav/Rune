"""Twenty-four consecutive frames, 90ms apart, of Rune's pulse in motion.

Founder, 2026-09-15 evening: the previous indicator "copied Claude Code and
built the exact same interface. I don't want that. I wanted that pulse design
only, and something very soothing -- a smooth animation, the kind of effect
Claude Code and Codex both have while they are working -- implemented
correctly, not copied from some other CLI."

Motion cannot be reviewed from a diff and it cannot be seen in a screen
snapshot: `vtscreen.py` models a character grid with no SGR state. So this rig
records, for each of 24 consecutive 90ms frames -- one whole breath -- three
things lifted out of the RAW BYTES the child wrote:

  * the RAMP INDEX: which level of `_ . , - = + * #` / `|_ .. ,, -- == ++ ** ##`
    (0-7, trough to crest) the mark was painted as;
  * the SGR the mark was painted with, so the colour ramp can be checked to
    move in step with the height and never to jump;
  * the SHIMMER WINDOW: where the brighter run inside the phrase started and
    ended, in cells, which is the sweep the founder asked for.

Read the output against the founder's words directly: the ramp index should
rise and fall smoothly by at most one level a frame with a pause at each end
(that is the breath), the mark's SGR should move with it from the faint slot up
to the accent and back (colour and height together), and the shimmer window
should walk left to right across the phrase and then be absent for a few frames
(the 0.4s rest between passes).

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

    python3 scripts/tui-capture/capture-pulse.py OUTDIR
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

# The ramp, by codepoint, trough to crest. This file stays seven-bit like the
# rest of the rig, so the levels are named rather than typed.
RAMP = [chr(c) for c in range(0x2581, 0x2589)]
RAMP_INDEX = {cell: i for i, cell in enumerate(RAMP)}
MIDDOT = "·"

# One SGR run: an optional colour, then the text it paints. `text`/body emits no
# escape at all in this theme (the terminal's own foreground), which is exactly
# the tint the shimmer window is painted in -- so a regex that demanded an
# escape would silently drop the whole shimmer.
SGR = re.compile(r"\x1b\[[0-9;]*m")
# Any other escape -- a cursor move, an erase -- which breaks a drawn run.
ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[\x20-\x2f]+[\x30-\x7e]")

# The 90ms frame clock, from working.ts. Twenty-four of them is one breath.
FRAME_MS = 90
FRAMES = 24

# Long enough that a whole breath of frames lands inside one turn before any
# prose arrives to change the phrase under the camera.
SILENCE_S = 6.0
CHUNKS = [
    "The band is composed in viewport.ts. ",
    "The composer takes its rows from the panel. ",
    "That is the whole of the layout decision.",
]
CHUNK_DELAY = 1.4


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
                # A deliberate silence first: the turn opens on `working`, and
                # that is the frame the whole breath has to be measured in --
                # one state, held, while only the motion moves.
                time.sleep(SILENCE_S)
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
            # refuses to run what it cannot meter.
            "[cost]\nmaxSessionUsd = 0\n" % port
        )
    with open(os.path.join(rig.PROFILE, "telemetry.json"), "w") as fh:
        fh.write(
            '{"v":1,"installId":null,"decision":"denied",'
            '"decidedAt":"2026-09-10T00:00:00.000Z","lastHeartbeat":null}\n'
        )


def runs_after(delta, start):
    """The (sgr, text) runs from `start` to the end of that painted row.

    Stops at the first control byte that is not an SGR -- a cursor move, a
    carriage return, a newline -- because that is where the renderer stopped
    drawing this row and started drawing something else.
    """
    out = []
    sgr = ""
    buf = []
    i = start
    n = len(delta)
    while i < n:
        ch = delta[i]
        if ch == "\x1b":
            m = SGR.match(delta, i)
            if not m:
                break
            if buf:
                out.append((sgr, "".join(buf)))
                buf = []
            seq = m.group(0)
            sgr = "" if seq in ("\x1b[0m", "\x1b[m") else seq
            i = m.end()
            continue
        if ch in ("\r", "\n"):
            break
        buf.append(ch)
        i += 1
    if buf:
        out.append((sgr, "".join(buf)))
    return out


def tokenize(delta):
    """The window's bytes as (plain text, the SGR active at each character).

    Working on a flattened copy is the only way to reason about ADJACENCY: the
    renderer diffs cell by cell, so a colour change lands between two
    characters that are neighbours on screen, and a scan over the raw bytes
    cannot tell "the cell after the mark" from "the escape after the mark".
    """
    plain = []
    sgrs = []
    sgr = ""
    i = 0
    n = len(delta)
    while i < n:
        ch = delta[i]
        if ch == "\x1b":
            m = SGR.match(delta, i)
            if m:
                seq = m.group(0)
                sgr = "" if seq in ("\x1b[0m", "\x1b[m") else seq
                i = m.end()
                continue
            # A cursor move or any other escape: the renderer stopped drawing
            # here, so the run breaks and the colour state goes with it.
            m = ESCAPE.match(delta, i)
            if m:
                plain.append("\x00")
                sgrs.append("")
                i = m.end()
                continue
        plain.append(ch)
        sgrs.append(sgr)
        i += 1
    return "".join(plain), sgrs


def read_frame(delta):
    """EVERY painted indicator in this window, in the order the child drew it.

    Every one, not just the last, because the capture loop's 90ms sleep drifts
    against the child's own 90ms interval: a window that overshoots carries two
    painted frames and one that undershoots carries none. Reading only the last
    would then report a two-level step the product never drew.

    Two shapes count as a painted indicator, and the difference is the
    renderer's, not the design's: a WHOLE row (`mark SPACE phrase ...`), and a
    MARK ALONE, which is what the cell diff emits when only the bar moved and
    the shimmer window happened to land on the same cells. The context meter is
    the one other thing on screen made of these cells, and it is excluded by
    adjacency -- its cells always touch another ramp cell or a bracket, and the
    indicator's mark always has a space on both sides.
    """
    plain, sgrs = tokenize(delta)
    out = []
    n = len(plain)
    for k, ch in enumerate(plain):
        if ch not in RAMP_INDEX:
            continue
        before = plain[k - 1] if k > 0 else " "
        after = plain[k + 1] if k + 1 < n else "\x00"
        if before in RAMP_INDEX or before == "[":
            continue
        if after in RAMP_INDEX or after == "]":
            continue
        index, sgr = RAMP_INDEX[ch], sgrs[k]
        if after != " ":
            # Mark alone: a cell-level repaint that moved only the bar.
            out.append({"index": index, "sgr": sgr, "phrase": None, "window": None})
            continue
        got = read_one(index, sgr, plain, sgrs, k + 2)
        out.append(got if got else {"index": index, "sgr": sgr, "phrase": None, "window": None})
    return out


def read_one(index, sgr, plain, sgrs, start):
    """The phrase and the shimmer window, from the flattened row."""
    # The row ends at the first thing that is not a character the renderer drew
    # in sequence; the phrase ends before the middot that opens the receipt, or
    # at the two-space gutter where the clock has not started yet.
    stop = start
    while stop < len(plain) and plain[stop] not in ("\x00", "\r", "\n"):
        stop += 1
    row = plain[start:stop]
    cut = len(row)
    for token in (MIDDOT, "  "):
        at = row.find(token)
        if at != -1:
            cut = min(cut, at)
    phrase = row[:cut].rstrip()
    if not phrase[:1].isalpha():
        return None
    # The shimmer: the phrase is painted `quiet` (which emits an SGR) with the
    # window in `text`, which in this theme is the terminal's OWN foreground and
    # emits no escape at all. So the bright cells are precisely the cells with
    # no colour on them.
    window = None
    for i in range(len(phrase)):
        if sgrs[start + i] == "" and phrase[i] != " ":
            j = i
            while j < len(phrase) and sgrs[start + j] == "":
                j += 1
            window = (i, j)
            break
    return {"index": index, "sgr": sgr, "phrase": phrase, "window": window}


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
            s.send("explain how the frame is composed", settle=0.5)
            s.send(CR, settle=0.5)
            # Let the rung settle onto one state, so the only thing moving
            # across the 24 frames is the motion itself.
            s.pump(1.2)
            for i in range(FRAMES):
                seen = len(s.raw)
                s.pump(FRAME_MS / 1000.0)
                frames.append(
                    {"frame": i, "at_ms": i * FRAME_MS, "read": read_frame(s.raw[seen:])}
                )
            s.snapshot(outdir, "pulse-last-frame-120x40")
        finally:
            s.close()

        # The seven-bit rung, at the founder's 80x24: the ramp folds to its
        # ASCII twins and the shimmer is off, so the height carries the whole
        # of the motion.
        s = rig.Session(rows=24, cols=80, RUNE_ASCII="1", NO_COLOR="1")
        try:
            s.wait_for(["rune"], timeout=90)
            s.pump(1.0)
            s.send("explain how the frame is composed", settle=0.5)
            s.send(CR, settle=2.0)
            s.snapshot(outdir, "pulse-ascii-80x24")
        finally:
            s.close()
    finally:
        mock.stop()

    path = Path(outdir) / "pulse-24-frames.txt"
    lines = [
        "# rune's pulse: 24 consecutive frames, 90ms apart -- one whole breath",
        "# terminal: 40 rows x 120 cols (real pty, alt screen), TERM=xterm-256color",
        "# provider: loopback mock ollama on 127.0.0.1 -- no live model call",
        "# ramp: 0=U+2581 (trough) .. 7=U+2588 (crest); sgr is the colour the",
        "#       mark was painted with; window is the shimmer's [start,end) in",
        "#       cells within the phrase, or '-' during the 0.4s rest.",
        "# " + "-" * 68,
        "# window  +ms   ramp  bar       mark sgr               shimmer   phrase",
        "#              (every level painted in the window; bar/sgr/shimmer are its last)",
    ]
    # The child's own frame sequence, flattened across the capture windows.
    painted = [g for f in frames for g in f["read"]]
    jumps = sum(
        1 for a, b in zip(painted, painted[1:]) if abs(b["index"] - a["index"]) > 1
    )
    for f in frames:
        got = f["read"]
        if not got:
            lines.append(
                "  %-6d %-5d (no repaint: the row was byte-identical to the last one)"
                % (f["frame"], f["at_ms"])
            )
            continue
        last = got[-1]
        win = "-" if not last["window"] else "%d..%d" % last["window"]
        sgr = (last["sgr"] or "(default fg)").replace("\x1b", "ESC")
        lines.append(
            "  %-6d %-5d %-5s %-9s %-22s %-9s %s"
            % (
                f["frame"],
                f["at_ms"],
                ",".join(str(g["index"]) for g in got),
                "#" * (last["index"] + 1),
                sgr,
                win,
                last["phrase"] if last["phrase"] is not None else "(mark-only repaint)",
            )
        )
    read = [g["index"] for g in painted]
    colours = [g["sgr"] for g in painted]
    windows = [g["window"] for g in painted]
    lines += [
        "",
        "# --- what the frames say ---",
        "painted frames read      %d across %d capture windows" % (len(painted), FRAMES),
        "windows with no repaint  %d   (the rung deduped: identical bytes)"
        % len([f for f in frames if not f["read"]]),
        "ramp levels touched      %s" % sorted(set(read)),
        "ramp steps > 1 level     %d   (any at all is a strobe)" % jumps,
        "distinct mark colours    %d" % len(set(colours)),
        "colours, trough to crest %s"
        % " -> ".join(
            dict.fromkeys(
                (g["sgr"] or "(default fg)").replace("\x1b", "ESC")
                for g in sorted(painted, key=lambda g: g["index"])
            )
        ),
        "frames with the window   %d" % len([w for w in windows if w]),
        "frames resting (no win)  %d   (the 0.4s pause between passes)"
        % len([w for w in windows if not w]),
        "window path (starts)     %s" % [w[0] for w in windows if w],
        "phrases seen             %s" % sorted({g["phrase"] for g in painted if g["phrase"]}),
        "mark-only repaints       %d   (cell diff: only the bar moved)"
        % len([g for g in painted if g["phrase"] is None]),
    ]
    Path(path).write_text("\n".join(lines) + "\n")
    print("  frames -> %s" % path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "out-pulse"))
