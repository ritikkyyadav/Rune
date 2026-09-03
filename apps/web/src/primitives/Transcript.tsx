// ─── Transcript — the conversation, folded ───
//
// Phase 11's correction demoted the transcript from the product to a primitive:
// "chat is the input; the interface is the output". So it is a fold, closed by
// default, and the label says how many turns are behind it rather than inviting
// a scroll.
//
// Four roles and one shape each. Tool turns collapse to one quiet line with a
// count, because a transcript that prints every tool call is the surface this
// phase exists to replace.

import { useState } from "react";
import { z } from "zod";
import { Chevron, Frame, baseProps } from "./kit";

export const TranscriptTurnSchema = z.strictObject({
  role: z.enum(["user", "agent", "tool", "system"]),
  text: z.string().max(20_000),
  at: z.string().max(40).optional(),
  /** For a tool turn: how many calls this line stands for. */
  count: z.number().int().positive().optional(),
});

export const TranscriptSchema = z.strictObject({
  ...baseProps,
  turns: z.array(TranscriptTurnSchema).max(2000),
  /** Start closed. Default true — this is a fold, not a feed. */
  folded: z.boolean().optional(),
});
export type TranscriptProps = z.infer<typeof TranscriptSchema>;

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  agent: "Gear",
  tool: "Tools",
  system: "System",
};

export function Transcript(props: TranscriptProps) {
  const [open, setOpen] = useState(props.folded === false);
  return (
    <Frame
      kind="p-transcript"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.turns.length === 0}
      emptyText="Nothing said yet."
      skeleton={3}
    >
      <button
        type="button"
        className="p-tr-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <span className="p-tr-title">Transcript</span>
        <span className="p-tr-count">{props.turns.length} turns</span>
      </button>
      {open ? (
        <ol className="p-tr-list">
          {props.turns.map((t, i) => (
            <li key={i} className={`p-tr-turn role-${t.role}`}>
              <span className="p-tr-role">{ROLE_LABEL[t.role] ?? t.role}</span>
              <span className="p-tr-text">
                {t.text}
                {t.role === "tool" && t.count ? (
                  <span className="p-tr-tally"> · {t.count} calls</span>
                ) : null}
              </span>
              {t.at ? <span className="p-tr-at">{t.at}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Frame>
  );
}
