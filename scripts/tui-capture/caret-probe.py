"""Read the terminal's OWN cursor position with the `/` palette open.

A terminal emulator's cursor state is the only honest answer to "where is the
caret", which is why this exists as a rig script rather than a unit test: the
arithmetic it measures is pinned in tests/unit/orchestrator/ui-frame.test.ts
("the caret is on the row that holds the field"), and this is how that
arithmetic was caught disagreeing with the screen (V-4 Lane A, A12: the caret
sat on the rule below the field at 80x24).

Zero model calls, by construction -- capture.py's driver, a scratch RUNE_HOME,
and `/` is never followed by Enter. 80x24 only, the size the defect reproduced
at. Prints one JSON object; `caret_row` should equal `field_row`.

    python3 scripts/tui-capture/caret-probe.py
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture as C  # noqa: E402

C.fresh_profile()
s = C.start(24, 80)
try:
    s.send("/", settle=1.0)
    ls = s.screen.lines()
    field_row = next((i + 1 for i, l in enumerate(ls) if l.strip() == "› /"), None)
    caret_row = s.screen.y + 1
    caret_col = s.screen.x + 1
    print(json.dumps({
        "caret_row": caret_row,
        "caret_col": caret_col,
        "field_row": field_row,
        "row_under_caret": ls[caret_row - 1] if 0 <= caret_row - 1 < len(ls) else None,
        "row_at_field": ls[field_row - 1] if field_row else None,
    }))
finally:
    s.close()
