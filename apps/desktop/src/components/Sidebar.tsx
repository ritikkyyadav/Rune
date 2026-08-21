import { useMemo } from "react";
import { GearMark } from "./GearMark";
import type { SessionInfo } from "../lib/types";
import type { GearInfo } from "../lib/gears";

/** Today · Thu Aug 20 / Yesterday · … / Past 7 days / Mon YYYY — the CLI's grouping. */
export function sessionGroupLabel(iso: string, now = new Date()): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Earlier";
  const day = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.max(0, Math.round((today - day) / 86_400_000));
  const date = `${value.toLocaleDateString("en-US", { weekday: "short" })} ${value.toLocaleDateString("en-US", { month: "short" })} ${value.getDate()}`;
  if (days === 0) return `Today · ${date}`;
  if (days === 1) return `Yesterday · ${date}`;
  if (days < 7) return "Past 7 days";
  return value.toLocaleDateString([], { month: "short", year: "numeric" });
}

function shortHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export function Sidebar(props: {
  sessions: SessionInfo[];
  activeId: string | null;
  loading: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  reviewCount: number;
  onReview: () => void;
  env: { gear: GearInfo; model: string; ctxPercent?: number; workspace: string; branch?: string };
  onOpenSettings: () => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const groups = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    const list = props.sessions
      .filter((s) => !q || `${s.title} ${s.workspace} ${s.model} ${s.id}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const out: Array<{ label: string; items: SessionInfo[] }> = [];
    for (const s of list) {
      const label = sessionGroupLabel(s.updatedAt);
      const last = out.at(-1);
      if (last && last.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [props.sessions, props.query]);

  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="new-task" onClick={props.onNew}>
          ＋ New task <kbd>⌘N</kbd>
        </button>
        <label className="side-search">
          /
          <input
            ref={props.searchRef}
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder="Search title, path, model…"
            aria-label="Search sessions"
          />
          <kbd>⌘K</kbd>
        </label>
      </div>
      <nav className="side-nav">
        <button className="side-item on">All tasks</button>
        <button className="side-item" onClick={props.onReview}>
          Review changes{" "}
          {props.reviewCount > 0 ? <span className="count">{props.reviewCount}</span> : null}
        </button>
      </nav>
      <div className="side-sessions">
        {groups.length === 0 ? (
          <div className="side-empty">
            {props.loading
              ? "Loading sessions…"
              : props.query
                ? "No sessions match."
                : "No sessions yet — start a task."}
          </div>
        ) : null}
        {groups.map((group) => (
          <div className="tl-group" key={group.label}>
            <div className="tl-head">{group.label}</div>
            {group.items.map((s) => {
              const current = s.id === props.activeId;
              const time = new Date(s.updatedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              });
              return (
                <button
                  key={s.id}
                  className={`s-item ${current ? "current" : ""}`}
                  onClick={() => props.onSelect(s.id)}
                  title={s.title}
                >
                  <span className="s-dot" />
                  <span className="s-body">
                    <span className="s-title">{s.title || "untitled"}</span>
                    <span className="s-sub">
                      {s.id.slice(0, 8)} · {shortHome(s.workspace)} · {s.model} · {s.eventCount}{" "}
                      events · {time}
                    </span>
                  </span>
                  <span className={`s-pill ${current ? "active" : "done"}`}>
                    {current ? "active" : "saved"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="side-foot">
        <div className="side-env">
          <span className={`env-badge ${props.env.gear.id === "auto" ? "auto" : "gear"}`}>
            {props.env.gear.arrows} {props.env.gear.label}
          </span>
          <span className="env-badge">{props.env.model}</span>
          {props.env.ctxPercent ? (
            <span className="env-badge">ctx {Math.round(props.env.ctxPercent)}%</span>
          ) : null}
        </div>
        <button
          className="side-account"
          onClick={props.onOpenSettings}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
          }}
        >
          <GearMark size={18} />
          <span style={{ minWidth: 0 }}>
            <b>Local workspace</b>
            <small>
              {shortHome(props.env.workspace)}
              {props.env.branch ? ` · ${props.env.branch}` : ""}
            </small>
          </span>
        </button>
      </div>
    </aside>
  );
}
