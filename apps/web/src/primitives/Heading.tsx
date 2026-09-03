// ─── Heading — the one line that says what a region is ───
//
// Three levels and no more. A task surface with a six-level outline is a
// document, and a document is what the Decision Record is for. `eyebrow` is the
// small label above the title (the task kind, the section), `meta` the quiet
// right-hand fact (elapsed, status) the wireframes put on the same line.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const HeadingSchema = z.strictObject({
  ...baseProps,
  text: z.string().max(200),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  eyebrow: z.string().max(60).optional(),
  meta: z.string().max(80).optional(),
});
export type HeadingProps = z.infer<typeof HeadingSchema>;

export function Heading(props: HeadingProps) {
  const level = props.level ?? 2;
  const Tag = (["h1", "h2", "h3"] as const)[level - 1]!;
  return (
    <Frame
      kind={`p-heading lvl-${level}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.text.trim().length === 0}
      emptyText="Untitled."
      skeleton={1}
      as="div"
    >
      {props.eyebrow ? <div className="p-heading-eyebrow">{props.eyebrow}</div> : null}
      <div className="p-heading-row">
        <Tag className="p-heading-text">{props.text}</Tag>
        {props.meta ? <span className="p-heading-meta">{props.meta}</span> : null}
      </div>
    </Frame>
  );
}
