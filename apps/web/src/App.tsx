import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { Tabs, type MainTab } from "./components/Tabs";
import { Transcript } from "./components/Transcript";
import { Composer, type CommandItem } from "./components/Composer";
import { TraceRail } from "./components/TraceRail";
import { GearPicker, ModelPicker, Toast } from "./components/Overlays";
import { Palette, type PaletteItem } from "./components/Palette";
import { PlanLedger, type PlanStep } from "./components/PlanLedger";
import { FilesTab } from "./components/Files";
import { ConnectTab, type Connector } from "./components/Connect";
import {
  AskCard,
  AutoChip,
  BriefCard,
  FleetPanel,
  HeldStepsPanel,
  type HeldOutcome,
} from "./components/Cards";
import { FirstRun, SettingsTab, firstRunDone } from "./components/Settings";
import { ReviewPanel, type CheckResult, type ReviewDiff } from "./components/Review";
import { INITIAL_FLEET, fleetReducer, fleetRows, type Fleet } from "./lib/fleet";
import { useEngine, type ProviderListing } from "./hooks/useEngine";
import { useSession } from "./hooks/useSession";
import { useTurns } from "./hooks/useTurns";
import { applyTheme, loadTheme, type ThemeChoice } from "./lib/theme";
import { gearInfo, nextGear, normalizeGear, type GearId } from "./lib/gears";
import { DEMO_TASK, demoSteps, type DemoStep } from "./lib/demo";
import { announceReady, hostPrompt } from "./lib/host";
import type {
  AutoApprovalNotice,
  Brief,
  BriefDecision,
  EngineEvent,
  EngineStatus,
  HeldStep,
  PermissionDecision,
  UserQuestion,
} from "./lib/types";
import type { TurnContext } from "@gear/protocol";

type Overlay = null | "model" | "gear" | "palette";

/** A round-trip the person still owes an answer to. */
interface PendingAsk {
  requestId: string;
  question: UserQuestion;
  answered?: string;
}
interface PendingBrief {
  requestId: string;
  brief: Brief;
  decided?: BriefDecision;
}

const VERSION = __APP_VERSION__;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m]!,
  );
}

/** Sandbox posture from the engine status; tolerant of the host's shapes. */
function sandboxOf(status: EngineStatus): boolean | null {
  const p = status.securityPosture as unknown;
  if (p == null) return null;
  if (typeof p === "string") return !/off|host|disabled|none/i.test(p);
  if (typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.sandbox === "boolean") return o.sandbox;
    if (typeof o.sandboxEnabled === "boolean") return o.sandboxEnabled;
    if (typeof o.osIsolation === "boolean") return o.osIsolation;
  }
  return null;
}

