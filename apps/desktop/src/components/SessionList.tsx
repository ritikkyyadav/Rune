import { useState, useCallback } from "react";
import type { SessionInfo } from "../lib/types";

interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession?: (id: string) => void;
  isLoading?: boolean;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 16px 12px",
    borderBottom: "1px solid var(--border)",
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  newButton: {
    background: "var(--accent)",
    color: "white",
    border: "none",
    borderRadius: "var(--radius-sm)",
    width: 28,
    height: 28,
    fontSize: 18,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  list: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px 0",
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    padding: "12px 16px 4px",
  },
  sessionItem: {
    padding: "10px 16px",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    margin: "0 8px",
    transition: "background 0.15s",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  sessionInfo: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  sessionMeta: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 2,
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  deleteButton: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 4px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0,
    transition: "opacity 0.15s, color 0.15s",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    padding: 24,
    color: "var(--text-muted)",
    fontSize: 13,
    textAlign: "center" as const,
    gap: 8,
  },
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    color: "var(--text-muted)",
    fontSize: 13,
  },
  modelBadge: {
    fontSize: 10,
    fontFamily: "var(--font-mono)",
    color: "var(--accent)",
    background: "rgba(124, 91, 245, 0.1)",
    padding: "0 4px",
    borderRadius: 4,
  },
};

function groupByDay(sessions: SessionInfo[]) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const groups: { label: string; sessions: SessionInfo[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "This Week", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const s of sessions) {
    const date = new Date(s.updatedAt);
    if (date.toDateString() === today.toDateString()) {
      groups[0].sessions.push(s);
    } else if (date.toDateString() === yesterday.toDateString()) {
      groups[1].sessions.push(s);
    } else if (date > weekAgo) {
      groups[2].sessions.push(s);
    } else {
      groups[3].sessions.push(s);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
  onDeleteSession,
  isLoading = false,
}: SessionListProps) {
  const groups = groupByDay(sessions);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleDelete = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (confirmDeleteId === sessionId) {
        onDeleteSession?.(sessionId);
        setConfirmDeleteId(null);
      } else {
        setConfirmDeleteId(sessionId);
        // Auto-reset confirm after 3 seconds
        setTimeout(() => setConfirmDeleteId(null), 3000);
      }
    },
    [confirmDeleteId, onDeleteSession],
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Sessions</span>
        <button
          style={styles.newButton}
          onClick={onNewSession}
          title="New session"
        >
          +
        </button>
      </div>

      {isLoading ? (
        <div style={styles.loadingState}>Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={{ fontSize: 24 }}>{"{ }"}</span>
          <span>No sessions yet</span>
          <span>Start a new session to begin</span>
        </div>
      ) : (
        <div style={styles.list}>
          {groups.map((group) => (
            <div key={group.label}>
              <div style={styles.groupLabel}>{group.label}</div>
              {group.sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                const isHovered = hoveredId === s.id;
                const isConfirming = confirmDeleteId === s.id;

                return (
                  <div
                    key={s.id}
                    style={{
                      ...styles.sessionItem,
                      background: isActive
                        ? "var(--bg-tertiary)"
                        : "transparent",
                    }}
                    onClick={() => onSelect(s.id)}
                    onMouseEnter={(e) => {
                      setHoveredId(s.id);
                      if (!isActive) {
                        e.currentTarget.style.background = "var(--bg-hover)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      setHoveredId(null);
                      if (!isActive) {
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    <div style={styles.sessionInfo}>
                      <div style={styles.sessionTitle}>
                        {s.title || "Untitled Session"}
                      </div>
                      <div style={styles.sessionMeta}>
                        <span>{s.eventCount} events</span>
                        <span>&middot;</span>
                        <span>{formatTime(s.updatedAt)}</span>
                        <span>&middot;</span>
                        <span>{formatDate(s.createdAt)}</span>
                      </div>
                      <div style={{ marginTop: 2 }}>
                        <span style={styles.modelBadge}>{s.model}</span>
                      </div>
                    </div>

                    {onDeleteSession && (isHovered || isConfirming) && (
                      <button
                        style={{
                          ...styles.deleteButton,
                          opacity: 1,
                          color: isConfirming
                            ? "var(--error)"
                            : "var(--text-muted)",
                        }}
                        onClick={(e) => handleDelete(e, s.id)}
                        title={isConfirming ? "Click again to confirm" : "Delete session"}
                      >
                        {isConfirming ? "?" : "\u00D7"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
