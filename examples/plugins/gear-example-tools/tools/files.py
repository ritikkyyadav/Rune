#!/usr/bin/env python3
"""A Gear plugin tool server, in Python, speaking line-delimited JSON on stdio.

Declared capability: ``workspace-write``. The OS sandbox — not this file — is
what confines the writes. This program deliberately performs **no path
validation of its own**: it opens exactly what it is asked to open and reports
the operating system's answer verbatim. That is the point. If a write outside
the workspace fails, the refusal is the sandbox's, and the error text proves
it (``[Errno 1] Operation not permitted``).

Protocol (one JSON object per line, both directions):

  out  {"type":"schema","protocol":1,"tools":[…]}   first, on start
  in   {"type":"hello","protocol":1,…}
  in   {"type":"call","id":"c1","tool":"write_text","args":{…}}
  out  {"type":"result","id":"c1","ok":true,"result":{…}}
  out  {"type":"result","id":"c1","ok":false,"error":"…"}
  in   {"type":"shutdown"}
"""

import json
import os
import sys

# The child's working directory is the PLUGIN's root, so a relative path from
# the caller is resolved against the workspace explicitly. This is path
# resolution, not validation: an absolute path is used as given, and whether
# either one is allowed is the sandbox's decision, not this program's.
WORKSPACE = os.environ.get("GEAR_WORKSPACE") or os.getcwd()


def resolve(path):
    return path if os.path.isabs(path) else os.path.join(WORKSPACE, path)


TOOLS = [
    {
        "name": "write_text",
        "description": (
            "Write UTF-8 text to a path. Relative paths resolve against the workspace root. "
            "Writes outside the plugin's declared capability are refused by the OS sandbox."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File to write."},
                "text": {"type": "string", "description": "Contents to write."},
            },
            "required": ["path", "text"],
        },
    },
    {
        "name": "read_text",
        "description": "Read UTF-8 text from a path and return the first max_bytes bytes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "max_bytes": {"type": "integer", "description": "Default 4096."},
            },
            "required": ["path"],
        },
    },
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def write_text(args):
    path = resolve(args["path"])
    text = args.get("text", "")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return {"path": path, "bytes": len(text.encode("utf-8"))}


def read_text(args):
    path = resolve(args["path"])
    limit = int(args.get("max_bytes", 4096))
    with open(path, "r", encoding="utf-8") as handle:
        return {"path": path, "text": handle.read(limit)}


HANDLERS = {"write_text": write_text, "read_text": read_text}


def main():
    emit({"type": "schema", "protocol": 1, "tools": TOOLS})
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except ValueError as err:
            emit({"type": "log", "level": "warn", "message": "unparseable frame: %s" % err})
            continue
        kind = frame.get("type")
        if kind == "shutdown":
            return
        if kind != "call":
            continue
        call_id = frame.get("id")
        handler = HANDLERS.get(frame.get("tool"))
        if handler is None:
            emit({"type": "result", "id": call_id, "ok": False, "error": "unknown tool"})
            continue
        try:
            emit(
                {
                    "type": "result",
                    "id": call_id,
                    "ok": True,
                    "result": handler(frame.get("args") or {}),
                }
            )
        except OSError as err:
            # Verbatim, including errno: a sandbox refusal is EPERM (1) and a
            # missing file is ENOENT (2), and the caller must be able to tell
            # them apart without guessing.
            emit(
                {
                    "type": "result",
                    "id": call_id,
                    "ok": False,
                    "error": "%s: %s" % (type(err).__name__, err),
                }
            )
        except Exception as err:  # noqa: BLE001 — a tool server never dies on one bad call
            emit(
                {
                    "type": "result",
                    "id": call_id,
                    "ok": False,
                    "error": "%s: %s" % (type(err).__name__, err),
                }
            )


if __name__ == "__main__":
    main()
