// ─── Text — a paragraph the agent wrote, or a run of them ───
//
// The one primitive whose content is prose, and therefore the one most likely
// to be handed raw HTML by a model that has learned every other interface
// accepts it. It takes a string and renders text nodes. Blank lines split
// paragraphs; nothing else is interpreted.

import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const TextSchema = z.strictObject({
  ...baseProps,
  body: z.string().max(20_000),
  /** Quiet secondary prose: a caption, a note under a figure. */
  muted: z.boolean().optional(),
});
export type TextProps = z.infer<typeof TextSchema>;

export function Text(props: TextProps) {
  const paragraphs = props.body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <Frame
      kind="p-text"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={paragraphs.length === 0}
      emptyText="No text yet."
      skeleton={3}
    >
      <div className={`p-text-body ${props.muted ? "muted" : ""}`}>
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </Frame>
  );
}
