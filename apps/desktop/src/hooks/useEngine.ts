import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  EngineEvent,
  PermissionPrompt,
  PermissionDecision,
  ToolCallInfo,
  Plan,
} from "../lib/types";

interface UseEngineOptions {
  onTextDelta: (text: string) => void;
  onToolCallStart: (callId: string, toolName: string) => void;
  onToolCallEnd: (callId: string, update: Partial<ToolCallInfo>) => void;
  onPlanCreated: (plan: Plan) => void;
  onPlanUpdated: (plan: Plan) => void;
  onTurnComplete: () => void;
  onError: (error: string) => void;
  onPermissionRequest: (
    prompt: PermissionPrompt,
  ) => Promise<PermissionDecision>;
}

interface TauriEvent {
  type: string;
  payload: Record<string, unknown>;
}

export function useEngine(options: UseEngineOptions) {
  const [isProcessing, setIsProcessing] = useState(false);
  const abortRef = useRef(false);

  const sendMessage = useCallback(
    async (sessionId: string, message: string) => {
      setIsProcessing(true);
      abortRef.current = false;

      try {
        // For now, use the Tauri command which returns all events at once.
        // In the future, this will be replaced with real streaming via
        // Tauri events or a WebSocket sidecar.
        const events = await invoke<TauriEvent[]>("send_message", {
          sessionId,
          message,
        });

        for (const event of events) {
          if (abortRef.current) break;
          handleEvent(event as unknown as EngineEvent);
        }
      } catch (err) {
        options.onError(
          err instanceof Error ? err.message : "Unknown error occurred",
        );
      } finally {
        setIsProcessing(false);
        options.onTurnComplete();
      }
    },
    [options],
  );

  const handleEvent = useCallback(
    (event: EngineEvent) => {
      switch (event.type) {
        case "text_delta":
          options.onTextDelta(event.text);
          break;

        case "tool_call_start":
          options.onToolCallStart(event.callId, event.toolName);
          break;

        case "tool_call_end":
          options.onToolCallEnd(event.callId, {
            status: event.output.success ? "success" : "error",
            result: event.output.result,
            error: event.output.error,
            durationMs: event.output.durationMs,
          });
          break;

        case "plan_created":
          options.onPlanCreated(event.plan);
          break;

        case "plan_updated":
          options.onPlanUpdated(event.plan);
          break;

        case "plan_completed":
          options.onPlanUpdated(event.plan);
          break;

        case "step_started":
          // Update plan step status via the plan
          break;

        case "step_completed":
          // Update plan step result
          break;

        case "turn_complete":
          options.onTurnComplete();
          break;

        case "error":
          options.onError(event.error);
          break;
      }
    },
    [options],
  );

  const createSession = useCallback(
    async (workspace: string, model: string) => {
      const sessionId = await invoke<string>("create_session", {
        workspace,
        model,
      });
      return sessionId;
    },
    [],
  );

  const abort = useCallback(() => {
    abortRef.current = true;
  }, []);

  return {
    sendMessage,
    createSession,
    isProcessing,
    abort,
  };
}
