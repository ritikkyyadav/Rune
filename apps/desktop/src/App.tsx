import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { Composer, type ComposerAttachment } from "./components/Composer";
import { EnvironmentPanel, summarizeChanges } from "./components/EnvironmentPanel";
import {
  ChatIcon,
  ChevronDownIcon,
  ComposeIcon,
  FolderIcon,
  MoreIcon,
  PanelIcon,
  ReviewIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  UserIcon,
} from "./components/Icons";
import { MessageStream } from "./components/MessageStream";
import { PermissionModal } from "./components/PermissionModal";
import { PlanPane } from "./components/PlanPane";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import { SessionList } from "./components/SessionList";
import { Settings } from "./components/Settings";
import { useEngine } from "./hooks/useEngine";
import { useSession } from "./hooks/useSession";
import type { ConnectionState, PermissionDecision, PermissionPrompt } from "./lib/types";

type WorkspaceView = "chat" | "review";

const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Ready",
  disconnected: "Offline",
  error: "Needs attention",
};

function friendlyModelName(model: string): string {
  const known: Record<string, string> = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
  };
  if (known[model]) return known[model];
  const short = model.split("/").pop() ?? model;
  return short
    .replace(/:free$/i, "")
    .split("-")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function workspaceLabel(path: string): string {
  if (!path || path === "~") return "Local workspace";
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function buildEnginePrompt(message: string, attachments: ComposerAttachment[]): string {
  if (attachments.length === 0) return message;
  const files = attachments
    .map(
      (attachment) =>
        `<attached_file name="${attachment.name}" type="${attachment.type}">\n${attachment.content}\n</attached_file>`,
    )
    .join("\n\n");
  return `${message}\n\nThe user attached these text files:\n\n${files}`;
}

export default function App() {
  const session = useSession();
  const [activeView, setActiveView] = useState<WorkspaceView>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [environmentOpen, setEnvironmentOpen] = useState(() => window.innerWidth >= 1120);
  const [showPlanPane, setShowPlanPane] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [permissionRequest, setPermissionRequest] = useState<{
    prompt: PermissionPrompt;
    resolve: (decision: PermissionDecision) => void;
  } | null>(null);

  const engine = useEngine({
    onTextDelta: session.appendAssistantText,
    onToolCallStart: (callId, toolName) => {
      session.addToolCall({ callId, toolName, args: {}, status: "running" });
    },
    onToolCallEnd: session.updateToolCall,
    onPlanCreated: (plan) => {
      session.setPlan(plan);
      setShowPlanPane(true);
    },
    onPlanUpdated: session.setPlan,
    onTurnComplete: () => session.setLoading(false),
    onError: (error) => {
      session.appendAssistantText(`\n\nGear hit a problem: ${error}`);
      session.setLoading(false);
    },
    onPermissionRequest: (prompt) =>
      new Promise<PermissionDecision>((resolve) => setPermissionRequest({ prompt, resolve })),
  });

  const activeSession = useMemo(
    () => session.sessions.find((item) => item.id === session.activeSessionId) ?? null,
    [session.activeSessionId, session.sessions],
  );
  const allToolCalls = useMemo(
    () => session.messages.flatMap((message) => message.toolCalls ?? []),
    [session.messages],
  );
  const changes = useMemo(() => summarizeChanges(allToolCalls), [allToolCalls]);
  const workspace = activeSession?.workspace ?? engine.status.workspace ?? "~";

  const createPersistedSession = useCallback(async () => {
    const engineSessionId = await engine.createSession(engine.status.model);
    return session.createSession({
      id: engineSessionId,
      model: engine.status.model,
      workspace: engine.status.workspace ?? "~",
    });
  }, [engine.createSession, engine.status.model, engine.status.workspace, session.createSession]);

  const handleSend = useCallback(
    async (message: string, attachments: ComposerAttachment[] = []) => {
      if (!message.trim() && attachments.length === 0) return;
      const sessionId = session.activeSessionId ?? (await createPersistedSession());
      session.addUserMessage(
        message || "Please review the attached file.",
        attachments.map(({ name, size, type }) => ({ name, size, type })),
      );
      setActiveView("chat");
      await engine.sendMessage(sessionId, buildEnginePrompt(message, attachments));
    },
    [createPersistedSession, engine.sendMessage, session.activeSessionId, session.addUserMessage],
  );

  const handleNewSession = useCallback(() => {
    setActiveView("chat");
    setSearchOpen(false);
    setSearchQuery("");
    void createPersistedSession();
  }, [createPersistedSession]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setActiveView("chat");
      void session.selectSession(sessionId);
    },
    [session.selectSession],
  );

  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      permissionRequest?.resolve(decision);
      setPermissionRequest(null);
    },
    [permissionRequest],
  );

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        if (event.key === "Escape") {
          setSearchOpen(false);
          setShowPlanPane(false);
        }
        return;
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleNewSession();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSidebarOpen(true);
        setSearchOpen(true);
      } else if (event.key === ",") {
        event.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleNewSession]);

  const isTauriRuntime = "__TAURI_INTERNALS__" in window;
  const taskTitle = activeSession?.title || "New task";
  const modelName = friendlyModelName(engine.status.model);

  return (
    <div
      className={`app-shell ${sidebarOpen ? "app-shell--sidebar" : ""} ${
        environmentOpen ? "app-shell--environment" : ""
      } ${isTauriRuntime ? "app-shell--tauri" : "app-shell--browser"}`}
    >
      {sidebarOpen ? (
        <aside className="sidebar no-select">
          <div className="sidebar-titlebar" data-tauri-drag-region>
            <div className="traffic-lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="sidebar-brand">
              <BrandMark size={25} />
              <strong>Gear</strong>
              <ChevronDownIcon />
            </div>
            <div className="sidebar-title-actions">
              <button
                type="button"
                onClick={() => setSearchOpen((open) => !open)}
                title="Search tasks (⌘K)"
                aria-label="Search tasks"
              >
                <SearchIcon />
              </button>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar"
                aria-label="Hide sidebar"
              >
                <SidebarIcon />
              </button>
            </div>
          </div>

          {searchOpen ? (
            <label className="sidebar-search">
              <SearchIcon />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search tasks…"
                aria-label="Search tasks"
              />
              <kbd>esc</kbd>
            </label>
          ) : null}

          <nav className="primary-nav" aria-label="Main navigation">
            <button type="button" className="new-task-button" onClick={handleNewSession}>
              <ComposeIcon />
              <span>New task</span>
              <kbd>⌘N</kbd>
            </button>
            <button
              type="button"
              className={`nav-item ${activeView === "chat" ? "nav-item--active" : ""}`}
              onClick={() => setActiveView("chat")}
            >
              <ChatIcon />
              <span>All tasks</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeView === "review" ? "nav-item--active" : ""}`}
              onClick={() => setActiveView("review")}
            >
              <ReviewIcon />
              <span>Review changes</span>
              {changes.calls.length > 0 ? <b>{changes.calls.length}</b> : null}
            </button>
          </nav>

          <SessionList
            sessions={session.sessions}
            activeSessionId={session.activeSessionId}
            onSelect={handleSelectSession}
            onNewSession={handleNewSession}
            onDeleteSession={session.deleteSession}
            isLoading={session.sessionsLoading}
            searchQuery={searchQuery}
          />

          <footer className="sidebar-footer">
            <button type="button" className="account-button" onClick={() => setShowSettings(true)}>
              <span className="account-avatar">
                <UserIcon />
              </span>
              <span>
                <strong>Local workspace</strong>
                <small>{workspaceLabel(workspace)}</small>
              </span>
              <SettingsIcon />
            </button>
          </footer>
        </aside>
      ) : null}

      <section className="workbench">
        <header className="workspace-header no-select" data-tauri-drag-region>
          <div className="workspace-heading">
            {!sidebarOpen ? (
              <button
                type="button"
                className="chrome-button"
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <SidebarIcon />
              </button>
            ) : null}
            <span className="workspace-heading-icon">
              <FolderIcon />
            </span>
            <h1>{taskTitle}</h1>
            <button
              type="button"
              className="title-more"
              title="Task options"
              aria-label="Task options"
            >
              <MoreIcon />
            </button>
            <span className={`connection-state connection-state--${engine.connectionState}`}>
              <i />
              {connectionLabels[engine.connectionState]}
            </span>
          </div>
          <div className="workspace-actions">
            <button
              type="button"
              className="chrome-button"
              onClick={() => setShowSettings(true)}
              title="Settings (⌘,)"
              aria-label="Open settings"
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              className={`chrome-button ${environmentOpen ? "chrome-button--active" : ""}`}
              onClick={() => setEnvironmentOpen((open) => !open)}
              title="Toggle environment"
              aria-label="Toggle environment panel"
              aria-pressed={environmentOpen}
            >
              <PanelIcon />
            </button>
          </div>
        </header>

        <div className="view-tabs no-select">
          <div role="tablist" aria-label="Task views">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "chat"}
              className={activeView === "chat" ? "view-tab--active" : ""}
              onClick={() => setActiveView("chat")}
            >
              Conversation
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "review"}
              className={activeView === "review" ? "view-tab--active" : ""}
              onClick={() => setActiveView("review")}
            >
              Review
              {changes.calls.length > 0 ? <b>{changes.calls.length}</b> : null}
            </button>
          </div>
          <span className="view-workspace-label" title={workspace}>
            <FolderIcon />
            {workspaceLabel(workspace)}
          </span>
        </div>

        {session.error ? (
          <div className="error-banner" role="alert">
            <span>{session.error}</span>
            <button type="button" onClick={session.clearError} aria-label="Dismiss error">
              ×
            </button>
          </div>
        ) : null}

        <div className="workbench-body">
          <main className="stage" role="tabpanel">
            {activeView === "chat" ? (
              <>
                <MessageStream
                  messages={session.messages}
                  isLoading={session.isLoading}
                  onSuggestion={(message) => void handleSend(message)}
                />
                <Composer
                  onSend={handleSend}
                  disabled={engine.isProcessing}
                  isProcessing={engine.isProcessing}
                  onAbort={engine.abort}
                  modelName={modelName}
                  onOpenSettings={() => setShowSettings(true)}
                />
              </>
            ) : (
              <ReviewWorkspace
                toolCalls={allToolCalls}
                onBackToChat={() => setActiveView("chat")}
              />
            )}
          </main>

          {environmentOpen ? (
            <EnvironmentPanel
              status={engine.status}
              connectionState={engine.connectionState}
              workspace={workspace}
              toolCalls={allToolCalls}
              plan={session.activePlan}
              planOpen={showPlanPane}
              onReview={() => setActiveView("review")}
              onTogglePlan={() => setShowPlanPane((open) => !open)}
            />
          ) : null}

          {showPlanPane && session.activePlan ? (
            <aside className="plan-drawer" aria-label="Task plan">
              <PlanPane plan={session.activePlan} onClose={() => setShowPlanPane(false)} />
            </aside>
          ) : null}
        </div>
      </section>

      {permissionRequest ? (
        <PermissionModal prompt={permissionRequest.prompt} onDecision={handlePermissionDecision} />
      ) : null}

      {showSettings ? (
        <Settings
          status={engine.status}
          onSwitchModel={engine.switchModel}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </div>
  );
}
