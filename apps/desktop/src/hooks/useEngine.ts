import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AutoApprovalNotice,
  Brief,
  BriefDecision,
  EngineEvent,
  HeldStep,
  PermissionPrompt,
  PermissionDecision,
  ConnectionState,
  EngineStatus,
  UserQuestion,
} from "../lib/types";
import {
  configuredServer,
  isTauriRuntime,
  openTransport,
  type EngineTransport,
  type RoundTripKind,
} from "../lib/transport";

export { isTauriRuntime } from "../lib/transport";

// ─── Hook interface ───
// A thin, typed bridge to the engine over whichever transport `openTransport`
// picked. Every engine event reaches `onEvent` verbatim — the transcript and the
// trace are both built from that one stream — and all five round-trips arrive
// with an id the UI answers by.

interface UseEngineOptions {
  onEvent: (event: EngineEvent) => void;
  onPermissionRequest: (requestId: string, prompt: PermissionPrompt) => void;
  onQuestion?: (requestId: string, question: UserQuestion) => void;
  onBrief?: (requestId: string, brief: Brief) => void;
  onHeldSteps?: (steps: HeldStep[]) => void;
  onAutoNotice?: (notice: AutoApprovalNotice) => void;
  onRoundTripResolved?: (requestId: string, reason: string, applied: string) => void;
  onStatus?: (status: EngineStatus) => void;
  onError?: (error: string) => void;
  onNote?: (note: string) => void;
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
    auth?: string;
    models: Array<{ id: string; label: string }>;
  }>;
  active: { provider: string; model: string };
}

