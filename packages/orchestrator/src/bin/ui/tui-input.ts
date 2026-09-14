// ─── The frame: keys, the composer, history ───
// Split out of tui.ts. Everything that turns a byte off stdin into a change of
// state lives here: the paste scanner's output, the key router, the composer's
// edit operations, and the prompt history.
//
// The composer's own rendering is ./composer.ts; this file is the controller
// side of it -- which block the footer is showing, where the caret is, and what
// each key does to the buffer.
//
// Mixed onto `Tui.prototype` at the bottom of tui.ts; see ./tui-frame.ts for
// why the `this: Tui` parameter is there.

import type { Tui } from "./tui";
import { arrowRun, parseKeys, type Key } from "./keys";
import { PasteScanner, shouldCollapse, pasteChip, expandPastes, livePasteIds } from "./paste";
import {
  renderComposer,
  renderPicker,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
  renderKeyManagerPanel,
  renderSessionsPanel,
  renderMemoryPanel,
  renderWorkReview,
  renderPermissionCard,
  renderQueueStrip,
  waitingRung,
  type RenderedBlock,
  type SlashItem,
} from "./composer";
import * as F from "./flow";
import { questionLines, questionPlaceholder } from "./question";
import { heldLines } from "./held";
import { loopPromptPreview } from "../../loop-mode";
import { text, muted, faint, info, ok, warn, danger } from "./theme";
import { glyph, TERMINAL_GLYPH_MODE } from "./glyphs";
import { rowsCount, SCROLL_STEP } from "./tui-frame";
import { fleetLedger } from "./agents-panel";
import { ledgerRows, maskLive, savedActiveRows, type StepReceipt } from "../../first-run";
/** The rung, read once. `ledgerRows` takes it as an argument because
 * first-run.ts is engine-side and never learns what a terminal can draw. */
const ASCII_RUNG = TERMINAL_GLYPH_MODE === "ascii";

