"""Rune's mark, cut out of the founder's artwork onto transparency.

The supplied file is a flat blue gear photographed onto near-white paper (a
JPEG, so every edge pixel is a compressed blend of the two). A threshold would
leave a white halo on GitHub's dark theme, so the alpha is SOLVED instead:
every pixel is read as `a * blue + (1 - a) * paper`, which gives the coverage
that produced it, and the colour channel is then set to the blue everywhere.
Nothing of the paper survives into the file, at any opacity.

    python3 scripts/make-rune-mark.py SOURCE.jpeg docs/assets/readme

Writes `rune-mark.png` (1024) and `rune-mark-512.png`, trimmed to the gear with
a small margin and squared, plus the sampled colours on stdout. The source file
is never modified.
"""

import sys
from pathlib import Path

from PIL import Image


def dominant(im, predicate):
    """The mean of every pixel matching `predicate` -- the true flat colour,
    not one sampled pixel, which in a JPEG is never quite the ink."""
    px = [p for count, p in im.getcolors(1 << 22) for _ in range(count) if predicate(p)]
    n = len(px)
    return tuple(round(sum(p[i] for p in px) / n) for i in range(3)), n


def cut(source, outdir):
    im = Image.open(source).convert("RGB")
    w, h = im.size

    ink, ink_n = dominant(im, lambda p: max(p) < 140 or (p[2] > 150 and p[2] - p[0] > 120))
    paper, paper_n = dominant(im, lambda p: min(p) > 235)
    print("  ink   #%02X%02X%02X  (%d px)" % (*ink, ink_n))
    print("  paper #%02X%02X%02X  (%d px)" % (*paper, paper_n))

    # a = <paper - pixel, paper - ink> / |paper - ink|^2
    axis = [paper[i] - ink[i] for i in range(3)]
    norm = sum(c * c for c in axis)
    src = im.load()
    out = Image.new("RGBA", (w, h), (*ink, 0))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            p = src[x, y]
            a = sum((paper[i] - p[i]) * axis[i] for i in range(3)) / norm
            a = 0.0 if a < 0.02 else min(1.0, a)
            if a:
                dst[x, y] = (*ink, round(a * 255))

    box = out.getbbox()
    side = max(box[2] - box[0], box[3] - box[1])
    margin = round(side * 0.04)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    half = side / 2 + margin
    square = out.crop((round(cx - half), round(cy - half), round(cx + half), round(cy + half)))

    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    for size, name in ((1024, "rune-mark.png"), (512, "rune-mark-512.png")):
        square.resize((size, size), Image.LANCZOS).save(outdir / name)
        print("  mark -> %s (%d x %d)" % (outdir / name, size, size))
    return ink


if __name__ == "__main__":
    cut(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "docs/assets/readme")
