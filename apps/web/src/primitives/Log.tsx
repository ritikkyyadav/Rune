// ─── Log — raw output, folded ───
//
// Closed by default and it says how much is behind the fold, because "Logs" as
// a bare disclosure triangle is a thing nobody opens. Open it and the lines are
// there verbatim, monospace, wrapped rather than scrolled sideways.
//
// The fold is a real <button> with `aria-expanded`; the content is in the DOM
// only when open, so a 4,000-line build log costs nothing until someone asks.

import { useState } from "react";
import { z } from "zod";
import { Chevron, Frame, baseProps } from "./kit";

export const LogSchema = z.strictObject({
  ...baseProps,
  /** The fold's own title: "build output", "stderr". */
  title: z.string().max(120).optional(),
  lines: z.array(z.string().max(4000)).max(20_000),
  /** Start open. The composer sets this for a log a run failed on. */
  folded: z.boolean().optional(),
  source: z.string().max(200).optional(),
});
export type LogProps = z.infer<typeof LogSchema>;

export function Log(props: LogProps) {
  const [open, setOpen] = useState(props.folded === false);
  return (
    <Frame
      kind="p-log"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.lines.length === 0}
      emptyText="No output."
      skeleton={2}
    >
      <button
        type="button"
        className="p-log-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <span className="p-log-title">{props.title ?? "Raw output"}</span>
        <span className="p-log-count">{props.lines.length.toLocaleString("en-US")} lines</span>
        {props.source ? <span className="p-log-source">{props.source}</span> : null}
      </button>
      {open ? <pre className="p-log-body">{props.lines.join("\n")}</pre> : null}
    </Frame>
  );
}
