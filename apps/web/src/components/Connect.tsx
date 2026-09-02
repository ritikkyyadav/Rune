// ─── Connect: the models and the services ───
//
// Two lists, because they are two different questions. A provider is where the
// thinking comes from and a connector is where the work reaches; conflating
// them into one "integrations" page is how a person ends up hunting for the
// model picker under a plug icon.
//
// Both are honest about state. A provider row says whether a credential is
// actually on this machine and where it came from; a connector row says what
// live discovery found, so "configured" and "working" are never the same claim.
// OAuth that needs a loopback callback prints the command rather than pretending
// the page can complete it — a button that silently does nothing is worse than
// a line of text that works.

import { useState } from "react";
import { PlugIcon } from "./Icons";
import type { ProviderListing } from "../hooks/useEngine";

export interface Connector {
  name: string;
  scope: string;
  where: string;
  enabled: boolean;
  health: "ok" | "failed" | "disabled" | "unknown";
  authed: boolean;
  needsAuth: boolean;
  toolCount: number;
  error?: string;
}

const HEALTH_LABEL: Record<Connector["health"], string> = {
  ok: "connected",
  failed: "not reachable",
  disabled: "disabled",
  unknown: "not started",
};

export function ConnectTab(props: {
  listing: ProviderListing | null;
  connectors: Connector[] | null;
  connectorsNote: string | null;
  busy: boolean;
  onSaveKey: (provider: string, key: string) => Promise<boolean>;
  onPickModel: (provider: string, model: string) => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const providers = props.listing?.providers ?? [];
  const active = props.listing?.active;

  return (
    <div className="connect" aria-label="Connect">
      <section className="connect-section">
        <div className="connect-head">
          <h3>Models</h3>
          <span className="connect-sub">
            {providers.filter((p) => p.hasKey).length} of {providers.length} have a credential on
            this machine
          </span>
          <button className="perm-btn" onClick={props.onRefresh} disabled={props.busy}>
            Refresh
          </button>
        </div>

        {providers.length === 0 ? (
          <div className="files-empty">
            {props.busy ? "Asking the engine…" : "No providers reported by the engine."}
          </div>
        ) : null}

        {providers.map((p) => {
          const current = active?.provider === p.id;
          return (
            <div key={p.id} className={`prov-row ${current ? "sel" : ""}`}>
              <span className={`prov-dot ${p.hasKey ? "on" : ""}`} />
              <span className="prov-name">{p.label}</span>
              <span className="prov-meta">
                {p.hasKey ? p.masked || p.source : p.local ? "local — no key needed" : "no key"}
                {p.auth ? ` · ${p.auth}` : ""}
              </span>
              {current ? <span className="prov-tag">active</span> : null}
              {p.models.length > 0 && p.hasKey ? (
                <select
                  className="prov-select"
                  value={current ? (active?.model ?? "") : ""}
                  onChange={(e) => e.target.value && props.onPickModel(p.id, e.target.value)}
                  aria-label={`Model for ${p.label}`}
                >
                  <option value="">Use a model…</option>
                  {p.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                className="perm-btn"
                onClick={() => {
                  setEditing(editing === p.id ? null : p.id);
                  setDraft("");
                }}
              >
                {p.hasKey ? "Replace key" : "Add key"}
              </button>
            </div>
          );
        })}

        {editing ? (
          <div className="prov-edit">
            <label htmlFor="prov-key">
              Paste an API key for <b>{editing}</b>. It is written to
              <span className="mono"> ~/.gear/secrets.json</span> and never leaves this machine.
            </label>
            <div className="prov-edit-row">
              <input
                id="prov-key"
                type="password"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="sk-…"
              />
              <button
                className="perm-btn primary"
                disabled={!draft.trim() || saving}
                onClick={async () => {
                  setSaving(true);
                  const ok = await props.onSaveKey(editing, draft.trim());
                  setSaving(false);
                  if (ok) {
                    setEditing(null);
                    setDraft("");
                  }
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button className="perm-btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
            <p className="prov-cmd">
              For OAuth providers run <span className="mono">gear login {editing}</span> in a
              terminal — the callback needs a loopback listener this page cannot open.
            </p>
          </div>
        ) : null}
      </section>

      <section className="connect-section">
        <div className="connect-head">
          <h3>Connectors</h3>
          <span className="connect-sub">MCP servers this workspace can reach</span>
        </div>

        {props.connectorsNote ? <div className="files-empty">{props.connectorsNote}</div> : null}

        {props.connectors && props.connectors.length === 0 ? (
          <div className="files-empty">
            No connectors configured. Add one with <span className="mono">gear mcp add notion</span>
            , or browse the catalogue with <span className="mono">gear mcp list --catalog</span>.
          </div>
        ) : null}

        {(props.connectors ?? []).map((c) => (
          <div key={`${c.scope}:${c.name}`} className="prov-row">
            <PlugIcon className={`conn-icon ${c.health}`} />
            <span className="prov-name">{c.name}</span>
            <span className="prov-meta">{c.where}</span>
            <span className={`conn-health ${c.health}`}>{HEALTH_LABEL[c.health]}</span>
            <span className="prov-tag">{c.scope}</span>
            {c.toolCount > 0 ? <span className="prov-tag">{c.toolCount} tools</span> : null}
            {c.needsAuth ? (
              <span className="prov-cmd mono">gear mcp login {c.name}</span>
            ) : c.authed ? (
              <span className="prov-tag">authorized</span>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
