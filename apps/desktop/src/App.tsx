import { useState, useCallback } from "react";
import { SessionList } from "./components/SessionList";
import { MessageStream } from "./components/MessageStream";
import { Composer } from "./components/Composer";
import { PlanPane } from "./components/PlanPane";
import { PermissionModal } from "./components/PermissionModal";
import { useSession } from "./hooks/useSession";
import { useEngine } from "./hooks/useEngine";
import type { PermissionPrompt, PermissionDecision } from "./lib/types";

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
};

export default function App() {
  const session = useSession();
  const [showPlanPane, setShowPlanPane] = useState(false);
  const [permissionRequest, setPermissionRequest] =
    useState<{
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

  return (
    <div style={styles.container}>
      {/* Left rail: session list */}
      <div style={styles.leftRail} className="no-select">
        <SessionList
          sessions={session.sessions}
          activeSessionId={session.activeSessionId}
          onSelect={session.selectSession}
          onNewSession={handleNewSession}
        />
      </div>

      {/* Center: message stream + composer */}
      <div style={styles.center}>
        <MessageStream
          messages={session.messages}
          isLoading={session.isLoading}
        />
        <Composer
          onSend={handleSend}
          disabled={engine.isProcessing}
        />
      </div>

      {/* Right rail: plan pane (collapsible) */}
      {showPlanPane && session.activePlan && (
        <div style={styles.rightRail}>
          <PlanPane
            plan={session.activePlan}
            onClose={() => setShowPlanPane(false)}
          />
        </div>
      )}

      {/* Permission modal overlay */}
      {permissionRequest && (
        <PermissionModal
          prompt={permissionRequest.prompt}
          onDecision={handlePermissionDecision}
        />
      )}
    </div>
  );
}
