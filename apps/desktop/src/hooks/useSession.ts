import { useState, useCallback, useEffect } from "react";
import type {
  SessionInfo,
  ChatMessage,
  ToolCallInfo,
  Plan,
} from "../lib/types";

// ─── Safe Tauri invoke wrapper ───
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    console.warn(`Tauri not available, using mock for: ${cmd}`);
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
      const sessions = await safeInvoke<SessionInfo[]>("list_sessions");
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

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // ─── Create session ───

  const createSession = useCallback(() => {
    const id = `session-${Date.now()}`;
    const session: SessionInfo = {
      id,
      title: "New Session",
      model: "deepseek/deepseek-v4-flash:free",
      workspace: "~",
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
  }, []);

  // ─── Select / resume session ───

  const selectSession = useCallback(async (sessionId: string) => {
    setState((prev) => ({
      ...prev,
      activeSessionId: sessionId,
      messages: [],
      activePlan: null,
      isLoading: true,
      error: null,
    }));

    try {
      const history = await safeInvoke<ChatMessage[]>("resume_session", {
        sessionId,
      });
      if (history) {
        setState((prev) => ({
          ...prev,
          messages: history,
          isLoading: false,
        }));
      } else {
        // Tauri not available -- just clear loading
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error:
          err instanceof Error ? err.message : "Failed to load session history",
      }));
    }
  }, []);

  // ─── Delete session ───

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await safeInvoke("delete_session", { sessionId });
    } catch {
      // Best effort -- remove from local state regardless
    }
    setState((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== sessionId);
      const activeSessionId =
        prev.activeSessionId === sessionId ? null : prev.activeSessionId;
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

  const addUserMessage = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: generateId(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    setState((prev) => ({
      ...prev,
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

  const updateToolCall = useCallback(
    (callId: string, update: Partial<ToolCallInfo>) => {
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
    },
    [],
  );

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
