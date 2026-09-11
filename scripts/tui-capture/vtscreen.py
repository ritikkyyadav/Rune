"""A small VT100/xterm screen model, written here because `pyte` is not
installed on this machine and installing from the network was forbidden for
this phase. It is deliberately narrow: enough of the escape grammar to model
what a fixed-frame TUI paints on an alternate screen, and nothing else.

Supported: CUP/HVP, CUU/CUD/CUF/CUB, CHA, VPA, ED, EL, ECH, ICH, DCH, IL, DL,
SU, SD, DECSTBM, DECSET/DECRST (incl. 1049 alt screen and autowrap), SGR
(parsed and discarded), OSC (discarded), ESC 7/8, RI, and the C0 controls the
renderer actually emits. East-Asian wide characters occupy two cells.
"""

import re
import unicodedata


def cell_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Screen:
    def __init__(self, rows: int, cols: int):
        self.rows = rows
        self.cols = cols
        self.main = self._blank()
        self.alt = self._blank()
        self.buf = self.main
        self.in_alt = False
        self.x = 0
        self.y = 0
        self.saved = (0, 0)
        self.top = 0
        self.bot = rows - 1
        self.autowrap = True
        self.pending_wrap = False

    def _blank(self):
        return [[" "] * self.cols for _ in range(self.rows)]

    # -- geometry --
    def resize(self, rows: int, cols: int) -> None:
        """Match a real terminal: keep the top-left, pad or clip the rest."""
        for name in ("main", "alt"):
            old = getattr(self, name)
            new = [[" "] * cols for _ in range(rows)]
            for r in range(min(rows, self.rows)):
                for c in range(min(cols, self.cols)):
                    new[r][c] = old[r][c]
            setattr(self, name, new)
        self.buf = self.alt if self.in_alt else self.main
        self.rows, self.cols = rows, cols
        self.top, self.bot = 0, rows - 1
        self.x = min(self.x, cols - 1)
        self.y = min(self.y, rows - 1)

    # -- primitives --
    def put(self, ch: str) -> None:
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
        self.buf[self.y][self.x] = ch
        for i in range(1, w):
            if self.x + i < self.cols:
                self.buf[self.y][self.x + i] = ""
        self.x += w
        if self.x >= self.cols:
            self.x = self.cols - 1
            self.pending_wrap = True

    def linefeed(self) -> None:
        if self.y == self.bot:
            self.scroll_up(1)
        elif self.y < self.rows - 1:
            self.y += 1

    def scroll_up(self, n: int) -> None:
        for _ in range(n):
            del self.buf[self.top]
            self.buf.insert(self.bot, [" "] * self.cols)

    def scroll_down(self, n: int) -> None:
        for _ in range(n):
            del self.buf[self.bot]
            self.buf.insert(self.top, [" "] * self.cols)

    def erase(self, y, x0, x1) -> None:
        for c in range(max(0, x0), min(self.cols, x1)):
            self.buf[y][c] = " "

    # -- output --
    def lines(self):
        out = []
        for row in self.buf:
            out.append("".join(c if c != "" else "" for c in row).rstrip())
        return out

    def text(self) -> str:
        return "\n".join(self.lines())


CSI_RE = re.compile(r"\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])")


