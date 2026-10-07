// ─── The agents panel: the right column, and what a fan-out looks like ───
//
// The complaint this closes, stated once: a fan-out of sub-agents was a COUNT.
// `3 sub-agents running | grep backend` — one number and one borrowed heartbeat
// from whichever member reported last, for however many minutes the slowest of
// them took. P2.6 turned that into a row per member, which fixed who and what,
// and left three things unfixed:
//
//   1. The rows had no NAME. `map the settings surface` is a brief, not a name,
//      and a brief is too long to be a column and too specific to survive the
//      second row it appears on.
//   2. The rows were RETIRED at `tool_call_end` (turn.ts). A member that came
//      back vanished from the panel — so the one moment you want to compare
//      four of them is the moment three of them are gone.
//   3. There was no TOKEN and no COST per member. Both were computed inside the
//      child, converted to dollars, and discarded (subagent.ts, worker.ts).
//
// This module is the panel, and it is deliberately pure: `renderAgentsPanel`
// takes a width and a list of cards and returns rows. The state it renders
// lives in `fleetLedger` below, which outlives any one TurnRenderer for a
// reason — `TurnRenderer.fleet` is cleared at `turn_complete` and `Tui.liveTurn`
// goes null a moment later, and the idle panel still has to be able to say
// "4 finished this turn".
//
// Terminal invariants, per the keel skill: no spinner, and since 2026-10-02 no
// per-member animation of any kind -- a member's cell is one static mark, and
// the one thing that moves is the rung's glyph, struck by every member's
// output together (turn.ts `heard`, ./waveform.ts); nothing carried by colour
// alone (the stall is the word `quiet 9s`, the failure is `✗` AND the word);
// every glyph from the closed budget with a one-cell ASCII twin; body text
// uncoloured. The panel is CHROME and therefore right-aligns its headings
// through `flow.row`, which is the chrome-legal call — the transcript's
// one-left-edge law (ui-grammar.test) binds `flow.flowRow` and the rail, and
// this column is neither.

import type { StoredDelegation } from "../../delegation-replay";
import { deriveChildName } from "../../subagent-events";
import { ChildLog, ChildTranscript } from "./child-transcript";
import * as F from "./flow";
import { PULSE_GLYPHS, TERMINAL_GLYPH_MODE, glyph } from "./glyphs";
import type { Key } from "./keys";
import { Pulse, QUIET_AFTER_MS } from "./pulse";
import { clampVisible, truncate, visLen } from "./render";
import { accent, danger, faint, muted, ok, speakerSurface, text } from "./theme";

// ─── The card ───

export type AgentState = "queued" | "running" | "done" | "failed" | "skipped";

/**
 * The rungs of the claim ladder a card is allowed to carry, as GLYPH NAMES so
 * the mark is never typed as a literal and never renders as a multi-byte
 * character on a seven-bit terminal (`brief.ts`'s ladder, `glyphs.ts`'s marks).
 *
 * There is no rung for "probably", which is the whole point of the ladder: a
 * card cannot say a check "likely" passed, because there is nothing to write it
 * with.
 */
export type ReceiptRung = "verified" | "failure" | "reproduced" | "observed" | "suspected";

/**
 * The last thing this agent actually PROVED, and when.
 *
 * The founder's philosophy review (2026-09-14) is the reason this exists as its
 * own field rather than as one more entry in the accounting row: the panel is
 * an audit surface, not activity theatre. What a member has verified or failed
 * is the fact you would act on; how many tokens it has spent getting there is
 * bookkeeping. So the card LEADS with this and the counts follow it.
 */
export interface CardReceipt {
  rung: ReceiptRung;
  /** What was verified, or what failed — in the child's own words, clipped. */
  text: string;
  /** Epoch ms, so the collapsed strip can lead with the newest one. */
  at: number;
}

/**
 * One member of a fan-out, as the panel draws it.
 *
 * Everything here is measured. There is no field a surface fills in from a
 * heuristic and no field derived from the model's prose: `tokens` and `cost`
 * come from the child's own forwarded `usage` events, `tools` from its own
 * `tool_call_end`s, `pulseStep` from the arrival of its events and nothing
 * else. A card that says `12.4k tok` is reporting a number a provider sent.
 */
export interface AgentCard {
  /** The fleet key: the call id, or `<callId>:<node>` for a workflow node. */
  id: string;
  /** The card title — one word. See `resolveName`. */
  name: string;
  /** The 2-5 word brief: what this one was SENT to do. Row 2. */
  brief: string;
  kind: "task" | "worker";
  state: AgentState;
  /** Epoch ms. Absent while queued: an unknown clock is left blank rather than
   *  started at a convenient moment. */
  startedAt?: number;
  endedAt?: number;
  /** What it is doing right now, verbatim from its own event. */
  note: string;
  /** The last verdict it produced. The card's LEAD detail row — see CardReceipt. */
  receipt?: CardReceipt;
  tokens: number;
  costUsd: number;
  tools: number;
  checks: number;
  checksPassed: number;
  reroutes: number;
  /**
   * The decayed output level (0…7) and how long since this child last said
   * anything. Sampled by the FEEDER, not by the renderer.
   *
   * No cell draws the level as a ramp any more -- the card's mark is one static
   * glyph (see `liveMark`) -- but the measurement is not decoration and has not
   * gone away: a level of 0 past the quiet threshold is what turns the mark
   * faint, which is the one thing the ramp did that a timer-driven mark could
   * never do.
   */
  pulseStep: number;
  quietMs: number;
  /** Workflow grouping, when this member is a graph node rather than ad-hoc. */
  wave?: number;
  workflow?: string;
  /** True once the call has landed in the transcript. The live rung drops these
   *  (the transcript is reporting them now); the panel keeps them, in its own
   *  section, until `c`. */
  retired: boolean;
  /**
   * The durable id of this member's record in the session log (`task_<uuid>`).
   *
   * The card's own `id` is the call that dispatched it, which is how the
   * stream names it and means nothing once the process ends. This is how the
   * same member is found again: its whole conversation is stored under it, and
   * a transcript that was never held in memory -- or was trimmed -- is read
   * back by it. Known once the call returns; absent before that.
   */
  taskId?: string;
  /**
   * True for a card read back from the log rather than run in this process.
   *
   * Its state, its name and its span are the record's. Its token and tool
   * counts were never measured HERE, and a card that drew `0 tok` for it would
   * be stating a measurement nobody made -- so those rows are left out.
   */
  restored?: boolean;
}

/** How a session's agents and its readout reach the panel. */
export interface PanelView {
  running: AgentCard[];
  finished: AgentCard[];
  /** The card the panel's selection sits on, or null when there is nothing. */
  selectedId: string | null;
  /** The card whose transcript is open in the workspace split. */
  openId: string | null;
  /** Whether the panel has keyboard focus — the only thing that paints a
   *  selection. A marker on an unfocused list is a claim about where the keys
   *  go that is false. */
  focused: boolean;
}

// ─── Names ───

/** Longest name the card's column can carry before the pulse moves. */
const NAME_COLS = 11;

