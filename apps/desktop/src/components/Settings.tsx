import { useState, useCallback, useEffect } from "react";
import type { EngineStatus } from "../lib/types";

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

interface SettingsProps {
  status: EngineStatus;
  onSwitchModel: (model: string, provider?: string) => void;
  onClose: () => void;
}

// ─── Live provider/key data from the engine (same source as the CLI `/keys`) ───

type KeySource = "saved" | "env" | "none";

interface ProviderRow {
  id: string;
  label: string;
  hasKey: boolean;
  source: KeySource;
  masked: string;
  disabled: boolean;
  active: boolean;
  models: { id: string; label: string }[];
}

interface SearchRow {
  id: string;
  label: string;
  hasKey: boolean;
  source: KeySource;
  masked: string;
  keyHint?: string;
}

interface ProvidersResponse {
  providers: ProviderRow[];
  search: SearchRow[];
  active: { provider: string; model: string };
}

type PermissionLevel = "ask" | "auto_allow" | "auto_deny";

interface MemoryData {
  content: string;
  meta: { updatedAt?: string; lastReflectedAt?: string; schedule?: string; tokens?: number };
  enabled: boolean;
  schedule: string;
  scheduleLabel: string;
  tokens: number;
  maxTokens: number;
}

/** Human label for a cadence token, matching the backend's describeSchedule(). */
function cadenceLabel(c: string): string {
  if (c === "daily") return "daily";
  if (c === "weekly") return "weekly";
  if (c === "3d") return "every 3 days";
  return "manual";
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(4px)",
  },
  panel: {
    background: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    width: 560,
    maxWidth: "90vw",
    maxHeight: "82vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 24px 16px",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    background: "var(--bg-secondary)",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 18,
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
    lineHeight: 1,
  },
  body: {
    padding: "16px 24px 24px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  label: {
    fontSize: 13,
    color: "var(--text-secondary)",
    minWidth: 110,
    flexShrink: 0,
  },
  input: {
    flex: 1,
    background: "var(--bg-primary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "6px 10px",
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    outline: "none",
    minWidth: 0,
  },
  select: {
    flex: 1,
    background: "var(--bg-primary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "6px 10px",
    color: "var(--text-primary)",
    fontSize: 13,
    outline: "none",
    cursor: "pointer",
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
    flexShrink: 0,
    minWidth: 44,
    textAlign: "center" as const,
  },
  toggle: { display: "flex", gap: 4 },
  toggleButton: {
    padding: "4px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.15s",
  },
  toggleActive: { background: "var(--accent)", color: "white", borderColor: "var(--accent)" },
  toggleInactive: { background: "transparent", color: "var(--text-secondary)" },
  costDisplay: {
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    color: "var(--text-primary)",
    padding: "8px 12px",
    background: "var(--bg-primary)",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
  },
  saveButton: {
    padding: "8px 20px",
    borderRadius: "var(--radius-md)",
    border: "none",
    background: "var(--accent)",
    color: "white",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    alignSelf: "flex-end",
    transition: "background 0.15s",
  },
  statusRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 13,
    color: "var(--text-secondary)",
  },
  hint: { fontSize: 11, color: "var(--text-muted)" },
  memoryArea: {
    width: "100%",
    minHeight: 120,
    maxHeight: 260,
    resize: "vertical" as const,
    background: "var(--bg-primary)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "8px 10px",
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.5,
    outline: "none",
    boxSizing: "border-box" as const,
  },
  memoryButtons: { display: "flex", gap: 8, flexWrap: "wrap" as const },
  secondaryButton: {
    padding: "6px 14px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.15s",
  },
};

function sourceBadge(source: KeySource): React.CSSProperties {
  if (source === "saved")
    return { ...styles.badge, background: "rgba(74, 222, 128, 0.15)", color: "var(--success)" };
  if (source === "env")
    return { ...styles.badge, background: "var(--bg-primary)", color: "var(--text-muted)" };
  return { ...styles.badge, background: "transparent", color: "var(--text-muted)" };
}

