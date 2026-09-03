// ─── Diff — what actually changed, as bands ───
//
// Added and removed lines are bands of the status colours at low alpha, not
// green and red text: a hunk read as coloured type is a hunk you cannot read
// for two hours. The gutter carries both line numbers, so a reviewer can point
// at a line in the file rather than at a line in the diff.
//
// The parser takes unified-diff text and nothing else. No syntax highlighting:
// a highlighter is a second colour system, and this file's job is to show which
// lines moved, not which tokens are keywords.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const DiffSchema = z.strictObject({
  ...baseProps,
  path: z.string().max(400),
  /** Unified diff body: lines beginning ` `, `+`, `-`, `@@`. */
  patch: z.string().max(200_000),
  /** Renamed from, when the change moved a file. */
  from: z.string().max(400).optional(),
  /** Counts the harness measured; absent means they are derived from the patch. */
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
});
export type DiffProps = z.infer<typeof DiffSchema>;

interface Line {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  old?: number;
  next?: number;
}

export function parsePatch(patch: string): Line[] {
  const out: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), next: newNo++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: oldNo++ });
    else if (raw.length > 0 || out.length > 0)
      out.push({ kind: "ctx", text: raw.replace(/^ /, ""), old: oldNo++, next: newNo++ });
  }
  while (out.length > 0 && out[out.length - 1]!.kind === "ctx" && out[out.length - 1]!.text === "")
    out.pop();
  return out;
}

export function Diff(props: DiffProps) {
  const lines = parsePatch(props.patch);
  const added = props.added ?? lines.filter((l) => l.kind === "add").length;
  const removed = props.removed ?? lines.filter((l) => l.kind === "del").length;

  return (
    <Frame
      kind="p-diff"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={lines.length === 0}
      emptyText="No change."
      skeleton={5}
    >
      <div className="p-diff-head">
        <span className="p-diff-path">
          {props.from ? (
            <>
              <span className="p-diff-from">{props.from}</span>
              <span aria-hidden> → </span>
            </>
          ) : null}
          {props.path}
        </span>
        <span className="p-diff-counts">
          <span className="add">+{added}</span>
          <span className="del">−{removed}</span>
        </span>
      </div>
      <div className="p-diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`p-diff-line ${l.kind}`}>
            <span className="p-diff-no">{l.kind === "add" ? "" : (l.old ?? "")}</span>
            <span className="p-diff-no">{l.kind === "del" ? "" : (l.next ?? "")}</span>
            <span className="p-diff-sign" aria-hidden>
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <span className="p-diff-text">{l.text || " "}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}
