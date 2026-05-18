import { useState, useCallback } from "react";
import type {
  SessionInfo,
  ChatMessage,
  ToolCallInfo,
  Plan,
} from "../lib/types";

interface SessionState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  activePlan: Plan | null;
  isLoading: boolean;
}

const initialState: SessionState = {
  sessions: [],
  activeSessionId: null,
  messages: [],
  activePlan: null,
  isLoading: false,
};

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useSession() {
  const [state, setState] = useState<SessionState>(initialState);

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
    }));
    return id;
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setState((prev) => ({
      ...prev,
      activeSessionId: sessionId,
      // In a real app, messages would be loaded from the backend
      messages: [],
      activePlan: null,
    }));
  }, []);

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

  return {
    ...state,
    createSession,
    selectSession,
    addUserMessage,
    appendAssistantText,
    addToolCall,
    updateToolCall,
    setPlan,
    setLoading,
  };
}
