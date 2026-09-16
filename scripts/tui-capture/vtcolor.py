"""A colour-carrying screen model, layered over `vtscreen`.

`vtscreen.Screen` models geometry and throws SGR away, which is right for
checking a layout and useless for making a PICTURE of one: the README hero has
to show the frame the way a terminal paints it, in the product's own palette.

This module keeps the geometry model exactly as it is -- one emulator, one set
of bugs -- and adds two things beside it:

  * `ColorScreen`, whose cells are `(char, attr)` pairs instead of bare
    characters, where `attr` is the SGR state that was in force when the cell
    was painted;
  * `ColorStream`, which is `vtscreen.Stream` with `SGR (m)` no longer
    discarded.

Blank cells written by the base model's own erase/scroll/insert paths stay
plain strings, which read back as "default attributes" -- so nothing in the
geometry model has to know that colour exists.

`html()` renders a captured screen as a `<pre>` of coloured spans, which is
what `hero-render.py` rasterises.
"""

import html as _html

from vtscreen import CSI_RE, Screen, Stream, cell_width  # noqa: F401

# attr = (fg, bg, bold, dim, italic, underline, reverse)
# fg/bg: None (terminal default) or an (r, g, b) triple.
DEFAULT_ATTR = (None, None, False, False, False, False, False)


