import { useEffect, useState } from "react";
import { ACCENTS, themeId, type ThemeChoice, type ThemeBase } from "../lib/theme";
import { GEARS, type GearId } from "../lib/gears";
import type { ProviderListing } from "../hooks/useEngine";

function OverlayShell({
  title,
  sub,
  onClose,
  children,
  footer,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" role="menu" aria-label={title}>
      <div className="overlay-header">
        <span>
          {title} {sub ? <span className="overlay-sub">· {sub}</span> : null}
        </span>
        <button className="overlay-close" onClick={onClose}>
          esc to close
        </button>
      </div>
      <div className="overlay-list">{children}</div>
      {footer ? <div className="overlay-footer">{footer}</div> : null}
    </div>
  );
}

export function ModelPicker(props: {
  listing: ProviderListing | null;
  current: { provider: string; model: string };
  onPick: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<string | null>(null);
  const providers = (props.listing?.providers ?? [])
    .filter((p) => p.hasKey || p.local || p.active)
    .filter((p) => !p.disabled || p.active);
  const chosen = provider ? providers.find((p) => p.id === provider) : null;
  if (!props.listing) {
    return (
      <OverlayShell title="Select model & provider" onClose={props.onClose}>
        <div className="palette-empty">Loading providers from the engine…</div>
      </OverlayShell>
    );
  }
  if (!chosen) {
    return (
      <OverlayShell
        title="Select provider"
        sub={`${providers.length} configured`}
        onClose={props.onClose}
        footer="Keys via /keys in the CLI (~/.gear/secrets.json) · local runtimes list live · the gateway retries & falls back automatically"
      >
        {providers.length === 0 ? (
          <div className="palette-empty">
            No providers configured yet — add a key with /keys in the CLI.
          </div>
        ) : null}
        {providers.map((p, i) => (
          <button
            key={p.id}
            className={`overlay-item ${p.active ? "selected" : ""}`}
            onClick={() => setProvider(p.id)}
          >
            <span className="oi-num">{i + 1}.</span>
            <span className="oi-name">{p.label}</span>
            <span className="oi-desc">
              {p.local
                ? (p.endpoint ?? "local runtime")
                : p.source === "oauth"
                  ? "oauth · signed in"
                  : p.masked
                    ? `key ${p.masked}`
                    : p.hasKey
                      ? "key configured"
                      : "—"}
            </span>
            {p.local ? <span className="oi-tag local">local</span> : null}
            {p.active ? <span className="oi-tag current">current</span> : null}
          </button>
        ))}
      </OverlayShell>
    );
  }
  const models = chosen.models.length
    ? chosen.models
    : props.current.provider === chosen.id
      ? [{ id: props.current.model, label: props.current.model }]
      : [];
  return (
    <OverlayShell
      title={`Model · ${chosen.label}`}
      sub={`${models.length} models`}
      onClose={() => setProvider(null)}
      footer="⏎ uses the model for this session · set the startup default with /model default in the CLI"
    >
      {models.length === 0 ? (
        <div className="palette-empty">
          No curated models for {chosen.label} — pick a provider with a list, or type /model
          provider/model in the CLI.
        </div>
      ) : null}
      {models.map((m, i) => {
        const current = props.current.provider === chosen.id && props.current.model === m.id;
        const free = /:free$/i.test(m.id) || /\bfree\b/i.test(m.label);
        return (
          <button
            key={m.id}
            className={`overlay-item ${current ? "selected" : ""}`}
            onClick={() => props.onPick(chosen.id, m.id)}
          >
            <span className="oi-num">{i + 1}.</span>
            <span className="oi-name">{m.label}</span>
            <span className="oi-desc">
              {chosen.id}/{m.id}
            </span>
            {free ? <span className="oi-tag free">free</span> : null}
            {chosen.local ? <span className="oi-tag local">local</span> : null}
            <span className="oi-tag">{chosen.id}</span>
            {current ? <span className="oi-tag current">current</span> : null}
          </button>
        );
      })}
    </OverlayShell>
  );
}

export function ThemePicker(props: {
  choice: ThemeChoice;
  onChoice: (choice: ThemeChoice) => void;
  onClose: () => void;
}) {
  const bases: Array<{ id: ThemeBase; label: string; desc: string }> = [
    { id: "system", label: "Follow system", desc: "light or dark with macOS" },
    { id: "light", label: "Light", desc: "warm ivory card" },
    { id: "dark", label: "Dark", desc: "near-black card" },
  ];
  return (
    <OverlayShell
      title="Accent palette"
      sub={themeId(props.choice)}
      onClose={props.onClose}
      footer="Same ten themes as the CLI (gear[-accent][-dark]) · the CLI persists its own choice in ~/.gear/theme.json"
    >
      {bases.map((b) => (
        <button
          key={b.id}
          className={`overlay-item ${props.choice.base === b.id ? "selected" : ""}`}
          onClick={() => props.onChoice({ ...props.choice, base: b.id })}
        >
          <span className="oi-name">{b.label}</span>
          <span className="oi-desc">{b.desc}</span>
          <span className="oi-tag">base</span>
        </button>
      ))}
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          className={`overlay-item ${props.choice.accent === a.id ? "selected" : ""}`}
          onClick={() => props.onChoice({ ...props.choice, accent: a.id })}
        >
          <span className="oi-dot" style={{ background: a.swatch }} />
          <span className="oi-name">{a.label}</span>
          <span className="oi-desc">{a.desc}</span>
          <span className="oi-tag">
            {a.id === "cobalt" ? "gear / gear-dark" : `gear-${a.id}[-dark]`}
          </span>
        </button>
      ))}
    </OverlayShell>
  );
}

export function GearPicker(props: {
  current: GearId;
  onPick: (gear: GearId) => void;
  onClose: () => void;
}) {
  return (
    <OverlayShell
      title="Shift gears"
      sub="Shift+Tab shifts up"
      onClose={props.onClose}
      footer="Applies to this engine now · the CLI's default lives in ~/.gear/config.toml [permissions] gear"
    >
      {GEARS.map((g) => (
        <button
          key={g.id}
          className={`overlay-item ${props.current === g.id ? "selected" : ""}`}
          onClick={() => props.onPick(g.id)}
        >
          <span className="oi-num" style={{ minWidth: 40 }}>
            {g.arrows}
          </span>
          <span className="oi-name">{g.label}</span>
          <span className="oi-desc">{g.detail}</span>
          {props.current === g.id ? <span className="oi-tag current">current</span> : null}
        </button>
      ))}
    </OverlayShell>
  );
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div
      className={`toast ${message ? "show" : ""}`}
      role="status"
      aria-live="polite"
      dangerouslySetInnerHTML={{ __html: message ?? "" }}
    />
  );
}
