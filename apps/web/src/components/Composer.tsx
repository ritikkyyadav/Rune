// ─── The composer ───
//
// One rounded field, 44px at rest, growing to eight lines and then scrolling —
// a field that grows without limit eats the transcript it is about to be a
// reply to. Left: attach. Right: the model, the gear, and send.
//
// The model and gear pickers live HERE rather than in Settings because they are
// per-turn decisions, and a decision you make every turn does not belong two
// clicks away in a preferences panel. Both open in place, above the field, and
// neither is a modal.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, ChevronDownIcon, PaperclipIcon, StopIcon } from "./Icons";
import type { GearInfo } from "../lib/gears";

export interface CommandItem {
  id: string;
  name: string;
  desc: string;
  tag?: string;
}

/** ctx ▮▮▯▯▯ 41% — quiet below 70%, ochre ≥70%, red ≥90%. */
function CtxMeter({ percent }: { percent?: number }) {
  if (!percent || !Number.isFinite(percent) || percent <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className={`ctx-meter ${pct >= 90 ? "hot" : pct >= 70 ? "warn" : ""}`}
      title="Context window usage"
    >
      <span>ctx</span>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  );
}

export function Composer(props: {
  processing: boolean;
  gear: GearInfo;
  ctxPercent?: number;
  queued: string[];
  commands: CommandItem[];
  /** provider/model as the engine reports them, plus whether it is authed. */
  model: { provider: string; model: string; authed: boolean };
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onUnqueue: (index: number) => void;
  onCycleGear: () => void;
  onPickModel: () => void;
  onPickGear: () => void;
  onCommand: (id: string) => void;
  onOpenStates?: () => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = props.inputRef ?? localRef;

  const slashOpen = value.startsWith("/") && !/\s/.test(value);
  const matches = useMemo(() => {
    if (!slashOpen) return [];
    const q = value.slice(1).toLowerCase();
    const pref = props.commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
    return pref.length
      ? pref
      : props.commands.filter((c) => c.name.slice(1).toLowerCase().includes(q));
  }, [props.commands, slashOpen, value]);

  useEffect(() => {
    setSel(0);
  }, [value]);

  // Auto-grow the textarea to its content (max-height in CSS).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [value, ref]);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    if (slashOpen && matches.length > 0) {
      props.onCommand(matches[Math.min(sel, matches.length - 1)]!.id);
      setValue("");
      return;
    }
    props.onSubmit(text);
    setValue("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (!matches.length) return;
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return;
    }
    if (e.key === "Tab" && slashOpen && matches.length > 0 && !e.shiftKey) {
      e.preventDefault();
      setValue(matches[sel]!.name);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape") {
      if (value) setValue("");
      else if (props.processing) props.onInterrupt();
    }
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        {slashOpen ? (
          <div className="overlay" role="menu" aria-label="Slash commands">
            <div className="overlay-header">
              <span>
                Commands{" "}
                <span className="overlay-sub">
                  · {matches.length} of {props.commands.length}
                </span>
              </span>
              <span className="overlay-sub">↑↓ navigate · tab complete · ⏎ run · esc close</span>
            </div>
            <div className="overlay-list">
              {matches.length === 0 ? (
                <div className="palette-empty">No command matches "{value}"</div>
              ) : null}
              {matches.map((c, i) => (
                <button
                  key={c.id}
                  className={`overlay-item ${i === sel ? "selected" : ""}`}
                  role="menuitem"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    props.onCommand(c.id);
                    setValue("");
                  }}
                >
                  <span className="oi-cmd">{c.name}</span>
                  <span className="oi-desc">{c.desc}</span>
                  {c.tag ? <span className="oi-tag">{c.tag}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {props.queued.length > 0 ? (
          <div className="queue-strip">
            <div className="queue-head">Queued · sends when this turn completes</div>
            {props.queued.map((q, i) => (
              <div className="queue-item" key={i}>
                <span className="q-idx">{i + 1}</span> {q}
                <button className="q-x" title="remove" onClick={() => props.onUnqueue(i)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="input-row" onClick={() => ref.current?.focus()}>
          <button
            className="input-attach"
            title="Attach a file — paste a path, or drop one in"
            aria-label="Attach"
            onClick={(e) => {
              e.stopPropagation();
              setValue((v) => (v.endsWith(" ") || v === "" ? v : v + " ") + "@");
              ref.current?.focus();
            }}
          >
            <PaperclipIcon />
          </button>
          <div className="input-shell">
            <textarea
              ref={ref}
              className={`input-field ${value ? "has-text" : ""}`}
              rows={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="Give Gear a coding task"
            />
            {!value ? (
              <>
                <span className="block-caret blink" aria-hidden="true" />
                <div className="input-placeholder">
                  {props.processing
                    ? "Type to steer or queue the next message (or / for commands)…"
                    : "Ask Gear to do something (or / for commands)…"}
                </div>
              </>
            ) : null}
          </div>
          <div className="input-tools" onClick={(e) => e.stopPropagation()}>
            <button
              className="picker"
              onClick={props.onPickModel}
              title="Provider, model and credential"
            >
              <span className={`prov-dot ${props.model.authed ? "on" : ""}`} />
              <span className="picker-label">{props.model.model || "no model"}</span>
              <ChevronDownIcon />
            </button>
            <button
              className="picker"
              data-level={props.gear.id}
              onClick={props.onPickGear}
              title={`${props.gear.label} — ${props.gear.desc} · shift+tab shifts up`}
            >
              <span className="picker-label">{props.gear.label}</span>
              <ChevronDownIcon />
            </button>
            {props.processing ? (
              <button className="send stop" onClick={props.onInterrupt} title="Interrupt (esc)">
                <StopIcon />
              </button>
            ) : (
              <button
                className="send"
                onClick={submit}
                disabled={!value.trim()}
                title="Send (⏎)"
                aria-label="Send"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </div>
        {/* What the gear MEANS, under the field that carries it. The picker
            names the gear; this line says what it will and will not do without
            asking, which is the part that matters and the part a two-word
            label cannot carry. */}
        <footer className="footer-strip">
          <span className="mode-desc">{props.gear.desc}</span>
          {props.ctxPercent ? <span className="footer-sep">·</span> : null}
          <CtxMeter percent={props.ctxPercent} />
          <div className="footer-right">
            <span className="footer-hint">
              <kbd>shift+tab</kbd> gear
            </span>
            <span className="footer-hint">
              <kbd>esc</kbd> interrupt
            </span>
            <button
              className="footer-link"
              onClick={() => {
                setValue("/");
                ref.current?.focus();
              }}
            >
              / commands
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