export function Settings({ status, onSwitchModel, onClose }: SettingsProps) {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState(status.provider);
  const [selectedModel, setSelectedModel] = useState(status.model);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("ask");
  // Newly-typed keys, keyed by provider id or search-backend id. Empty = unchanged.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ─── System Memory ("dreaming") ───
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryBusy, setMemoryBusy] = useState<null | "cadence" | "refresh" | "save" | "clear">(
    null,
  );

  const load = useCallback(async () => {
    const res = await safeInvoke<ProvidersResponse>("list_providers");
    if (res) {
      setData(res);
      setSelectedProvider(res.active.provider);
      setSelectedModel(res.active.model);
      setLoadError(null);
    } else {
      setLoadError("Engine not connected — start the app via `alan desktop`.");
    }
  }, []);

  const loadMemory = useCallback(async () => {
    const m = await safeInvoke<MemoryData>("get_system_memory");
    if (m) {
      setMemory(m);
      setMemoryDraft(m.content);
    }
  }, []);

  useEffect(() => {
    load();
    loadMemory();
  }, [load, loadMemory]);

  const applyMemory = useCallback((r: { memory?: MemoryData } | null) => {
    if (r?.memory) {
      setMemory(r.memory);
      setMemoryDraft(r.memory.content);
    }
  }, []);

  const setCadence = useCallback(
    async (schedule: string) => {
      setMemoryBusy("cadence");
      applyMemory(await safeInvoke("set_memory_schedule", { schedule }));
      setMemoryBusy(null);
    },
    [applyMemory],
  );

  const refreshMemory = useCallback(async () => {
    setMemoryBusy("refresh");
    applyMemory(await safeInvoke("reflect_system_memory", {}));
    setMemoryBusy(null);
  }, [applyMemory]);

  const saveMemory = useCallback(async () => {
    setMemoryBusy("save");
    applyMemory(await safeInvoke("save_system_memory", { content: memoryDraft }));
    setMemoryBusy(null);
  }, [memoryDraft, applyMemory]);

  const clearMemory = useCallback(async () => {
    setMemoryBusy("clear");
    applyMemory(await safeInvoke("clear_system_memory", {}));
    setMemoryBusy(null);
  }, [applyMemory]);

  const providers = data?.providers ?? [];
  const activeProvider = providers.find((p) => p.id === selectedProvider);
  const modelOptions = activeProvider?.models ?? [];
  // Always include the currently-selected model even if it isn't in the curated list.
  const modelList = modelOptions.some((m) => m.id === selectedModel)
    ? modelOptions
    : [{ id: selectedModel, label: selectedModel }, ...modelOptions];

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const pid = e.target.value;
      setSelectedProvider(pid);
      const p = providers.find((pr) => pr.id === pid);
      if (p && p.models.length > 0) setSelectedModel(p.models[0].id);
    },
    [providers],
  );

  const setDraft = useCallback((id: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Only send keys the user actually typed.
      const apiKeys: Record<string, string> = {};
      for (const [id, val] of Object.entries(drafts)) {
        if (val.trim()) apiKeys[id] = val.trim();
      }
      await safeInvoke("save_settings", {
        provider: selectedProvider,
        model: selectedModel,
        permissionLevel,
        apiKeys,
      });
      onSwitchModel(selectedModel, selectedProvider);
      setDrafts({});
      await load(); // refresh masked/source badges
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, selectedModel, permissionLevel, drafts, onSwitchModel, load]);

  const contextPercent =
    status.contextMax > 0 ? Math.round((status.contextUsed / status.contextMax) * 100) : 0;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Settings</span>
          <button style={styles.closeButton} onClick={onClose} title="Close">
            &#215;
          </button>
        </div>

        <div style={styles.body}>
          {loadError && <div style={{ ...styles.hint, color: "var(--error)" }}>{loadError}</div>}

          {/* Provider & Model */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Model</div>
            <div style={styles.fieldRow}>
              <span style={styles.label}>Provider</span>
              <select
                style={styles.select}
                value={selectedProvider}
                onChange={handleProviderChange}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.hasKey ? "" : "  (no key)"}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.fieldRow}>
              <span style={styles.label}>Model</span>
              <select
                style={styles.select}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {modelList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Provider API Keys */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Provider Keys</div>
            <div style={styles.hint}>
              Shared with the CLI — stored in ~/.alan/secrets.json (mode 600). Leave blank to keep.
            </div>
            {providers.map((p) => (
              <div key={p.id} style={styles.fieldRow}>
                <span style={styles.label}>{p.label}</span>
                <input
                  style={styles.input}
                  type="password"
                  placeholder={p.hasKey ? p.masked : `Add ${p.label} key`}
                  value={drafts[p.id] ?? ""}
                  onChange={(e) => setDraft(p.id, e.target.value)}
                />
                <span style={sourceBadge(p.source)}>{p.source}</span>
              </div>
            ))}
          </div>

          {/* Web Search Keys */}
          {(data?.search?.length ?? 0) > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Web Search</div>
              <div style={styles.hint}>
                Powers the web_search tool and /research. Keyless DuckDuckGo is the fallback.
              </div>
              {data!.search.map((s) => (
                <div key={s.id} style={styles.fieldRow}>
                  <span style={styles.label}>{s.label}</span>
                  <input
                    style={styles.input}
                    type="password"
                    placeholder={s.hasKey ? s.masked : `Add ${s.label} key`}
                    value={drafts[s.id] ?? ""}
                    onChange={(e) => setDraft(s.id, e.target.value)}
                  />
                  <span style={sourceBadge(s.source)}>{s.source}</span>
                </div>
              ))}
            </div>
          )}

          {/* Permission Level */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Permissions</div>
            <div style={styles.toggle}>
              {(["ask", "auto_allow"] as PermissionLevel[]).map((level) => (
                <button
                  key={level}
                  style={{
                    ...styles.toggleButton,
                    ...(permissionLevel === level ? styles.toggleActive : styles.toggleInactive),
                  }}
                  onClick={() => setPermissionLevel(level)}
                >
                  {level === "ask" ? "Ask before tools" : "Auto-approve"}
                </button>
              ))}
            </div>
          </div>

          {/* System Memory ("dreaming") */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>System Memory</div>
            <div style={styles.hint}>
              An evergreen profile of you and your codebases, injected so models tailor to you — a
              guide, not rules. Shared with the CLI (~/.alan/system-memory.md).
            </div>
            <div style={styles.fieldRow}>
              <span style={styles.label}>Auto-update</span>
              <div style={styles.toggle}>
                {(["manual", "daily", "3d", "weekly"] as const).map((c) => {
                  const active = memory?.scheduleLabel === cadenceLabel(c);
                  return (
                    <button
                      key={c}
                      style={{
                        ...styles.toggleButton,
                        ...(active ? styles.toggleActive : styles.toggleInactive),
                      }}
                      onClick={() => setCadence(c)}
                      disabled={memoryBusy !== null}
                    >
                      {c === "3d" ? "3 days" : c}
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              style={styles.memoryArea}
              value={memoryDraft}
              onChange={(e) => setMemoryDraft(e.target.value)}
              placeholder="Empty — click Refresh to let Alan learn from your recent sessions, or write your own notes here."
              spellCheck={false}
            />
            <div style={styles.hint}>
              {memory
                ? `~${memory.tokens}/${memory.maxTokens} tokens · cadence ${memory.scheduleLabel}` +
                  (memory.meta.lastReflectedAt
                    ? ` · last dreamed ${new Date(memory.meta.lastReflectedAt).toLocaleDateString()}`
                    : " · never dreamed")
                : "…"}
            </div>
            <div style={styles.memoryButtons}>
              <button
                style={styles.secondaryButton}
                onClick={refreshMemory}
                disabled={memoryBusy !== null}
                title="Distill recent sessions into your profile now"
              >
                {memoryBusy === "refresh" ? "Dreaming…" : "Refresh now"}
              </button>
              <button
                style={styles.secondaryButton}
                onClick={saveMemory}
                disabled={memoryBusy !== null || memoryDraft === (memory?.content ?? "")}
              >
                {memoryBusy === "save" ? "Saving…" : "Save edits"}
              </button>
              <button
                style={styles.secondaryButton}
                onClick={clearMemory}
                disabled={memoryBusy !== null || !memory?.content}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Usage & Cost */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Usage</div>
            <div style={styles.statusRow}>
              <span>Context Window</span>
              <span>
                {status.contextUsed.toLocaleString()} / {status.contextMax.toLocaleString()} tokens
                ({contextPercent}%)
              </span>
            </div>
            <div style={styles.costDisplay}>Session Cost: ${status.totalCost.toFixed(4)}</div>
          </div>

          <button
            style={{ ...styles.saveButton, opacity: saving ? 0.6 : 1 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save & Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
