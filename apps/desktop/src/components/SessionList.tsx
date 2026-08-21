import { useCallback, useMemo, useState } from "react";
import type { SessionInfo } from "../lib/types";
import { BrandMark } from "./BrandMark";
import { MoreIcon } from "./Icons";

interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession?: (id: string) => void;
  isLoading?: boolean;
  searchQuery?: string;
}

interface SessionGroup {
  label: string;
  sessions: SessionInfo[];
}

function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const groups: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Previous 7 days", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (date.toDateString() === now.toDateString()) groups[0].sessions.push(session);
    else if (date > weekAgo) groups[1].sessions.push(session);
    else groups[2].sessions.push(session);
  }

  return groups.filter((group) => group.sessions.length > 0);
}

function workspaceName(workspace: string): string {
  if (!workspace || workspace === "~") return "Local";
  const segments = workspace.split("/").filter(Boolean);
  return segments.at(-1) ?? workspace;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
  onDeleteSession,
  isLoading = false,
  searchQuery = "",
}: SessionListProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) =>
      `${session.title} ${session.workspace} ${session.model}`.toLowerCase().includes(query),
    );
  }, [searchQuery, sessions]);
  const groups = useMemo(() => groupSessions(visibleSessions), [visibleSessions]);

  const handleDelete = useCallback(
    (event: React.MouseEvent, sessionId: string) => {
      event.stopPropagation();
      if (confirmDeleteId === sessionId) {
        onDeleteSession?.(sessionId);
        setConfirmDeleteId(null);
        return;
      }
      setConfirmDeleteId(sessionId);
      window.setTimeout(() => setConfirmDeleteId(null), 2600);
    },
    [confirmDeleteId, onDeleteSession],
  );

  return (
    <section className="sessions-panel" aria-label="Recent tasks">
      <div className="sessions-heading">
        <span>Tasks</span>
        <b>{visibleSessions.length}</b>
      </div>

      {isLoading ? (
        <div className="sessions-loading" aria-label="Loading tasks">
          <i />
          <i />
          <i />
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="sessions-empty">
          <p>{searchQuery ? "No matching tasks." : "Your recent tasks will appear here."}</p>
          {!searchQuery ? (
            <button type="button" onClick={onNewSession}>
              Start a task
            </button>
          ) : null}
        </div>
      ) : (
        <div className="sessions-list">
          {groups.map((group) => (
            <div className="session-group" key={group.label}>
              <div className="session-group-label">{group.label}</div>
              {group.sessions.map((session) => {
                const active = session.id === activeSessionId;
                const hovered = hoveredId === session.id;
                const confirming = confirmDeleteId === session.id;
                return (
                  <div
                    className={`session-row ${active ? "session-row--active" : ""}`}
                    key={session.id}
                    onMouseEnter={() => setHoveredId(session.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <button
                      className="session-select"
                      type="button"
                      onClick={() => onSelect(session.id)}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="session-mark">
                        <BrandMark size={14} />
                      </span>
                      <span className="session-copy">
                        <strong>{session.title || "Untitled task"}</strong>
                        <small>{workspaceName(session.workspace)}</small>
                      </span>
                    </button>
                    {onDeleteSession && (hovered || confirming) ? (
                      <button
                        type="button"
                        className={`session-delete ${confirming ? "session-delete--confirm" : ""}`}
                        onClick={(event) => handleDelete(event, session.id)}
                        aria-label={confirming ? "Confirm task deletion" : "Delete task"}
                        title={confirming ? "Click again to delete" : "Delete task"}
                      >
                        {confirming ? "Delete" : <MoreIcon />}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
