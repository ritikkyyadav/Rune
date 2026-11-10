# Will terminal captures

Captured on 9 November 2026 from the `codex/will-rebrand` source branch based on
v1.4.17. The header displays v1.4.17; the source build identifies itself as a
development build in `--version`.

The 120×32 and 80×22 captures use the existing light theme, matte finish, glyph,
layout, and colors. Both show real terminal output and actual file edits and test
runs against a fresh local fixture. The model is a scripted Ollama-compatible
server on loopback: 20 requests across both captures, no hosted model calls.
Each fixture's two tests passed and its version flag printed `0.3.2`.

| Size   | Image                            | Terminal cells                  | Captured HTML                    |
| ------ | -------------------------------- | ------------------------------- | -------------------------------- |
| 120×32 | [Image](will-session-120x32.jpg) | [Text](will-session-120x32.txt) | [HTML](will-session-120x32.html) |
| 80×22  | [Image](will-session-80x22.jpg)  | [Text](will-session-80x22.txt)  | [HTML](will-session-80x22.html)  |

[Capture manifest and hashes](will-capture.json). The original Rune captures and
[their record](README.md) remain available as historical evidence.

Reproduce with `python3 scripts/tui-capture/capture-readme-hero.py /tmp/will-captures`
after building `rune-tools`. The driver retains the real renderer's terminal cells;
the HTML wrapper adds only the surrounding terminal window.
