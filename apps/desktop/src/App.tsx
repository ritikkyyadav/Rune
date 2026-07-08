import { useState, useCallback } from "react";
import { SessionList } from "./components/SessionList";
import { MessageStream } from "./components/MessageStream";
import { Composer } from "./components/Composer";
import { PlanPane } from "./components/PlanPane";
import { PermissionModal } from "./components/PermissionModal";
import { Settings } from "./components/Settings";
import { useSession } from "./hooks/useSession";
import { useEngine } from "./hooks/useEngine";
import type { PermissionPrompt, PermissionDecision, ConnectionState } from "./lib/types";

// ─── Connection status dot colours ───
const connectionColors: Record<ConnectionState, string> = {
  connecting: "var(--warning)",
  connected: "var(--success)",
  disconnected: "var(--text-muted)",
  error: "var(--error)",
};

const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting...",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Connection error",
};

// ─── Layout styles ───

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
  },
  leftRail: {
    width: 250,
    minWidth: 250,
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-secondary)",
  },
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  rightRail: {
    width: 300,
    minWidth: 300,
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-secondary)",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 16px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-secondary)",
    minHeight: 40,
    gap: 12,
  },
  topBarLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "var(--text-secondary)",
  },
  wordmark: {
    display: "flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "0.02em",
  },
  wordmarkCursor: {
    color: "var(--accent)",
    marginLeft: 1,
  },
  brandDivider: {
    width: 1,
    height: 16,
    background: "var(--border)",
    margin: "0 4px",
  },
  topBarRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  modelLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-muted)",
    padding: "2px 8px",
    background: "var(--bg-primary)",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
  },
  contextBarOuter: {
    width: 100,
    height: 6,
    background: "var(--bg-primary)",
    borderRadius: 3,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  contextBarInner: {
    height: "100%",
    borderRadius: 3,
    transition: "width 0.3s ease",
  },
  contextLabel: {
    fontSize: 11,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
  },
  settingsButton: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 14,
    padding: "4px 8px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
    transition: "background 0.15s",
  },
  errorBanner: {
    padding: "8px 16px",
    background: "rgba(248, 113, 113, 0.1)",
    borderBottom: "1px solid var(--error)",
    color: "var(--error)",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  errorDismiss: {
    background: "transparent",
    border: "none",
    color: "var(--error)",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: "0 4px",
  },
};

export default function App() {
  const session = useSession();
  const [showPlanPane, setShowPlanPane] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<{
    prompt: PermissionPrompt;
    resolve: (decision: PermissionDecision) => void;
  } | null>(null);

  const engine = useEngine({
    onTextDelta: session.appendAssistantText,
    onToolCallStart: (callId, toolName) => {
      session.addToolCall({
        callId,
        toolName,
        args: {},
        status: "running",
      });
    },
    onToolCallEnd: (callId, update) => {
      session.updateToolCall(callId, update);
    },
    onPlanCreated: (plan) => {
      session.setPlan(plan);
      setShowPlanPane(true);
    },
    onPlanUpdated: (plan) => {
      session.setPlan(plan);
    },
    onTurnComplete: () => {
      session.setLoading(false);
    },
    onError: (error) => {
      session.appendAssistantText(`\n\nError: ${error}`);
      session.setLoading(false);
    },
    onPermissionRequest: (prompt) => {
      return new Promise<PermissionDecision>((resolve) => {
        setPermissionRequest({ prompt, resolve });
      });
    },
  });

  // ─── Handlers ───

  const handleSend = useCallback(
    async (message: string) => {
      if (!message.trim()) return;

      let sid = session.activeSessionId;
      if (!sid) {
        sid = session.createSession();
      }

      session.addUserMessage(message);
      await engine.sendMessage(sid, message);
    },
    [session, engine],
  );

  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      if (permissionRequest) {
        permissionRequest.resolve(decision);
        setPermissionRequest(null);
      }
    },
    [permissionRequest],
  );

  const handleNewSession = useCallback(() => {
    session.createSession();
  }, [session]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      session.deleteSession(sessionId);
    },
    [session],
  );

  // ─── Context usage bar ───

  const contextPercent =
    engine.status.contextMax > 0
      ? Math.min(Math.round((engine.status.contextUsed / engine.status.contextMax) * 100), 100)
      : 0;

  const contextBarColor =
    contextPercent > 90 ? "var(--error)" : contextPercent > 70 ? "var(--warning)" : "var(--accent)";

  return (
    <div style={styles.container}>
      {/* Left rail: session list */}
      <div style={styles.leftRail} className="no-select">
        <SessionList
          sessions={session.sessions}
          activeSessionId={session.activeSessionId}
          onSelect={session.selectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          isLoading={session.sessionsLoading}
        />
      </div>

      {/* Center: top bar + message stream + composer */}
      <div style={styles.center}>
        {/* Top bar with connection status, model, and context usage */}
        <div style={styles.topBar} className="no-select">
          <div style={styles.topBarLeft}>
            <span style={styles.wordmark} title="Berne — Sovereign Agentic Coding Assistant">
              Berne<span style={styles.wordmarkCursor}>▮</span>
            </span>
            <div style={styles.brandDivider} />
            <div
              style={{
                ...styles.statusDot,
                background: connectionColors[engine.connectionState],
              }}
              title={connectionLabels[engine.connectionState]}
            />
            <span>{connectionLabels[engine.connectionState]}</span>
          </div>

          <div style={styles.topBarRight}>
            {/* Model label */}
            <span style={styles.modelLabel}>{engine.status.model}</span>

            {/* Context usage bar */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              title={`Context: ${engine.status.contextUsed.toLocaleString()} / ${engine.status.contextMax.toLocaleString()} tokens`}
            >
              <div style={styles.contextBarOuter}>
                <div
                  style={{
                    ...styles.contextBarInner,
                    width: `${contextPercent}%`,
                    background: contextBarColor,
                  }}
                />
              </div>
              <span style={styles.contextLabel}>{contextPercent}%</span>
            </div>

            {/* Settings */}
            <button
              style={styles.settingsButton}
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              &#9881;
            </button>
          </div>
        </div>

        {/* Error banner */}
        {session.error && (
          <div style={styles.errorBanner}>
            <span>{session.error}</span>
            <button style={styles.errorDismiss} onClick={session.clearError}>
              &#215;
            </button>
          </div>
        )}

        <MessageStream messages={session.messages} isLoading={session.isLoading} />
        <Composer
          onSend={handleSend}
          disabled={engine.isProcessing}
          isProcessing={engine.isProcessing}
          onAbort={engine.abort}
        />
      </div>

      {/* Right rail: plan pane (collapsible) */}
      {showPlanPane && session.activePlan && (
        <div style={styles.rightRail}>
          <PlanPane plan={session.activePlan} onClose={() => setShowPlanPane(false)} />
        </div>
      )}

      {/* Permission modal overlay */}
      {permissionRequest && (
        <PermissionModal prompt={permissionRequest.prompt} onDecision={handlePermissionDecision} />
      )}

      {/* Settings panel */}
      {showSettings && (
        <Settings
          status={engine.status}
          onSwitchModel={engine.switchModel}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