export function useEngine(options: UseEngineOptions) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [status, setStatus] = useState<EngineStatus>(DEFAULT_STATUS);
  const [transportKind, setTransportKind] = useState<"tauri" | "ws" | "none">(() =>
    configuredServer() ? "ws" : isTauriRuntime() ? "tauri" : "none",
  );
  const [transportLabel, setTransportLabel] = useState<string>("");
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transportRef = useRef<EngineTransport | null>(null);
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

  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
    retriesRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      void connectRef.current?.();
    }, delay);
  }, []);

  const onStream = useCallback(
    (name: string, payload: Record<string, unknown>) => {
      switch (name) {
        case "chat_event": {
          // Socket mode tags events with the session; the sidecar shape is bare.
          const raw = payload as { event?: EngineEvent } | EngineEvent;
          handleEvent((raw as { event?: EngineEvent }).event ?? (raw as EngineEvent));
          return;
        }
        case "ready":
        case "engine_status":
          applyStatus(payload as Partial<EngineStatus>);
          return;
        case "auto_notice":
          // What Auto did without asking. A push, not a question.
          if (payload.notice)
            optionsRef.current.onAutoNotice?.(payload.notice as AutoApprovalNotice);
          return;
        case "held_steps":
          optionsRef.current.onHeldSteps?.(
            Array.isArray(payload.steps) ? (payload.steps as HeldStep[]) : [],
          );
          return;
        case "roundtrip_resolved":
          optionsRef.current.onRoundTripResolved?.(
            String(payload.requestId ?? ""),
            String(payload.reason ?? ""),
            String(payload.applied ?? ""),
          );
          return;
        case "transport_note":
          optionsRef.current.onNote?.(String(payload.note ?? ""));
          return;
        default:
          // A stream this build does not know is a NEWER host, not a bug.
          return;
      }
    },
    [applyStatus, handleEvent],
  );

  const onRoundTrip = useCallback((kind: RoundTripKind, id: string, payload: unknown) => {
    if (kind === "permission")
      optionsRef.current.onPermissionRequest(id, payload as PermissionPrompt);
    else if (kind === "question") optionsRef.current.onQuestion?.(id, payload as UserQuestion);
    else optionsRef.current.onBrief?.(id, payload as Brief);
  }, []);

  const connect = useCallback(async () => {
    setConnectionState("connecting");
    try {
      transportRef.current?.close();
      const transport = await openTransport({
        onStream,
        onRoundTrip,
        onClose: () => {
          setConnectionState("error");
          scheduleReconnect();
        },
      });
      transportRef.current = transport;
      setTransportKind(transport.kind);
      setTransportLabel(transport.label);

      const engineStatus = await transport.call("get_status", {});
      if (engineStatus) applyStatus(engineStatus as Partial<EngineStatus>);
      // No engine (browser preview): stay usable, and clearly labelled.
      setConnectionState("connected");
      retriesRef.current = 0;
    } catch (err) {
      optionsRef.current.onError?.(
        `connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [applyStatus, onRoundTrip, onStream, scheduleReconnect]);
  connectRef.current = connect;

  useEffect(() => {
    void connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, [connect]);

  // ─── Commands ───
  // Every command funnels through `command`, which turns a transport failure
  // into three real consequences instead of a silent null: the error toast, an
  // honest "error" connection state, and an armed reconnect. `ok: false` means
  // the engine did not hear the command; `value: null` means there is no engine
  // at all (browser preview).

  type CommandResult<T> = { ok: true; value: T | null } | { ok: false };
  const command = useCallback(
    async <T>(
      cmd: string,
      args: Record<string, unknown> | undefined,
      what: string,
    ): Promise<CommandResult<T>> => {
      const transport = transportRef.current;
      // Not connected YET is not the same as "there is no engine". Reporting it
      // as a null result made a message typed during the first second of the
      // page's life vanish into a spinner that never stopped — the transport
      // was still opening, and nothing said so.
      if (!transport) {
        optionsRef.current.onError?.(`${what} — still connecting to the engine; try again`);
        return { ok: false };
      }
      try {
        const value = (await transport.call(
          cmd as Parameters<EngineTransport["call"]>[0],
          args as never,
        )) as T | null;
        return { ok: true, value };
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

  const hasEngine = useCallback(() => transportRef.current?.kind !== "none", []);

  const createSession = useCallback(
    async (model?: string) => {
      const r = await command<string>(
        "create_session",
        { model: model ?? status.model },
        "new session",
      );
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
      if (!hasEngine()) {
        // Browser preview: no engine. Say so honestly, then end the turn.
        handleEvent({
          type: "text_delta",
          text: "This is Gear's browser preview — no engine is attached, so nothing ran. Run `gear web` for the same interface with your real workspace, tools and models, or `gear desktop` for the app.",
        });
        handleEvent({ type: "turn_complete", stopReason: "end_turn", totalTurns: 1 });
      }
    },
    [command, handleEvent, hasEngine],
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
    const r = await command<ProviderListing>("list_providers", {}, "provider list");
    return r.ok ? r.value : null;
  }, [command]);

  /** Write a provider key through the engine's credential store. */
  const saveKeys = useCallback(
    async (apiKeys: Record<string, string>, provider?: string, model?: string) => {
      const r = await command<EngineStatus>(
        "save_settings",
        { apiKeys, provider, model, persist: true },
        "save credentials",
      );
      if (r.ok && r.value) applyStatus(r.value);
      return r.ok;
    },
    [applyStatus, command],
  );

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
    const r = await command<EngineStatus>("get_status", {}, "status refresh");
    if (r.ok && r.value) applyStatus(r.value);
  }, [applyStatus, command]);

  const abort = useCallback(async () => {
    await command("abort_chat", {}, "stop");
    setIsProcessing(false);
  }, [command]);

  // ─── The round-trips ───
  // Each is answered through the transport, so the same call works whether the
  // host is streaming `{requestId, …}` (sidecar) or the SDK is holding a
  // promise for us (websocket).

  const answer = useCallback((kind: RoundTripKind, id: string, body: unknown) => {
    transportRef.current?.answer(kind, id, body);
  }, []);

  const respondPermission = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      answer("permission", requestId, { decision });
    },
    [answer],
  );
  const respondQuestion = useCallback(
    (requestId: string, text: string) => answer("question", requestId, { answer: text }),
    [answer],
  );
  const respondBrief = useCallback(
    (requestId: string, decision: BriefDecision) => answer("brief", requestId, { decision }),
    [answer],
  );

  // ─── Held steps (Auto mode's end-of-turn ledger) ───

  const listHeldSteps = useCallback(async (): Promise<HeldStep[]> => {
    const r = await command<HeldStep[]>("list_held_steps", {}, "held steps");
    return r.ok && Array.isArray(r.value) ? r.value : [];
  }, [command]);

  const runHeldStep = useCallback(
    async (stepId: string) => {
      const r = await command<{ ok: boolean; detail?: string }>(
        "run_held_step",
        { stepId },
        "run held step",
      );
      return r.ok ? r.value : null;
    },
    [command],
  );

  const dismissHeldSteps = useCallback(
    async (stepIds?: string[]) => {
      await command("dismiss_held_steps", stepIds ? { stepIds } : {}, "dismiss held steps");
    },
    [command],
  );

  /** Prompt assembly for a model span — the inspector's evidence (P3.4). */
  const getTurnContext = useCallback(
    async (sessionId?: string) => {
      const r = await command<unknown>("get_turn_context", { sessionId }, "turn context");
      return r.ok ? r.value : null;
    },
    [command],
  );

  /**
   * The session, exported through the engine's own exporter and signed.
   *
   * Deliberately NOT a client-side dump of the rail: an export that cannot be
   * verified by someone who was not watching the screen is a picture, not
   * evidence. This is the same artifact `gear export --sign` produces.
   */
  const exportTrace = useCallback(
    async (sessionId?: string, sign = true) => {
      const r = await command<{
        content: string;
        format: string;
        signature?: string;
        publicKey?: string;
        chainOk: boolean;
      }>("export_trace", { sessionId, format: "md", sign }, "export");
      return r.ok ? r.value : null;
    },
    [command],
  );

  return {
    sendMessage,
    interject,
    createSession,
    switchModel,
    listProviders,
    saveKeys,
    setGear,
    refreshStatus,
    respondPermission,
    respondQuestion,
    respondBrief,
    listHeldSteps,
    runHeldStep,
    dismissHeldSteps,
    getTurnContext,
    exportTrace,
    isProcessing,
    setIsProcessing,
    connectionState,
    transportKind,
    transportLabel,
    status,
    abort,
  };
}
