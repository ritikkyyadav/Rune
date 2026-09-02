// ─── The sidebar ───
//
// Workspace at the top, five ways in, then every session grouped by day, then a
// quiet footer that says which gear you are in, what today has cost and which
// version is running.
//
// Sessions are grouped rather than paginated because the question a person
// actually has is "the thing I was doing yesterday", not "page 2". The groups
// are the same ones the console prints, so switching surfaces does not mean
// re-learning where anything is.

import { useMemo } from "react";
import { GearMark } from "./GearMark";
import {
  ChatIcon,
  ChevronDownIcon,
  FolderIcon,
  PlugIcon,
  ReviewIcon,
  SearchIcon,
  SettingsIcon,
} from "./Icons";
import type { SessionInfo } from "../lib/types";
import type { GearInfo } from "../lib/gears";

export type NavItem = "sessions" | "files" | "connect" | "settings";

/** Today · Thu Aug 20 / Yesterday · … / Past 7 days / Mon YYYY — the console's grouping. */
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

export function shortHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function folderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function Sidebar(props: {
  sessions: SessionInfo[];
  activeId: string | null;
  loading: boolean;
  nav: NavItem;
  onNav: (item: NavItem) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSearch: () => void;
  reviewCount: number;
  workspace: string;
  version: string;
  gear: GearInfo;
  /** Today's spend, from the engine. `null` means no data — never zero. */
  costToday: number | null;
}) {
  const groups = useMemo(() => {
    const list = props.sessions.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const out: Array<{ label: string; items: SessionInfo[] }> = [];
    for (const s of list) {
      const label = sessionGroupLabel(s.updatedAt);
      const last = out.at(-1);
      if (last && last.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [props.sessions]);

  return (
    <aside className="sidebar" aria-label="Sessions and navigation">
      {/* The workspace switcher. One folder at a time is the engine's own
          model, so the chevron opens the honest answer — how to point it
          somewhere else — rather than a picker that cannot deliver. */}
      <div className="side-head">
        <GearMark size={18} />
        <b title={props.workspace}>{folderName(props.workspace)}</b>
        <ChevronDownIcon className="side-chev" />
      </div>
      <div className="side-path" title={props.workspace}>
        {shortHome(props.workspace)}
      </div>

      <div className="side-top">
        <button className="new-task" onClick={props.onNew}>
          <ChatIcon />
          New session <kbd>⌘N</kbd>
        </button>
        <button className="side-item" onClick={props.onSearch}>
          <SearchIcon />
          Search <kbd>⌘K</kbd>
        </button>
      </div>

      <nav className="side-nav" aria-label="Sections">
        <button
          className={`side-item ${props.nav === "files" ? "on" : ""}`}
          onClick={() => props.onNav("files")}
        >
          <FolderIcon />
          Files
        </button>
        <button
          className={`side-item ${props.nav === "connect" ? "on" : ""}`}
          onClick={() => props.onNav("connect")}
        >
          <PlugIcon />
          Connect
        </button>
        <button
          className={`side-item ${props.nav === "settings" ? "on" : ""}`}
          onClick={() => props.onNav("settings")}
        >
          <SettingsIcon />
          Settings
        </button>
        {props.reviewCount > 0 ? (
          <button className="side-item" onClick={() => props.onNav("sessions")}>
            <ReviewIcon />
            Review changes <span className="count">{props.reviewCount}</span>
          </button>
        ) : null}
      </nav>

      <div className="side-sessions">
        {groups.length === 0 ? (
          <div className="side-empty">
            {props.loading ? "Reading sessions…" : "No sessions yet."}
          </div>
        ) : null}
        {groups.map((group) => (
          <div className="tl-group" key={group.label}>
            <div className="tl-head">{group.label}</div>
            {group.items.map((s) => {
              const current = s.id === props.activeId;
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
                      {s.id.slice(0, 8)} · {s.model}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="side-foot">
        <span className={`env-badge ${props.gear.id === "auto" ? "auto" : "gear"}`}>
          {props.gear.arrows} {props.gear.label}
        </span>
        <span className="side-meta">
          {/* `null` is "no data", never zero: an invented $0.00 is a claim. */}
          {props.costToday == null ? "cost —" : `$${props.costToday.toFixed(2)} today`}
        </span>
        <span className="side-meta">v{props.version}</span>
      </div>
    </aside>
  );
}