def _xterm256(n):
    """The standard 256-colour palette as RGB."""
    if n < 16:
        base = [
            (0, 0, 0), (170, 0, 0), (0, 170, 0), (170, 85, 0),
            (0, 0, 170), (170, 0, 170), (0, 170, 170), (170, 170, 170),
            (85, 85, 85), (255, 85, 85), (85, 255, 85), (255, 255, 85),
            (85, 85, 255), (255, 85, 255), (85, 255, 255), (255, 255, 255),
        ]
        return base[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


def parse_sgr(params, attr):
    """Apply one SGR parameter string to `attr`, returning the new attr."""
    fg, bg, bold, dim, italic, underline, reverse = attr
    raw = params.split(";") if params else [""]
    nums = []
    for p in raw:
        nums.append(int(p) if p.isdigit() else 0)
    i = 0
    while i < len(nums):
        v = nums[i]
        if v == 0:
            fg = bg = None
            bold = dim = italic = underline = reverse = False
        elif v == 1:
            bold = True
        elif v == 2:
            dim = True
        elif v == 3:
            italic = True
        elif v == 4:
            underline = True
        elif v == 7:
            reverse = True
        elif v == 22:
            bold = dim = False
        elif v == 23:
            italic = False
        elif v == 24:
            underline = False
        elif v == 27:
            reverse = False
        elif 30 <= v <= 37:
            fg = _xterm256(v - 30)
        elif 90 <= v <= 97:
            fg = _xterm256(v - 90 + 8)
        elif 40 <= v <= 47:
            bg = _xterm256(v - 40)
        elif 100 <= v <= 107:
            bg = _xterm256(v - 100 + 8)
        elif v == 39:
            fg = None
        elif v == 49:
            bg = None
        elif v in (38, 48):
            mode = nums[i + 1] if i + 1 < len(nums) else 0
            if mode == 5:
                colour = _xterm256(nums[i + 2] if i + 2 < len(nums) else 0)
                i += 2
            elif mode == 2:
                colour = tuple((nums[i + 2 + k] if i + 2 + k < len(nums) else 0) for k in range(3))
                i += 4
            else:
                colour = None
            if v == 38:
                fg = colour
            else:
                bg = colour
        i += 1
    return (fg, bg, bold, dim, italic, underline, reverse)


class ColorScreen(Screen):
    """`vtscreen.Screen` whose painted cells remember their SGR state."""

    def __init__(self, rows, cols):
        super().__init__(rows, cols)
        self.attr = DEFAULT_ATTR

    def put(self, ch):
        """The base `put`, storing `(char, attr)` instead of a bare char.

        Duplicated rather than wrapped because the wrap position is computed
        from the character's width before the write, and there is no seam in
        the base method to hook between the two.
        """
        w = cell_width(ch)
        if w == 0:
            return
        if self.pending_wrap and self.autowrap:
            self.x = 0
            self.linefeed()
            self.pending_wrap = False
        if self.x + w > self.cols:
            if not self.autowrap:
                return
            self.x = 0
            self.linefeed()
        self.buf[self.y][self.x] = (ch, self.attr)
        for i in range(1, w):
            if self.x + i < self.cols:
                self.buf[self.y][self.x + i] = ("", self.attr)
        self.x += w
        if self.x >= self.cols:
            self.x = self.cols - 1
            self.pending_wrap = True

    # -- output --
    @staticmethod
    def _cell(c):
        """Normalise: the geometry model writes bare `" "` for blanks."""
        return c if isinstance(c, tuple) else (c, DEFAULT_ATTR)

    def cells(self):
        return [[self._cell(c) for c in row] for row in self.buf]

    def lines(self):
        return ["".join(self._cell(c)[0] for c in row).rstrip() for row in self.buf]


class ColorStream(Stream):
    """`vtscreen.Stream` with SGR applied to the screen instead of dropped."""

    def csi(self, params, final):
        if final == "m" and not params.startswith("?"):
            self.s.attr = parse_sgr(params, self.s.attr)
            return
        super().csi(params, final)


def _css(rgb):
    return "#%02x%02x%02x" % rgb


def html(screen, ground, foreground, title="rune", font_px=15, line_height=1.32, scale=2):
    """One captured screen as a macOS-style terminal window, as HTML.

    The chrome (rounded corners, the three dots, the title) is drawn in CSS
    around a `<pre>` of the real cells, so nothing about the frame itself is
    redrawn by hand.
    """
    rows = screen.cells()
    out = []
    for row in rows:
        parts = []
        run_attr = None
        run = []

        def flush():
            if not run:
                return
            text = _html.escape("".join(run))
            if run_attr == DEFAULT_ATTR:
                parts.append(text)
                return
            fg, bg, bold, dim, italic, underline, reverse = run_attr
            fgc = fg if fg is not None else foreground
            bgc = bg if bg is not None else ground
            if reverse:
                fgc, bgc = bgc, fgc
            style = ["color:%s" % _css(fgc)]
            if reverse or bg is not None:
                style.append("background:%s" % _css(bgc))
            if bold:
                style.append("font-weight:600")
            if dim:
                style.append("opacity:.62")
            if italic:
                style.append("font-style:italic")
            if underline:
                style.append("text-decoration:underline")
            parts.append('<span style="%s">%s</span>' % (";".join(style), text))

        for ch, attr in row:
            if ch == "":
                continue
            if attr != run_attr:
                flush()
                run = []
                run_attr = attr
            run.append(ch)
        flush()
        out.append("".join(parts))

    body = "\n".join(out)
    return TEMPLATE % {
        "title": _html.escape(title),
        "ground": _css(ground),
        "fg": _css(foreground),
        "font_px": font_px,
        "line_height": line_height,
        "body": body,
        "cols": screen.cols,
        "scale": scale,
    }


TEMPLATE = """<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { padding: 34px 34px 40px; width: max-content; }
  .window {
    background: %(ground)s;
    border-radius: 11px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.10);
    box-shadow: 0 24px 60px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4);
  }
  .bar {
    height: 30px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    background: linear-gradient(#2c2f38, #23262e);
    border-bottom: 1px solid rgba(0,0,0,.55);
  }
  .dots { display: flex; gap: 8px; }
  .dot { width: 11px; height: 11px; border-radius: 50%%; }
  .r { background: #ff5f57; } .y { background: #febc2e; } .g { background: #28c840; }
  .name {
    flex: 1; text-align: center; margin-left: -46px;
    font: 12px/1 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
    color: #b9bdc7; letter-spacing: .01em;
  }
  pre {
    margin: 0;
    padding: 14px 16px 16px;
    font-family: Menlo, "SF Mono", Monaco, "DejaVu Sans Mono", monospace;
    font-size: %(font_px)spx;
    line-height: %(line_height)s;
    color: %(fg)s;
    white-space: pre;
    font-variant-ligatures: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  span { white-space: pre; }
</style>
<div class="window">
  <div class="bar">
    <div class="dots"><i class="dot r"></i><i class="dot y"></i><i class="dot g"></i></div>
    <div class="name">%(title)s</div>
  </div>
  <pre>%(body)s</pre>
</div>
"""
