// ─── Checklist — the plan, with the evidence marks ───
//
// A direct port of the ledger's grammar into the primitive vocabulary, and it
// keeps the distinction the ledger exists for: `completed` is what the harness
// recorded as closed, `verified` is a step whose own check ran and PASSED, and
// `unproven` is a completion the harness refused once and the model re-submitted
// anyway. Three different marks, because flattening them into one tick is
// exactly the claim this product does not make.
//
// `owner` renders when a fleet is working the plan; absent means the lead.

import { z } from "zod";
import { CheckGlyph, Frame, WarnGlyph, baseProps } from "./kit";

export const ChecklistItemSchema = z.strictObject({
  content: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** The step's own check ran and passed. */
  verified: z.boolean().optional(),
  /** Closed without proof, and why. Mirrors TodoItem.unproven. */
  unproven: z.enum(["no_evidence", "check_failed"]).optional(),
  owner: z.string().max(60).optional(),
});

export const ChecklistSchema = z.strictObject({
  ...baseProps,
  items: z.array(ChecklistItemSchema).max(200),
  /** Show the "n of m · k verified" line. On by default. */
  summary: z.boolean().optional(),
});
export type ChecklistProps = z.infer<typeof ChecklistSchema>;

const UNPROVEN_TEXT: Record<string, string> = {
  no_evidence: "closed with no evidence",
  check_failed: "closed after a failed check",
};

export function Checklist(props: ChecklistProps) {
  const done = props.items.filter((i) => i.status === "completed").length;
  const verified = props.items.filter((i) => i.verified).length;

  return (
    <Frame
      kind="p-checklist"
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.items.length === 0}
      emptyText="No plan yet."
      skeleton={4}
    >
      {props.summary === false ? null : (
        <div className="p-check-summary">
          {done} of {props.items.length}
          {verified > 0 ? ` · ${verified} verified` : ""}
        </div>
      )}
      <ol className="p-check-list">
        {props.items.map((item, i) => (
          <li key={i} className={`p-check-item st-${item.status}`}>
            <span className={`p-check-mark st-${item.status}`} aria-hidden>
              {item.status === "completed" ? <CheckGlyph /> : null}
            </span>
            <span className="p-check-text">{item.content}</span>
            {item.owner ? <span className="p-check-owner">{item.owner}</span> : null}
            {item.unproven ? (
              <span className="p-check-unproven" title={UNPROVEN_TEXT[item.unproven]}>
                <WarnGlyph />
                unproven
              </span>
            ) : item.verified ? (
              <span className="p-check-verified">verified</span>
            ) : null}
          </li>
        ))}
      </ol>
    </Frame>
  );
}
