"""Lane C's frames: the composer that wraps, grows, and then scrolls.

Reuses the Phase 4 pty rig (`capture.py`) unchanged -- same emulator, same
scratch profile, same zero-model-call construction. The only bytes this driver
sends are printable text, one bracketed paste, `ctrl+b` and `ctrl+u`. **Nothing
is ever submitted**: no `\\r` is written in any composer frame, so no turn
starts and no provider is opened.

  * `120x40-composer-long`   the founder's draft from §2.5, wrapped in the
                             40-cell right column, with a collapsed paste on a
                             row of its own. Compared against
                             `docs/program/phase-4-mocks/120x40-composer-long.txt`.
  * `80x24-composer-long`    the same draft with the right column collapsed, so
                             the field is the width of the window.
  * `120x40-composer-capped` a draft past the 21-row cap: the field scrolls
                             inside itself and states the elision.
  * `120x40-composer-ctrl-b` explicit newlines, kept as structure.
  * `80x24-composer-ascii`   NO_COLOR + RUNE_ASCII, at the collapsed width.

    python3 scripts/tui-capture/capture-lane-c.py OUTDIR
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

os.environ.setdefault(
    "CAPTURE_ROOT",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "rune-lane-c-capture"),
)

import capture as rig  # noqa: E402

CTRL_B = b"\x02"
CTRL_U = b"\x15"
PASTE_START = b"\x1b[200~"
PASTE_END = b"\x1b[201~"

# The draft in §2.5 of the design, and the mock frame drawn from it.
DRAFT_HEAD = (
    "Rework the first-run wizard so the provider step remembers what the last "
    "session used, and make the spend cap accept a monthly figure as well as a "
    "per-session one. "
)
DRAFT_TAIL = (
    "The acceptance is the 80x24 capture matching the mock exactly, including "
    "the collapsed right column and the one-line agent strip."
)
# 38 lines, which is what the mock's chip counts.
PASTE_BODY = "\n".join("pasted line %02d" % (i + 1) for i in range(38))


def type_draft(s):
    """The draft, with a real bracketed paste in the middle of it."""
    s.send(DRAFT_HEAD, settle=1.2)
    s.send(PASTE_START + PASTE_BODY.encode() + PASTE_END, settle=1.0)
    s.send(" " + DRAFT_TAIL, settle=1.2)


def composer_frames(outdir):
    for rows, cols, name in ((40, 120, "120x40"), (24, 80, "80x24")):
        s = rig.start(rows, cols)
        try:
            s.wait_for(["describe a change"])
            type_draft(s)
            s.snapshot(outdir, "%s-composer-long" % name)
        finally:
            s.close()

    # Past the cap: the field takes its rows from the panel, stops at 21, and
    # then scrolls inside itself with the elision stated.
    s = rig.start(40, 120)
    try:
        s.wait_for(["describe a change"])
        for i in range(26):
            s.send("row %02d of a draft that is longer than the field " % (i + 1), settle=0.12)
        s.pump(1.0)
        s.snapshot(outdir, "120x40-composer-capped")
    finally:
        s.close()

    # ctrl+b: a real newline, kept as structure rather than rendered.
    s = rig.start(40, 120)
    try:
        s.wait_for(["describe a change"])
        s.send("first line", settle=0.5)
        s.send(CTRL_B, settle=0.4)
        s.send("second line", settle=0.5)
        s.send(CTRL_B, settle=0.4)
        s.send("third", settle=0.8)
        s.snapshot(outdir, "120x40-composer-ctrl-b")
        # …and ctrl+u clears it, so the frame returns to where it started.
        s.send(CTRL_U, settle=0.8)
        s.snapshot(outdir, "120x40-composer-cleared")
    finally:
        s.close()

    # The seven-bit rung, at the collapsed width.
    s = rig.start(24, 80, NO_COLOR="1", RUNE_ASCII="1", LANG="C", LC_ALL="C")
    try:
        s.wait_for(["describe a change"])
        type_draft(s)
        s.snapshot(outdir, "80x24-composer-ascii")
    finally:
        s.close()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(rig.REPO / "captures")
    os.makedirs(out, exist_ok=True)
    rig.fresh_profile()
    composer_frames(out)
    print("done ->", out)