/**
 * The name this card is known by, and the rule for collisions.
 *
 * Order (P4 §2.6): the master's own `name` argument; else the harness's
 * derivation from the task shape (`scout-auth`, `build-ui`); else the ordinal.
 * The ordinal is the floor rather than the rule because a panel of `agent-1`
 * … `agent-5` is a count again, wearing five hats.
 *
 * Uniqueness is enforced HERE and not by the model, because the model cannot
 * see the other four calls it is writing in the same message: two `builder`s
 * is the ordinary case, not the exceptional one. The second gets `builder-2`,
 * and the suffix is fixed at registration and never recomputed — a name that
 * renumbered itself when a sibling finished would be worse than no name.
 */
export function resolveName(
  written: string | undefined,
  derived: string | undefined,
  ordinal: number,
  taken: ReadonlySet<string>,
): string {
  const clean = (v: string | undefined): string =>
    (v ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, NAME_COLS);
  const base = clean(written) || clean(derived) || `agent-${ordinal}`;
  if (!taken.has(base)) return base;
  // `builder`, `builder-2`, `builder-3`. Bounded by the fan-out's own width.
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, NAME_COLS - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `agent-${ordinal}`;
}

/**
 * The initials row's label for one card: the first letter, upper-cased, and the
 * first two when a single letter would collide.
 *
 * Collisions are resolved against the whole roster rather than pairwise, so the
 * row is stable while members come and go — `Pl Pa` stay two letters even after
 * the third `p` has finished.
 */
export function initialsFor(names: readonly string[]): string[] {
  const firstCounts = new Map<string, number>();
  for (const n of names) {
    const k = n.slice(0, 1).toUpperCase();
    firstCounts.set(k, (firstCounts.get(k) ?? 0) + 1);
  }
  const twoLetter = (n: string, one: string): string =>
    (n.slice(0, 1).toUpperCase() + n.slice(1, 2)).padEnd(2, one === "" ? "?" : " ").trim();

  // A second collision, one level deeper: two names that both escalate to two
  // letters and land on the IDENTICAL two-letter cell. `resolveName`'s own
  // dedup suffix produces exactly this shape (`builder`, `builder-2` share
  // their first two characters), so this is not a contrived case. Counted
  // against the whole roster, like the first level, so the row stays stable
  // while members come and go.
  const twoCounts = new Map<string, number>();
  for (const n of names) {
    const one = n.slice(0, 1).toUpperCase();
    if ((firstCounts.get(one) ?? 0) <= 1) continue;
    const two = twoLetter(n, one);
    twoCounts.set(two, (twoCounts.get(two) ?? 0) + 1);
  }
  const ordinalOf = new Map<string, number>();
  return names.map((n) => {
    const one = n.slice(0, 1).toUpperCase();
    if ((firstCounts.get(one) ?? 0) <= 1) return one;
    const two = twoLetter(n, one);
    if ((twoCounts.get(two) ?? 0) <= 1) return two;
    // Still identical at two letters: a stable ordinal takes the second cell
    // instead of the row silently repeating a mark no reader can tell apart --
    // the same deterministic, registration-order tie-break `resolveName` uses
    // for the names themselves.
    const nth = (ordinalOf.get(two) ?? 0) + 1;
    ordinalOf.set(two, nth);
    return `${one}${nth}`;
  });
}

// ─── Numbers, in the panel's own words ───

