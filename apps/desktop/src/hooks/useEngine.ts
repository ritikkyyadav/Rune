import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EngineEvent,
  PermissionPrompt,
  PermissionDecision,
  ToolCallInfo,
  Plan,
  ConnectionState,
  EngineStatus,
} from "../lib/types";

// ─── Safe Tauri invoke wrapper ───
// Falls back gracefully when running outside the Tauri shell (e.g. in a
// browser during development).
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    console.warn(`Tauri not available, using mock for: ${cmd}`);
    return null;
  }
}

type ListenUnlisten = () => void;

async function safeListen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<ListenUnlisten> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen(event, (ev: { payload: unknown }) => {
      handler(ev.payload);
    });
    return unlisten;
  } catch {
    console.warn(`Tauri event system not available for: ${event}`);
    return () => {};
  }
}

// ─── Hook interface ───

interface UseEngineOptions {
  onTextDelta: (text: string) => void;
  onToolCallStart: (callId: string, toolName: string) => void;
  onToolCallEnd: (callId: string, update: Partial<ToolCallInfo>) => void;
  onPlanCreated: (plan: Plan) => void;
  onPlanUpdated: (plan: Plan) => void;
  onTurnComplete: () => void;
  onError: (error: string) => void;
  onPermissionRequest: (prompt: PermissionPrompt) => Promise<PermissionDecision>;
}

const DEFAULT_STATUS: EngineStatus = {
  state: "disconnected",
  model: "deepseek/deepseek-v4-flash:free",
  provider: "openrouter",
  contextUsed: 0,
  contextMax: 128000,
  totalCost: 0,
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function useEngine(options: UseEngineOptions) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [status, setStatus] = useState<EngineStatus>(DEFAULT_STATUS);
  const abortRef = useRef(false);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<ListenUnlisten | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ─── Event handler ───

  const handleEvent = useCallback((event: EngineEvent) => {
    const opts = optionsRef.current;
    switch (event.type) {
      case "text_delta":
        opts.onTextDelta(event.text);
        break;

      case "tool_call_start":
        opts.onToolCallStart(event.callId, event.toolName);
        break;

      case "tool_call_end":
        opts.onToolCallEnd(event.callId, {
          status: event.output.success ? "success" : "error",
          result: event.output.result,
          error: event.output.error,
          durationMs: event.output.durationMs,
        });
        break;

      case "plan_created":
        opts.onPlanCreated(event.plan);
        break;

      case "plan_updated":
        opts.onPlanUpdated(event.plan);
        break;

      case "plan_completed":
        opts.onPlanUpdated(event.plan);
        break;

      case "step_started":
        // Plan step status is tracked via plan events
        break;

      case "step_completed":
        // Plan step result is tracked via plan events
        break;

      case "turn_complete":
        setIsProcessing(false);
        opts.onTurnComplete();
        break;

      case "error":
        opts.onError(event.error);
        if (!event.recoverable) {
          setIsProcessing(false);
        }
        break;
    }
  }, []);

  // ─── Connection management ───

  const connect = useCallback(async () => {
    setConnectionState("connecting");

    try {
      const engineStatus = await safeInvoke<EngineStatus>("get_status");
      if (engineStatus) {
        setStatus(engineStatus);
        setConnectionState("connected");
        retriesRef.current = 0;
      } else {
        // Tauri not available -- treat as connected in dev mode
        setConnectionState("connected");
        retriesRef.current = 0;
      }

      // (Re)subscribe to streaming events from the engine.
      if (unlistenRef.current) {
        unlistenRef.current();
      }
      const unlistenChat = await safeListen("chat_event", (payload) => {
        handleEvent(payload as EngineEvent);
      });
      const unlistenStatus = await safeListen("engine_status", (payload) => {
        const update = payload as Partial<EngineStatus>;
        setStatus((prev) => ({ ...prev, ...update }));
      });
      // Permission prompts: ask the UI, then send the decision back to the engine.
      // The engine host blocks the tool call until respond_permission arrives, so
      // always answer (defaulting to deny if the modal throws/cancels).
      const unlistenPerm = await safeListen("permission_request", (payload) => {
        const { requestId, prompt } = (payload ?? {}) as {
          requestId: string;
          prompt: PermissionPrompt;
        };
        void optionsRef.current
          .onPermissionRequest(prompt)
          .then((decision) => safeInvoke("respond_permission", { requestId, decision }))
          .catch(() => safeInvoke("respond_permission", { requestId, decision: "deny" }));
      });
      unlistenRef.current = () => {
        unlistenChat();
        unlistenStatus();
        unlistenPerm();
      };
    } catch {
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [handleEvent]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
    retriesRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, [connect]);

  // ─── Session creation ───

  const createSession = useCallback(
    async (model?: string) => {
      const sessionId = await safeInvoke<string>("create_session", {
        model: model ?? status.model,
      });
      return sessionId ?? `session-${Date.now()}`;
    },
    [status.model],
  );

  // ─── Chat (streaming via IPC events) ───

  const sendMessage = useCallback(
    async (sessionId: string, message: string) => {
      setIsProcessing(true);
      abortRef.current = false;

      try {
        // Start the chat -- the engine emits streaming events via the
        // "chat_event" channel which our listener picks up.
        const result = await safeInvoke<null>("chat_start", {
          sessionId,
          message,
        });

        // If Tauri is not available, simulate a response for development
        if (result === null && connectionState !== "connected") {
          handleEvent({
            type: "text_delta",
            text: "Tauri backend not available. Running in browser dev mode.",
          });
          handleEvent({
            type: "turn_complete",
            stopReason: "end_turn",
            totalTurns: 1,
          });
        }
      } catch (err) {
        optionsRef.current.onError(err instanceof Error ? err.message : "Failed to send message");
        setIsProcessing(false);
      }
    },
    [connectionState, handleEvent],
  );

  // ─── Model switching ───

  const switchModel = useCallback(async (model: string, provider?: string) => {
    const result = await safeInvoke<EngineStatus>("switch_model", {
      model,
      provider,
    });
    if (result) {
      setStatus(result);
    } else {
      setStatus((prev) => ({
        ...prev,
        model,
        provider: provider ?? prev.provider,
      }));
    }
  }, []);

  // ─── Status polling ───

  const refreshStatus = useCallback(async () => {
    const engineStatus = await safeInvoke<EngineStatus>("get_status");
    if (engineStatus) {
      setStatus(engineStatus);
    }
  }, []);

  // ─── Abort ───

  const abort = useCallback(async () => {
    abortRef.current = true;
    await safeInvoke("abort_chat");
    setIsProcessing(false);
  }, []);

  // ─── Permission response ───

  const respondPermission = useCallback(async (requestId: string, decision: PermissionDecision) => {
    await safeInvoke("respond_permission", {
      requestId,
      decision,
    });
  }, []);

  return {
    sendMessage,
    createSession,
    switchModel,
    refreshStatus,
    respondPermission,
    isProcessing,
    connectionState,
    status,
    abort,
  };
}
