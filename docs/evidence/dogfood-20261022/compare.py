#!/usr/bin/env python3
"""The dogfood comparison, read from the evidence: baseline/, codex/, rune/
(summary.json, result.json, change.patch) and drive-1.log (quota windows).

    python3 -I compare.py            # markdown table + compare.json

Every figure here is read from a file the run wrote; nothing is estimated
except where a line says so.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ARMS = [a for a in ("codex", "rune") if os.path.exists(os.path.join(ROOT, a, "summary.json"))]


def load(name, arm):
    p = os.path.join(ROOT, arm, name)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f) if name.endswith(".json") else f.read()


base = load("summary.json", "baseline")
if base is None:
    sys.exit("no baseline/summary.json yet")


def windows():
    """(label, five-hour %, weekly %) in log order, labelled by the arm that ran before."""
    out, last = [], "start"
    with open(os.path.join(ROOT, "drive-1.log")) as f:
        for line in f:
            m = re.match(r"=== (\w+) exit=", line)
            if m:
                last = m.group(1)
            m = re.match(r"window \S+ five-hour (\d+)% weekly (\d+)%", line)
            if m:
                out.append((last, int(m.group(1)), int(m.group(2))))
    return out


def asked(patch, untracked, tracked):
    files = [t["file"] for t in tracked] + list(untracked)
    tests = [f for f in files if f.startswith("tests/") and f.endswith(".ts")]
    docs_hit = "docs/ci.md" in files and re.search(r"^\+.*model_unavailable", patch or "", re.M) is not None
    tests_hit = bool(tests) and re.search(r"^\+.*model_unavailable", patch or "", re.M) is not None
    stray = [f for f in untracked if not (f.startswith(("tests/", "packages/", "docs/")))]
    return {"docs_table": docs_hit, "tests_added": tests_hit, "test_files": tests, "stray_files": stray}


rows = {}
for arm in ARMS:
    s = load("summary.json", arm)
    r = load("result.json", arm) or {}
    patch = load("change.patch", arm) or ""
    g = s["grade"]
    a = s.get("agent") or {}
    text = r.get("resultText") or ""
    verdict = None
    m = re.search(r"\[verdict\] ([^\n]+)", text)
    if m:
        verdict = m.group(1)
    tr = s["change"]["tracked"]
    rows[arm] = {
        "hidden": f"{g['hidden']['pass']}/{(g['hidden']['pass'] or 0) + (g['hidden']['fail'] or 0)}",
        "hidden_all": g["hidden"]["exit"] == 0,
        "exit": a.get("exitCode"),
        "terminal": a.get("terminal"),
        "claimed": a.get("claimedSuccess"),
        "verdict": verdict,
        "minutes": round((a.get("durationMs") or 0) / 60000, 1),
        "turns": a.get("turns"),
        "calls": a.get("calls"),
        "usage": a.get("usage"),
        "models": a.get("models"),
        "quotaPct": r.get("quotaPct"),
        "unit": (g["unit"]["pass"], g["unit"]["fail"]),
        "integration": (g["integration"]["pass"], g["integration"]["fail"]),
        "reliability": (g["reliability"]["pass"], g["reliability"]["fail"]),
        "typecheck": g["typecheck"]["exit"],
        "lint": g["lint"]["exit"],
        "format": g["format"]["exit"],
        "files": len(tr) + len(s["change"]["untracked"]),
        "added": sum(t["added"] for t in tr),
        "deleted": sum(t["deleted"] for t in tr),
        "new_files": s["change"]["untracked"],
        "commits": s["change"].get("commits", []),
        **asked(patch, s["change"]["untracked"], tr),
    }

bg = base["grade"]
print(f"baseline: hidden {bg['hidden']['pass']}/{(bg['hidden']['pass'] or 0) + (bg['hidden']['fail'] or 0)}, "
      f"unit {bg['unit']['pass']}/{bg['unit']['fail']} fail, integration {bg['integration']['pass']}/{bg['integration']['fail']} fail, "
      f"reliability {bg['reliability']['pass']}/{bg['reliability']['fail']} fail, typecheck {bg['typecheck']['exit']}, "
      f"lint {bg['lint']['exit']}, format {bg['format']['exit']}")
w = windows()
print("windows:", w)
used = {}
for i in range(1, len(w)):
    used[w[i][0]] = (w[i][1] - w[i - 1][1], w[i][2] - w[i - 1][2])

def fmt_usage(u):
    if not u:
        return "—"
    return (f"in {u['inputTokens']:,} · cached {u['cacheReadTokens']:,} · out {u['outputTokens']:,}"
            f" · reasoning {u['reasoningTokens']:,}")

lines = ["| | " + " | ".join(ARMS) + " |", "|---|" + "---|" * len(ARMS)]
def row(label, fn):
    lines.append(f"| {label} | " + " | ".join(str(fn(rows[a], a)) for a in ARMS) + " |")
row("hidden test (404, 410, 401)", lambda x, a: x["hidden"])
row("docs/ci.md table updated", lambda x, a: x["docs_table"])
row("tests for the new ending", lambda x, a: f"{x['tests_added']} {x['test_files']}")
row("committed (asked not to)", lambda x, a: x["commits"] or "no")
row("unit pass/fail (baseline %s/%s)" % (bg["unit"]["pass"], bg["unit"]["fail"]), lambda x, a: "%s/%s" % x["unit"])
row("integration pass/fail (baseline %s/%s)" % (bg["integration"]["pass"], bg["integration"]["fail"]), lambda x, a: "%s/%s" % x["integration"])
row("reliability pass/fail (baseline %s/%s)" % (bg["reliability"]["pass"], bg["reliability"]["fail"]), lambda x, a: "%s/%s" % x["reliability"])
row("typecheck / lint / format exit", lambda x, a: f"{x['typecheck']} / {x['lint']} / {x['format']}")
row("change: files, +lines, -lines", lambda x, a: f"{x['files']}, +{x['added']}, -{x['deleted']}")
row("new files", lambda x, a: x["new_files"])
row("stray files", lambda x, a: x["stray_files"] or "none")
row("agent exit / ending / says finished", lambda x, a: f"{x['exit']} / {x['terminal']} / {x['claimed']}")
row("Rune's verdict line", lambda x, a: x["verdict"] or "—")
row("wall time (min)", lambda x, a: x["minutes"])
row("turns / model calls", lambda x, a: f"{x['turns']} / {x['calls']}")
row("tokens", lambda x, a: fmt_usage(x["usage"]))
row("models", lambda x, a: x["models"])
row("five-hour / weekly window used (pts, incl. one probe)", lambda x, a: used.get(a, "—"))
print("\n".join(lines))
with open(os.path.join(ROOT, "compare.json"), "w") as f:
    json.dump({"baseline": bg, "rows": rows, "windows": w, "used": used}, f, indent=2, default=str)