/** `12.4k`, `900`. Tokens, at the resolution a person compares them at. */
export function tokenWord(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** Elapsed under 2s is suppressed by the caller; `48s`, `2m 04s` past it. */
export function elapsedWord(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The same span with the spaces squeezed out, for a row carrying two cards. */
export function compactElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}`;
}

/** Below this an elapsed reading is noise pretending to be data — the same
 *  floor the live rung keeps (turn.ts ELAPSED_AFTER_MS). */
const ELAPSED_AFTER_MS = 2000;

function spanOf(card: AgentCard, now: number): string {
  if (card.startedAt == null) return "";
  const until = card.endedAt ?? now;
  return until - card.startedAt < ELAPSED_AFTER_MS ? "" : elapsedWord(until - card.startedAt);
}

// ─── The card's four rows ───

/**
 * A running member's cell: one mark, and it does not move.
 *
 * It was a bar on this member's byte rate (nine of them in a column was a
 * graphic equaliser), then the same bar eased on a timer phased on `startedAt`
 * -- and the founder's reading of that, 2026-10-02, is why it is neither now:
 * "the pulses of those sub agents ... not tightly coordinated to those agents'
 * realtime operation, just follows a deterministic behaviour. I don't want that
 * in Rune, just that one Glyph as the animation." A timer is not the member.
 *
 * So the member's cell says only what is measured and only when it changes: in
 * the text ink while its own output is arriving, faint once it has said nothing
 * for the quiet threshold -- beside the word `quiet 9s`, so a mono terminal
 * loses nothing. What the fleet is DOING is the rung's glyph, which every
 * member's output strikes.
 */
function liveMark(card: AgentCard): string {
  const silent = card.quietMs >= QUIET_AFTER_MS && card.pulseStep === 0;
  return silent ? faint(glyph("live")) : text(glyph("live"));
}

/**
 * Row one: `› 1  planner    ◇  2m 04s`.
 *
 * Three fixed cells before the name — the selection mark, the open-pane mark,
 * and the ordinal — so the name column starts in the same place on every row
 * whatever the marks are doing. That column is the whole reason the panel
 * scans: a list whose names start one cell apart reads as ragged rather than
 * as a list.
 */
function headRow(card: AgentCard, index: number, view: PanelView, now: number, width: number) {
  const selected = view.focused && view.selectedId === card.id;
  const mark = selected ? glyph("selection") : " ";
  const open = view.openId === card.id ? accent(glyph("phase")) : " ";
  const ordinal = index <= 9 ? String(index) : " ";
  const name = card.name.padEnd(NAME_COLS).slice(0, NAME_COLS);
  // Settled members give the pulse cell up to their verdict: a pulse on a
  // finished row would be reporting liveness for something that is not alive.
  const beat =
    card.state === "done"
      ? ok(glyph("verified"))
      : card.state === "failed"
        ? danger(glyph("failure"))
        : card.state === "skipped"
          ? faint(glyph("observed"))
          : card.state === "queued"
            ? faint(glyph("live"))
            : liveMark(card);
  // The stall is STATED. Past the quiet threshold the row swaps its clock's
  // tail for the word, because a flat pulse and a dead pulse are the same cell.
  const quiet =
    card.state === "running" && card.quietMs >= QUIET_AFTER_MS
      ? `quiet ${Math.floor(card.quietMs / 1000)}s`
      : "";
  const openWord = view.openId === card.id ? "OPEN" : "";
  const tail = F.receiptOf([spanOf(card, now), quiet]);
  const left = `${mark}${open}${muted(ordinal)}  ${text(name)}${beat}  ${faint(tail)}`;
  const row = clampVisible(openWord ? `${left}  ${accent(openWord)}` : left, width);
  // The member the keys are on is the full-width bar, like every other list.
  return selected ? F.band(row, width) : row;
}

/** Rows two to four, indented to the name column so the card reads as a block. */
const CARD_INDENT = "     ";

function detailRow(body: string, width: number): string {
  return clampVisible(`${CARD_INDENT}${body}`, width);
}

/**
 * One verdict, drawn as the mark and the word.
 *
 * Never the mark alone: `✓` is an accelerant for people who can see it, and the
 * row has to survive `NO_COLOR`, a seven-bit terminal and a reader who is
 * scanning. So the rung's glyph, then what it was a verdict ABOUT.
 */
export function receiptLine(receipt: CardReceipt, width: number): string {
  const mark = glyph(receipt.rung);
  const paint =
    receipt.rung === "verified"
      ? ok
      : receipt.rung === "failure"
        ? danger
        : receipt.rung === "suspected"
          ? muted
          : faint;
  return `${paint(mark)} ${text(truncate(receipt.text, Math.max(4, width - 2)))}`;
}

/**
 * The whole card, at the rung the panel can afford.
 *
 *   full  — head, verdict, brief, accounting (4 rows)
 *   short — head, verdict-or-brief (2 rows)
 *   line  — head only (1 row)
 *
 * DEVIATION FROM THE MOCK, on purpose (founder review, 2026-09-14). The mock's
 * card is head / brief / heartbeat / accounting. This one leads its detail rows
 * with the member's last RECEIPT — what it verified or failed, carrying the
 * rung it earned — because the panel is an audit surface and not activity
 * theatre. The heartbeat is what the member is doing this second and the
 * accounting is what it has spent; neither is a claim anybody can act on. The
 * row budget is unchanged at four, and a member that has proved nothing yet
 * draws exactly the mock's card — brief, heartbeat, accounting — because
 * absent is not zero here either.
 */
export type CardRung = "full" | "short" | "line";

export function renderCard(
  card: AgentCard,
  index: number,
  view: PanelView,
  rung: CardRung,
  width: number,
  now: number,
): string[] {
  const rows = [headRow(card, index, view, now, width)];
  if (rung === "line") return rows;
  const inner = Math.max(8, width - CARD_INDENT.length);
  const brief = card.brief ? muted(truncate(card.brief, inner)) : "";
  const verdict = card.receipt ? receiptLine(card.receipt, inner) : "";
  // The lead. A member with a verdict leads with it; one without leads with
  // what it was sent to do, which is the only claim it has made so far.
  const lead = verdict || brief;
  if (lead) rows.push(detailRow(lead, width));
  if (rung === "short") return rows;
  // Second detail row: the contract when the verdict took the lead, else what
  // it is doing NOW. A settled member has nothing in flight and says nothing
  // rather than holding its last move up as though it were still making it.
  const second = verdict
    ? brief
    : card.state === "running" && card.note
      ? faint(truncate(card.note, inner))
      : "";
  if (second) rows.push(detailRow(second, width));
  // Bookkeeping, last and quiet. Absent is not zero: a member that ran no
  // checks says nothing about checks.
  const parts = [
    // A card read back from the log was not metered by this process. It says
    // where it came from instead of a zero it did not measure.
    card.restored ? "from the session log" : `${tokenWord(card.tokens)} tok`,
    card.tools > 0 ? `${card.tools} tool${card.tools === 1 ? "" : "s"}` : "",
    card.checks > 0 ? `${card.checksPassed}/${card.checks} checks` : "",
    card.reroutes > 0 ? `${card.reroutes} reroute${card.reroutes === 1 ? "" : "s"}` : "",
    card.retired && view.openId !== card.id ? "enter view" : "",
  ];
  rows.push(detailRow(faint(truncate(F.receiptOf(parts), inner)), width));
  return rows;
}

// ─── The panel ───

/** A section heading and its rule: `AGENTS   3 running` over 38 dashes. */
function heading(title: string, right: string, width: number): string[] {
  return [
    F.row(faint(title), right ? faint(right) : "", width),
    faint(glyph("rule").repeat(Math.max(1, width))),
  ];
}

/**
 * Two cards on one row, for a fan-out too wide to give each of them four.
 *
 *     › 1 planner  ◇ 2m04   2 builder ◇ 1m12
 */
function pairRow(
  cards: Array<{ card: AgentCard; index: number }>,
  view: PanelView,
  width: number,
  now: number,
): string {
  const cell = Math.max(12, Math.floor((width - 2) / 2));
  const one = ({ card, index }: { card: AgentCard; index: number }): string => {
    const mark = view.focused && view.selectedId === card.id ? glyph("selection") : " ";
    const beat =
      card.state === "done"
        ? glyph("verified")
        : card.state === "failed"
          ? glyph("failure")
          : glyph("live");
    const span =
      card.startedAt == null ? "" : compactElapsed((card.endedAt ?? now) - card.startedAt);
    const name = truncate(card.name, Math.max(4, cell - 8));
    const body = `${mark}${index <= 9 ? index : " "} ${name.padEnd(Math.max(4, cell - 8))} ${beat} ${span}`;
    return truncate(body, cell).padEnd(cell);
  };
  return clampVisible(faint(cards.map(one).join("  ")), width);
}

/**
 * Everybody, one cell each: `P◇ B◇ V◇ S✓ M✓ T✗ D· R· C·      +3`.
 *
 * The floor of the ladder, and the point at which the panel stops pretending to
 * be a list. A mark rides beside each initial so the row still says who is
 * running and who is back; the full roster stays reachable by `ctrl+f` and the arrows, which
 * walk every member regardless of what the panel can draw.
 */
function initialsRow(cards: AgentCard[], view: PanelView, width: number): string {
  const marks = initialsFor(cards.map((c) => c.name));
  const cells = cards.map((card, i) => {
    const beat =
      card.state === "done"
        ? glyph("verified")
        : card.state === "failed"
          ? glyph("failure")
          : card.state === "running"
            ? glyph("live")
            : glyph("observed");
    const cell = `${marks[i]}${beat}`;
    return view.focused && view.selectedId === card.id ? accent(cell) : faint(cell);
  });
  let shown = cells.length;
  const fits = (n: number): number => n * 3 + (n < cells.length ? 6 : 0);
  while (shown > 1 && fits(shown) > width) shown--;
  const kept = cells.slice(0, shown).join(" ");
  const more = shown < cells.length ? faint(`+${cells.length - shown}`) : "";
  return F.row(kept, more, width);
}

/**
 * Choose the densest rung whose total fits, and give the selected card one
 * rung more than its neighbours.
 *
 * Exported because the ladder is the part with a decision in it, and a test for
 * it should not need a terminal.
 */
export function chooseRungs(
  running: number,
  finished: number,
  rows: number,
): { rung: CardRung; pairs: boolean; initials: boolean } {
  // Two headings + their rules + a blank between the sections.
  const chrome = 2 + (finished > 0 ? 3 : 0);
  const body = Math.max(0, rows - chrome);
  const members = running + finished;
  if (members === 0) return { rung: "full", pairs: false, initials: false };
  if (members * 4 <= body) return { rung: "full", pairs: false, initials: false };
  if (members * 2 + 2 <= body) return { rung: "short", pairs: false, initials: false };
  if (members <= body) return { rung: "line", pairs: false, initials: false };
  // The floor. Two cards to a row and an initials row under them, and if even
  // that overflows the frame clamps it -- there is no rung below "everybody,
  // one cell each", and inventing one would mean dropping members silently.
  return { rung: "line", pairs: true, initials: true };
}

/**
 * The right column while agents exist: running, then finished.
 *
 * Rows never re-sort. The second row is still the same sub-agent it was a
 * minute ago, including after the first one finishes — a list that re-orders
 * itself under the eye cannot be tracked, and being able to track it is the
 * entire point.
 */
export function renderAgentsPanel(
  view: PanelView,
  width: number,
  rows: number,
  now: number = Date.now(),
): string[] {
  const { running, finished } = view;
  const plan = chooseRungs(running.length, finished.length, rows);
  const index = new Map<string, number>();
  [...running, ...finished].forEach((c, i) => index.set(c.id, i + 1));

  const out: string[] = [];
  const runningWord =
    running.length === 0 ? (finished.length > 0 ? "all back" : "") : `${running.length} running`;
  out.push(...heading("AGENTS", runningWord, width));

  if (running.length === 0 && finished.length === 0) {
    out.push("");
    out.push(clampVisible(`  ${faint("no agents this session")}`, width));
    out.push(clampVisible(`  ${faint("a fan-out's cards land here, one per child")}`, width));
    return out;
  }

  const draw = (cards: AgentCard[]): void => {
    if (plan.pairs) {
      for (let i = 0; i < cards.length; i += 2) {
        const pair = cards
          .slice(i, i + 2)
          .map((card) => ({ card, index: index.get(card.id) ?? 0 }));
        out.push(pairRow(pair, view, width, now));
      }
      return;
    }
    for (const card of cards) {
      const rung: CardRung =
        view.selectedId === card.id && plan.rung === "line" ? "short" : plan.rung;
      out.push(...renderCard(card, index.get(card.id) ?? 0, view, rung, width, now));
    }
  };

  draw(running);
  if (finished.length > 0) {
    out.push("");
    out.push(...heading(`FINISHED ${finished.length}`, "c clear", width));
    draw(finished);
  }
  if (plan.initials) {
    out.push(faint(glyph("rule").repeat(Math.max(1, width))));
    out.push(initialsRow([...running, ...finished], view, width));
  }
  // The budget is a budget. Past it the column says how many it could not
  // draw rather than cutting a card off mid-way and leaving the reader to
  // wonder whether that was all of them -- and the arrows still walk every
  // member regardless of what fits.
  if (rows > 0 && out.length > rows) {
    const kept = out.slice(0, Math.max(1, rows - 1));
    kept.push(clampVisible(faint(`  +${out.length - kept.length} more rows`), width));
    return kept;
  }
  return out;
}

// ─── The idle readout ───

/**
 * `/status`'s content as a column rather than as a paragraph printed into the
 * transcript (P4 §2.4).
 *
 * Every field optional, and an absent field draws no row: a readout that
 * printed `cost  $0.00` before the first call would be stating a measurement it
 * has not made. `/status` itself stays, as the same content printed into the
 * workspace for copying.
 */
export interface SessionReadout {
  contextPercent?: number;
  contextUsed?: number;
  contextLimit?: number;
  model?: string;
  effort?: string;
  route?: string;
  costUsd?: number;
  toolCalls?: number;
  toolBreakdown?: string;
  filesChanged?: number;
  added?: number;
  removed?: number;
  sandbox?: string;
  gear?: string;
  lastCheck?: string;
}

/** Label column: the readout is a table of facts, so the facts line up. */
const LABEL_COLS = 9;

/**
 * The context meter: `[███████             ]  34%`.
 *
 * Built from the top of the pulse ramp rather than from a private block
 * character, so a seven-bit terminal folds it to `[#######      ]` through the
 * same rung everything else uses, and an ambiguous-width locale gets the ASCII
 * twin rather than a cell that eats its neighbour.
 */
export function contextBar(percent: number, cells = 20): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const full = PULSE_GLYPHS[PULSE_GLYPHS.length - 1]!;
  const mark = TERMINAL_GLYPH_MODE === "utf8" ? full.utf8 : full.ascii;
  const filled = Math.min(cells, Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * cells)));
  return `[${mark.repeat(filled)}${" ".repeat(cells - filled)}]`;
}