/** Keys, the composer and history, mixed onto `Tui.prototype`. */
export const INPUT_METHODS = {
  /** Commands matching the `/`-prefixed token being typed; empty hides the palette. */
  slashMatches(this: Tui): SlashItem[] {
    if (this.mode !== "input") return [];
    const v = this.input;
    if (!v.startsWith("/") || /\s/.test(v)) return []; // not a command, or name already complete
    const t = v.slice(1).toLowerCase();
    const all = this.slashCatalog();
    const pref = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(t));
    return pref.length ? pref : all.filter((c) => c.name.slice(1).toLowerCase().includes(t));
  },

  composerBlock(this: Tui, height = Math.max(3, rowsCount() - 1)): RenderedBlock {
    // What the field may grow to inside `height`, once the block's own chrome
    // is paid for: the blank row, two rules and the status line, plus whatever
    // the mode floats above the field. Three fifths of the window is the same
    // ceiling the four-region frame gives it (viewport.regions) -- a composer
    // that can take the whole window is a composer that can erase the thing it
    // is being written about.
    const fieldCap = (head: number): number =>
      Math.max(1, Math.min(height - 4 - head, Math.max(4, Math.floor(rowsCount() * 0.6))));
    if (this.mode === "picker" && this.picker) {
      return renderPicker(
        this.picker.title,
        this.picker.items,
        this.picker.sel,
        this.contentCols(),
        height,
        { footnote: this.picker.footnote },
      );
    }
    if (this.mode === "permission" && this.perm) {
      const card = renderPermissionCard(
        this.perm.toolName,
        this.perm.argsSummary,
        this.contentCols(),
        {
          preview: this.perm.preview,
          selected: this.perm.sel,
          maxPreviewLines: Math.max(2, Math.min(7, rowsCount() - 15)),
        },
      );
      // v2 status ladder: the run is paused on a human decision -- say so in
      // the ochre "Waiting on approval..." rung above the card, with the live
      // elapsed receipt and the gear the decision is needed in.
      const waitSecs = Math.max(0, Math.floor((Date.now() - this.turnStart) / 1000));
      const head = waitingRung(waitSecs, this.perm.toolName, this.ctx.engine.getPermissionMode());
      return {
        lines: [head, ...card.lines],
        caretRow: card.caretRow + 1,
        caretCol: card.caretCol,
      };
    }
    if (this.mode === "held" && this.heldState) {
      const st = this.heldState;
      const lines = heldLines({
        steps: st.steps,
        outcomes: st.outcomes,
        selected: st.sel,
        running: st.running,
        width: this.contentCols(),
      });
      // The caret parks on the hint row: there is no field here, and the
      // marker already says where the selection is.
      return { lines, caretRow: lines.length - 1, caretCol: F.BODY.length };
    }
    if (this.mode === "ask" && this.askState) {
      const title = `  ${info("?")} ${text(this.askState.title)} ${faint("(Enter = ok | Esc = skip)")}`;
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
        maxRows: fieldCap(1),
      });
      return {
        lines: [title, ...base.lines],
        caretRow: base.caretRow + 1,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "question" && this.questionState) {
      const q = this.questionState;
      const head = questionLines({ ...q, input: this.input, width: this.contentCols() });
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
        placeholder: questionPlaceholder(q.options.length),
        maxRows: fieldCap(head.length),
      });
      return {
        lines: [...head, ...base.lines],
        // The caret stays in the field, not on the highlighted row: typing an
        // answer is a first-class path here, and the marker already says where
        // the selection is. A caret parked on a list you may not be using is
        // the thing that made this surface feel like it was guessing.
        caretRow: base.caretRow + head.length,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "keys") {
      if (this.keysEdit) {
        const e = this.keysEdit;
        return renderKeyEditor({
          title: e.title,
          subtitle: e.subtitle,
          value: e.value,
          caret: e.caret,
          width: this.contentCols(),
          masked: e.masked,
        });
      }
      if (this.keysManage) {
        const row = this.keysRows.find((r) => r.id === this.keysManage!.id);
        return renderKeyManagerPanel(
          this.keysManage.label,
          row?.savedKeys ?? [],
          this.keysManage.sel,
          this.contentCols(),
        );
      }
      return renderKeysPanel(
        this.keysRows,
        this.keysSel,
        this.contentCols(),
        Math.max(4, rowsCount() - 1),
      );
    }
    if (this.mode === "setup" && this.ctx.firstRun) {
      const setup = this.ctx.firstRun;
      const step = setup.current();
      // The three-rung ladder, like every other block: a marked row at MARK, the
      // prose under it at BODY. `flowRow` budgets a row but does NOT indent it —
      // the caller owns the gutter — and without these two prefixes every row of
      // the wizard started at column 0, which is the same defect the 2026-09-10
      // frames caught in `/config`'s confirmation.
      const cols = this.contentCols();
      const mark = (s: string): string =>
        `${F.MARK}${F.flowRow(s, "", Math.max(8, cols - F.MARK.length))}`;
      const body = (s: string): string =>
        `${F.BODY}${F.flowRow(s, "", Math.max(8, cols - F.BODY.length))}`;
      // The ledger rows come from first-run.ts, which is where the integration
      // test reads them and where their widths are pinned. A second
      // implementation here is how the panel and the test start disagreeing
      // about what a skipped step says.
      const ledger = ledgerRows(setup.steps(), Math.max(8, cols - F.MARK.length), ASCII_RUNG);
      // Saved vs active (§2.8): two columns, identical unless a session
      // override is in force -- a `--provider` flag, an env var, a `/model`
      // pick this session -- and when one is, this is the only place that
      // names which source won. `savedVsActive()`/`savedActiveRows()` already
      // existed, fully tested in isolation (first-run.test.ts,
      // fresh-home-onboarding.test.ts), but nothing under bin/ui ever called
      // either one, so no wizard screen could show the comparison no matter
      // what was overridden -- the computation was real and the render call
      // site was not.
      // The whole table sits at the one MARK rung every other row here uses --
      // its own two columns are internal alignment, not a second indent
      // convention, which is why `savedActiveRows`'s heading row carries the
      // word `setting` rather than a run of blanks: nothing here may trim a
      // row's leading space without pulling that row out of its column.
      const comparison = setup.savedVsActive();
      const savedActive = savedActiveRows(comparison, Math.max(8, cols - F.MARK.length)).map(
        (line) => mark(faint(line)),
      );
      // `savedActiveRows` already ends on the precedence ladder whenever a row
      // differs -- that is the whole point of naming a winner -- so the wizard
      // states the ladder in exactly one place instead of printing it twice,
      // once under the table and once on its own row directly beneath.
      const ladder = comparison.some((row) => row.differs)
        ? []
        : [body(faint(setup.precedenceLine(Math.max(8, cols - F.BODY.length))))];
      // A step's receipt is evidence, so it wears the same frame every other
      // piece of evidence wears (§2.8: "the file written, the endpoint probed,
      // the response … in the same boxes every other tool call uses"). The
      // title is `check GET <url>` / `write <path>` / `set model`: the verb is
      // the first word, exactly as a tool row's is.
      const receipt = this.setupReceipt
        ? F.box(
            {
              verb: this.setupReceipt.title.split(" ")[0] ?? "setup",
              arg: this.setupReceipt.title.split(" ").slice(1).join(" "),
            },
            F.boxOutput(this.setupReceipt.body),
            {
              status: this.setupReceipt.ok ? "pass" : "fail",
              parts: [this.setupReceipt.close],
            },
            { width: F.measure(cols) },
          )
        : [];
      const head = [
        mark(`${faint("setup")}  ${text(setup.heading())}`),
        ...ledger.map((line) => mark(faint(line))),
        ...savedActive,
        ...ladder,
        ...(setup.restartNote() ? [body(warn(setup.restartNote()!))] : []),
        ...receipt,
        ...(step ? [mark(text(step.question)), body(faint(step.hint))] : []),
      ];
      const shown = step?.secret ? maskLive(this.input, setup.maskCell()) : this.input;
      const base = renderComposer({
        input: shown,
        caret: Math.min(this.caret, shown.length),
        width: this.contentCols(),
        // `renderComposer` sets its status rows down exactly as it is given
        // them, so the gutter is the caller's here as it is above.
        // The footer layout has no status strip of its own -- this block IS the
        // footer -- so the promise the split layout puts on the strip (§2.8:
        // "no model call to edit configuration") rides on the hint row here
        // rather than costing a row in a window that has none to spare.
        status: body(
          faint(
            step
              ? `enter continue ${glyph("observed")} esc cancel ${glyph("observed")} no model called yet`
              : `setup complete ${glyph("observed")} enter close`,
          ),
        ),
        placeholder: this.setupBusy
          ? "checking..."
          : step?.secret
            ? "paste key (masked)"
            : "type a value, or enter to skip",
        maxRows: fieldCap(head.length),
      });
      return {
        lines: [...head, ...base.lines],
        caretRow: head.length + base.caretRow,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "sessions") {
      return renderSessionsPanel(
        this.sessionsList.map((s) => this.sessionRowView(s)),
        this.sessionsSel,
        {
          view: this.sessionsView,
          pendingDelete: this.sessionsPendingDelete != null,
          query: this.sessionsQuery,
          searching: this.sessionsSearching,
        },
        this.contentCols(),
        Math.max(4, rowsCount() - 1),
      );
    }
    if (this.mode === "memory") {
      const m = this.ctx.engine.getSystemMemory();
      return renderMemoryPanel(
        {
          content: m.content,
          scheduleLabel: m.scheduleLabel,
          tokens: m.tokens,
          maxTokens: m.maxTokens,
          lastDreamed: m.meta.lastReflectedAt ? this.relTime(m.meta.lastReflectedAt) : "never",
          busy: this.memoryBusy,
          note: this.memoryNote ?? undefined,
          pendingClear: this.memoryPendingClear,
        },
        this.memorySel,
        this.contentCols(),
      );
    }
    if (this.mode === "review") {
      const log = this.liveTurn?.fullLog() ?? this.reviewLog ?? `  ${faint("No work details yet")}`;
      return renderWorkReview(
        log,
        this.reviewTop,
        this.contentCols(),
        Math.max(4, rowsCount() - 1),
      );
    }
    if (this.mode === "turn") {
      // The composer stays live while a turn streams so the next message can be typed ahead.
      // The working indicator (and any queued messages) float above the still-editable box.
      //
      // The head is measured FIRST so the field's cap can subtract it: while a
      // turn streams the rows above the box are the run's own receipt, and a
      // type-ahead draft that grew over them would erase what it is answering.
      const head = this.turnStateLines();
      head.push(...renderQueueStrip(this.queued, this.contentCols()));
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
        maxRows: fieldCap(head.length),
      });
      return {
        lines: [...head, ...base.lines],
        caretRow: base.caretRow + head.length,
        caretCol: base.caretCol,
      };
    }
    const base = renderComposer({
      input: this.input,
      caret: this.caret,
      width: this.contentCols(),
      status: this.statusStr(),
      maxRows: fieldCap(0),
    });
    const matches = this.slashMatches();
    // The palette only opens on a `/` with no space in it yet, so the field
    // under it is one row -- which is why the cap above can ignore it and the
    // palette's own budget can go on subtracting the field's height.
    if (matches.length === 0) return base;
    // Float the palette above the input box; the caret stays in the box.
    const palette = renderSlashPalette(
      matches,
      this.slashSel,
      this.contentCols(),
      Math.max(1, rowsCount() - base.lines.length - 2),
      this.slashCatalog().length,
    );
    return {
      lines: [...palette, ...base.lines],
      caretRow: base.caretRow + palette.length,
      caretCol: base.caretCol,
    };
  },

  onData(this: Tui, chunk: string): void {
    // Bracketed paste is carved out of the stream as substrings (PasteScanner) -- never fed through
    // parseKeys. A multi-megabyte paste (e.g. dumping a large doc) would otherwise allocate one Key
    // object per character and rebuild an accumulator char-by-char (O(n2)), freezing the UI for
    // seconds. Here the whole body is one substring, so a huge paste is effectively free.
    for (const seg of this.paste.push(chunk)) {
      if (seg.type === "paste") this.endPaste(seg.content);
      else {
        const keys = parseKeys(seg.data);
        // A wheel notch under alternate-scroll mode lands as several arrows
        // in ONE read; a finger on a key never does. Route the burst as a
        // scroll of that many lines, never as a stack of history recalls.
        const run = arrowRun(keys);
        if (run !== 0 && this.arrowScrolls(true)) {
          this.scrollLines(run);
          continue;
        }
        for (const key of keys) this.routeKey(key);
      }
    }
  },

  /** Route one decoded key event to the active mode (paste is handled upstream in onData). */
  routeKey(this: Tui, key: Key): void {
    if (this.mode === "review" && (key.type === "wheel-up" || key.type === "wheel-down")) {
      this.moveWorkReview(key.type === "wheel-up" ? -SCROLL_STEP : SCROLL_STEP);
      return;
    }
    // The mouse wheel scrolls the transcript in every mode -- even while a turn streams.
    if (key.type === "wheel-up") {
      this.scrollLines(SCROLL_STEP);
      return;
    }
    if (key.type === "wheel-down") {
      this.scrollLines(-SCROLL_STEP);
      return;
    }
    // A left click opens or closes the fold under it; ctrl+o answers for the
    // newest fold without leaving the keyboard, and falls back to the full
    // work log where there is nothing to open.
    if (key.type === "click") {
      this.clickTranscript(key.x, key.y);
      return;
    }
    if (
      key.type === "ctrl" &&
      key.name === "o" &&
      (this.mode === "input" || this.mode === "turn")
    ) {
      const fold = this.inline ? undefined : this.folds.newest();
      if (fold) this.toggleFold(fold);
      else this.expandWorkLog();
      return;
    }
    // Shift+Tab cycles confirm -> Autonomy I -> II -> III -> Auto -> confirm while composing.
    // Inside an approval ask it is the explicit "allow for session" shortcut printed
    // beside choice 2, so the visible contract and the keyboard behavior stay identical.
    if (key.type === "shift-tab") {
      if (this.mode === "permission") this.permKey(key);
      else if (this.mode === "input" || this.mode === "turn") this.cyclePermissionMode();
      return;
    }
    // The agents panel has the keys (P4 §2.7). It is checked before the mode
    // because the panel is focusable in BOTH writing modes and the keys mean
    // the same thing in each: a fan-out does not stop being reviewable because
    // the master happens to be mid-turn. Every key it does not claim falls
    // through to the mode below, so typing is never swallowed.
    if ((this.mode === "input" || this.mode === "turn") && this.focus === "panel") {
      if (this.panelKey(key)) return;
    }
    switch (this.mode) {
      case "input":
        this.inputKey(key);
        break;
      case "turn":
        this.turnKey(key);
        break;
      case "picker":
        this.pickerKey(key);
        break;
      case "permission":
        this.permKey(key);
        break;
      case "keys":
        this.keysKey(key);
        break;
      case "sessions":
        this.sessionsKey(key);
        break;
      case "memory":
        this.memoryKey(key);
        break;
      case "setup":
        this.setupKey(key);
        break;
      case "ask":
        this.askKey(key);
        break;
      case "question":
        this.questionKey(key);
        break;
      case "held":
        this.heldKey(key);
        break;
      case "review":
        this.workReviewKey(key);
        break;
    }
  },

  /** Land a finished paste: small single-line pastes drop in inline; anything multi-line or long
   *  collapses to a chip so the composer stays a clean single line (see `pastes`). */
  endPaste(this: Tui, content: string): void {
    // Key/URL editor is a single-line field -- always inline, newlines stripped by insertActive.
    if (this.mode === "keys" || this.mode === "setup") {
      this.insertActive(content);
      this.scheduleDraw();
      return;
    }
    if (shouldCollapse(content)) {
      const id = ++this.pasteSeq;
      this.pastes.set(id, content);
      this.insert(pasteChip(id, content));
    } else {
      this.insert(content);
    }
    this.scheduleDraw();
  },

  /** Swap `[Pasted text #N ...]` chips back to their stored bodies just before a message is sent. */
  expandPastes(this: Tui, s: string): string {
    return expandPastes(s, this.pastes);
  },

  /** Drop paste bodies whose chip no longer appears in the composer (consumed or edited away). */
  gcPastes(this: Tui): void {
    if (this.pastes.size === 0) return;
    const live = livePasteIds(this.input);
    for (const id of [...this.pastes.keys()]) if (!live.has(id)) this.pastes.delete(id);
  },

  insert(this: Tui, s: string): void {
    const clean = s.replace(/\r/g, "");
    this.input = this.input.slice(0, this.caret) + clean + this.input.slice(this.caret);
    this.caret += clean.length;
  },

  /** Route pasted text to whichever field is active (composer, or a key editor). */
  insertActive(this: Tui, s: string): void {
    if (this.mode === "keys") {
      if (!this.keysEdit) return; // ignore pastes on the list view
      const clean = s.replace(/[\r\n]+/g, ""); // keys/URLs are single-line
      const e = this.keysEdit;
      e.value = e.value.slice(0, e.caret) + clean + e.value.slice(e.caret);
      e.caret += clean.length;
      return;
    }
    this.insert(s);
  },

  setupKey(this: Tui, key: Key): void {
    if (!this.ctx.firstRun || this.setupBusy) return;
    if (this.ctx.firstRun.done()) {
      if (key.type === "enter" || key.type === "esc") {
        this.input = "";
        this.caret = 0;
        this.mode = "input";
        this.scheduleDraw();
      }
      return;
    }
    if (key.type === "esc") {
      this.ctx.firstRun.cancel();
      this.input = "";
      this.caret = 0;
      this.setupReceipt = null;
      this.mode = "input";
      this.scheduleDraw();
      return;
    }
    if (key.type === "enter") {
      const answer = this.input;
      this.input = "";
      this.caret = 0;
      this.setupBusy = true;
      this.scheduleDraw();
      void this.ctx.firstRun.answer(answer).then(
        (outcome) => {
          this.setupBusy = false;
          this.landSetupReceipt(outcome.receipt);
          this.scheduleDraw();
        },
        (err) => {
          this.setupBusy = false;
          this.landSetupReceipt({
            ok: false,
            title: "setup",
            body: [],
            close: err instanceof Error ? err.message : String(err),
          });
          this.scheduleDraw();
        },
      );
      return;
    }
    if (this.editComposer(key)) this.scheduleDraw();
  },

  /**
   * Where a step's receipt goes once the step is answered.
   *
   * §2.8 puts it in the WORKSPACE, "in the same boxes every other tool call
   * uses" -- so in the split layout it is committed to the transcript the
   * moment it exists, which is also what makes the wizard accumulate a record:
   * the file that was written, then the endpoint that was probed, then the one
   * that was rejected, each still on screen while the next step is answered.
   * The footer block could only ever show the LAST one, because it redrew the
   * receipt from a single field.
   *
   * Committed and held are exclusive. A window that shrinks below
   * `PANEL_MIN_COLS` mid-wizard falls back to the footer block, and that block
   * draws `setupReceipt` -- so a receipt that is already in the transcript above
   * it must not also be a field, or the shrink prints it twice.
   *
   * Nothing here is the secret: `StepReceipt` is redacted at the source
   * (first-run.ts) and the provider's own 401, which echoes the key back, is
   * redacted before it becomes a body line.
   */
  landSetupReceipt(this: Tui, receipt: StepReceipt): void {
    if (!this.setupInBand()) {
      this.setupReceipt = receipt;
      return;
    }
    this.setupReceipt = null;
    const cols = this.contentCols();
    const lines = F.box(
      {
        verb: receipt.title.split(" ")[0] ?? "setup",
        arg: receipt.title.split(" ").slice(1).join(" "),
      },
      F.boxOutput(receipt.body),
      { status: receipt.ok ? "pass" : "fail", parts: [receipt.close] },
      { width: F.measure(cols) },
    );
    this.print(lines.join("\n"));
  },

  /** Apply a pure text-editing key to the composer (insert / caret motion / deletion). Returns
   *  true when it handled the key. Shared by input mode and mid-turn type-ahead so the composer
   *  edits identically whether or not a turn is streaming; callers own redraw + side effects. */
  editComposer(this: Tui, key: Key): boolean {
    switch (key.type) {
      case "char":
        this.insert(key.value);
        this.scroll = 0; // typing returns to the latest output
        return true;
      case "backspace":
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
        }
        return true;
      case "delete":
        if (this.caret < this.input.length) {
          this.input = this.input.slice(0, this.caret) + this.input.slice(this.caret + 1);
        }
        return true;
      case "left":
        if (this.caret > 0) this.caret--;
        return true;
      case "right":
        if (this.caret < this.input.length) this.caret++;
        return true;
      case "home":
        this.caret = 0;
        return true;
      case "end":
        this.caret = this.input.length;
        return true;
      case "ctrl":
        // The explicit newline.
        //
        // Not shift+enter: a terminal never sees the shift, so the two arrive
        // as the same byte and the composer cannot tell them apart. Not ctrl+j
        // or ctrl+m either -- those ARE Enter at the wire (keys.ts), which is
        // why the widely-suggested binding cannot be built here. `ctrl+b` was
        // free, and it is handled in editComposer rather than in ctrlKey so
        // that it works identically while a turn is streaming, where the
        // type-ahead path falls through to this same function.
        if (key.name === "b") {
          this.insert("\n");
          this.scroll = 0;
          return true;
        }
        return false;
      default:
        return false;
    }
  },

  /**
   * The keys, while the agents panel has focus (P4 §2.7).
   *
   * Returns true when it claimed the key. Four bindings and no more:
   *
   *   ↑↓     move the selection. Held on the LEDGER, by id, so a member
   *          finishing above the selection does not move it under the eye.
   *   1–9    jump straight to that agent. Digits already mean "select" in
   *          every other Rune list (the picker, the permission card, the held
   *          panel), so this is the existing idiom rather than a new one --
   *          and it is what the founder's `shift+N` becomes, because a
   *          terminal never delivers shift+3 as anything but `#` (§2.7).
   *   enter  open that agent's live transcript in the workspace split. The
   *          buffer is handed over BY REFERENCE, so a pane opened mid-run
   *          keeps filling as the child reports rather than freezing at the
   *          moment you looked.
   *   c      clear the finished section.
   *
   * `esc`, `ctrl+f` and `ctrl+w` are deliberately NOT here: they are the ring
   * and they must behave identically from every region, which is what the
   * fall-through below gives them.
   */
  panelKey(this: Tui, key: Key): boolean {
    const view = fleetLedger.view(true);
    const any = view.running.length + view.finished.length > 0;
    if (key.type === "up" || key.type === "down") {
      if (!any) return false;
      fleetLedger.move(key.type === "up" ? -1 : 1);
      this.scheduleDraw();
      return true;
    }
    if (key.type === "char" && /^[1-9]$/.test(key.value)) {
      if (!fleetLedger.selectIndex(Number(key.value))) return false;
      this.scheduleDraw();
      return true;
    }
    if (key.type === "char" && key.value === "c") {
      // Nothing to clear is not a key press to swallow: `c` falls through and
      // types a `c`, which is what a composer-bound user expects.
      if (view.finished.length === 0) return false;
      fleetLedger.clearFinished();
      if (this.childPane && !fleetLedger.get(this.childPane.id)) this.closeChildPane();
      this.scheduleDraw();
      return true;
    }
    if (key.type === "enter") {
      const id = view.selectedId;
      const card = id ? fleetLedger.get(id) : undefined;
      if (!card) return false;
      // Already open on this one: enter closes it. A key that only ever opens
      // leaves the reader hunting for the one that undoes it.
      if (this.childPane?.id === card.id) {
        fleetLedger.detachPane();
        this.closeChildPane();
        this.scheduleDraw();
        return true;
      }
      const pane = { id: card.id, name: card.name, lines: fleetLedger.buffer(card.id) };
      fleetLedger.attachPane(pane);
      fleetLedger.refreshPane();
      this.openChildPane(pane);
      this.scheduleDraw();
      return true;
    }
    return false;
  },

  inputKey(this: Tui, key: Key): void {
    // Reference-card shortcuts: left from an empty composer opens history; `?`
    // opens the same live command palette as `/` without submitting a message.
    if (key.type === "left" && this.input.length === 0) {
      this.openSessions();
      return;
    }
    if (key.type === "char" && key.value === "?" && this.input.length === 0) {
      this.input = "/";
      this.caret = 1;
      this.slashSel = 0;
      this.scheduleDraw();
      return;
    }
    // When the `/` palette is open, up/down navigate it and tab/enter pick from it.
    const sm = this.slashMatches();
    if (sm.length > 0) {
      const sel = Math.max(0, Math.min(this.slashSel, sm.length - 1));
      switch (key.type) {
        case "up":
          this.slashSel = (sel - 1 + sm.length) % sm.length;
          this.scheduleDraw();
          return;
        case "down":
          this.slashSel = (sel + 1) % sm.length;
          this.scheduleDraw();
          return;
        case "tab":
          this.input = sm[sel]!.name + " ";
          this.caret = this.input.length;
          this.slashSel = 0;
          this.scheduleDraw();
          return;
        case "enter":
          this.input = sm[sel]!.name;
          this.caret = this.input.length;
          this.slashSel = 0;
          void this.submit();
          return;
      }
    }
    // Text editing (insert / caret / delete) is shared with mid-turn type-ahead.
    if (this.editComposer(key)) {
      this.sigintArmed = false;
      this.slashSel = 0;
      this.scheduleDraw();
      return;
    }
    switch (key.type) {
      case "pageup":
        this.scrollBy(1);
        break;
      case "pagedown":
        this.scrollBy(-1);
        break;
      case "enter":
        void this.submit();
        break;
      case "up":
        if (this.arrowScrolls(false)) this.scrollLines(1);
        else this.historyPrev();
        break;
      case "down":
        if (this.arrowScrolls(false)) this.scrollLines(-1);
        else this.historyNext();
        break;
      case "esc":
        // Focus first: `esc` gains a meaning only where it had none. It never
        // takes one away -- with the composer focused it still clears the draft
        // and cancels a loop, which is the binding people rely on.
        if (this.releaseFocus()) return;
        if (this.input.length === 0) {
          const cancelled = this.ctx.engine.cancelLoopTask(this.ctx.sessionId);
          if (cancelled.ok && cancelled.task) {
            this.print(
              `  ${danger(glyph("failure"))} ${muted("stopped loop")} ${info(cancelled.task.id)} ${faint(loopPromptPreview(cancelled.task.prompt, 56))}`,
            );
          }
        } else {
          this.input = "";
          this.caret = 0;
          this.scheduleDraw();
        }
        break;
      case "ctrl":
        this.ctrlKey(key.name);
        break;
    }
  },

  ctrlKey(this: Tui, name: string): void {
    switch (name) {
      // The focus ring. `ctrl+f` was free (tui.ts had no binding on it) and it
      // is one key rather than the founder's shift+N, which the parser cannot
      // see: on every terminal Rune supports shift+3 arrives as `#`, and
      // modified keys are dropped before a handler ever runs (keys.ts).
      case "f":
        this.cycleFocus();
        return;
      // The child pane closes from anywhere, including while the composer has
      // focus -- otherwise closing it would need two keys.
      case "w":
        this.closeChildPane();
        return;
      // History, by name: the arrows read the transcript in the fixed frame
      // (arrowScrolls), so recall keeps a pair of keys that never scroll.
      case "p":
        this.historyPrev();
        return;
      case "n":
        this.historyNext();
        return;
      case "r":
        this.expandWorkLog();
        return;
      case "c":
        if (this.input.length > 0) {
          this.input = "";
          this.caret = 0;
          this.sigintArmed = false;
          this.scheduleDraw();
          return;
        }
        if (this.sigintArmed) {
          this.exit(0);
          return;
        }
        this.sigintArmed = true;
        this.print(`  ${faint("(ctrl-c again to exit)")}`);
        setTimeout(() => {
          this.sigintArmed = false;
        }, 2000);
        break;
      case "d":
        if (this.input.length === 0) this.exit(0);
        break;
      case "l":
        this.resetTranscript();
        break;
      case "u":
        this.input = this.input.slice(this.caret);
        this.caret = 0;
        this.scheduleDraw();
        break;
      case "a":
        this.caret = 0;
        this.scheduleDraw();
        break;
      case "e":
        this.caret = this.input.length;
        this.scheduleDraw();
        break;
      case "t":
        // The transcript view this promised is `ctrl+f` to the panel, then
        // enter on an agent. Say so rather than promising a later build again.
        this.print(`  ${faint("Transcript view: ctrl+f to the agents panel, then enter.")}`);
        break;
    }
  },

  historyPrev(this: Tui): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.draft = this.input;
      this.histIdx = this.history.length;
    }
    if (this.histIdx > 0) {
      this.histIdx--;
      this.input = this.history[this.histIdx]!;
      this.caret = this.input.length;
      this.scheduleDraw();
    }
  },

  historyNext(this: Tui): void {
    if (this.histIdx === -1) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.input = this.draft;
    } else {
      this.input = this.history[this.histIdx]!;
    }
    this.caret = this.input.length;
    this.scheduleDraw();
  },
};

export type InputMethods = typeof INPUT_METHODS;
