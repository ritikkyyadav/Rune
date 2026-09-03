// ─── Hypothesis — an experiment, and what happened to it ───
//
// This is the primitive the phase exists for. "The person must feel what is
// being built and learn from the work: show the experimentation while it runs,
// fold the branches that turned out wrong."
//
// Four statuses and one rule each:
//   proposed  — written down, not yet tried
//   testing   — being tried right now; the mark is live
//   refuted   — FOLDS to one line carrying its reason, and the reason is
//               required by the schema, because "refuted" with no reason is
//               the branch disappearing rather than being folded
//   confirmed — stays open with its evidence
//
// The fold is reversible and it is a real <button> with `aria-expanded`, so the
// wrong turns are one keystroke away rather than gone. The Decision Record
// keeps them present for the same reason.

import { useState } from "react";
import { z } from "zod";
import { Chevron, Frame, LocatorSchema, baseProps, locatorText } from "./kit";

export const HypothesisStatusSchema = z.enum(["proposed", "testing", "refuted", "confirmed"]);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HypothesisSchema = z
  .strictObject({
    ...baseProps,
    id: z.string().max(120).optional(),
    text: z.string().max(600),
    status: HypothesisStatusSchema,
    /** Why it was refuted, or what confirmed it. One clause. */
    reason: z.string().max(400).optional(),
    evidence: z.array(LocatorSchema).max(40).optional(),
    /** Ordinal in the investigation: "3" in "3 query regression". */
    index: z.number().int().positive().optional(),
    /** Start folded. The composer sets this for anything refuted. */
    folded: z.boolean().optional(),
  })
  .refine((h) => h.status !== "refuted" || (h.reason !== undefined && h.reason.length > 0), {
    message: "a refuted hypothesis must carry the reason it was refuted",
    path: ["reason"],
  });
export type HypothesisProps = z.infer<typeof HypothesisSchema>;

const MARK: Record<HypothesisStatus, string> = {
  proposed: "○",
  testing: "●",
  refuted: "▸",
  confirmed: "✓",
};

export function Hypothesis(props: HypothesisProps) {
  const startOpen = props.folded === undefined ? props.status !== "refuted" : !props.folded;
  const [open, setOpen] = useState(startOpen);
  const evidence = props.evidence ?? [];

  return (
    <Frame
      kind={`p-hypothesis st-${props.status} ${open ? "open" : "folded"}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.text.trim().length === 0}
      emptyText="No hypothesis."
      skeleton={2}
      as="div"
    >
      <button
        type="button"
        className="p-hyp-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`p-hyp-mark st-${props.status}`} aria-hidden>
          {MARK[props.status]}
        </span>
        {props.index !== undefined ? <span className="p-hyp-index">{props.index}</span> : null}
        <span className="p-hyp-text">{props.text}</span>
        <span className={`p-hyp-status st-${props.status}`}>{props.status}</span>
        {props.reason ? <span className="p-hyp-reason">{props.reason}</span> : null}
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="p-hyp-body">
          {props.reason ? <p className="p-hyp-because">{props.reason}</p> : null}
          {evidence.length > 0 ? (
            <ul className="p-hyp-evidence">
              {evidence.map((e, i) => (
                <li key={i}>
                  {e.kind === "url" ? (
                    <a href={e.ref} target="_blank" rel="noopener noreferrer">
                      {locatorText(e)}
                    </a>
                  ) : (
                    <span>{locatorText(e)}</span>
                  )}
                  {e.excerpt ? <span className="p-hyp-excerpt">{e.excerpt}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-hyp-noevidence">No evidence recorded yet.</p>
          )}
        </div>
      ) : null}
    </Frame>
  );
}