export function renderSessionPanel(
  readout: SessionReadout,
  width: number,
  agents?: { running: number; finished: number },
): string[] {
  const out = [...heading("SESSION", "", width)];
  const field = (label: string, value: string): void => {
    if (!value) return;
    out.push(clampVisible(`  ${faint(label.padEnd(LABEL_COLS))}${value}`, width));
  };
  const wrapField = (value: string): void => {
    out.push(clampVisible(`  ${" ".repeat(LABEL_COLS)}${faint(value)}`, width));
  };

  // FIRST, and a deviation from the mock's ordering, on purpose (founder
  // review, 2026-09-14): the idle column follows the card's rule. `check` is
  // the one field that says whether the current state of the tree has been
  // tested at all; context, cost and tool counts are what it cost to get here.
  // A readout that buried the verdict under the bookkeeping was reporting
  // spend to somebody who came to the column to ask about evidence.
  field("check", readout.lastCheck ?? "");
  if (readout.contextPercent != null) {
    // The bar's cells shrink with the column rather than overrunning it: the
    // percent is the fact, the bar is the shape of the fact. Budgeted against
    // the row it shares -- two cells of indent, the label, the two brackets,
    // the two-cell gap and the reading itself -- so `100%` costs the bar a
    // cell instead of costing the row its last character.
    const reading = `${Math.round(readout.contextPercent)}%`;
    const cells = Math.max(6, Math.min(20, width - LABEL_COLS - 6 - reading.length));
    field("context", `${faint(contextBar(readout.contextPercent, cells))}  ${text(reading)}`);
    if (readout.contextUsed != null && readout.contextLimit != null) {
      wrapField(`${tokenWord(readout.contextUsed)} / ${tokenWord(readout.contextLimit)} tokens`);
    }
  }
  // `gpt-5.6-sol  max`: the model and the effort it is running at are one
  // fact about one thing, so they share a field rather than a separator.
  field("model", [readout.model, readout.effort].filter(Boolean).join("  "));
  field("route", readout.route ?? "");
  field("cost", readout.costUsd != null ? `$${readout.costUsd.toFixed(2)} this session` : "");
  if (readout.toolCalls != null && readout.toolCalls > 0) {
    field("tools", `${readout.toolCalls} call${readout.toolCalls === 1 ? "" : "s"}`);
    if (readout.toolBreakdown) wrapField(readout.toolBreakdown);
  }
  if (readout.filesChanged != null && readout.filesChanged > 0) {
    const diff =
      readout.added != null || readout.removed != null
        ? `  +${readout.added ?? 0} -${readout.removed ?? 0}`
        : "";
    field("changed", `${readout.filesChanged} file${readout.filesChanged === 1 ? "" : "s"}${diff}`);
  }
  field("sandbox", readout.sandbox ?? "");
  field("gear", readout.gear ?? "");

  // The agents heading stays on the idle panel when any ran this session: the
  // finished section is reachable, and saying so is the difference between
  // "they are gone" and "they are one key away".
  if (agents && (agents.running > 0 || agents.finished > 0)) {
    out.push("");
    out.push(...heading("AGENTS", agents.finished > 0 ? "c clear" : "", width));
    out.push(
      clampVisible(
        `  ${faint(F.receiptOf([`${agents.running === 0 ? "none" : agents.running} running`, `${agents.finished} finished this turn`]))}`,
        width,
      ),
    );
    out.push(clampVisible(`  ${faint("ctrl+f to review them")}`, width));
  }
  return out;
}

