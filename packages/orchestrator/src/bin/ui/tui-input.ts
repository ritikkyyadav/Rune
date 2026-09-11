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
import { text, muted, faint, info, ok, danger } from "./theme";
import { glyph } from "./glyphs";
import { rowsCount, SCROLL_STEP } from "./tui-frame";
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
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
      });
      const title = `  ${info("?")} ${text(this.askState.title)} ${faint("(Enter = ok | Esc = skip)")}`;
      return {
        lines: [title, ...base.lines],
        caretRow: base.caretRow + 1,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "question" && this.questionState) {
      const q = this.questionState;
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
        placeholder: questionPlaceholder(q.options.length),
      });
      const head = questionLines({ ...q, input: this.input, width: this.contentCols() });
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
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
      });
      // The buffered prose run streams live here (it commits to the transcript only
      // once the turn decides which partition -- work rail or response -- it belongs to).
      const head = this.turnStateLines();
      head.push(...renderQueueStrip(this.queued, this.contentCols()));
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
    });
    const matches = this.slashMatches();
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
    if (this.mode === "keys") {
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
      default:
        return false;
    }
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
        this.print(`  ${faint("Transcript view (ctrl+t) is coming in a later build.")}`);
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
