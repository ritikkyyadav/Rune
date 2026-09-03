// ─── Decision — what was decided, and what it was decided on ───
//
// The centre of the Decision Record. A decision states the choice, the evidence
// it rests on, and — the part every other tool omits — what was NOT chosen and
// why. "Restored the index" is a changelog entry; "restored the index rather
// than adding a covering index, because the write path is already the hot one"
// is a decision a person can disagree with.
//
// `basedOn` mirrors P11.1's `decisions[].basedOn: EvidenceRef[]`. A decision
// with an empty `basedOn` renders as ungrounded, in the caution colour, rather
// than as a confident sentence.

import { z } from "zod";
import { Frame, LocatorSchema, WarnGlyph, baseProps, locatorText } from "./kit";

export const DecisionSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  text: z.string().max(1500),
  basedOn: z.array(LocatorSchema).max(40),
  at: z.string().max(40).optional(),
  /** What was considered and not taken. One line each. */
  alternatives: z.array(z.string().max(300)).max(8).optional(),
  /** Who made the call: the agent, or a person who approved it. */
  by: z.string().max(80).optional(),
});
export type DecisionProps = z.infer<typeof DecisionSchema>;

export function Decision(props: DecisionProps) {
  const grounded = props.basedOn.length > 0;
  return (
    <Frame
      kind={`p-decision ${grounded ? "grounded" : "ungrounded"}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.text.trim().length === 0}
      emptyText="No decision recorded."
      skeleton={3}
    >
      <p className="p-decision-text">{props.text}</p>
      {props.alternatives && props.alternatives.length > 0 ? (
        <ul className="p-decision-alts">
          {props.alternatives.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      ) : null}
      <div className="p-decision-foot">
        {grounded ? (
          <ul className="p-decision-basis">
            {props.basedOn.map((b, i) => (
              <li key={i}>
                {b.kind === "url" ? (
                  <a href={b.ref} target="_blank" rel="noopener noreferrer">
                    {locatorText(b)}
                  </a>
                ) : (
                  <span>{locatorText(b)}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="p-decision-ungrounded">
            <WarnGlyph />
            no evidence recorded
          </span>
        )}
        <span className="p-decision-by">
          {props.by ? props.by : null}
          {props.by && props.at ? " · " : null}
          {props.at ?? null}
        </span>
      </div>
    </Frame>
  );
}