// ─── The members on the rung ───

/**
 * One block per member in flight, set down after the rung's own words:
 *
 *     ▁▂▅▂▁▁▁▂▄▂▁▁ looking · 18s  [planner] [builder] [verifier ✓]
 *
 * The founder's sketch (2026-10-02): the glyph, and then a box for each agent
 * "to showcase that an agent is live ... but there should be one universal
 * glyph which would showcase the full work". So a block is a NAME in a box and
 * nothing else. It does not animate -- the glyph before it is the animation,
 * and it is struck by all of them together -- and what it says changes only
 * when something measured changes: in the text ink while the member's own
 * output is arriving, faint while it is queued or has gone quiet, a tick or a
 * cross once it is back and before its call has landed in the transcript.
 *
 * This replaces the collapsed strip, which took the rung's place whenever a
 * member existed -- hiding the glyph at exactly the moment the most was
 * happening -- and drew each member a bar breathing on a timer.
 *
 * It names the members it has room for and counts the rest (`+2`); with room
 * for none it is a count with a noun (`4 agents`), never a bare number.
 *
 * With `selectedId` the same blocks are the SELECTOR: the keys are on the row,
 * one block carries the selection, and the window follows it.
 *
 *     ▁▂▅▂▁ looking · 18s  [planner]›[builder] [verifier ✓] +2
 *
 * The selection is the `›` in the cell before the block and the product's one
 * selection ink on the block itself (`F.band`'s, at the width of a block) --
 * the mark where there is no colour at all, the ink where there is. Nothing
 * else about a block changes when it is selected, and the row does not grow:
 * the members it cannot draw are counted on the side they are on.
 */
export function agentBlocks(
  cards: readonly AgentCard[],
  room: number,
  marks: { selectedId?: string | null } = {},
): string {
  if (cards.length === 0) return "";
  const selected = marks.selectedId ? cards.findIndex((c) => c.id === marks.selectedId) : -1;
  if (selected >= 0) return selectorBlocks(cards, selected, room);
  const blocks: string[] = [];
  let spent = 0;
  for (const [i, card] of cards.entries()) {
    const block = blockText(card);
    const rest = cards.length - i - 1;
    // Room for this block, its gap, and the `+N` it would leave owing.
    const owing = rest > 0 ? visLen(`+${rest}`) + 1 : 0;
    if (spent + visLen(block) + (blocks.length > 0 ? 1 : 0) + owing > room) break;
    spent += visLen(block) + (blocks.length > 0 ? 1 : 0);
    blocks.push(blockInk(card)(block));
  }
  if (blocks.length === 0)
    return faint(`${cards.length} ${cards.length === 1 ? "agent" : "agents"}`);
  const left = cards.length - blocks.length;
  return left > 0 ? `${blocks.join(" ")} ${faint(`+${left}`)}` : blocks.join(" ");
}

/** `[planner]`, `[builder ✓]`, `[verifier ✗]`: a name in a box, and how it
 *  ended once it has. */
function blockText(card: AgentCard): string {
  const settled =
    card.state === "done"
      ? ` ${glyph("verified")}`
      : card.state === "failed"
        ? ` ${glyph("failure")}`
        : card.state === "skipped"
          ? ` ${glyph("observed")}`
          : "";
  return `[${card.name}${settled}]`;
}

/** In the text ink while its own output is arriving, faint while it is queued,
 *  quiet or back, and the failure ink when it failed. */
function blockInk(card: AgentCard): (value: string) => string {
  if (card.state === "failed") return danger;
  const silent =
    card.state !== "running" || (card.quietMs >= QUIET_AFTER_MS && card.pulseStep === 0);
  return silent ? faint : text;
}

/**
 * The blocks with one of them selected, windowed so the selection is drawn.
 *
 * Each block is preceded by one cell: `›` before the selected one, a space
 * before the rest -- so moving the selection changes two cells and nothing
 * shifts. The window grows outward from the selection, right then left, and
 * what falls outside it is counted where it fell: `+2 [c]›[d] [e] +3`.
 */
function selectorBlocks(cards: readonly AgentCard[], selected: number, room: number): string {
  const cells = cards.map(blockText);
  const cost = (i: number): number => visLen(cells[i]!) + 1;
  // What a count costs on its side, the cell that separates it included.
  const owing = (hidden: number): number => (hidden > 0 ? String(hidden).length + 2 : 0);
  let start = selected;
  let end = selected + 1;
  let used = cost(selected);
  for (;;) {
    let grew = false;
    if (
      end < cards.length &&
      used + cost(end) + owing(start) + owing(cards.length - end - 1) <= room
    ) {
      used += cost(end);
      end++;
      grew = true;
    }
    if (
      start > 0 &&
      used + cost(start - 1) + owing(start - 1) + owing(cards.length - end) <= room
    ) {
      used += cost(start - 1);
      start--;
      grew = true;
    }
    if (!grew) break;
  }
  let out = "";
  for (let i = start; i < end; i++) {
    const card = cards[i]!;
    out +=
      i === selected
        ? `${accent(glyph("selection"))}${speakerSurface(cells[i]!)}`
        : ` ${blockInk(card)(cells[i]!)}`;
  }
  // The first block's lead is a space unless it is the selected one; dropped,
  // so the row keeps its ordinary two-space gap before the blocks.
  if (out.startsWith(" ")) out = out.slice(1);
  const before = start > 0 ? `${faint(`+${start}`)} ` : "";
  const after = end < cards.length ? ` ${faint(`+${cards.length - end}`)}` : "";
  return `${before}${out}${after}`;
}

/**
 * What the row above the composer says about members that are no longer in
 * flight: how many came back, in words. Their cards, tokens and transcripts are
 * the panel's (`ctrl+f`); the rung only says they are there to be read.
 */
export function agentsBack(view: PanelView): string {
  const back = view.finished.length;
  return back === 0 ? "" : `${back} ${back === 1 ? "agent" : "agents"} back`;
}

/**
 * The key that reaches the agents, said on the rung wherever there is one to
 * reach.
 *
 * `->` is the right arrow, spelled the way the product already spells an arrow
 * (the reroute row, the steer receipt): the glyph itself is outside the closed
 * alphabet and has no one-cell ASCII twin. It replaced `ctrl+f agents`, which
 * named a key that did nothing for the whole of a running turn -- the only time
 * a sub-agent is live to be looked at.
 */
