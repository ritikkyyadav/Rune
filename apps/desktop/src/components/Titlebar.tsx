import { GearMark } from "./GearMark";
import type { ConnectionState } from "../lib/types";
import type { GearInfo } from "../lib/gears";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting",
  connected: "engine ready",
  disconnected: "engine offline",
  error: "engine needs attention",
};

export function Titlebar(props: {
  version: string;
  task?: string;
  turnLabel?: string;
  sandboxOn: boolean | null;
  mcpCount?: number;
  gear: GearInfo;
  connection: ConnectionState;
  railOpen: boolean;
  sideOpen: boolean;
  reviewCount: number;
  onToggleRail: () => void;
  onToggleSide: () => void;
  onOpenSettings: () => void;
  onOpenReview: () => void;
}) {
  return (
    <header className="titlebar no-select" data-tauri-drag-region>
      {!props.sideOpen ? (
        <button
          className="tb-btn"
          onClick={props.onToggleSide}
          title="Show sidebar (⌘B)"
          aria-label="Show sidebar"
        >
          ☰
        </button>
      ) : null}
      <div className="tb-brand">
        <GearMark size={18} />
        Gear <span className="version">v{props.version}</span>
      </div>
      <div className="tb-task" data-tauri-drag-region>
        <b>{props.task || "New task"}</b>
        {props.turnLabel ? <span className="turn">{props.turnLabel}</span> : null}
      </div>
      <div className="tb-actions">
        <span className={`conn ${props.connection}`} title={CONNECTION_LABEL[props.connection]}>
          <i />
          {props.connection === "connected" ? null : CONNECTION_LABEL[props.connection]}
        </span>
        {props.sandboxOn === true ? <span className="env-badge sandbox">sandbox on</span> : null}
        {props.sandboxOn === false ? <span className="env-badge danger">sandbox off</span> : null}
        {props.mcpCount ? <span className="env-badge">MCP · {props.mcpCount}</span> : null}
        <button className="tb-btn" onClick={props.onOpenReview} title="Review changes">
          Review {props.reviewCount > 0 ? <span className="count">{props.reviewCount}</span> : null}
        </button>
        <button
          className={`tb-btn ${props.railOpen ? "on" : ""}`}
          onClick={props.onToggleRail}
          title="Toggle trace rail (⌘T)"
          aria-pressed={props.railOpen}
        >
          Trace
        </button>
        <button className="tb-btn" onClick={props.onOpenSettings} title="Settings (⌘,)">
          ⚙ Settings
        </button>
      </div>
    </header>
  );
}
