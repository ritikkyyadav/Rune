"""`/keys` in the single column, on a real pty, with the arrow keys pressed.

The v7 pass measured this at 120x40: `/keys` opened with
`... 3 more lines above (ctrl+r to expand)` and NO selection marker anywhere on
the screen, and none after the first four presses of down — the footer window
kept the TAIL of the block, and a picker puts the row you are standing on at the
head. The frames here are the record of that, before and after.

Everything about the rig — the scratch RUNE_HOME, the credential scrub by shape,
the local-only ollama profile, `--new --no-browser --pristine` — is capture.py's
and is imported rather than copied.

Zero model calls: nothing is ever submitted to the composer.

    python3 scripts/tui-capture/capture-keys-picker.py OUTDIR
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture as rig  # noqa: E402

ESC = rig.ESC
CR = rig.CR
DOWN = b"\x1b[B"


def marker_rows(path):
    """The screen rows carrying a selection marker, 1-based, for the summary."""
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle.read().split("\n"):
            if "|" not in line or line.startswith("#"):
                continue
            number, _, body = line.partition("|")
            if "›" in body:
                rows.append(int(number.strip()))
    return rows


def frames(outdir, tag, rows, cols, **env):
    s = rig.start(rows, cols, **env)
    try:
        s.send("/keys", settle=0.4)
        s.send(CR, settle=1.8)
        s.snapshot(outdir, "%s-keys-open" % tag)
        for press in range(1, 6):
            s.send(DOWN, settle=0.35)
            s.snapshot(outdir, "%s-keys-down-%d" % (tag, press))
        s.send(ESC, settle=0.8)
    finally:
        s.close()


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    rig.fresh_profile()
    frames(outdir, "120x40", 40, 120)
    # The control the v7 pass used: the same window told to draw the split,
    # where the picker has always tracked every keypress.
    frames(outdir, "120x40-split", 40, 120, RUNE_LAYOUT="split")
    for name in sorted(os.listdir(outdir)):
        if name.endswith(".txt") and "keys" in name:
            print("%-32s selection marker on rows %s" % (name, marker_rows(os.path.join(outdir, name))))
    print("captured -> %s" % outdir)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "out-keys"))