export const AGENTS_KEY_HINT = "-> agents";

// ─── The keys ───

/**
 * Where the agents keys currently go.
 *
 *   composer  nowhere: the field has them, as always.
 *   row       the blocks on the rung, in place. Arrows move, enter opens.
 *   cards     the full roster (`ctrl+f`): a card per member, with what each
 *             proved and what it spent.
 *   view      one member's transcript is open in the workspace.
 */
export type AgentFocus = "composer" | "row" | "cards" | "view";

export interface AgentKeyState {
  focus: AgentFocus;
  /** Members in the ledger, running or back. */
  members: number;
  /** Nothing is typed in the composer. */
  empty: boolean;
  /** A turn is in flight, as opposed to the surface being at rest. */
  streaming: boolean;
}

/** What an agents key asks for. `none` means it is not one: it belongs to the
 *  composer or the turn, and falls through to them untouched. */
export type AgentKeyAction =
  | { kind: "none" }
  /** Claimed, and nothing happens: the key is the agents' here, with nowhere
   *  to go. It must not fall through to mean something else underneath. */
  | { kind: "stay" }
  | { kind: "focus" }
  | { kind: "move"; delta: -1 | 1 }
  | { kind: "jump"; ordinal: number }
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "cards" }
  | { kind: "clear" };

const NONE: AgentKeyAction = { kind: "none" };

/**
 * Does this key, pressed with the keys on the COMPOSER, step onto the agents
 * row?
 *
 * This is the one decision in the feature that is a matter of taste rather
 * than of correctness, and it is isolated here so changing it is one line and
 * one test.
 *
 * TODO(human): the entry gesture. Today it is the right arrow on an empty
 * composer -- a key that otherwise does nothing there, that a scroll wheel
 * never sends (alternate-scroll mode delivers the wheel as UP and DOWN, so
 * either of those would focus the row every time a trackpad overshot the
 * bottom of the transcript), and that points the way the blocks run. Left is
 * not an entry: at rest, left on an empty composer already opens the sessions
 * panel. If you want left to enter too while a turn is streaming (it is free
 * there), or `tab`, add it here; `state.streaming` tells the two apart.
 * Whatever is chosen must be a key that cannot be typed by accident, because
 * the next enter opens a transcript instead of sending a message.
 */
export function entersAgentRow(key: Key, state: AgentKeyState): boolean {
  return key.type === "right" && state.empty && state.members > 0;
}

/**
 * What a key means to the agents, given where the keys currently go.
 *
 * Pure, so the whole table is a unit test and none of it needs a terminal.
 * Three properties it is built to keep:
 *
 *   Typing is never swallowed. On the row and in a transcript no printable key
 *   is an agents key -- not even a digit -- so a message typed with the row
 *   focused arrives whole, and the caller hands the keys back to the composer
 *   on the first character.
 *
 *   `esc` is always one step back and never further. With the keys on the
 *   agents it returns them; only with the keys on the composer does it reach
 *   the turn, where it interrupts. Before this, `esc` on the panel during a
 *   running turn aborted the run it was being used to look at.
 *
 *   Every focus has the same two keys out: `esc`, and `ctrl+f` for the cards.
 */
export function agentKeyAction(key: Key, state: AgentKeyState): AgentKeyAction {
  // `ctrl+f` is the cards from anywhere, and the way back from them.
  if (key.type === "ctrl" && key.name === "f") return { kind: "cards" };
  if (state.focus === "composer") {
    return entersAgentRow(key, state) ? { kind: "focus" } : NONE;
  }
  if (key.type === "esc") return { kind: "back" };
  switch (state.focus) {
    case "row":
      if (state.members === 0) return NONE;
      if (key.type === "left") return { kind: "move", delta: -1 };
      if (key.type === "right") return { kind: "move", delta: 1 };
      if (key.type === "enter" && state.empty) return { kind: "open" };
      return NONE;
    case "cards":
      if (state.members === 0) return NONE;
      if (key.type === "up") return { kind: "move", delta: -1 };
      if (key.type === "down") return { kind: "move", delta: 1 };
      if (key.type === "enter") return { kind: "open" };
      if (key.type === "char" && /^[1-9]$/.test(key.value)) {
        return { kind: "jump", ordinal: Number(key.value) };
      }
      if (key.type === "char" && key.value === "c") return { kind: "clear" };
      return NONE;
    case "view":
      // The arrows switch transcripts only while nothing is typed: over a
      // draft they are the caret's, as they are everywhere else.
      if (!state.empty) return NONE;
      if (key.type !== "left" && key.type !== "right") return NONE;
      // With one agent there is no neighbour -- and the key still belongs to
      // the transcript. Let through, `left` on an empty composer would open
      // the sessions panel over the transcript being read.
      if (state.members < 2) return { kind: "stay" };
      return { kind: "move", delta: key.type === "left" ? -1 : 1 };
  }
}

/**
 * The key legend for wherever the agents keys are, in the composer's hint row.
 *
 * Each legend is a ladder: the tail is given up first when the row is narrow,
 * and the way out is the last thing to go.
 */
export function agentsHint(focus: AgentFocus, view: PanelView, max = 200): string {
  const sep = ` ${glyph("observed")} `;
  const members = view.running.length + view.finished.length;
  const tiers = ((): string[][] => {
    switch (focus) {
      case "row":
        return [
          ["left/right select", "enter open", "ctrl+f cards", "esc back"],
          ["left/right select", "enter open", "esc back"],
          ["enter open", "esc back"],
        ];
      case "view":
        return members > 1
          ? [
              ["left/right switch", "up/down scroll", "esc back"],
              ["left/right switch", "esc back"],
              ["esc back"],
            ]
          : [["up/down scroll", "esc back"], ["esc back"]];
      case "cards": {
        const keys = panelHint(view);
        return [[keys, "esc back"], [keys], ["esc back"]];
      }
      case "composer":
        return [[]];
    }
  })();
  for (const tier of tiers) {
    const line = tier.filter((part) => part !== "").join(sep);
    if (visLen(line) <= max) return line;
  }
  return "";
}

/**
 * The most recent verdict in a roster, with the card that earned it.
 *
 * By the receipt's own timestamp rather than by list position: a finished
 * member can easily hold the newest one, and ordering by where a card sits
 * would report the freshest fact as whatever happens to be at the top.
 */
export function newestReceipt(
  cards: readonly AgentCard[],
): { card: AgentCard; receipt: CardReceipt } | null {
  let best: { card: AgentCard; receipt: CardReceipt } | null = null;
  for (const card of cards) {
    if (!card.receipt) continue;
    if (!best || card.receipt.at > best.receipt.at) best = { card, receipt: card.receipt };
  }
  return best;
}

