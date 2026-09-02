// ─── The cards the design contract asks for (M2–M4) ───
//
// Everything here obeys one rule from `docs/gear-desktop-design.md`: the agent
// stops for you INSIDE the stream, never over it. A modal takes the transcript
// away at the moment you most need to read it, so nothing in this file is one —
// the permission card, the question, the read-back and the held-step ledger all
// sit in the flow, and every one of them names exactly what it is asking about.

import { useEffect, useRef, useState } from "react";
import type {
  AutoApprovalNotice,
  Brief,
  BriefDecision,
  HeldStep,
  UserQuestion,
} from "../lib/types";
import type { FleetRow } from "../lib/fleet";

// ─── ask_user ───

/**
 * The agent is asking the person a question.
 *
 * Before Phase 2 this failed outright off-terminal ("No interactive user is
 * available"), so the desktop has never shown one. Options are one keystroke
 * each because that is what a person does with a four-option question, and the
 * free-text field stays available because the honest answer is often neither.
 */
export function AskCard(props: {
  requestId: string;
  question: UserQuestion;
  answered?: string;
  onAnswer: (requestId: string, answer: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { question, answered } = props;

  useEffect(() => {
    if (!answered) inputRef.current?.focus();
  }, [answered]);

  if (answered) {
    return (
      <div className="ask-card decided" role="group" aria-label="Question, answered">
        <div className="ask-head">
          <span className="ask-q">{question.question}</span>
        </div>
        <div className="ask-answer">
          <b>{answered}</b> · sent to the agent
        </div>
      </div>
    );
  }

  return (
    <div className="ask-card" role="group" aria-label="Question">
      <div className="ask-head">
        {question.total && question.total > 1 ? (
          <span className="meta">
            {(question.index ?? 0) + 1} of {question.total}
          </span>
        ) : null}
        <span className="ask-q">{question.question}</span>
      </div>
      {question.options.length > 0 ? (
        <div className="ask-options">
          {question.options.map((option, i) => (
            <button
              key={option}
              className="ask-btn"
              onClick={() => props.onAnswer(props.requestId, option)}
            >
              {option} <kbd>{i + 1}</kbd>
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="ask-free"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) props.onAnswer(props.requestId, text.trim());
        }}
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={question.options.length ? "…or answer in your own words" : "Your answer"}
          aria-label="Answer"
        />
        <button className="ask-btn primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <div className="ask-note">
        The turn is waiting. If nobody answers, the agent proceeds on its best judgment and states
        the assumption.
      </div>
    </div>
  );
}

// ─── The read-back ───

/**
 * What the agent understood, before it starts.
 *
 * The criteria are the load-bearing half: each one carries a rung and the
 * evidence that moved it, and the model can never set a rung directly. A brief
 * that shows every criterion as `null` is telling the truth — nothing has been
 * checked yet — which is why nothing here fills them in.
 */
export function BriefCard(props: {
  requestId: string;
  brief: Brief;
  decided?: BriefDecision;
  onDecide: (requestId: string, decision: BriefDecision) => void;
}) {
  const { brief, decided } = props;
  const [note, setNote] = useState("");
  return (
    <div className={`brief-card ${decided ? "decided" : ""}`} role="group" aria-label="Read-back">
      <div className="brief-head">
        <span className="meta">Reading it back</span>
      </div>
      <p className="brief-reading">{brief.reading}</p>
      {brief.touch.length > 0 ? (
        <div className="brief-row">
          <span className="meta">Touching</span>
          <span>{brief.touch.join(" · ")}</span>
        </div>
      ) : null}
      {brief.leave.length > 0 ? (
        <div className="brief-row">
          <span className="meta">Leaving alone</span>
          <span>{brief.leave.join(" · ")}</span>
        </div>
      ) : null}
      {brief.criteria.length > 0 ? (
        <ul className="brief-criteria">
          {brief.criteria.map((c) => (
            <li key={c.text}>
              <span className={`rung ${c.rung ?? "none"}`}>{c.rung ?? "not yet"}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {decided ? (
        <div className="brief-decision">
          {decided.accepted ? "✓ accepted — work started" : "✕ corrected"}
          {decided.note ? ` · ${decided.note}` : ""}
        </div>
      ) : (
        <>
          <input
            className="brief-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Correct the reading (optional)"
            aria-label="Correct the reading"
          />
          <div className="brief-actions">
            <button
              className="perm-btn primary"
              onClick={() => props.onDecide(props.requestId, { accepted: true })}
            >
              That&apos;s right <kbd>↵</kbd>
            </button>
            <button
              className="perm-btn"
              disabled={!note.trim()}
              onClick={() =>
                props.onDecide(props.requestId, { accepted: false, note: note.trim() })
              }
            >
              Not quite
            </button>
          </div>
          <div className="ask-note">
            Not a gate. Left unanswered, the reading is accepted as stated and work begins.
          </div>
        </>
      )}
    </div>
  );
}

// ─── Auto-mode approval chips ───

/**
 * What Auto did without asking, and on whose authority.
 *
 * The chip carries the classifier's risk and the SOURCE of the decision,
 * because "it was approved automatically" is not a statement anyone can audit.
 */
export function AutoChip({ notice }: { notice: AutoApprovalNotice }) {
  const kind = notice.kind ?? "approved";
  return (
    <span className={`auto-chip ${kind}`} title={notice.argsSummary}>
      <span className="ac-kind">{kind}</span>
      <span className="ac-tool">{notice.toolName}</span>
      <span className="ac-risk">
        risk {notice.risk} · {notice.tier}
      </span>
      {notice.route ? <span className="ac-route">{notice.route}</span> : null}
    </span>
  );
}

// ─── The held-step ledger ───

export type HeldOutcome = "ran" | "failed" | "refused" | "skipped";

/** The index of the next undecided step at or after `from`, or -1. */
export function nextUndecided(outcomes: ReadonlyArray<HeldOutcome | null>, from: number): number {
  for (let i = 0; i < outcomes.length; i++) {
    const at = (from + i) % outcomes.length;
    if (outcomes[at] === null) return at;
  }
  return -1;
}

export type HeldAction =
  | { kind: "move"; selected: number }
  | { kind: "run"; index: number }
  | { kind: "skip"; index: number }
  | { kind: "leave" }
  | { kind: "ignore" };

/**
 * The panel's state machine, ported from `bin/ui/held.ts` so the two surfaces
 * agree on what a key means.
 *
 * Enter runs the selected step; a digit picks AND runs, the one-keystroke fast
 * path; `s` leaves one unrun; Esc closes and leaves every undecided step in the
 * ledger. A decided step cannot be re-run by a stray digit — a step cannot be
 * un-run, and the second press of a key is exactly when that happens.
 */
export function heldAction(
  key: string,
  view: { steps: unknown[]; outcomes: ReadonlyArray<HeldOutcome | null>; selected: number },
): HeldAction {
  const count = view.steps.length;
  if (count === 0) return { kind: "leave" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    const step = key === "ArrowDown" ? 1 : -1;
    return { kind: "move", selected: (view.selected + step + count) % count };
  }
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    if (index >= count) return { kind: "ignore" };
    return view.outcomes[index] === null ? { kind: "run", index } : { kind: "ignore" };
  }
  if (key === "Enter") {
    return view.outcomes[view.selected] === null
      ? { kind: "run", index: view.selected }
      : { kind: "ignore" };
  }
  if (key === "s" || key === "S") {
    return view.outcomes[view.selected] === null
      ? { kind: "skip", index: view.selected }
      : { kind: "ignore" };
  }
  if (key === "Escape") return { kind: "leave" };
  return { kind: "ignore" };
}

/**
 * Auto's end-of-turn ledger, with exact-grant semantics.
 *
 * Approving a step runs EXACTLY the call the agent asked for — the host holds
 * the arguments and the client sends only an id, so nothing broader is granted
 * and the raw arguments never cross the wire. The alternative this replaces is
 * the reason it exists: the path of least resistance past one held publish used
 * to be "shift to 4th gear", which grants everything to get one thing.
 */
export function HeldStepsPanel(props: {
  steps: HeldStep[];
  outcomes: Array<HeldOutcome | null>;
  selected: number;
  running: boolean;
  onSelect: (index: number) => void;
  onRun: (index: number) => void;
  onSkip: (index: number) => void;
  onClose: () => void;
}) {
  const { steps, outcomes, selected, running } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (running) {
        if (e.key === "Escape") e.preventDefault();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const action = heldAction(e.key, { steps, outcomes, selected });
      if (action.kind === "ignore") return;
      e.preventDefault();
      if (action.kind === "move") props.onSelect(action.selected);
      else if (action.kind === "run") props.onRun(action.index);
      else if (action.kind === "skip") props.onSkip(action.index);
      else props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outcomes, props, running, selected, steps]);

  if (steps.length === 0) return null;
  const ran = outcomes.filter((o) => o === "ran").length;
  const unrun = outcomes.filter((o) => o === null || o === "skipped").length;

  return (
    <section className="held-panel" aria-label="Held steps">
      <div className="held-head">
        <span className="meta">Held steps</span>
        <span className="held-sub">
          {steps.length} outward step{steps.length === 1 ? "" : "s"} Auto declined to take
          unattended
        </span>
        <button className="tb-btn" onClick={props.onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>
      {steps.map((step, i) => {
        const outcome = outcomes[i] ?? null;
        return (
          <div
            key={step.id}
            className={`held-row ${i === selected ? "sel" : ""} ${outcome ?? ""}`}
            onClick={() => props.onSelect(i)}
          >
            <span className="held-index">{i + 1}</span>
            <div className="held-body">
              <div className="held-summary">{step.summary}</div>
              <div className="held-reason">{step.reason}</div>
              {step.substitute ? (
                <div className="held-sub-run">ran instead: {step.substitute}</div>
              ) : null}
            </div>
            <div className="held-actions">
              {outcome ? (
                <span className={`held-outcome ${outcome}`}>
                  {outcome === "ran"
                    ? "✓ ran exactly this"
                    : outcome === "failed"
                      ? "✕ ran and failed"
                      : outcome === "refused"
                        ? "✕ refused"
                        : "left unrun"}
                </span>
              ) : (
                <>
                  <button
                    className="perm-btn primary"
                    disabled={running}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRun(i);
                    }}
                  >
                    Run exactly this <kbd>{i < 9 ? i + 1 : "↵"}</kbd>
                  </button>
                  <button
                    className="perm-btn"
                    disabled={running}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSkip(i);
                    }}
                  >
                    Leave <kbd>s</kbd>
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="held-foot">
        {running ? "running exactly this — esc cancels" : null}
        {!running && ran + unrun > 0
          ? `${ran} ran · ${unrun} left unrun · an approval grants this exact call and nothing wider`
          : null}
      </div>
    </section>
  );
}

// ─── The fleet ───

/**
 * One row per sub-agent, in dispatch order.
 *
 * Dispatch order and not arrival order: arrival is whichever worker happened to
 * speak first, which makes the panel reorder itself while you read it.
 */
export function FleetPanel({ rows, now }: { rows: FleetRow[]; now: number }) {
  if (rows.length === 0) return null;
  return (
    <section className="fleet" aria-label="Sub-agents">
      <div className="fleet-head">
        <span className="meta">Fleet</span>
        <span className="fleet-sub">
          {rows.filter((r) => r.state === "running").length} running of {rows.length}
        </span>
      </div>
      {rows.map((row) => (
        <div key={row.agentId} className={`fleet-row ${row.state}`}>
          <span className={`fleet-state ${row.state}`}>{row.state}</span>
          <span className="fleet-label">{row.label}</span>
          <span className="fleet-note">{row.note}</span>
          <span className="fleet-time">
            {Math.round(((row.endedAt ?? now) - row.startedAt) / 100) / 10}s
            {row.tools > 0 ? ` · ${row.tools} tools` : ""}
          </span>
        </div>
      ))}
    </section>
  );
}
