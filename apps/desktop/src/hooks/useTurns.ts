import { useCallback, useMemo, useReducer, useRef } from "react";
import type { EngineEvent, PermissionDecision, PermissionPrompt } from "../lib/types";
import { INITIAL_STREAM, streamReducer, type StreamAction, type StreamState } from "../lib/stream";
import { INITIAL_TRACE, traceReducer, type TraceAction, type TraceState } from "../lib/trace";

// ─── One event stream, two views ───
// The transcript (what the user reads) and the trace (the run tree) are both
// reduced from the same engine events, so they can never disagree. The
// component layer only renders.

export interface TurnsApi {
  stream: StreamState;
  trace: TraceState;
  turnStart: (task: string) => void;
  event: (event: EngineEvent) => void;
  permissionRequest: (requestId: string, prompt: PermissionPrompt) => void;
  permissionDecided: (requestId: string, decision: PermissionDecision) => void;
  abort: () => void;
  reset: () => void;
  setPosture: (posture: "sandboxed" | "host", provider?: string, model?: string) => void;
}

interface Combined {
  stream: StreamState;
  trace: TraceState;
  posture: "sandboxed" | "host";
}

type Action =
  | { type: "stream+trace"; stream: StreamAction; trace: TraceAction }
  | { type: "posture"; posture: "sandboxed" | "host"; provider?: string; model?: string };

function reducer(state: Combined, action: Action): Combined {
  if (action.type === "posture") {
    return {
      ...state,
      posture: action.posture,
      trace: traceReducer(state.trace, {
        type: "status",
        posture: action.posture,
        provider: action.provider,
        model: action.model,
      }),
    };
  }
  return {
    ...state,
    stream: streamReducer(state.stream, action.stream, state.posture),
    trace: traceReducer(state.trace, action.trace),
  };
}

export function useTurns(): TurnsApi {
  const [state, dispatch] = useReducer(reducer, {
    stream: INITIAL_STREAM,
    trace: INITIAL_TRACE,
    posture: "sandboxed",
  });
  const turnNo = useRef(0);

  const turnStart = useCallback((task: string) => {
    turnNo.current += 1;
    const now = Date.now();
    dispatch({
      type: "stream+trace",
      stream: { type: "turn_start", task, turn: turnNo.current, now },
      trace: { type: "turn_start", task, turn: turnNo.current, now },
    });
  }, []);

  const event = useCallback((ev: EngineEvent) => {
    const now = Date.now();
    dispatch({
      type: "stream+trace",
      stream: { type: "event", event: ev, now },
      trace: { type: "event", event: ev, now },
    });
  }, []);

  const permissionRequest = useCallback((requestId: string, prompt: PermissionPrompt) => {
    const now = Date.now();
    dispatch({
      type: "stream+trace",
      stream: { type: "permission_request", requestId, prompt, now },
      trace: { type: "permission_request", requestId, prompt, now },
    });
  }, []);

  const permissionDecided = useCallback((requestId: string, decision: PermissionDecision) => {
    const now = Date.now();
    dispatch({
      type: "stream+trace",
      stream: { type: "permission_decided", requestId, decision, now },
      trace: { type: "permission_decided", requestId, decision, now },
    });
  }, []);

  const abort = useCallback(() => {
    const now = Date.now();
    dispatch({
      type: "stream+trace",
      stream: { type: "abort", now },
      trace: {
        type: "event",
        event: { type: "turn_complete", stopReason: "aborted", totalTurns: 0 },
        now,
      },
    });
  }, []);

  const reset = useCallback(() => {
    turnNo.current = 0;
    dispatch({ type: "stream+trace", stream: { type: "reset" }, trace: { type: "reset" } });
  }, []);

  const setPosture = useCallback(
    (posture: "sandboxed" | "host", provider?: string, model?: string) => {
      dispatch({ type: "posture", posture, provider, model });
    },
    [],
  );

  return useMemo(
    () => ({
      stream: state.stream,
      trace: state.trace,
      turnStart,
      event,
      permissionRequest,
      permissionDecided,
      abort,
      reset,
      setPosture,
    }),
    [
      state.stream,
      state.trace,
      turnStart,
      event,
      permissionRequest,
      permissionDecided,
      abort,
      reset,
      setPosture,
    ],
  );
}
