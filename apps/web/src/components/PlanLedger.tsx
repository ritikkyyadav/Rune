// ─── The plan, as a quiet checklist ───
//
// One line per step, at the top of the session, above the transcript. Quiet is
// the whole design: it is a thing you glance at, not a thing that competes with
// the work happening below it. No progress bar, no percentage, no confetti.
//
// A step's mark comes from the LEDGER, not from the model's say-so: `done` is
// what the harness recorded as closed, and `checked` is a step whose own check
// ran and passed. That distinction is the product's whole claim, so it is on
// screen rather than flattened into a tick.
//
// It renders nothing when there is no plan. A checklist with one row that says
// "no plan yet" is a widget insisting on its own existence.

import { CheckIcon } from "./Icons";

export interface PlanStep {
  content: string;
  status: string;
  /** The step's own check ran and passed — evidence, not the model's word. */
  checked?: boolean;
}

/** The status vocabulary the todo tool writes, mapped to three states. */
function state(status: string): "done" | "active" | "todo" {
  const s = status.toLowerCase();
  if (s === "completed" || s === "done" || s === "complete") return "done";
  if (s === "in_progress" || s === "active" || s === "running") return "active";
  return "todo";
}

export function PlanLedger(props: {
  steps: PlanStep[];
  /** Collapsed by default once a plan is long; the caller owns the toggle. */
  open: boolean;
  onToggle: () => void;
}) {
  if (props.steps.length === 0) return null;
  const done = props.steps.filter((s) => state(s.status) === "done").length;
  const checked = props.steps.filter((s) => s.checked).length;

  return (
    <section className="ledger" aria-label="Plan">
      <button
        className="ledger-head"
        onClick={props.onToggle}
        aria-expanded={props.open}
        title={props.open ? "Collapse the plan" : "Expand the plan"}
      >
        <span className="ledger-title">Plan</span>
        <span className="ledger-count">
          {done} of {props.steps.length}
          {checked > 0 ? ` · ${checked} verified` : ""}
        </span>
        <span className={`ledger-chev ${props.open ? "open" : ""}`}>›</span>
      </button>
      {props.open ? (
        <ol className="ledger-list">
          {props.steps.map((step, i) => {
            const st = state(step.status);
            return (
              <li key={`${i}-${step.content}`} className={`ledger-step ${st}`}>
                <span className={`ledger-mark ${st}`} aria-hidden>
                  {st === "done" ? <CheckIcon /> : null}
                </span>
                <span className="ledger-text">{step.content}</span>
                {step.checked ? (
                  <span className="ledger-evidence" title="This step's own check ran and passed">
                    verified
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
