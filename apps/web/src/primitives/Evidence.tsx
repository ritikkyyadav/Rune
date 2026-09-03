// ─── Evidence — a claim bound to the things that support it ───
//
// The load-bearing primitive of the whole vocabulary. A claim with no sources
// renders as a claim with no sources — explicitly, in the caution colour, with
// the word "unsupported" — rather than as a sentence that looks exactly like a
// supported one. Nine of ten interfaces get this wrong by rendering both the
// same and putting a footnote marker on the lucky one.
//
// `strength` is derived from the sources, not supplied: none is unsupported,
// one is single-sourced, two or more is corroborated. A model cannot mark its
// own claim "strong".

import { z } from "zod";
import { CheckGlyph, Frame, LocatorSchema, WarnGlyph, baseProps, locatorText } from "./kit";

export const EvidenceSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  claim: z.string().max(1000),
  sources: z.array(LocatorSchema).max(40),
  /** What the agent concluded FROM the sources, if anything beyond the claim. */
  reading: z.string().max(600).optional(),
  /** A claim the harness itself verified — a check that ran, not model prose. */
  verified: z.boolean().optional(),
});
export type EvidenceProps = z.infer<typeof EvidenceSchema>;

export function Evidence(props: EvidenceProps) {
  const n = props.sources.length;
  const strength = n === 0 ? "unsupported" : n === 1 ? "single-sourced" : "corroborated";
  return (
    <Frame
      kind={`p-evidence s-${n === 0 ? "none" : n === 1 ? "one" : "many"}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.claim.trim().length === 0}
      emptyText="No claim."
      skeleton={3}
    >
      <p className="p-evidence-claim">
        {props.verified ? (
          <span className="p-evidence-verified" title="A check ran and passed">
            <CheckGlyph />
          </span>
        ) : null}
        {props.claim}
      </p>
      {props.reading ? <p className="p-evidence-reading">{props.reading}</p> : null}
      <div className="p-evidence-foot">
        <span className={`p-evidence-strength ${n === 0 ? "weak" : ""}`}>
          {n === 0 ? <WarnGlyph /> : null}
          {strength}
        </span>
        {n > 0 ? (
          <ul className="p-evidence-sources">
            {props.sources.map((s, i) => (
              <li key={i}>
                {s.kind === "url" ? (
                  <a href={s.ref} target="_blank" rel="noopener noreferrer">
                    {locatorText(s)}
                  </a>
                ) : (
                  <span>{locatorText(s)}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Frame>
  );
}