/** The key legend the composer's hint row carries while the panel has focus. */
export function panelHint(view: PanelView): string {
  const sep = ` ${glyph("observed")} `;
  if (view.running.length === 0 && view.finished.length === 0) {
    return ["ctrl+f back", "esc composer"].join(sep);
  }
  return [
    // `up/down`, not the arrow glyphs the mock draws: ↑ and ↓ are outside the
    // closed alphabet, have no one-cell ASCII twin, and would be mojibake on a
    // seven-bit terminal. Every other key legend in the product already spells
    // them this way (composer.ts's pickers, held.ts), so the ASCII rung costs
    // nothing and the idiom is the existing one.
    "up/down select",
    view.openId ? "ctrl+w close" : "enter open",
    view.finished.length > 0 ? "c clear" : "",
  ]
    .filter((p) => p !== "")
    .join(sep);
}

// ─── The ledger ───

/** What a card carries when it is first registered. */
export interface RegisterInput {
  id: string;
  kind: "task" | "worker";
  brief: string;
  /** The name the MASTER wrote, when it wrote one. */
  written?: string;
  /** The harness's derivation from the task shape. */
  derived?: string;
  wave?: number;
  workflow?: string;
  state?: AgentState;
  startedAt?: number;
}

/**
 * Every agent this session has dispatched, and each one's transcript.
 *
 * Session-scoped on purpose. `TurnRenderer.fleet` is cleared at `turn_complete`
 * and `Tui.liveTurn` is nulled immediately after, so a panel reading either of
 * them goes blank the instant the work finishes — which is the one moment the
 * finished section exists to survive. The founder's requirement ("finished
 * agents persist with a `c clear`") is therefore a lifetime question before it
 * is a rendering question, and this is the answer to it.
 */
export class FleetLedger {
  private cards = new Map<string, AgentCard>();
  /** Each child's transcript rows, and the writer a RUNNING child's events go
   *  through. See ./child-transcript.ts. */
  private logs = new Map<string, ChildLog>();
  private writers = new Map<string, ChildTranscript>();
  /**
   * One accumulator per child, fed by that child's own events.
   *
   * Here rather than on the renderer's fleet entry because the two have
   * different lifetimes: the entry is deleted when the call lands in the
   * transcript and the card outlives it. A pulse that died with the entry
   * would leave a finished card's last cell reading whatever the map happened
   * to contain, which is the kind of number that looks measured and is not.
   */
  private pulses = new Map<string, Pulse>();
  private names = new Set<string>();
  private ordinal = 0;
  /** The card the arrows sit on. An id rather than an index, so a card
   *  finishing above the selection does not move it. */
  private selected: string | null = null;
  /** The open pane, so a card's header can be refreshed in place. */
  private pane: { id: string; name: string; note?: string; lines: string[] } | null = null;
  /**
   * Where the agents keys currently go.
   *
   * Written by the frame, which owns focus, and read by the rung, which has to
   * draw it: the renderer that builds the rung's row is rebuilt every turn and
   * knows nothing about the frame, and this ledger is the one object both
   * already share. Held here for the same reason the selection is.
   */
  private focus: AgentFocus = "composer";

