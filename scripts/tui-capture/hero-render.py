"""Rasterise a captured frame's HTML into a retina PNG.

`capture-readme-hero.py` writes each frame twice: as text (the layout, checkable
byte for byte) and as HTML (the same cells, carrying the colours the renderer
painted them in). This turns the HTML into the picture the README shows, at
device scale 2 so it stays crisp on a retina display, cropped to the terminal
window so there is no stray page margin around it.

    python3 scripts/tui-capture/hero-render.py FRAME.html OUT.png [--scale 2]

Headless Chromium through Playwright, which is the only rasteriser on this
machine that lays out a monospace grid the way a terminal does. It opens a
`file://` URL and nothing else -- no network, no model.
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def render(src, out, scale=2):
    src = Path(src).resolve()
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        page = browser.new_page(
            device_scale_factor=scale,
            viewport={"width": 2200, "height": 1400},
        )
        page.goto(src.as_uri())
        page.wait_for_timeout(350)
        window = page.locator(".window")
        window.screenshot(path=str(out), omit_background=True, scale="device")
        box = window.bounding_box()
        browser.close()
    print("  png -> %s  (%d x %d css px, %dx)" % (out, box["width"], box["height"], scale))
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    scale = 2
    for a in sys.argv[1:]:
        if a.startswith("--scale"):
            scale = int(a.split("=", 1)[1]) if "=" in a else 2
    render(args[0], args[1], scale)
