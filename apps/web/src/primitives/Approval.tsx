// ─── Approval — a held step, and the EXACT grant it is asking for ───
//
// The held-step surface's rule, ported: the panel approves exactly this, not a
// category. So `grant` is a required, specific string — `s3:PutObject on
// arn:aws:s3:::gear-artifacts/*`, not "AWS access" — and the scope of what
// "always" would widen to is spelled out beside the key rather than discovered
// afterwards.
//
// Keys: y approve once · a approve for this session · n refuse. They are shown,
// because a shortcut nobody can see is a shortcut nobody uses, and the buttons
// exist because a keyboard-only affordance is not an affordance.
//
// It never modals. A decision that steals focus is a decision made under
// pressure, and the run is not going anywhere.

import { useEffect, useState } from "react";
import { z } from "zod";
import { Chevron, Frame, baseProps } from "./kit";

export const ApprovalSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  /** What the agent wants to do, in one line. */
  action: z.string().max(400),
  /** The exact grant. Never a category. */
  grant: z.string().max(600),
  /** What "always" would widen to, spelled out. */
  alwaysScope: z.string().max(300).optional(),
  reason: z.string().max(600).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  /** Set once the person answered; the card stays, showing what they chose. */
  outcome: z.enum(["approved", "always", "refused"]).nullable().optional(),
  deadline: z.string().max(40).optional(),
  /**
   * Collapse to one line. The composer sets this through `foldWhen: "resolved"`,
   * so an answered decision stops taking the room an open one deserves without
   * disappearing — "what did I approve" is a question people ask afterwards.
   * An OPEN approval ignores it: a held step folded out of sight is a run
   * stopped for a reason nobody can see.
   */
  folded: z.boolean().optional(),
});
export type ApprovalProps = z.infer<typeof ApprovalSchema> & {
  onDecide?: (outcome: "approved" | "always" | "refused") => void;
};

const OUTCOME_TEXT = {
  approved: "approved once",
  always: "approved for this session",
  refused: "refused",
} as const;

export function Approval(props: ApprovalProps) {
  const decided = props.outcome ?? null;
  const onDecide = props.onDecide;
  const [open, setOpen] = useState(true);
  // Only a DECIDED approval may fold, and the person can still open it.
  const collapsed = decided !== null && props.folded === true && !open;

  useEffect(() => {
    if (decided !== null || !onDecide) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "y") onDecide("approved");
      else if (e.key === "a") onDecide("always");
      else if (e.key === "n") onDecide("refused");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decided, onDecide]);

  return (
    <Frame
      kind={`p-approval risk-${props.risk ?? "medium"} ${decided ? "decided" : "open"}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.action.trim().length === 0}
      emptyText="Nothing held."
      skeleton={3}
    >
      {collapsed ? (
        <button
          type="button"
          className="p-appr-folded"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Chevron open={false} />
          <span className="p-appr-action">{props.action}</span>
          <span className="p-appr-outcome-word">{OUTCOME_TEXT[decided]}</span>
        </button>
      ) : (
        <>
          <div className="p-appr-head" role="group" aria-label="Held step">
            <span className="p-appr-action">{props.action}</span>
            {props.deadline ? <span className="p-appr-deadline">{props.deadline}</span> : null}
          </div>
          <dl className="p-appr-grant">
            <dt>Grants exactly</dt>
            <dd>{props.grant}</dd>
            {props.alwaysScope ? (
              <>
                <dt>“Always” would widen to</dt>
                <dd>{props.alwaysScope}</dd>
              </>
            ) : null}
            {props.reason ? (
              <>
                <dt>Because</dt>
                <dd>{props.reason}</dd>
              </>
            ) : null}
          </dl>
          {decided ? (
            <p className="p-appr-outcome">{OUTCOME_TEXT[decided]}</p>
          ) : (
            <div className="p-appr-actions">
              <button
                type="button"
                className="p-btn primary"
                onClick={() => props.onDecide?.("approved")}
              >
                Approve <kbd>y</kbd>
              </button>
              <button type="button" className="p-btn" onClick={() => props.onDecide?.("always")}>
                Always <kbd>a</kbd>
              </button>
              <button type="button" className="p-btn" onClick={() => props.onDecide?.("refused")}>
                Refuse <kbd>n</kbd>
              </button>
            </div>
          )}
        </>
      )}
    </Frame>
  );
}
