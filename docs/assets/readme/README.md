# README terminal captures

These frames show Rune **v1.4.7**, captured from the release source at `f2e40a7` on
2026-10-16. They use a white terminal, `rune-light`, and the `matte` finish at 120×32
and 80×22. Both sizes are independent runs against fresh copies of the same fixture.

The CLI, file changes, native tools, diffs, shell commands, and checks are real. The model is a
scripted Ollama-compatible server on loopback. Credentials are removed from the child process;
the capture does not call a hosted model. The fixture's version is `0.3.2`; the Rune version
is shown separately in the header.

| Asset                                   | Purpose                                      |
| --------------------------------------- | -------------------------------------------- |
| [120×32 image](rune-session-120x32.jpg) | Desktop README hero                          |
| [80×22 image](rune-session-80x22.jpg)   | Compact README hero                          |
| [120×32 text](rune-session-120x32.txt)  | Terminal cells as text                       |
| [80×22 text](rune-session-80x22.txt)    | Compact terminal cells as text               |
| [Capture manifest](capture.json)        | Source, appearance, checks, and asset hashes |

## Reproduce

From the repository root, with Bun, Node.js, Python 3, and Rust installed:

```sh
bun install --frozen-lockfile
cargo build --locked -p rune-tools
python3 scripts/tui-capture/capture-readme-hero.py /tmp/rune-readme-captures
```

The [driver](../../../scripts/tui-capture/capture-readme-hero.py) waits for a completed turn,
checks the displayed Rune version, then independently reruns the fixture's tests and version
flag. It fails if either run is incomplete or its colors were lost.

Each HTML file contains the actual captured cells in a white terminal window. The committed
JPEGs were exported from those HTML files in the browser. A standalone rasterizer is also
available with Python Playwright and Chromium installed:

```sh
python3 scripts/tui-capture/hero-render.py \
  /tmp/rune-readme-captures/hero-120x32-settled.html rune-session-120x32.jpg
python3 scripts/tui-capture/hero-render.py \
  /tmp/rune-readme-captures/hero-80x22-settled.html rune-session-80x22.jpg
```

Only the surrounding terminal window is styled for presentation. The transcript is not
rewritten or reconstructed. Timing values will vary on a fresh run.