class Stream:
    """Feed bytes in, drive a Screen. Keeps a partial-escape tail between
    calls, because a pty read can split a sequence anywhere."""

    def __init__(self, screen: Screen):
        self.s = screen
        self.tail = ""

    def feed(self, data: str) -> None:
        data = self.tail + data
        self.tail = ""
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self.tail = data[i:]
                    return
                nxt = data[i + 1]
                if nxt == "[":
                    m = CSI_RE.match(data, i)
                    if not m:
                        # Either incomplete, or a sequence we cannot parse.
                        if len(data) - i < 64:
                            self.tail = data[i:]
                            return
                        i += 2
                        continue
                    self.csi(m.group(1), m.group(3))
                    i = m.end()
                    continue
                if nxt == "]":
                    end = data.find("\x07", i)
                    st = data.find("\x1b\\", i)
                    if end == -1 and st == -1:
                        self.tail = data[i:]
                        return
                    cands = [p for p in (end, st) if p != -1]
                    stop = min(cands)
                    i = stop + (1 if stop == end else 2)
                    continue
                if nxt in "()#%":
                    if i + 2 >= n:
                        self.tail = data[i:]
                        return
                    i += 3
                    continue
                if nxt == "7":
                    self.s.saved = (self.s.x, self.s.y)
                    i += 2
                    continue
                if nxt == "8":
                    self.s.x, self.s.y = self.s.saved
                    i += 2
                    continue
                if nxt == "M":
                    if self.s.y == self.s.top:
                        self.s.scroll_down(1)
                    else:
                        self.s.y = max(0, self.s.y - 1)
                    i += 2
                    continue
                if nxt in "DE":
                    self.s.linefeed()
                    if nxt == "E":
                        self.s.x = 0
                    i += 2
                    continue
                i += 2
                continue
            if ch == "\r":
                self.s.x = 0
                self.s.pending_wrap = False
            elif ch == "\n":
                self.s.linefeed()
                self.s.pending_wrap = False
            elif ch == "\b":
                self.s.x = max(0, self.s.x - 1)
                self.s.pending_wrap = False
            elif ch == "\t":
                self.s.x = min(self.s.cols - 1, ((self.s.x // 8) + 1) * 8)
            elif ch in ("\x07", "\x00", "\x0e", "\x0f"):
                pass
            else:
                self.s.put(ch)
            i += 1

    def csi(self, params: str, final: str) -> None:
        s = self.s
        private = params.startswith("?")
        body = params[1:] if private else params
        raw = [p for p in body.split(";")]
        nums = []
        for p in raw:
            try:
                nums.append(int(p))
            except ValueError:
                nums.append(0)
        def arg(i, d=1):
            return nums[i] if i < len(nums) and nums[i] != 0 else d
        if private:
            if final in "hl":
                on = final == "h"
                for v in nums:
                    if v in (1047, 1049, 47):
                        if on and not s.in_alt:
                            s.alt = s._blank()
                            s.buf = s.alt
                            s.in_alt = True
                            s.x = s.y = 0
                        elif not on and s.in_alt:
                            s.buf = s.main
                            s.in_alt = False
                    elif v == 7:
                        s.autowrap = on
            return
        if final == "H" or final == "f":
            s.y = min(s.rows - 1, max(0, arg(0) - 1))
            s.x = min(s.cols - 1, max(0, arg(1) - 1))
            s.pending_wrap = False
        elif final == "A":
            s.y = max(0, s.y - arg(0))
        elif final == "B":
            s.y = min(s.rows - 1, s.y + arg(0))
        elif final == "C":
            s.x = min(s.cols - 1, s.x + arg(0))
            s.pending_wrap = False
        elif final == "D":
            s.x = max(0, s.x - arg(0))
            s.pending_wrap = False
        elif final == "G":
            s.x = min(s.cols - 1, max(0, arg(0) - 1))
            s.pending_wrap = False
        elif final == "d":
            s.y = min(s.rows - 1, max(0, arg(0) - 1))
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                s.erase(s.y, s.x, s.cols)
                for r in range(s.y + 1, s.rows):
                    s.erase(r, 0, s.cols)
            elif mode == 1:
                s.erase(s.y, 0, s.x + 1)
                for r in range(0, s.y):
                    s.erase(r, 0, s.cols)
            else:
                for r in range(s.rows):
                    s.erase(r, 0, s.cols)
        elif final == "K":
            mode = nums[0] if nums else 0
            if mode == 0:
                s.erase(s.y, s.x, s.cols)
            elif mode == 1:
                s.erase(s.y, 0, s.x + 1)
            else:
                s.erase(s.y, 0, s.cols)
        elif final == "X":
            s.erase(s.y, s.x, s.x + arg(0))
        elif final == "P":
            n = arg(0)
            row = s.buf[s.y]
            del row[s.x:s.x + n]
            row.extend([" "] * n)
        elif final == "@":
            n = arg(0)
            row = s.buf[s.y]
            for _ in range(n):
                row.insert(s.x, " ")
            del row[s.cols:]
        elif final == "L":
            n = arg(0)
            for _ in range(n):
                s.buf.insert(s.y, [" "] * s.cols)
                del s.buf[s.bot + 1]
        elif final == "M":
            n = arg(0)
            for _ in range(n):
                del s.buf[s.y]
                s.buf.insert(s.bot, [" "] * s.cols)
        elif final == "S":
            s.scroll_up(arg(0))
        elif final == "T":
            s.scroll_down(arg(0))
        elif final == "r":
            s.top = max(0, arg(0) - 1)
            s.bot = min(s.rows - 1, arg(1, s.rows) - 1)
            s.x = s.y = 0
        elif final == "s":
            s.saved = (s.x, s.y)
        elif final == "u":
            s.x, s.y = s.saved
        # SGR (m), DSR (n), and the rest carry no geometry: discarded.
