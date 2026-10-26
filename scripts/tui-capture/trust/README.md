# TUI trust checks

Replay the seven scenarios from the October 2026 interface audit in real pseudo-terminals:

```sh
python3 scripts/tui-capture/trust/run.py /tmp/rune-trust-evidence
```

Python 3, Bun and a built `rune-tools` are required on macOS or Linux. The default tools binary is
`~/.rune/bin/rune-tools`; `RIG_TOOLS` selects another build. `RIG_WT` selects another source tree.
`RIG_CLI` selects a compiled CLI instead of the source entrypoint, allowing the same scenarios to
verify a published release. Each scenario gets a fresh scratch profile and workspace.

The only model is a scripted HTTP server on loopback. Provider credentials are scrubbed from the
child environment by the shared capture rig, browser access is disabled, and no paid model is
called. The agent scenario exercises Rune's own child-session behavior against that same server.

The checks cover word editing, Option keys during a run, stepping back from agent panes, deliberate
stop confirmation, typing on approval cards, declined actions, terminal outcomes, separate replies,
rendered Markdown and Ctrl+L preserving the transcript. Text and HTML frames accompany the logs.
Any failed assertion, crash or timeout makes the runner fail; a successful process exit alone is
not the proof. Unit tests cover additional event sequences and the paste-to-approval guard.
