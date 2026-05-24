import { useState, useCallback } from "react";
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

interface ProviderConfig {
  name: string;
  id: string;
  models: string[];
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: "OpenRouter",
    id: "openrouter",
    models: [
      "deepseek/deepseek-v4-flash:free",
      "deepseek/deepseek-r1:free",
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4",
    ],
  },
  {
    name: "Anthropic",
    id: "anthropic",
    models: [
      "claude-sonnet-4-20250514",
      "claude-haiku-3-20250422",
      "claude-opus-4-20250514",
    ],
  },
  {
    name: "OpenAI",
    id: "openai",
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "o3-mini",
    ],
  },
  {
    name: "Google",
    id: "google",
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ],
  },
];

type PermissionLevel = "ask" | "auto_allow" | "auto_deny";

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
    width: 520,
    maxWidth: "90vw",
    maxHeight: "80vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 24px 16px",
    borderBottom: "1px solid var(--border)",
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
    minWidth: 80,
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
  toggle: {
    display: "flex",
    gap: 4,
  },
  toggleButton: {
    padding: "4px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.15s",
  },
  toggleActive: {
    background: "var(--accent)",
    color: "white",
    borderColor: "var(--accent)",
  },
  toggleInactive: {
    background: "transparent",
    color: "var(--text-secondary)",
  },
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
};

export function Settings({ status, onSwitchModel, onClose }: SettingsProps) {
  const [selectedProvider, setSelectedProvider] = useState(status.provider);
  const [selectedModel, setSelectedModel] = useState(status.model);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("ask");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const provider = PROVIDERS.find((p) => p.id === selectedProvider) ?? PROVIDERS[0];

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const pid = e.target.value;
      setSelectedProvider(pid);
      const p = PROVIDERS.find((pr) => pr.id === pid);
      if (p && p.models.length > 0) {
        setSelectedModel(p.models[0]);
      }
    },
    [],
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedModel(e.target.value);
    },
    [],
  );

  const handleApiKeyChange = useCallback(
    (providerId: string, value: string) => {
      setApiKeys((prev) => ({ ...prev, [providerId]: value }));
    },
    [],
  );

  const maskKey = (key: string): string => {
    if (key.length <= 8) return key.replace(/./g, "*");
    return key.slice(0, 4) + "*".repeat(key.length - 8) + key.slice(-4);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Persist settings via IPC
      await safeInvoke("save_settings", {
        provider: selectedProvider,
        model: selectedModel,
        permissionLevel,
        apiKeys,
      });
      onSwitchModel(selectedModel, selectedProvider);
    } catch {
      // Settings save is best-effort
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, selectedModel, permissionLevel, apiKeys, onSwitchModel]);

  const contextPercent =
    status.contextMax > 0
      ? Math.round((status.contextUsed / status.contextMax) * 100)
      : 0;

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
          {/* Provider & Model */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Model Configuration</div>
            <div style={styles.fieldRow}>
              <span style={styles.label}>Provider</span>
              <select
                style={styles.select}
                value={selectedProvider}
                onChange={handleProviderChange}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.fieldRow}>
              <span style={styles.label}>Model</span>
              <select
                style={styles.select}
                value={selectedModel}
                onChange={handleModelChange}
              >
                {provider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* API Keys */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>API Keys</div>
            {PROVIDERS.map((p) => (
              <div key={p.id} style={styles.fieldRow}>
                <span style={styles.label}>{p.name}</span>
                <input
                  style={styles.input}
                  type="password"
                  placeholder={`${p.name} API key`}
                  value={apiKeys[p.id] ?? ""}
                  onChange={(e) => handleApiKeyChange(p.id, e.target.value)}
                />
                {apiKeys[p.id] && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {maskKey(apiKeys[p.id])}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Permission Level */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Permission Level</div>
            <div style={styles.toggle}>
              {(["ask", "auto_allow", "auto_deny"] as PermissionLevel[]).map(
                (level) => (
                  <button
                    key={level}
                    style={{
                      ...styles.toggleButton,
                      ...(permissionLevel === level
                        ? styles.toggleActive
                        : styles.toggleInactive),
                    }}
                    onClick={() => setPermissionLevel(level)}
                  >
                    {level === "ask"
                      ? "Ask"
                      : level === "auto_allow"
                        ? "Auto Allow"
                        : "Auto Deny"}
                  </button>
                ),
              )}
            </div>
          </div>

          {/* Usage & Cost */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Usage</div>
            <div style={styles.statusRow}>
              <span>Context Window</span>
              <span>
                {status.contextUsed.toLocaleString()} /{" "}
                {status.contextMax.toLocaleString()} tokens ({contextPercent}%)
              </span>
            </div>
            <div style={styles.costDisplay}>
              Session Cost: ${status.totalCost.toFixed(4)}
            </div>
          </div>

          {/* Save */}
          <button
            style={{
              ...styles.saveButton,
              opacity: saving ? 0.6 : 1,
            }}
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
