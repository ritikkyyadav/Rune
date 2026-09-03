// ─── Divider — one hairline, optionally carrying a word ───
//
// The only purely structural primitive. It exists so a composer can separate
// two runs of blocks without inventing a wrapper, and so that separation is a
// hairline rather than a margin nobody agrees on.

import { z } from "zod";
import { baseProps } from "./kit";

export const DividerSchema = z.strictObject({
  ...baseProps,
  text: z.string().max(60).optional(),
  /** Extra room above and below, for the seam between two regions. */
  spacious: z.boolean().optional(),
});
export type DividerProps = z.infer<typeof DividerSchema>;

export function Divider(props: DividerProps) {
  const view =
    props.state === "error" ? "is-error" : props.state === "loading" ? "is-loading" : "is-ready";
  const text = props.state === "error" ? (props.error ?? "unreadable") : props.text;
  return (
    <div
      className={`pf p-divider ${props.spacious ? "spacious" : ""} ${view}`}
      role="separator"
      aria-label={props.label ?? props.text}
    >
      {text ? <span className="p-divider-text">{text}</span> : null}
    </div>
  );
}
