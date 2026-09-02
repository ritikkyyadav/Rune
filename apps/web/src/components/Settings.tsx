// ─── Settings, and the two minutes before them ───
//
// Two surfaces that used to exist only in the terminal: the provider list with
// its auth status, and the place a key gets typed. A desktop that makes you
// open a terminal to connect a model is not a desktop application; it is a
// window onto one.
//
// What is honest about the OAuth half: the flow itself is `gear login`, which
// opens a browser, catches a loopback redirect and writes the credential to the
// OS keychain. That is a terminal-owned flow today and this panel says so
// exactly, with the command to run, rather than presenting a button that does
// nothing. Moving it into the app is a host command away and is logged in
// docs/program/backlog.md rather than faked here.

import { useEffect, useState } from "react";
import type { ProviderListing } from "../hooks/useEngine";

type Row = ProviderListing["providers"][number];

/** How a provider is authenticated, and whether the app can do it. */
function authKind(row: Row): { label: string; inApp: boolean } {
  const id = row.id;
  if (row.local) return { label: "local — no credential", inApp: true };
  if (id === "anthropic" || id === "codex" || id === "openrouter")
    return { label: "OAuth or API key", inApp: false };
  if (id === "copilot") return { label: "device flow", inApp: false };
  return { label: "API key", inApp: true };
}

export function SettingsPanel(props: {
  listing: ProviderListing | null;
  onSaveKey: (provider: string, key: string) => Promise<boolean>;
  onPickModel: (provider: string, model: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  transport: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const rows = props.listing?.providers ?? [];
  const active = props.listing?.active;

  return (
    <div className="overlay-scrim" onClick={props.onClose}>
      <div
        className="overlay settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="overlay-head">
          <span className="meta">Providers</span>
          <span className="oi-desc">
            {active ? `${active.provider}/${active.model}` : "no model selected"} · engine over{" "}
            {props.transport}
          </span>
          <button className="tb-btn" onClick={props.onClose}>
            Close <kbd>esc</kbd>
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="overlay-empty">
            No engine attached, so there is nothing to list. Run <code>gear web</code> or{" "}
            <code>gear desktop</code>.
          </div>
        ) : null}

        {rows.map((row) => {
          const auth = authKind(row);
          return (
            <div key={row.id} className={`prov-row ${row.active ? "active" : ""}`}>
              <span className={`prov-dot ${row.hasKey ? "on" : "off"}`} />
              <div className="prov-body">
                <div className="prov-name">
                  {row.label}
                  {row.active ? <span className="prov-tag">active</span> : null}
                </div>
                <div className="prov-meta">
                  {row.hasKey ? `connected · ${row.masked || row.source}` : auth.label}
                  {row.endpoint ? ` · ${row.endpoint}` : ""}
                </div>
              </div>
              <div className="prov-actions">
                {editing === row.id ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      const ok = await props.onSaveKey(row.id, value.trim());
                      setBusy(false);
                      if (ok) {
                        setSaved(row.id);
                        setEditing(null);
                        setValue("");
                        props.onRefresh();
                      }
                    }}
                  >
                    <input
                      autoFocus
                      type="password"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={`${row.label} API key`}
                      aria-label={`${row.label} API key`}
                    />
                    <button className="perm-btn primary" disabled={busy || !value.trim()}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="perm-btn"
                      onClick={() => {
                        setEditing(null);
                        setValue("");
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : auth.inApp ? (
                  <button className="perm-btn" onClick={() => setEditing(row.id)}>
                    {row.hasKey ? "Replace key" : "Paste key"}
                  </button>
                ) : (
                  <code className="prov-cmd">gear login {row.id}</code>
                )}
                {row.hasKey && !row.active && row.models[0] ? (
                  <button
                    className="perm-btn"
                    onClick={() => props.onPickModel(row.id, row.models[0]!.id)}
                  >
                    Use this
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}

        <div className="overlay-foot">
          {saved ? `${saved} saved to ~/.gear/secrets.json (0600)` : null}
          {!saved
            ? "Keys are written to ~/.gear/secrets.json at 0600 and applied live. OAuth and the OS keychain are `gear login`."
            : null}
        </div>
      </div>
    </div>
  );
}

// ─── First run ───

const SEEN_KEY = "gear.firstRun.done";

export function firstRunDone(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode: it will ask again, which is not a failure */
  }
}

/**
 * The first two minutes.
 *
 * Three steps, no tour, no video: connect a model, pick a folder, run something.
 * The copy is declarative and specific — it states what Gear does and what it
 * declines, and carries a number where a number is available, because that is
 * the register the rest of the product is written in.
 */
export function FirstRun(props: {
  connected: boolean;
  providerCount: number;
  workspace?: string;
  onOpenSettings: () => void;
  onRunDemo: () => void;
  onStart: (prompt: string) => void;
  onDismiss: () => void;
}) {
  const [step, setStep] = useState(props.connected ? 1 : 0);
  useEffect(() => {
    if (props.connected && step === 0) setStep(1);
  }, [props.connected, step]);

  const finish = () => {
    markDone();
    props.onDismiss();
  };

  return (
    <div className="first-run" role="region" aria-label="First run">
      <h1 className="fr-title">
        Gear
        <span className="wm-cursor" aria-hidden="true" />
      </h1>
      <p className="fr-lede">
        An agent that proves its work, on the model you already pay for. Every answer traces to the
        tools, prompts and permissions that produced it. It runs on this machine; there is no cloud
        and no account.
      </p>

      <ol className="fr-steps">
        <li className={step >= 0 ? "on" : ""}>
          <span className="meta">Step 1</span>
          <b>Connect a model.</b>
          <span>
            {props.providerCount > 0
              ? `${props.providerCount} providers are configured on this machine. Paste an API key, or run gear login for OAuth.`
              : "Paste an API key for any provider, or run gear login for OAuth."}
          </span>
          <button className="perm-btn primary" onClick={props.onOpenSettings}>
            Open providers
          </button>
        </li>
        <li className={step >= 1 ? "on" : ""}>
          <span className="meta">Step 2</span>
          <b>Pick the folder to work in.</b>
          <span>
            {props.workspace
              ? `Currently ${props.workspace}. Start Gear from another directory to change it.`
              : "Gear works in one directory at a time — the one it was started in."}
          </span>
        </li>
        <li className={step >= 1 ? "on" : ""}>
          <span className="meta">Step 3</span>
          <b>Give it a task.</b>
          <span>
            Watch the trace rail on the right. It records every model call, tool, permission and
            check, and an export of it is signed.
          </span>
          <div className="fr-actions">
            <button
              className="perm-btn primary"
              onClick={() => {
                markDone();
                props.onStart("Read this repository and tell me what it does, in five sentences.");
              }}
            >
              Read this repository
            </button>
            <button
              className="perm-btn"
              onClick={() => {
                markDone();
                props.onRunDemo();
              }}
            >
              Replay a recorded turn
            </button>
          </div>
        </li>
      </ol>

      <button className="fr-skip" onClick={finish}>
        Skip this
      </button>
    </div>
  );
}
