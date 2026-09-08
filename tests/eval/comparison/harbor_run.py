"""Validate the unchanged legacy anchor against a supplied Harbor dataset, then run it.

No substitution of missing tasks with names from Terminal-Bench 2.0 is allowed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def selected_tasks(root: Path, anchor: Path) -> list[str]:
    ids = json.loads(anchor.read_text())["task_ids"]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate pinned task IDs")
    missing = [name for name in ids if not (root / name / "task.toml").is_file()]
    if missing:
        raise ValueError("Dataset does not match this legacy anchor; missing: " + ", ".join(missing))
    return ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks-root", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--real", action="store_true")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    anchor = here.parent / "anchors" / "terminal-bench-20.json"
    ids = selected_tasks(args.tasks_root.resolve(), anchor)
    if args.out.exists():
        raise ValueError("Choose a fresh job output directory")
    command = ["harbor", "run", "--path", str(args.tasks_root.resolve()), "--agent", "harbor_agent:RuneAgent",
               "--model", args.model, "--jobs-dir", str(args.out.resolve().parent), "--job-name", args.out.name,
               "--n-concurrent", "1"]
    for name in ids:
        command += ["--include-task-name", name]
    print(shlex.join(command))
    if not args.real:
        print("Validated task names only. Add --real to run with Harbor 0.22.0 and a Linux RUNE_BENCH_BUNDLE.")
        return
    env = dict(os.environ)
    env["PYTHONPATH"] = str(here) + os.pathsep + env.get("PYTHONPATH", "")
    # Evidence belongs next to the job, not in the task environment.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    provenance = args.out.with_suffix(".anchor.json")
    if provenance.exists():
        raise ValueError("Anchor provenance already exists; choose a fresh output name")
    digests = {name: hashlib.sha256((args.tasks_root / name / "task.toml").read_bytes()).hexdigest() for name in ids}
    provenance.write_text(json.dumps({"anchor_sha256": hashlib.sha256(anchor.read_bytes()).hexdigest(),
                                     "task_configs": digests, "model": args.model, "arm": "pristine"}, indent=2))
    sys.exit(subprocess.run(command, env=env).returncode)


if __name__ == "__main__":
    main()
