/**
 * The agent's question, and how you answer it.
 *
 * Every assertion here exists because the surface it replaced got the same
 * thing wrong. The old picker was three inert lines and a legend: nothing was
 * selected, so Enter had to mean options[0]; the digit shortcut was real but
 * only while the field was empty, and nothing on screen said so; and the
 * composer went on advertising "describe a change" while the agent sat blocked
 * on an answer.
 *
 * So the rule these tests pin is one rule: a key may only mean what the screen
 * is currently saying it means.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  graceRemaining,
  questionAction,
  questionHint,
  questionLines,
  questionPlaceholder,
  type QuestionView,
} from "../../../packages/orchestrator/src/bin/ui/question";
import {
  COMPOSER_PLACEHOLDER,
  renderComposer,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import type { Key } from "../../../packages/orchestrator/src/bin/ui/keys";

const OPTIONS = [
  "Orbital launch vehicles",
  "Sounding/suborbital rockets",
  "Both from day one",
  "Model/high-power rockets",
];

const view = (over: Partial<QuestionView> = {}): QuestionView => ({
  question: "What should the first production release simulate?",
  options: OPTIONS,
  selected: 0,
  input: "",
  width: 100,
  ...over,
});

const plain = (v: QuestionView): string[] => questionLines(v).map(stripAnsi);
const char = (value: string): Key => ({ type: "char", value });

afterEach(() => setTermWidthOverride(null));

describe("what a keystroke means", () => {
  it("a bare digit answers in one keystroke", () => {
    expect(questionAction(char("2"), view())).toEqual({
      kind: "answer",
      text: "Sounding/suborbital rockets",
      chosen: 1,
    });
  });

  it("a digit with no option behind it does nothing at all", () => {
    // Falling through to the composer would drop a stray "7" into an answer the
    // person believed they had just submitted.
    expect(questionAction(char("7"), view())).toEqual({ kind: "ignore" });
  });

  it("a digit inside a written answer stays a digit", () => {
    expect(questionAction(char("2"), view({ input: "build " }))).toEqual({ kind: "edit" });
  });

  it("up/down walk the choices and wrap at both ends", () => {
    expect(questionAction({ type: "down" }, view({ selected: 0 }))).toEqual({
      kind: "move",
      selected: 1,
    });
    expect(questionAction({ type: "up" }, view({ selected: 0 }))).toEqual({
      kind: "move",
      selected: 3,
    });
    expect(questionAction({ type: "down" }, view({ selected: 3 }))).toEqual({
      kind: "move",
      selected: 0,
    });
  });

  it("arrows belong to the composer once an answer is being written", () => {
    expect(questionAction({ type: "down" }, view({ input: "b" }))).toEqual({ kind: "edit" });
  });

  it("enter commits the HIGHLIGHTED choice, never a fixed first option", () => {
    // The bug this replaces: Enter meant options[0] whatever was on screen, so
    // the reflex Enter of someone clearing a prompt answered a product question
    // with an option they had not necessarily read.
    expect(questionAction({ type: "enter" }, view({ selected: 2 }))).toEqual({
      kind: "answer",
      text: "Both from day one",
      chosen: 2,
    });
  });

  it("enter sends written words verbatim, with no option index attached", () => {
    const action = questionAction({ type: "enter" }, view({ input: "  both, sounding first  " }));
    expect(action).toEqual({ kind: "answer", text: "both, sounding first" });
    expect("chosen" in action).toBe(false);
  });

  it("escape backs out one step at a time", () => {
    // A typo must never cost the round: clear first, abandon only from empty.
    expect(questionAction({ type: "esc" }, view({ input: "half a thou" }))).toEqual({
      kind: "clear",
    });
    expect(questionAction({ type: "esc" }, view())).toEqual({ kind: "skip" });
  });
});

describe("what the screen says the keys mean", () => {
  it("marks the highlighted choice without moving the number column", () => {
    // A list that shifts sideways as the selection travels is the cheapest way
    // to make a picker feel unsteady, so the marker is paid for out of the body
    // indent rather than prepended to it.
    const rows = plain(view({ selected: 2 })).filter((l) => /^\s*\S?\s*\d\s{3}\S/.test(l));
    expect(rows).toHaveLength(4);
    const columnOf = (row: string): number => row.indexOf(row.trim()[0]!);
    expect(rows.filter((r) => r.includes(glyph("selection")))).toHaveLength(1);
    expect(rows[2]).toContain(glyph("selection"));
    // Every number sits in the same column, selected or not.
    const numberCols = rows.map((r) => r.indexOf(String(rows.indexOf(r) + 1)));
    expect(new Set(numberCols).size).toBe(1);
    expect(columnOf(rows[2]!)).toBeLessThan(numberCols[2]!);
  });

  it("the question wears the fork, not the cursor", () => {
    // The chevron is the cursor everywhere in this product -- the composer, the
    // palette, the highlighted choice. Drawing the question with one put two
    // identical marks in the same column two rows apart.
    const head = plain(view())[1]!;
    expect(head).toContain(glyph("phase"));
    expect(head.indexOf(glyph("selection"))).toBe(-1);
  });

  it("dims the choices and rewrites the hint the moment words are typed", () => {
    const armed = plain(view()).at(-1)!;
    const writing = plain(view({ input: "both, sounding first" })).at(-1)!;
    expect(armed).toContain("1-4  pick");
    expect(armed).toContain("enter  choose");
    expect(writing).toContain("enter  send this answer");
    expect(writing).toContain("esc  back to the choices");
    // And the marker leaves the list, because the list is no longer what Enter
    // commits. That change IS the mode indicator.
    expect(plain(view({ input: "x" })).join("\n")).not.toContain(glyph("selection"));
  });

  it("names the round so four questions read as four, not as four interruptions", () => {
    expect(plain(view({ index: 1, total: 4 }))[1]).toContain("2 of 4");
    expect(plain(view({ index: 0, total: 1 }))[1]).not.toContain("of 1");
  });

  it("counts the 4th-gear grace window down instead of stating a stale 60", () => {
    const now = 1_000_000;
    setTermWidthOverride(140);
    const v = view({ width: 140, deadline: now + 41_000, now });
    expect(graceRemaining(v)).toBe(41);
    expect(questionHint(v)).toContain("continues on its own in 41s");
    // Expired is zero, never negative.
    expect(graceRemaining(view({ deadline: now - 5_000, now }))).toBe(0);
    expect(graceRemaining(view())).toBeNull();
  });

  it("gives up bindings before it gives up the countdown, and never mid-word", () => {
    const now = 1_000_000;
    for (const width of [40, 52, 60, 80, 100, 140]) {
      setTermWidthOverride(width);
      const hint = questionHint(view({ width, deadline: now + 9_000, now }));
      expect(hint.length, `at ${width}`).toBeLessThanOrEqual(width - 2 - 4);
      // The digit shortcut and the clock survive every width the product runs at.
      expect(hint, `at ${width}`).toContain("1-4");
      expect(hint, `at ${width}`).toMatch(/9s/);
    }
  });

  it("tells the field what it is for while the agent is blocked on an answer", () => {
    const placeholder = questionPlaceholder(4);
    expect(placeholder).toContain("1-4");
    expect(placeholder).not.toBe(COMPOSER_PLACEHOLDER);
    const shown = renderComposer({
      input: "",
      caret: 0,
      width: 100,
      status: "",
      placeholder,
    }).lines.map(stripAnsi);
    expect(shown.join("\n")).toContain(placeholder);
    expect(shown.join("\n")).not.toContain(COMPOSER_PLACEHOLDER);
  });

  it("holds the measure at every width, like every other block", () => {
    for (const width of [60, 80, 120, 190]) {
      setTermWidthOverride(width);
      for (const l of questionLines(view({ width, index: 1, total: 4, deadline: Date.now() }))) {
        expect(stripAnsi(l).length, `at ${width}`).toBeLessThanOrEqual(width - 2);
      }
    }
  });
});
