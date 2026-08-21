import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EngineEvent,
  PermissionPrompt,
  PermissionDecision,
  ConnectionState,
  EngineStatus,
} from "../lib/types";

// ─── Safe Tauri invoke wrapper ───
// Falls back gracefully when running outside the Tauri shell (e.g. in a
// browser during development).
export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
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
    return () => {};
  }
}

// ─── Hook interface ───
// The hook is a thin, typed bridge to the engine-host (via the Rust sidecar
// bridge). Every engine event reaches `onEvent` verbatim — the transcript and
// the trace are both built from that one stream.

interface UseEngineOptions {
  onEvent: (event: EngineEvent) => void;
  onPermissionRequest: (requestId: string, prompt: PermissionPrompt) => void;
  onStatus?: (status: EngineStatus) => void;
  onError?: (error: string) => void;
}

const DEFAULT_STATUS: EngineStatus = {
  state: "disconnected",
  model: "gemini-2.5-flash",
  provider: "google",
  contextUsed: 0,
  contextMax: 1_000_000,
  totalCost: 0,
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface ProviderListing {
  providers: Array<{
    id: string;
    label: string;
    hasKey: boolean;
    local?: boolean;
    active: boolean;
    disabled: boolean;
    source: string;
    masked: string;
    endpoint?: string;
    models: Array<{ id: string; label: string }>;
  }>;
  active: { provider: string; model: string };
}

export function useEngine(options: UseEngineOptions) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [status, setStatus] = useState<EngineStatus>(DEFAULT_STATUS);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<ListenUnlisten | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleEvent = useCallback((event: EngineEvent) => {
    optionsRef.current.onEvent(event);
    if (event.type === "turn_complete") setIsProcessing(false);
    if (event.type === "error" && !(event as { recoverable?: boolean }).recoverable)
      setIsProcessing(false);
  }, []);

  const applyStatus = useCallback((update: Partial<EngineStatus>) => {
    setStatus((prev) => {
      const next = { ...prev, ...update };
      optionsRef.current.onStatus?.(next);
      return next;
    });
  }, []);

  // ─── Connection management ───

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
    retriesRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      void connectRef.current?.();
    }, delay);
  }, []);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const connect = useCallback(async () => {
    setConnectionState("connecting");
    try {
      const engineStatus = await safeInvoke<EngineStatus>("get_status");
      if (engineStatus) {
        applyStatus(engineStatus);
        setConnectionState("connected");
      } else {
        // No Tauri runtime (browser preview): stay usable, clearly labelled.
        setConnectionState(isTauriRuntime() ? "error" : "connected");
      }
      retriesRef.current = 0;

      if (unlistenRef.current) unlistenRef.current();
      const unlistenChat = await safeListen("chat_event", (payload) => {
        // Socket mode tags events with the session; the desktop shape is bare.
        const raw = payload as { event?: EngineEvent } | EngineEvent;
        const event = (raw as { event?: EngineEvent }).event ?? (raw as EngineEvent);
        handleEvent(event);
      });
      const unlistenStatus = await safeListen("engine_status", (payload) => {
        applyStatus(payload as Partial<EngineStatus>);
      });
      // Permission prompts: surface them inline; the UI answers via
      // respondPermission(requestId, decision). The engine blocks the tool
      // until it hears back.
      const unlistenPerm = await safeListen("permission_request", (payload) => {
        const { requestId, prompt } = (payload ?? {}) as {
          requestId: string;
          prompt: PermissionPrompt;
        };
        if (requestId && prompt) optionsRef.current.onPermissionRequest(requestId, prompt);
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
  }, [applyStatus, handleEvent, scheduleReconnect]);
  connectRef.current = connect;

  useEffect(() => {
    void connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (unlistenRef.current) unlistenRef.current();
    };
  }, [connect]);

  // ─── Commands (bridged 1:1 to the engine host) ───

  const createSession = useCallback(
    async (model?: string) => {
      const sessionId = await safeInvoke<string>("create_session", {
        model: model ?? status.model,
      });
      return sessionId ?? `session-${Date.now()}`;
    },
    [status.model],
  );

  const sendMessage = useCallback(
    async (sessionId: string, message: string) => {
      setIsProcessing(true);
      try {
        await safeInvoke<null>("chat_start", { sessionId, message });
        if (!isTauriRuntime()) {
          // Browser preview: no engine. Say so honestly, then end the turn.
          handleEvent({
            type: "text_delta",
            text: "This is Gear's browser preview — no engine is attached, so nothing ran. Launch the desktop app (gear desktop) to work against your real workspace, tools, and models.",
          });
          handleEvent({ type: "turn_complete", stopReason: "end_turn", totalTurns: 1 });
        }
      } catch (err) {
        optionsRef.current.onError?.(err instanceof Error ? err.message : "Failed to send message");
        setIsProcessing(false);
      }
    },
    [handleEvent],
  );

  /** Mid-turn steering: fold text into the running turn. False → send as the next turn instead. */
  const interject = useCallback(async (text: string): Promise<boolean> => {
    const res = await safeInvoke<{ accepted: boolean }>("interject_chat", { text });
    return res?.accepted === true;
  }, []);

  const switchModel = useCallback(
    async (model: string, provider?: string) => {
      const result = await safeInvoke<EngineStatus>("switch_model", { model, provider });
      if (result) applyStatus(result);
      else applyStatus({ model, provider: provider ?? status.provider });
    },
    [applyStatus, status.provider],
  );

  const listProviders = useCallback(async (): Promise<ProviderListing | null> => {
    return safeInvoke<ProviderListing>("list_providers");
  }, []);

  /** Shift gears (this engine only; pass persist to write config.toml). */
  const setGear = useCallback(
    async (gear: string, persist = false) => {
      const result = await safeInvoke<EngineStatus>("save_settings", {
        apiKeys: {},
        permissionLevel: gear,
        persist,
      });
      if (result) applyStatus(result);
      else applyStatus({ permissionMode: gear });
    },
    [applyStatus],
  );

  const refreshStatus = useCallback(async () => {
    const engineStatus = await safeInvoke<EngineStatus>("get_status");
    if (engineStatus) applyStatus(engineStatus);
  }, [applyStatus]);

  const abort = useCallback(async () => {
    await safeInvoke("abort_chat");
    setIsProcessing(false);
  }, []);

  const respondPermission = useCallback(async (requestId: string, decision: PermissionDecision) => {
    await safeInvoke("respond_permission", { requestId, decision });
  }, []);

  return {
    sendMessage,
    interject,
    createSession,
    switchModel,
    listProviders,
    setGear,
    refreshStatus,
    respondPermission,
    isProcessing,
    setIsProcessing,
    connectionState,
    status,
    abort,
  };
}
