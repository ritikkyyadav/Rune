import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EngineEvent,
  PermissionPrompt,
  PermissionDecision,
  ConnectionState,
  EngineStatus,
} from "../lib/types";

// ─── Safe Tauri invoke wrapper ───
// Outside the Tauri shell (browser preview) there is no engine: resolve null
// so the preview stays usable. INSIDE the shell a failed invoke throws to the
// caller — swallowing it here once made every reconnect/backoff path
// unreachable and turned a dead engine into a silent stuck spinner.
export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(cmd, args);
}

type ListenUnlisten = () => void;

async function safeListen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<ListenUnlisten> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen(event, (ev: { payload: unknown }) => {
    handler(ev.payload);
  });
  return unlisten;
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
        setConnectionState("connected");
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
  // Every command funnels through `command`, which turns an invoke failure
  // into three real consequences instead of a silent null: the error toast,
  // an honest "error" connection state, and an armed reconnect. `ok: false`
  // means the engine did not hear the command; `value: null` means there is
  // no engine at all (browser preview).

  type CommandResult<T> = { ok: true; value: T | null } | { ok: false };
  const command = useCallback(
    async <T,>(
      cmd: string,
      args: Record<string, unknown> | undefined,
      what: string,
    ): Promise<CommandResult<T>> => {
      try {
        return { ok: true, value: await safeInvoke<T>(cmd, args) };
      } catch (err) {
        optionsRef.current.onError?.(
          `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setConnectionState("error");
        scheduleReconnect();
        return { ok: false };
      }
    },
    [scheduleReconnect],
  );

  const createSession = useCallback(
    async (model?: string) => {
      const r = await command<string>("create_session", { model: model ?? status.model }, "new session");
      // No engine (preview) or a reported failure: a local-only id keeps the
      // UI navigable; nothing pretends the engine has this session.
      return r.ok && r.value ? r.value : `local-${Date.now()}`;
    },
    [command, status.model],
  );

  const sendMessage = useCallback(
    async (sessionId: string, message: string) => {
      setIsProcessing(true);
      const r = await command<null>("chat_start", { sessionId, message }, "send");
      if (!r.ok) {
        // The engine never heard it — do not leave the spinner running.
        setIsProcessing(false);
        return;
      }
      if (!isTauriRuntime()) {
        // Browser preview: no engine. Say so honestly, then end the turn.
        handleEvent({
          type: "text_delta",
          text: "This is Gear's browser preview — no engine is attached, so nothing ran. Launch the desktop app (gear desktop) to work against your real workspace, tools, and models.",
        });
        handleEvent({ type: "turn_complete", stopReason: "end_turn", totalTurns: 1 });
      }
    },
    [command, handleEvent],
  );

  /** Mid-turn steering: fold text into the running turn. False → send as the next turn instead. */
  const interject = useCallback(
    async (text: string): Promise<boolean> => {
      const r = await command<{ accepted: boolean }>("interject_chat", { text }, "interject");
      return r.ok && r.value?.accepted === true;
    },
    [command],
  );

  const switchModel = useCallback(
    async (model: string, provider?: string) => {
      const r = await command<EngineStatus>("switch_model", { model, provider }, "model switch");
      if (!r.ok) return; // refused/failed: the header keeps showing the truth
      if (r.value) applyStatus(r.value);
      // Browser preview only: echo the choice locally so the picker works.
      else applyStatus({ model, provider: provider ?? status.provider });
    },
    [applyStatus, command, status.provider],
  );

  const listProviders = useCallback(async (): Promise<ProviderListing | null> => {
    const r = await command<ProviderListing>("list_providers", undefined, "provider list");
    return r.ok ? r.value : null;
  }, [command]);

  /** Shift gears (this engine only; pass persist to write config.toml). */
  const setGear = useCallback(
    async (gear: string, persist = false) => {
      const r = await command<EngineStatus>(
        "save_settings",
        { apiKeys: {}, permissionLevel: gear, persist },
        "gear change",
      );
      if (!r.ok) return; // a refused gear change must never be painted as done
      if (r.value) applyStatus(r.value);
      // Browser preview only: no engine to refuse, echo the chip locally.
      else applyStatus({ permissionMode: gear });
    },
    [applyStatus, command],
  );

  const refreshStatus = useCallback(async () => {
    const r = await command<EngineStatus>("get_status", undefined, "status refresh");
    if (r.ok && r.value) applyStatus(r.value);
  }, [applyStatus, command]);

  const abort = useCallback(async () => {
    await command("abort_chat", undefined, "stop");
    setIsProcessing(false);
  }, [command]);

  const respondPermission = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      await command("respond_permission", { requestId, decision }, "permission reply");
    },
    [command],
  );

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