  register(input: RegisterInput): AgentCard {
    const existing = this.cards.get(input.id);
    if (existing) return existing;
    this.ordinal++;
    const name = resolveName(input.written, input.derived, this.ordinal, this.names);
    this.names.add(name);
    const card: AgentCard = {
      id: input.id,
      name,
      brief: input.brief,
      kind: input.kind,
      state: input.state ?? "queued",
      note: "",
      tokens: 0,
      costUsd: 0,
      tools: 0,
      checks: 0,
      checksPassed: 0,
      reroutes: 0,
      pulseStep: 0,
      quietMs: 0,
      retired: false,
      ...(input.startedAt != null ? { startedAt: input.startedAt } : {}),
      ...(input.wave != null ? { wave: input.wave } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
    };
    this.cards.set(input.id, card);
    this.selected ??= card.id;
    return card;
  }

  /**
   * Rename a card once its arguments have finished streaming.
   *
   * A delegation's name arrives as JSON fragments, so the card is registered
   * before it is nameable. Re-resolving is allowed only while the card is still
   * wearing an ordinal — once a real name is on screen it is the name, because
   * a row that renames itself mid-run is a row you cannot follow.
   */
  rename(id: string, written?: string, derived?: string): void {
    const card = this.cards.get(id);
    if (!card || !/^agent-\d+$/.test(card.name)) return;
    const proposed = resolveName(written, derived, this.ordinal, this.names);
    if (proposed === card.name || /^agent-\d+$/.test(proposed)) return;
    this.names.delete(card.name);
    this.names.add(proposed);
    card.name = proposed;
    if (this.pane?.id === id) this.pane.name = proposed;
  }

  get(id: string): AgentCard | undefined {
    return this.cards.get(id);
  }

  all(): AgentCard[] {
    return [...this.cards.values()];
  }

  /**
   * Record real output from one child. `units` is bytes where bytes exist and
   * one of `PULSE_WEIGHT` otherwise — the same contract the parent's pulse
   * keeps, because it is the same class and the same promise: feeding zero to
   * keep a row alive is the lie the whole mechanism exists to prevent.
   */
  feed(id: string, units: number, now: number = Date.now()): void {
    let pulse = this.pulses.get(id);
    if (!pulse) {
      pulse = new Pulse(now);
      this.pulses.set(id, pulse);
    }
    pulse.feed(units, now);
  }

  /**
   * Turn the accumulators into the two numbers a card states.
   *
   * Done HERE, at the state boundary, and not in `renderCard`: a renderer that
   * sampled a clock would be a spinner with extra steps, and the panel has to
   * stay a pure function of its cards for the tests that draw it without a
   * terminal. A settled member is left exactly as it was — its liveness is a
   * closed question and its last reading is not evidence of anything.
   */
  sample(now: number = Date.now()): void {
    for (const card of this.cards.values()) {
      if (card.retired || card.state !== "running") continue;
      const pulse = this.pulses.get(card.id);
      if (!pulse) continue;
      const s = pulse.sample(now);
      card.pulseStep = s.step;
      card.quietMs = s.quietMs;
    }
  }

  view(focused: boolean, now: number = Date.now()): PanelView {
    this.sample(now);
    const all = this.all();
    return {
      running: all.filter((c) => !c.retired),
      finished: all.filter((c) => c.retired),
      selectedId: this.selectedId(),
      openId: this.pane?.id ?? null,
      focused,
    };
  }

  /** The ordered roster the keys walk: running first, then finished, in
   *  dispatch order — the same order the panel draws. */
  order(): AgentCard[] {
    const all = this.all();
    return [...all.filter((c) => !c.retired), ...all.filter((c) => c.retired)];
  }

  selectedId(): string | null {
    const order = this.order();
    if (order.length === 0) return null;
    if (this.selected && order.some((c) => c.id === this.selected)) return this.selected;
    return order[0]!.id;
  }

  /** Tell the ledger where the keys are. Returns whether that changed, so the
   *  frame knows the rung has to be drawn again. */
  setFocus(focus: AgentFocus): boolean {
    if (focus === this.focus) return false;
    this.focus = focus;
    return true;
  }

  /**
   * The member the rung should mark, or null when the keys are elsewhere.
   *
   * On the row it is the selection. In a transcript it is the member whose
   * transcript is open -- the block that says which one you are reading -- so
   * the arrows that switch transcripts move the same mark the row's did.
   */
  marked(): string | null {
    if (this.focus === "row") return this.selectedId();
    if (this.focus === "view") return this.pane?.id ?? null;
    return null;
  }

  /** Move the selection by `delta`, wrapping. Survives a repaint because it is
   *  held here, not rebuilt from the frame. */
  move(delta: number): void {
    const order = this.order();
    if (order.length === 0) return;
    const at = Math.max(
      0,
      order.findIndex((c) => c.id === this.selectedId()),
    );
    this.selected = order[(at + delta + order.length) % order.length]!.id;
  }

  /** Put the selection on one card by id. Returns false when it is not here. */
  select(id: string): boolean {
    if (!this.cards.has(id)) return false;
    this.selected = id;
    return true;
  }

  /** `1`–`9`: select that agent directly. Returns false when there is no Nth. */
  selectIndex(n: number): boolean {
    const card = this.order()[n - 1];
    if (!card) return false;
    this.selected = card.id;
    return true;
  }

  /** One child's transcript, by id. Created on first use, and the same object
   *  for the life of the card. */
  log(id: string): ChildLog {
    let log = this.logs.get(id);
    if (!log) {
      log = new ChildLog();
      this.logs.set(id, log);
    }
    return log;
  }

  /** The writer a running child's own events go through. One per child, so an
   *  open paragraph and the calls in flight survive between events. */
  transcript(id: string): ChildTranscript {
    let writer = this.writers.get(id);
    if (!writer) {
      writer = new ChildTranscript(this.log(id));
      this.writers.set(id, writer);
    }
    return writer;
  }

  /** The child's transcript rows. Handed to the pane BY REFERENCE so a pane
   *  opened mid-run keeps filling as the child reports. */
  buffer(id: string): string[] {
    return this.log(id).lines;
  }

  /** How many times the open pane's transcript has changed. The frame compares
   *  it between ticks, so a transcript that is growing repaints and one that is
   *  not costs nothing. Zero when no pane is open. */
  paneRevision(): number {
    return this.pane ? (this.logs.get(this.pane.id)?.revision ?? 0) : 0;
  }

  /** The card whose transcript is open, when one is. */
  openId(): string | null {
    return this.pane?.id ?? null;
  }

  /**
   * Bring back the children a session's log records.
   *
   * Called when a session is opened with history. Each stored child becomes a
   * FINISHED card under the name it ran as -- its state and its span are the
   * record's -- and its transcript is left empty: that is read back from the
   * log only when the card is opened, because it is the child's whole
   * conversation and most cards are never opened.
   *
   * A child with no terminal status in the record is one whose process ended
   * mid-run. It is drawn as failed, with that said on the card, rather than as
   * `running`: nothing is running in a log that is being read back.
   */
  restore(stored: readonly StoredDelegation[]): number {
    let restored = 0;
    for (const child of stored) {
      const id = child.callId ?? child.id;
      if (this.cards.has(id)) continue;
      const brief = truncate((child.label ?? child.promptHead ?? "").trim(), 44);
      const card = this.register({
        id,
        kind: child.kind,
        brief,
        written: child.name,
        // The same derivation a live card falls back to, so a child from a
        // build that stored no name is still `scout-auth` and not `agent-3`.
        derived: brief ? deriveChildName(child.kind, brief) : undefined,
        state: "done",
      });
      // The same reading a live card gets. A child that returned -- even one
      // that ran out of turns and handed back what it had -- is `done`, and
      // the card says how it stopped. Only a child that never returned, or one
      // the harness gave up on, is `failed`.
      const status = child.status ?? "";
      const clean = status === "end_turn" || status === "completed";
      const failed =
        status === "" || status === "stalled" || status === "provider_lost" || status === "error";
      card.state = failed ? "failed" : "done";
      card.retired = true;
      card.restored = true;
      card.taskId = child.id;
      const ended = Date.parse(child.at);
      if (Number.isFinite(ended)) {
        card.endedAt = ended;
        const started = child.startedAt ? Date.parse(child.startedAt) : NaN;
        if (Number.isFinite(started)) card.startedAt = started;
        else if (child.elapsedMs != null) card.startedAt = ended - child.elapsedMs;
      }
      if (!clean) {
        card.receipt = {
          rung: failed ? "failure" : "observed",
          text: status ? `stopped: ${status.replace(/_/g, " ")}` : "ended mid-run",
          at: Number.isFinite(ended) ? ended : 0,
        };
      }
      restored++;
    }
    return restored;
  }

  attachPane(pane: { id: string; name: string; note?: string; lines: string[] }): void {
    this.pane = pane;
  }

  detachPane(): void {
    this.pane = null;
  }

  /**
   * Keep the open pane's header honest while its child runs.
   *
   * The header carries the SAME ordinal the card does (`3  verifier`), because
   * the two are one object seen twice and a reader who pressed `3` should find
   * a `3` at the top of what opened. Called from the paint path rather than
   * from the key, so the tokens and the clock in it advance with the run.
   */
  refreshPane(now: number = Date.now()): void {
    const pane = this.pane;
    if (!pane) return;
    const card = this.cards.get(pane.id);
    if (!card) return;
    const ordinal = this.order().findIndex((c) => c.id === card.id) + 1;
    pane.name = ordinal > 0 ? `${ordinal}  ${card.name}` : card.name;
    pane.note = F.receiptOf([
      // How it stands and for how long: a settled member keeps its span, since
      // "done" beside a transcript says nothing about how much run it holds.
      `${card.state} ${spanOf(card, now)}`.trim(),
      card.restored ? "from the session log" : `${tokenWord(card.tokens)} tok`,
      card.tools > 0 ? `${card.tools} tool${card.tools === 1 ? "" : "s"}` : "",
    ]);
  }

  /** `c` under panel focus: the finished section goes, the running stay. */
  clearFinished(): number {
    let cleared = 0;
    for (const card of this.all()) {
      if (!card.retired) continue;
      this.cards.delete(card.id);
      this.logs.delete(card.id);
      this.writers.delete(card.id);
      this.pulses.delete(card.id);
      this.names.delete(card.name);
      cleared++;
    }
    // A pane open on a card that has just been cleared has nothing left to
    // show; leaving it would be a header naming an agent that no longer exists.
    if (this.pane && !this.cards.has(this.pane.id)) this.pane = null;
    if (this.selected && !this.cards.has(this.selected)) this.selected = null;
    return cleared;
  }

  /** A fresh session (or `/clear`): everything goes, including the ordinals. */
  reset(): void {
    this.cards.clear();
    this.logs.clear();
    this.writers.clear();
    this.pulses.clear();
    this.names.clear();
    this.ordinal = 0;
    this.selected = null;
    this.pane = null;
    this.focus = "composer";
  }
}

/**
 * The one ledger.
 *
 * A module singleton rather than a field on `Tui`, for the same reason the
 * pastes register is one: the writer is the TurnRenderer (rebuilt per turn),
 * the readers are the frame and the key handler, and threading one object
 * through three files that four lanes are editing concurrently buys nothing a
 * module scope does not already give. `reset()` is called where the transcript
 * is.
 */
export const fleetLedger = new FleetLedger();
