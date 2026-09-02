// ─── Settings, and the two minutes before them ───
//
// Settings is a SECTION, not a dialog. The provider list moved to Connect,
// where it belongs beside the connectors; what is left here is the handful of
// defaults a person sets once — appearance, the gear a new session starts in,
// and whether anything is reported anywhere.
//
// Every row states what it changes and where that change lives, because a
// preference whose blast radius is unclear is a preference nobody touches.

import { useEffect, useState } from "react";
import { GearMark } from "./GearMark";
import { GEARS, type GearId } from "../lib/gears";
import { THEME_BASES, type ThemeChoice } from "../lib/theme";

/**
 * The settings section.
 *
 * Theme is applied live and remembered in this browser; the gear applies to the
 * running engine now; the model default lives with the provider that owns it,
 * in Connect. Telemetry is reported, not offered: it is off, it is off by
 * default, and turning it on is `gear telemetry on` because consent for
 * diagnostics should be given somewhere it can be read back.
 */
export function SettingsTab(props: {
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  gear: GearId;
  onGear: (gear: GearId) => void;
  model: { provider: string; model: string };
  workspace: string;
  transport: string;
  version: string;
  onOpenConnect: () => void;
}) {
  return (
    <div className="settings-tab" aria-label="Settings">
      <section className="connect-section">
        <div className="connect-head">
          <h3>Appearance</h3>
          <span className="connect-sub">Remembered in this browser</span>
        </div>
        <div className="setting-row">
          {THEME_BASES.map((b) => (
            <button
              key={b.id}
              className={`choice ${props.theme.base === b.id ? "on" : ""}`}
              onClick={() => props.onTheme({ base: b.id })}
              aria-pressed={props.theme.base === b.id}
            >
              <b>{b.label}</b>
              <small>{b.desc}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="connect-section">
        <div className="connect-head">
          <h3>Gear</h3>
          <span className="connect-sub">What proceeds without asking. Shift+Tab shifts up.</span>
        </div>
        <div className="setting-row wrap">
          {GEARS.map((g) => (
            <button
              key={g.id}
              className={`choice ${props.gear === g.id ? "on" : ""}`}
              data-level={g.id}
              onClick={() => props.onGear(g.id)}
              aria-pressed={props.gear === g.id}
            >
              <b>
                {g.arrows} {g.label}
              </b>
              <small>{g.detail}</small>
            </button>
          ))}
        </div>
        <p className="setting-note">
          Applies to this engine now. The default for new sessions lives in{" "}
          <span className="mono">~/.gear/config.toml</span> under{" "}
          <span className="mono">[permissions] gear</span>.
        </p>
      </section>

      <section className="connect-section">
        <div className="connect-head">
          <h3>Model</h3>
          <span className="connect-sub">Per session; the default belongs to the provider</span>
        </div>
        <div className="setting-row">
          <span className="prov-name mono">
            {props.model.provider}/{props.model.model}
          </span>
          <button className="perm-btn" onClick={props.onOpenConnect}>
            Change in Connect
          </button>
        </div>
      </section>

      <section className="connect-section">
        <div className="connect-head">
          <h3>Telemetry</h3>
          <span className="connect-sub">Off, and off by default</span>
        </div>
        <p className="setting-note">
          Nothing is sent anywhere. Diagnostics are opt-in and the switch is{" "}
          <span className="mono">gear telemetry on</span> — consent for diagnostics belongs
          somewhere it can be read back, which a checkbox in a browser is not.
        </p>
      </section>

      <section className="connect-section">
        <div className="connect-head">
          <h3>This engine</h3>
        </div>
        <div className="setting-facts">
          <div className="kv">
            <span>workspace</span>
            <span className="mono">{props.workspace}</span>
          </div>
          <div className="kv">
            <span>transport</span>
            <span className="mono">{props.transport}</span>
          </div>
          <div className="kv">
            <span>version</span>
            <span className="mono">v{props.version}</span>
          </div>
        </div>
        <div className="setting-mark">
          <GearMark size={22} />
        </div>
      </section>
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
  onOpenConnect: () => void;
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
        <GearMark size={20} />
        Gear
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
          <button className="perm-btn primary" onClick={props.onOpenConnect}>
            Connect a model
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
