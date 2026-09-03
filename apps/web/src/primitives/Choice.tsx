// ─── Choice — an `ask_user` question, with its options ───
//
// The ask_user orbit (2026-09-01) was nine rewordings of one question in seven
// minutes, because the options were prose the model re-derived each time. Here
// the options are DATA: each has a stable id, a label and an optional
// consequence, so answering is a click and re-asking the same question is
// visible as the same shape.
//
// Options are numbered 1–9 and those digits are the shortcuts. `other` adds a
// free-text field, because a fixed list that does not contain the real answer
// is how a person gets forced into a wrong one.

import { useState } from "react";
import { z } from "zod";
import { Chevron, Frame, baseProps } from "./kit";

export const ChoiceOptionSchema = z.strictObject({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(300),
  /** What picking this means. One clause, not a paragraph. */
  consequence: z.string().max(300).optional(),
  recommended: z.boolean().optional(),
});

export const ChoiceSchema = z.strictObject({
  ...baseProps,
  id: z.string().max(120).optional(),
  question: z.string().max(1000),
  options: z.array(ChoiceOptionSchema).max(9),
  /** Allow a typed answer alongside the options. */
  other: z.boolean().optional(),
  /** The option id already chosen; the card stays and shows it. */
  answered: z.string().max(60).nullable().optional(),
  context: z.string().max(600).optional(),
  /**
   * Collapse to one line, through the composer's `foldWhen: "resolved"`. Only an
   * ANSWERED question folds; an open one is the run waiting on a person, and a
   * question folded out of sight is a run that looks stuck for no reason.
   */
  folded: z.boolean().optional(),
});
export type ChoiceProps = z.infer<typeof ChoiceSchema> & {
  onAnswer?: (id: string, text?: string) => void;
};

export function Choice(props: ChoiceProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const answered = props.answered ?? null;
  const chosen = props.options.find((o) => o.id === answered);
  const collapsed = answered !== null && props.folded === true && !open;

  if (collapsed) {
    return (
      <Frame
        kind="p-choice answered folded"
        label={props.label}
        state={props.state}
        error={props.error}
        skeleton={2}
      >
        <button
          type="button"
          className="p-choice-folded"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Chevron open={false} />
          <span className="p-choice-question">{props.question}</span>
          <span className="p-choice-answered">{chosen ? chosen.label : answered}</span>
        </button>
      </Frame>
    );
  }

  return (
    <Frame
      kind={`p-choice ${answered ? "answered" : "open"}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.question.trim().length === 0}
      emptyText="No question."
      skeleton={3}
    >
      <p className="p-choice-question">{props.question}</p>
      {props.context ? <p className="p-choice-context">{props.context}</p> : null}
      {answered ? (
        <p className="p-choice-answered">{chosen ? chosen.label : answered}</p>
      ) : (
        <>
          <ul className="p-choice-options">
            {props.options.map((o, i) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={`p-choice-opt ${o.recommended ? "recommended" : ""}`}
                  onClick={() => props.onAnswer?.(o.id)}
                >
                  <kbd>{i + 1}</kbd>
                  <span className="p-choice-label">{o.label}</span>
                  {o.consequence ? (
                    <span className="p-choice-consequence">{o.consequence}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {props.other ? (
            <form
              className="p-choice-other"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim().length > 0) props.onAnswer?.("other", text.trim());
              }}
            >
              <label className="p-choice-otherlabel" htmlFor={`other-${props.id ?? "x"}`}>
                Something else
              </label>
              <input
                id={`other-${props.id ?? "x"}`}
                className="p-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type an answer"
              />
              <button type="submit" className="p-btn">
                Send
              </button>
            </form>
          ) : null}
        </>
      )}
    </Frame>
  );
}
