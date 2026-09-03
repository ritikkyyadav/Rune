// ─── File — a file, with the region that matters ───
//
// One row a person can point at: the path, what happened to it, and — when the
// agent read or wrote a specific region — the lines and an excerpt. The excerpt
// is TEXT with a line gutter, never highlighted, for the same reason Diff is
// not: a second colour system arriving through a syntax theme.
//
// The path is not truncated in the middle. `src/database/orders.ts` and
// `src/…/orders.ts` are the same length to a reader and only one of them can be
// copied.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const FileSchema = z.strictObject({
  ...baseProps,
  path: z.string().max(400),
  action: z.enum(["read", "written", "created", "deleted", "renamed"]).optional(),
  language: z.string().max(24).optional(),
  line: z.number().int().positive().optional(),
  excerpt: z.string().max(8000).optional(),
  bytes: z.number().int().nonnegative().optional(),
  note: z.string().max(200).optional(),
});
export type FileProps = z.infer<typeof FileSchema>;

const TONE: Record<string, string> = {
  read: "neutral",
  written: "accent",
  created: "ok",
  deleted: "danger",
  renamed: "neutral",
};

export function File(props: FileProps) {
  const lines = props.excerpt ? props.excerpt.replace(/\n$/, "").split("\n") : [];
  const first = props.line ?? 1;
  return (
    <Frame
      kind="p-file"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.path.trim().length === 0}
      emptyText="No file."
      skeleton={3}
    >
      <div className="p-file-head">
        <span className="p-file-path">{props.path}</span>
        {props.action ? (
          <span className={`p-file-action tone-${TONE[props.action] ?? "neutral"}`}>
            {props.action}
          </span>
        ) : null}
        {props.bytes !== undefined ? (
          <span className="p-file-bytes">{props.bytes.toLocaleString("en-US")} B</span>
        ) : null}
      </div>
      {lines.length > 0 ? (
        <pre className="p-file-excerpt">
          {lines.map((l, i) => (
            <span className="p-file-line" key={i}>
              <span className="p-file-no">{first + i}</span>
              <span className="p-file-code">{l || " "}</span>
            </span>
          ))}
        </pre>
      ) : null}
      {props.note ? <p className="p-file-note">{props.note}</p> : null}
    </Frame>
  );
}
