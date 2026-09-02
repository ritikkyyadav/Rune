// ─── The tab strip ───
//
// Session · Files · Review, at the top of the main column and belonging to it.
// Not a title bar: a bar spanning the whole window is a native-application idea,
// and this product is a page.
//
// The right side carries the two things a keyboard-first surface still has to
// advertise, because nobody discovers a shortcut they were never shown: ⌘K and
// ⌘T. Both are buttons as well as shortcuts — a keyboard-first interface is not
// a keyboard-only one.

import { PanelIcon, SearchIcon, SidebarIcon } from "./Icons";
import type { ConnectionState } from "../lib/types";

export type MainTab = "session" | "files" | "review";

const TABS: Array<{ id: MainTab; label: string }> = [
  { id: "session", label: "Session" },
  { id: "files", label: "Files" },
  { id: "review", label: "Review" },
];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting to the engine",
  connected: "engine ready",
  disconnected: "engine offline",
  error: "engine needs attention",
};

export function Tabs(props: {
  tab: MainTab;
  onTab: (t: MainTab) => void;
  title: string;
  subtitle?: string;
  reviewCount: number;
  connection: ConnectionState;
  sideOpen: boolean;
  railOpen: boolean;
  onToggleSide: () => void;
  onToggleRail: () => void;
  onSearch: () => void;
}) {
  return (
    <header className="tabs no-select">
      <button
        className="tb-btn icon"
        onClick={props.onToggleSide}
        title={`${props.sideOpen ? "Hide" : "Show"} the sidebar (⌘B)`}
        aria-label="Toggle sidebar"
        aria-pressed={props.sideOpen}
      >
        <SidebarIcon />
      </button>

      <nav className="tab-list" aria-label="Session views">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${props.tab === t.id ? "on" : ""}`}
            onClick={() => props.onTab(t.id)}
            aria-current={props.tab === t.id ? "page" : undefined}
          >
            {t.label}
            {t.id === "review" && props.reviewCount > 0 ? (
              <span className="count">{props.reviewCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="tab-title">
        <b>{props.title}</b>
        {props.subtitle ? <span className="tb-meta">{props.subtitle}</span> : null}
      </div>

      <div className="tb-actions">
        <span
          className={`conn ${props.connection}`}
          title={CONNECTION_LABEL[props.connection]}
          aria-label={CONNECTION_LABEL[props.connection]}
        >
          <i />
          {props.connection === "connected" ? null : CONNECTION_LABEL[props.connection]}
        </span>
        <button className="tb-btn icon" onClick={props.onSearch} title="Search (⌘K)">
          <SearchIcon />
        </button>
        <button
          className={`tb-btn icon ${props.railOpen ? "on" : ""}`}
          onClick={props.onToggleRail}
          title="Trace rail (⌘T)"
          aria-pressed={props.railOpen}
        >
          <PanelIcon />
        </button>
      </div>
    </header>
  );
}
