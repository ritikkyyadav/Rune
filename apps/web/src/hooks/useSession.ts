import { useState, useCallback } from "react";
import type { SessionInfo, ChatMessage, MessageAttachment, ToolCallInfo, Plan } from "../lib/types";
import { activeTransport } from "../lib/transport";

// ─── Session commands, over whichever transport is up ───
//
// This used to reach the engine directly, which meant the session list existed
// only in the app and never in `gear web`. It goes through the same transport as
// every other command now; `null` means there is no engine at all (the browser
// preview), which the caller renders as an empty list rather than an error.
async function hostCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const transport = activeTransport();
  if (!transport || transport.kind === "none") return null;
  try {
    return (await transport.call(
      cmd as Parameters<typeof transport.call>[0],
      args as never,
    )) as T | null;
  } catch {
    return null;
  }
}

interface SessionState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  activePlan: Plan | null;
  isLoading: boolean;
  sessionsLoading: boolean;
  error: string | null;
}

const initialState: SessionState = {
  sessions: [],
  activeSessionId: null,
  messages: [],
  activePlan: null,
  isLoading: false,
  sessionsLoading: false,
  error: null,
};

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useSession() {
  const [state, setState] = useState<SessionState>(initialState);

  // ─── Load sessions from backend on mount ───

  const loadSessions = useCallback(async () => {
    setState((prev) => ({ ...prev, sessionsLoading: true, error: null }));
    try {
      const sessions = await hostCall<SessionInfo[]>("list_sessions");
      if (sessions) {
        setState((prev) => ({
          ...prev,
          sessions,
          sessionsLoading: false,
        }));
      } else {
        setState((prev) => ({ ...prev, sessionsLoading: false }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        sessionsLoading: false,
        error: err instanceof Error ? err.message : "Failed to load sessions",
      }));
    }
  }, []);

  // NOT on mount: the transport opens asynchronously, so a list_sessions at
  // mount reaches `activeTransport() === null`, returns nothing, and the list
  // stays empty for the life of the page. That was invisible until a reload
  // needed to bring existing sessions BACK, which is exactly the case the
  // product depends on — a page can be closed; the engine keeps the work.
  // App.tsx calls this when the engine reports connected.

  // ─── Create session ───

  const createSession = useCallback(
    (options?: { id?: string; model?: string; workspace?: string }) => {
      const id = options?.id ?? `session-${Date.now()}`;
      const session: SessionInfo = {
        id,
        title: "New task",
        model: options?.model ?? "deepseek/deepseek-v4-flash:free",
        workspace: options?.workspace ?? "~",
        eventCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setState((prev) => ({
        ...prev,
        sessions: [session, ...prev.sessions],
        activeSessionId: id,
        messages: [],
        activePlan: null,
        error: null,
      }));
      return id;
    },
    [],
  );

  // ─── Select / resume session ───

  const selectSession = useCallback(async (sessionId: string): Promise<ChatMessage[]> => {
    setState((prev) => ({
      ...prev,
      activeSessionId: sessionId,
      messages: [],
      activePlan: null,
      isLoading: true,
      error: null,
    }));

    try {
      const history = await hostCall<ChatMessage[]>("resume_session", {
        sessionId,
      });
      if (history) {
        setState((prev) => ({
          ...prev,
          messages: history,
          isLoading: false,
        }));
        return history;
      }
      // No engine attached — clear loading and show the empty state.
      setState((prev) => ({ ...prev, isLoading: false }));
      return [];
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load session history",
      }));
      return [];
    }
  }, []);

  // ─── Delete session ───

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await hostCall("delete_session", { sessionId });
    } catch {
      // Best effort -- remove from local state regardless
    }
    setState((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== sessionId);
      const activeSessionId = prev.activeSessionId === sessionId ? null : prev.activeSessionId;
      return {
        ...prev,
        sessions,
        activeSessionId,
        messages: activeSessionId === null ? [] : prev.messages,
        activePlan: activeSessionId === null ? null : prev.activePlan,
      };
    });
  }, []);

  // ─── Message management ───

  const addUserMessage = useCallback((content: string, attachments?: MessageAttachment[]) => {
    const timestamp = new Date().toISOString();
    const msg: ChatMessage = {
      id: generateId(),
      role: "user",
      content,
      timestamp,
      attachments,
    };
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === prev.activeSessionId
          ? {
              ...session,
              title:
                session.title === "New task" || session.title === "New Session"
                  ? content.replace(/\s+/g, " ").trim().slice(0, 54) || "New task"
                  : session.title,
              eventCount: session.eventCount + 1,
              updatedAt: timestamp,
            }
          : session,
      ),
      messages: [...prev.messages, msg],
      isLoading: true,
      error: null,
    }));
    return msg.id;
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    setState((prev) => {
      const msgs = [...prev.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = {
          ...last,
          content: last.content + text,
        };
      } else {
        msgs.push({
          id: generateId(),
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
        });
      }
      return { ...prev, messages: msgs };
    });
  }, []);

  const addToolCall = useCallback((toolCall: ToolCallInfo) => {
    setState((prev) => {
      const msgs = [...prev.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = {
          ...last,
          toolCalls: [...(last.toolCalls ?? []), toolCall],
        };
      } else {
        msgs.push({
          id: generateId(),
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
          toolCalls: [toolCall],
        });
      }
      return { ...prev, messages: msgs };
    });
  }, []);

  const updateToolCall = useCallback((callId: string, update: Partial<ToolCallInfo>) => {
    setState((prev) => {
      const msgs = prev.messages.map((msg) => {
        if (!msg.toolCalls) return msg;
        const toolCalls = msg.toolCalls.map((tc) =>
          tc.callId === callId ? { ...tc, ...update } : tc,
        );
        return { ...msg, toolCalls };
      });
      return { ...prev, messages: msgs };
    });
  }, []);

  const setPlan = useCallback((plan: Plan | null) => {
    setState((prev) => ({ ...prev, activePlan: plan }));
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    setState((prev) => ({ ...prev, isLoading: loading }));
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    loadSessions,
    createSession,
    selectSession,
    deleteSession,
    addUserMessage,
    appendAssistantText,
    addToolCall,
    updateToolCall,
    setPlan,
    setLoading,
    clearError,
  };
}
