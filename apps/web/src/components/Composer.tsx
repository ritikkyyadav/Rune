import { useEffect, useMemo, useRef, useState } from "react";
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
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onUnqueue: (index: number) => void;
  onCycleGear: () => void;
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
          <span className="input-prompt">›</span>
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
                    : "Give Gear a coding task (or / for commands)…"}
                </div>
              </>
            ) : null}
          </div>
        </div>
        <footer className="footer-strip">
          <button
            className="mode-indicator"
            data-level={props.gear.id}
            onClick={props.onCycleGear}
            title="Shift+Tab shifts up: 1st → 2nd → 3rd → 4th → auto"
          >
            <span>{props.gear.arrows}</span>
            <span>{props.gear.label}</span>
          </button>
          <span className="mode-desc">{props.gear.desc}</span>
          <span className="footer-sep">·</span>
          <CtxMeter percent={props.ctxPercent} />
          {props.ctxPercent ? <span className="footer-sep">·</span> : null}
          <span className="footer-hint">
            <kbd>shift+tab</kbd> mode
          </span>
          <span className="footer-hint">
            <kbd>esc</kbd> interrupt
          </span>
          <span className="footer-hint">
            <kbd>⌘T</kbd> trace
          </span>
          <div className="footer-right">
            {props.onOpenStates ? (
              <button className="footer-link" onClick={props.onOpenStates}>
                ? states
              </button>
            ) : null}
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