export default function App() {
  // ── theme ──
  const [theme, setThemeState] = useState<ThemeChoice>(() => loadTheme());
  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    applyTheme(next);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const follow = () => applyTheme(loadTheme());
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, []);

  // ── chrome state ──
  const [sideOpen, setSideOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToastState] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((html: string) => {
    setToastState(html);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState(null), 2600);
  }, []);
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const [listing, setListing] = useState<ProviderListing | null>(null);
  // ── the round-trips this surface holds, and what Auto did without asking ──
  const [asks, setAsks] = useState<PendingAsk[]>([]);
  const [briefs, setBriefs] = useState<PendingBrief[]>([]);
  const [autoNotices, setAutoNotices] = useState<AutoApprovalNotice[]>([]);
  const [held, setHeld] = useState<HeldStep[]>([]);
  const [heldOutcomes, setHeldOutcomes] = useState<Array<HeldOutcome | null>>([]);
  const [heldSelected, setHeldSelected] = useState(0);
  const [heldRunning, setHeldRunning] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [fleet, setFleet] = useState<Fleet>(INITIAL_FLEET);
  const [showFirstRun, setShowFirstRun] = useState(() => !firstRunDone());
  const [turnContext, setTurnContext] = useState<TurnContext | null>(null);
  // ── the review workspace ──
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<ReviewDiff | null>(null);
  const [checks, setChecks] = useState<CheckResult | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── engine + turns ──
  const turns = useTurns();
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const session = useSession();
  const engine = useEngine({
    onEvent: (ev) => {
      turnsRef.current.event(ev);
      // The fleet reads the SAME union the transcript reads (P2.6): a
      // sub-agent's retries, checks and handoffs are events here, not prose.
      setFleet((f) => fleetReducer(f, ev));
    },
    onPermissionRequest: (id, prompt) => turnsRef.current.permissionRequest(id, prompt),
    onQuestion: (requestId, question) => setAsks((q) => [...q, { requestId, question }]),
    onBrief: (requestId, brief) => setBriefs((b) => [...b, { requestId, brief }]),
    onAutoNotice: (notice) => setAutoNotices((n) => [...n.slice(-11), notice]),
    onHeldSteps: (steps) => {
      setHeld(steps);
      setHeldOutcomes(steps.map(() => null));
      setHeldSelected(0);
      setHeldOpen(steps.length > 0);
    },
    onRoundTripResolved: (requestId, reason, applied) => {
      // The host answered for us — timed out, or every client left. Drop the
      // card rather than leaving a decision on screen that has been made.
      setAsks((q) => q.filter((a) => a.requestId !== requestId));
      setBriefs((b) => b.filter((x) => x.requestId !== requestId));
      showToast(`a pending question resolved without an answer (${reason}) — applied ${applied}`);
    },
    onNote: (note) => showToast(escapeHtml(note)),
    onStatus: (s) =>
      turnsRef.current.setPosture(
        sandboxOf(s) === false ? "host" : "sandboxed",
        s.provider,
        s.model,
      ),
    onError: (msg) => showToast(`<b>engine</b> — ${escapeHtml(msg)}`),
  });
  const { status } = engine;
  const gear = gearInfo(status.permissionMode);
  const sandboxOn = sandboxOf(status);
  const liveTurn =
    turns.stream.current != null ? (turns.stream.turns[turns.stream.current] ?? null) : null;
  const processing = engine.isProcessing || liveTurn != null;

  // The status rung ticks while a turn runs.
  useEffect(() => {
    if (!processing) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [processing]);

  // ── demo (browser preview only) ──
  const demoRef = useRef<{
    steps: DemoStep[];
    i: number;
    timer: number | null;
    waiting: string | null;
  } | null>(null);
  const playDemo = useCallback(() => {
    const d = demoRef.current;
    if (!d) return;
    if (d.i >= d.steps.length) {
      demoRef.current = null;
      engine.setIsProcessing(false);
      return;
    }
    const step = d.steps[d.i]!;
    const prevAt = d.i > 0 ? d.steps[d.i - 1]!.at : 0;
    d.timer = window.setTimeout(
      () => {
        d.i += 1;
        if ("permission" in step) {
          d.waiting = step.permission.requestId;
          turnsRef.current.permissionRequest(step.permission.requestId, step.permission.prompt);
          return;
        }
        turnsRef.current.event(step.event);
        playDemo();
      },
      Math.max(0, step.at - prevAt),
    );
  }, [engine]);
  const runDemo = useCallback(() => {
    if (demoRef.current) return;
    demoRef.current = { steps: demoSteps(), i: 0, timer: null, waiting: null };
    engine.setIsProcessing(true);
    turns.turnStart(DEMO_TASK);
    playDemo();
  }, [engine, playDemo, turns]);

  // ─── sessions ───

  /**
   * Rebuild a session from the engine's own event stream.
   *
   * The frames and the user turns arrive with sequences, so they interleave
   * into the order they happened; each one then goes through the SAME reducer
   * the live stream uses. A resumed session is therefore not an approximation
   * of a running one — it is the same construction from the same events, with
   * the tool calls, diffs, checks and permissions intact.
   */
  const replayFrames = useCallback(
    (
      backfill: Array<{ seq: number; event: EngineEvent }>,
      userTurns: Array<{ seq: number; text: string }>,
    ) => {
      turns.reset();
      const timeline = [
        ...userTurns.map((t) => ({ seq: t.seq, user: t.text })),
        ...backfill.map((f) => ({ seq: f.seq, event: f.event })),
      ].sort((a, b) => a.seq - b.seq);
      let open = false;
      for (const entry of timeline) {
        if ("user" in entry) {
          if (open)
            turnsRef.current.event({
              type: "turn_complete",
              stopReason: "end_turn",
              totalTurns: 0,
            });
          turnsRef.current.turnStart(entry.user);
          open = true;
          continue;
        }
        if (!open) {
          // Events before any user turn: a detached run, or a session whose
          // first message predates the store. Open a turn rather than dropping
          // them — losing the work is worse than an unlabelled heading.
          turnsRef.current.turnStart("(resumed)");
          open = true;
        }
        turnsRef.current.event(entry.event);
      }
      if (open)
        turnsRef.current.event({ type: "turn_complete", stopReason: "end_turn", totalTurns: 0 });
    },
    [turns],
  );

  const openSession = useCallback(
    async (id: string) => {
      if (processing) {
        showToast("finish or interrupt the running turn first");
        return;
      }
      await session.selectSession(id);
      const replay = await engine.subscribeSession(id);
      if (replay) replayFrames(replay.backfill ?? [], replay.userTurns ?? []);
      // Frames the host has not written to the store yet — a turn running right
      // now in another tab, or a detached run. Without these, opening a live
      // session shows it as finished.
      for (const ev of replay?.live ?? []) turnsRef.current.event(ev);
      setSelectedSpan(null);
      setSelectedTurn(null);
    },
    [engine, processing, replayFrames, session, showToast],
  );
  const newTask = useCallback(async () => {
    if (processing) {
      showToast("finish or interrupt the running turn first");
      return;
    }
    const id = await engine.createSession(status.model);
    session.createSession({ id, model: status.model, workspace: status.workspace ?? "~" });
    turns.reset();
    setSelectedSpan(null);
    setSelectedTurn(null);
    setQueued([]);
    inputRef.current?.focus();
  }, [engine, processing, session, showToast, status.model, status.workspace, turns]);

  // ── send / steer / queue ──
  const send = useCallback(
    async (text: string) => {
      if (processing) {
        const accepted = await engine.interject(text);
        if (accepted) {
          showToast(
            "<b>folded into the running task</b> — the agent adapts at its next tool boundary",
          );
          return;
        }
        setQueued((q) => [...q, text]);
        return;
      }
      let sid = session.activeSessionId;
      if (!sid) {
        const id = await engine.createSession(status.model);
        sid = session.createSession({
          id,
          model: status.model,
          workspace: status.workspace ?? "~",
        });
      }
      session.addUserMessage(text);
      turns.turnStart(text);
      setSelectedTurn(null);
      await engine.sendMessage(sid, text);
    },
    [engine, processing, session, showToast, status.model, status.workspace, turns],
  );
  // Drain the queue in order when a turn completes.
  useEffect(() => {
    if (processing || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    void send(next!);
  }, [processing, queued, send]);

  const interrupt = useCallback(() => {
    if (demoRef.current) {
      if (demoRef.current.timer) window.clearTimeout(demoRef.current.timer);
      demoRef.current = null;
      engine.setIsProcessing(false);
      turns.abort();
      showToast("interrupted — partial work kept");
      return;
    }
    if (!processing) return;
    void engine.abort();
    turns.abort();
    showToast("interrupted — partial work kept · /rewind restores the last checkpoint");
  }, [engine, processing, showToast, turns]);

  const decide = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      turns.permissionDecided(requestId, decision);
      const d = demoRef.current;
      if (d && d.waiting === requestId) {
        d.waiting = null;
        if (decision === "deny") {
          if (d.timer) window.clearTimeout(d.timer);
          demoRef.current = null;
          turnsRef.current.event({
            type: "text_delta",
            text: "Stopped before the shell step. The edit is staged but unverified — re-run with approval, shift up a gear, or ask me to verify another way.",
          });
          turnsRef.current.event({ type: "turn_complete", stopReason: "end_turn", totalTurns: 0 });
          engine.setIsProcessing(false);
        } else {
          playDemo();
        }
        return;
      }
      void engine.respondPermission(requestId, decision);
    },
    [engine, playDemo, turns],
  );

  // ── gears / model / theme ──
  const cycleGear = useCallback(async () => {
    const next = nextGear(status.permissionMode);
    await engine.setGear(next);
    const info = gearInfo(next);
    showToast(`<b>${info.label}</b> — ${escapeHtml(info.desc)}`);
  }, [engine, showToast, status.permissionMode]);
  const pickGear = useCallback(
    async (id: GearId) => {
      setOverlay(null);
      await engine.setGear(id);
      showToast(`<b>${gearInfo(id).label}</b> — ${escapeHtml(gearInfo(id).desc)}`);
    },
    [engine, showToast],
  );
  const openModelPicker = useCallback(async () => {
    setOverlay("model");
    setListing(await engine.listProviders());
  }, [engine]);
  const pickModel = useCallback(
    async (provider: string, model: string) => {
      setOverlay(null);
      await engine.switchModel(model, provider);
      showToast(`model → <b>${escapeHtml(provider)}/${escapeHtml(model)}</b> · this session`);
    },
    [engine, showToast],
  );

  // ── commands ──
  const commands = useMemo<CommandItem[]>(
    () => [
      { id: "model", name: "/model", desc: "Switch provider, account & model", tag: "settings" },
      {
        id: "gear",
        name: "/gear",
        desc: "Shift gears — 1st · 2nd · 3rd · 4th · auto",
        tag: "shift+tab",
      },
      { id: "theme", name: "/theme", desc: "Accent colors & light/dark", tag: "cosmetic" },
      { id: "trace", name: "/trace", desc: "Toggle the trace rail", tag: "⌘T" },
      { id: "new", name: "/new", desc: "Start a new task", tag: "⌘N" },
      { id: "sessions", name: "/sessions", desc: "Search sessions", tag: "⌘K" },
      { id: "cost", name: "/cost", desc: "Session cost so far" },
      { id: "status", name: "/status", desc: "Engine, model, gear & sandbox" },
      {
        id: "demo",
        name: "/demo",
        desc: "Run the recorded demo turn — no engine needed",
        tag: "preview",
      },
    ],
    [],
  );
  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "model":
          void openModelPicker();
          break;
        case "gear":
          setOverlay("gear");
          break;
        case "theme":
          setNav("settings");
          break;
        case "trace":
          setRailOpen((v) => !v);
          break;
        case "new":
          void newTask();
          break;
        case "sessions":
          setOverlay("palette");
          break;
        case "cost":
          showToast(`session cost so far: <b>$${status.totalCost.toFixed(4)}</b>`);
          break;
        case "status":
          showToast(
            `<b>${escapeHtml(status.provider)}/${escapeHtml(status.model)}</b> · ${gear.label} · sandbox ${sandboxOn == null ? "unknown" : sandboxOn ? "on" : "off"} · ctx ${status.contextMax ? Math.round((status.contextUsed / status.contextMax) * 100) : 0}% · engine ${engine.connectionState}`,
          );
          break;
        case "demo":
          runDemo();
          break;
      }
    },
    [
      engine.connectionState,
      gear.label,
      newTask,
      openModelPicker,
      runDemo,
      sandboxOn,
      showToast,
      status,
    ],
  );

  // ── keyboard ──
  const pendingPermission = liveTurn?.pendingPermission ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
      const composerEmpty = !(inputRef.current?.value ?? "").length;
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        void cycleGear();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "n") {
          e.preventDefault();
          void newTask();
        } else if (k === "k") {
          e.preventDefault();
          setOverlay((o) => (o === "palette" ? null : "palette"));
        } else if (k === "t") {
          e.preventDefault();
          setRailOpen((v) => !v);
        } else if (k === "b") {
          e.preventDefault();
          setSideOpen((v) => !v);
        } else if (e.key === ",") {
          e.preventDefault();
          setNav("settings");
        }
        return;
      }
      if (e.key === "Escape") {
        if (overlay) {
          setOverlay(null);
          return;
        }
        if (!typing && processing) interrupt();
        return;
      }
      if (pendingPermission && (!typing || (target === inputRef.current && composerEmpty))) {
        if (e.key === "y") {
          e.preventDefault();
          decide(pendingPermission, "allow_once");
        } else if (e.key === "a") {
          e.preventDefault();
          decide(pendingPermission, "allow_session");
        } else if (e.key === "n") {
          e.preventDefault();
          decide(pendingPermission, "deny");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleGear, decide, interrupt, newTask, overlay, pendingPermission, processing]);

  // ── the editor that framed us ──
  //
  // "Send selection to Gear" and "Open trace for this file" are VS Code
  // commands that post a composed prompt into this frame. `hostPrompt` decides
  // whether a `message` is one of them — it refuses anything that is not from
  // an editor webview origin — and `send` is the same path the composer uses,
  // so a selection arrives as an ordinary turn with an ordinary transcript.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const prompt = hostPrompt(event);
      if (prompt) void send(prompt.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send]);

  // "Ready" means the socket is up, NOT that the handler is attached. A page
  // that says ready while its transport is still opening gets the selection,
  // calls `create_session` against no transport, and reports "still connecting"
  // to a person who is looking at their editor — the message is gone. The host
  // holds the selection until it hears this, so the wait costs nothing.
  useEffect(() => {
    if (engine.connectionState === "connected") announceReady();
  }, [engine.connectionState]);

  // ── derived ──
  const activeSession = session.sessions.find((s) => s.id === session.activeSessionId) ?? null;
  const lastTurn = turns.stream.turns.at(-1) ?? null;
  const taskTitle =
    activeSession?.title && activeSession.title !== "New task"
      ? activeSession.title
      : (lastTurn?.task ?? "New task");
  const turnLabel = lastTurn
    ? [
        `turn ${lastTurn.turn}`,
        lastTurn.checkpoint ? `checkpoint v${lastTurn.checkpoint.version}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const reviewCount = useMemo(
    () => new Set(turns.stream.turns.flatMap((t) => t.files.map((f) => f.path))).size,
    [turns.stream.turns],
  );
  const ctxPercent =
    lastTurn?.contextPercent ??
    (status.contextMax > 0 && status.contextUsed > 0
      ? (status.contextUsed / status.contextMax) * 100
      : undefined);
  const currentTraceTurn =
    selectedTurn != null
      ? turns.trace.turns.find((t) => t.turn === selectedTurn)
      : turns.trace.turns.at(-1);
  const highlightCallId =
    currentTraceTurn?.spans.find((s) => s.id === selectedSpan)?.tool?.callId ?? null;
  const showInTrace = useCallback(
    (callId: string) => {
      const t = turns.trace.turns
        .slice()
        .reverse()
        .find((turn) => turn.spans.some((s) => s.tool?.callId === callId));
      const span = t?.spans.find((s) => s.tool?.callId === callId);
      if (!t || !span) return;
      setSelectedTurn(t.turn);
      setSelectedSpan(span.id);
      setRailOpen(true);
    },
    [turns.trace.turns],
  );
  const exportTrace = useCallback(async () => {
    const t = currentTraceTurn;
    if (!t) return;
    // The SAME exporter `gear export --sign` uses, through the host: the
    // transcript, the tool calls, the diffs and the audit chain, signed with
    // the Ed25519 key in ~/.gear/keys. The client-side JSON dump this replaced
    // was a picture of the rail, not evidence — nothing in it could be verified
    // by anyone who had not been watching the screen.
    const signed = (await engine.exportTrace(session.activeSessionId ?? undefined, true)) as {
      content: string;
      signature?: string;
      chainOk: boolean;
    } | null;
    if (!signed) {
      // No engine (the browser preview): the rail's own record is all there is,
      // and it is offered as exactly that.
      const payload = {
        gear: VERSION,
        exportedAt: new Date().toISOString(),
        signed: false,
        note: "browser preview — no engine, so this is the rail's own record and is not signed",
        turn: t,
      };
      void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
      showToast(`turn ${t.turn} copied — <b>unsigned</b>, no engine attached`);
      return;
    }
    const doc = signed.signature
      ? `${signed.content}\n\n<!-- ed25519: ${signed.signature} -->\n`
      : signed.content;
    void navigator.clipboard?.writeText(doc);
    showToast(
      signed.signature
        ? `session exported and <b>signed</b> · audit chain ${signed.chainOk ? "verified" : "BROKEN"} · on the clipboard`
        : "session exported — the signing key was unavailable, so this copy is unsigned",
    );
  }, [currentTraceTurn, engine, session.activeSessionId, showToast]);

  // ── the inspector's evidence: what was actually in the prompt ──
  // Depend on the CALLBACK, never on `engine`: the hook returns a fresh object
  // every render, so `[engine]` is `[every render]` — and an effect that
  // setStates on every render is an infinite loop that presents as the whole
  // window hanging. (It did. That is why this comment exists.)
  const getTurnContext = engine.getTurnContext;
  const activeSessionId = session.activeSessionId;
  const connected = engine.connectionState === "connected";
  // The session list belongs to the ENGINE, so it is fetched when the engine is
  // reachable rather than when this component mounted. A reload re-attaches and
  // the sessions come back; without this they came back empty.
  const loadSessions = session.loadSessions;
  useEffect(() => {
    if (connected) void loadSessions();
  }, [connected, loadSessions]);
  useEffect(() => {
    // Only once the transport is actually open. Asking earlier produced a
    // "still connecting" toast on every page load — an honest message about a
    // background poll nobody asked for, which is noise.
    if (!railOpen || !connected) return;
    let cancelled = false;
    void getTurnContext(activeSessionId ?? undefined).then((ctx) => {
      if (!cancelled) setTurnContext((ctx as TurnContext | null) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, connected, getTurnContext, railOpen, turns.trace.turns.length]);

  // ── held steps ──
  const runHeld = useCallback(
    async (index: number) => {
      const step = held[index];
      if (!step || heldRunning) return;
      setHeldRunning(true);
      const result = (await engine.runHeldStep(step.id)) as {
        ran?: boolean;
        refusal?: string;
      } | null;
      setHeldRunning(false);
      setHeldOutcomes((prev) => {
        const next = [...prev];
        next[index] = result?.ran ? "ran" : result?.refusal ? "refused" : "failed";
        return next;
      });
      if (result?.refusal) showToast(`refused — ${escapeHtml(result.refusal)}`);
    },
    [engine, held, heldRunning, showToast],
  );
  const skipHeld = useCallback((index: number) => {
    setHeldOutcomes((prev) => {
      const next = [...prev];
      next[index] = "skipped";
      return next;
    });
  }, []);
  const closeHeld = useCallback(() => {
    setHeldOpen(false);
    // Undecided steps stay in the ledger. Dismissing is a decision the next
    // turn is told about, not a silence it re-litigates.
    void engine.dismissHeldSteps();
  }, [engine]);

  // ── the round-trips ──
  const answerAsk = useCallback(
    (requestId: string, answer: string) => {
      engine.respondQuestion(requestId, answer);
      setAsks((q) => q.map((a) => (a.requestId === requestId ? { ...a, answered: answer } : a)));
    },
    [engine],
  );
  const decideBrief = useCallback(
    (requestId: string, decision: BriefDecision) => {
      engine.respondBrief(requestId, decision);
      setBriefs((b) => b.map((x) => (x.requestId === requestId ? { ...x, decided: decision } : x)));
    },
    [engine],
  );

  // ── review ──
  const refreshReview = useCallback(async () => {
    setReviewBusy(true);
    setReview((await engine.reviewDiff()) as ReviewDiff | null);
    setReviewBusy(false);
  }, [engine]);
  const openReview = useCallback(() => {
    setReviewOpen(true);
    void refreshReview();
  }, [refreshReview]);
  const revertFiles = useCallback(
    async (paths: string[]) => {
      setReviewBusy(true);
      const result = await engine.revertPaths(paths);
      setReviewBusy(false);
      if (result?.ok) showToast(`reverted <b>${escapeHtml(paths.join(", "))}</b>`);
      else showToast(`revert refused — ${escapeHtml(result?.reason ?? "no engine")}`);
      await refreshReview();
    },
    [engine, refreshReview, showToast],
  );
  const runProjectChecks = useCallback(async () => {
    setReviewBusy(true);
    setChecks(null);
    const result = (await engine.runChecks()) as CheckResult | null;
    setReviewBusy(false);
    setChecks(result);
    if (result && !result.ran) showToast("this project has no checks Gear can detect");
  }, [engine, showToast]);
  const openInEditor = useCallback(
    async (path: string) => {
      const result = await engine.openPath(path);
      if (result && !result.opened)
        showToast(`could not open — ${escapeHtml(result.reason ?? "")}`);
    },
    [engine, showToast],
  );

  const saveProviderKey = useCallback(
    async (provider: string, key: string) => {
      const ok = await engine.saveKeys({ [provider]: key });
      if (ok)
        showToast(`<b>${escapeHtml(provider)}</b> connected · key written to ~/.gear/secrets.json`);
      return ok;
    },
    [engine, showToast],
  );

  // ─── The shell's own state ───

  const [tab, setTab] = useState<MainTab>("session");
  const [nav, setNav] = useState<NavItem>("sessions");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [connectorNote, setConnectorNote] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(true);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);

  const listFiles = engine.listFiles;
  const readTextFile = engine.readTextFile;
  const listConnectors = engine.listConnectors;

  /**
   * The plan, from the ledger rather than from the prose.
   *
   * The most recent `todo_updated` is the plan; a step is `checked` when a
   * `step_check` with the same label passed. That distinction — closed versus
   * proven — is the product's whole claim, so it survives into the checklist
   * instead of being flattened into a tick.
   */
  const planSteps = useMemo<PlanStep[]>(() => {
    let latest: { content: string; status: string }[] = [];
    const passed = new Set<string>();
    for (const t of turns.stream.turns) {
      for (const item of t.items) if (item.kind === "todo") latest = item.items;
      for (const c of t.checks) if (c.status === "passed") passed.add(c.label);
    }
    return latest.map((s) => ({ ...s, checked: passed.has(s.content) }));
  }, [turns.stream.turns]);

  /** Files the palette can find: whatever the tree has already fetched. */
  useEffect(() => {
    if (nav !== "files" && tab !== "files") return;
    let cancelled = false;
    void listFiles().then((listing) => {
      if (cancelled || !listing) return;
      setKnownFiles((prev) => {
        const next = new Set(prev);
        for (const e of listing.entries) if (!e.dir) next.add(e.path);
        return [...next];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [listFiles, nav, tab]);

  const openConnect = useCallback(async () => {
    setNav("connect");
    setConnectBusy(true);
    setListing(await engine.listProviders());
    const result = await listConnectors();
    setConnectors(result?.servers ?? null);
    setConnectorNote(result?.reason ?? (result ? null : "no engine attached"));
    setConnectBusy(false);
  }, [engine, listConnectors]);

  const openFile = useCallback((path: string) => {
    setNav("sessions");
    setTab("files");
    setSelectedFile(path);
  }, []);

  const paletteCommands = useMemo(
    () => commands.map((c) => ({ id: c.id, name: c.name, desc: c.desc, tag: c.tag })),
    [commands],
  );

  const onPalettePick = useCallback(
    (item: PaletteItem) => {
      setOverlay(null);
      if (item.kind === "session") void openSession(item.id);
      else if (item.kind === "file") openFile(item.id);
      else runCommand(item.id);
    },
    [openFile, openSession, runCommand],
  );

  return (
    <div className={`app ${sideOpen ? "" : "side-closed"} ${railOpen ? "" : "rail-closed"}`}>
      <Sidebar
        sessions={session.sessions}
        activeId={session.activeSessionId}
        loading={session.sessionsLoading}
        nav={nav}
        onNav={(item) => {
          if (item === "connect") void openConnect();
          else if (item === "files") {
            setNav("sessions");
            setTab("files");
          } else setNav(item);
        }}
        onSelect={(id) => {
          setNav("sessions");
          setTab("session");
          void openSession(id);
        }}
        onNew={() => {
          setNav("sessions");
          setTab("session");
          void newTask();
        }}
        onSearch={() => setOverlay("palette")}
        reviewCount={reviewCount}
        workspace={status.workspace ?? "~"}
        version={VERSION}
        gear={gear}
        costToday={status.totalCost > 0 ? status.totalCost : null}
      />
      <Tabs
        tab={nav === "sessions" ? tab : "session"}
        onTab={(t) => {
          setNav("sessions");
          setTab(t);
          if (t === "review") openReview();
        }}
        title={nav === "connect" ? "Connect" : nav === "settings" ? "Settings" : taskTitle}
        subtitle={nav === "sessions" ? turnLabel : undefined}
        reviewCount={reviewCount}
        connection={engine.connectionState}
        sideOpen={sideOpen}
        railOpen={railOpen}
        onToggleSide={() => setSideOpen((v) => !v)}
        onToggleRail={() => setRailOpen((v) => !v)}
        onSearch={() => setOverlay("palette")}
      />
      <section className="main">
        {nav === "connect" ? (
          <div className="pane">
            <ConnectTab
              listing={listing}
              connectors={connectors}
              connectorsNote={connectorNote}
              busy={connectBusy}
              onSaveKey={saveProviderKey}
              onPickModel={(p, m) => void pickModel(p, m)}
              onRefresh={() => void openConnect()}
            />
          </div>
        ) : nav === "settings" ? (
          <div className="pane">
            <SettingsTab
              theme={theme}
              onTheme={setTheme}
              gear={normalizeGear(status.permissionMode)}
              onGear={(g) => void pickGear(g)}
              model={{ provider: status.provider, model: status.model }}
              workspace={status.workspace ?? "~"}
              transport={engine.transportLabel || engine.transportKind}
              version={VERSION}
              onOpenConnect={() => void openConnect()}
            />
          </div>
        ) : tab === "files" ? (
          <div className="pane">
            <FilesTab
              list={listFiles}
              read={readTextFile}
              onOpenInEditor={(path) => void openInEditor(path)}
              selected={selectedFile}
              onSelect={setSelectedFile}
            />
          </div>
        ) : (
          <>
            {planSteps.length > 0 ? (
              <div className="column-pad">
                <PlanLedger
                  steps={planSteps}
                  open={ledgerOpen}
                  onToggle={() => setLedgerOpen((v) => !v)}
                />
              </div>
            ) : null}
            <Transcript
              turns={turns.stream.turns}
              now={now}
              sandboxed={sandboxOn !== false}
              gearLabel={gear.label}
              highlightCallId={highlightCallId}
              onDecide={decide}
              onShowInTrace={showInTrace}
              onStarter={(prompt) => void send(prompt)}
              demo={{ available: true, onRun: runDemo }}
              workspace={status.workspace}
            />

            {/* ── What stops the run, in the run ──
            Every one of these sits in the flow rather than over it. A modal
            takes the transcript away at the moment you most need to read it. */}
            {showFirstRun && turns.stream.turns.length === 0 ? (
              <FirstRun
                connected={engine.connectionState === "connected"}
                providerCount={listing?.providers.filter((p) => p.hasKey).length ?? 0}
                workspace={status.workspace}
                onOpenConnect={() => void openConnect()}
                onRunDemo={() => {
                  setShowFirstRun(false);
                  runDemo();
                }}
                onStart={(prompt) => {
                  setShowFirstRun(false);
                  void send(prompt);
                }}
                onDismiss={() => setShowFirstRun(false)}
              />
            ) : null}

            {autoNotices.length > 0 ? (
              <div className="auto-chips" aria-label="Automatic approvals">
                {autoNotices.map((n, i) => (
                  <AutoChip key={`${n.toolName}-${i}`} notice={n} />
                ))}
              </div>
            ) : null}

            {briefs.map((b) => (
              <BriefCard
                key={b.requestId}
                requestId={b.requestId}
                brief={b.brief}
                decided={b.decided}
                onDecide={decideBrief}
              />
            ))}
            {asks.map((a) => (
              <AskCard
                key={a.requestId}
                requestId={a.requestId}
                question={a.question}
                answered={a.answered}
                onAnswer={answerAsk}
              />
            ))}

            {reviewOpen ? (
              <ReviewPanel
                diff={review}
                checks={checks}
                busy={reviewBusy}
                onRefresh={() => void refreshReview()}
                onRevert={(paths) => void revertFiles(paths)}
                onOpen={(path) => void openInEditor(path)}
                onRunChecks={() => void runProjectChecks()}
                onClose={() => setReviewOpen(false)}
              />
            ) : null}

            <FleetPanel rows={fleetRows(fleet)} now={now} />

            {heldOpen ? (
              <HeldStepsPanel
                steps={held}
                outcomes={heldOutcomes}
                selected={heldSelected}
                running={heldRunning}
                onSelect={setHeldSelected}
                onRun={(i) => void runHeld(i)}
                onSkip={skipHeld}
                onClose={closeHeld}
              />
            ) : null}

            {overlay === "model" ? (
              <ModelPicker
                listing={listing}
                current={{ provider: status.provider, model: status.model }}
                onPick={(p, m) => void pickModel(p, m)}
                onClose={() => setOverlay(null)}
              />
            ) : null}
            {overlay === "gear" ? (
              <GearPicker
                current={normalizeGear(status.permissionMode)}
                onPick={(g) => void pickGear(g)}
                onClose={() => setOverlay(null)}
              />
            ) : null}
            <Composer
              processing={processing}
              gear={gear}
              ctxPercent={ctxPercent}
              queued={queued}
              commands={commands}
              model={{
                provider: status.provider,
                model: status.model,
                authed: engine.connectionState === "connected",
              }}
              onSubmit={(text) => void send(text)}
              onInterrupt={interrupt}
              onUnqueue={(i) => setQueued((q) => q.filter((_, k) => k !== i))}
              onCycleGear={() => void cycleGear()}
              onPickModel={() => void openModelPicker()}
              onPickGear={() => setOverlay("gear")}
              onCommand={runCommand}
              inputRef={inputRef}
            />
          </>
        )}
      </section>
      <TraceRail
        trace={turns.trace}
        selectedTurn={selectedTurn}
        onSelectTurn={setSelectedTurn}
        selectedSpanId={selectedSpan}
        onSelectSpan={setSelectedSpan}
        turnContext={turnContext}
        onExport={exportTrace}
        onShowInTranscript={(callId) =>
          showToast(`highlighted in the transcript: ${escapeHtml(callId)}`)
        }
        now={now}
      />
      {overlay === "palette" ? (
        <Palette
          sessions={session.sessions}
          files={knownFiles}
          commands={paletteCommands}
          onPick={onPalettePick}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      <Toast message={toast} />
    </div>
  );
}
