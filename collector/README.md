# Berne telemetry collector

The receiving end of Berne's opt-in diagnostics channel — a single,
dependency-free Bun server you run yourself. It stores the reports Berne clients
send into a local SQLite file and serves a small live adoption/health dashboard.

## Run it

```bash
# pick a strong shared secret; clients must present the same token
BERNE_COLLECTOR_TOKEN=$(openssl rand -hex 16) bun collector/berne-collector.ts
```

Then open <http://localhost:8787/> for the dashboard.

### Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `BERNE_COLLECTOR_PORT` | `8787` | Port to listen on |
| `BERNE_COLLECTOR_TOKEN` | *(none)* | Shared bearer token; if set, `POST /ingest` requires it |
| `BERNE_COLLECTOR_DB` | `~/.berne-collector/reports.db` | Where reports are stored |

### Endpoints

- `POST /ingest` — clients send `{ "v": 1, "reports": [ … ] }` here (token-guarded).
- `GET /` — live HTML dashboard (active installs, versions, OS, top errors, recent incidents).
- `GET /stats` — the same aggregates as JSON.
- `GET /health` — `{ "ok": true }`.

## Point a Berne build at it

In the client's `~/.alan/config.toml` (the web installer can write this for you):

```toml
[telemetry]
enabled  = true
endpoint = "https://your-host:8787/ingest"
token    = "the-same-secret"
```

Each user still gets the first-run consent prompt and can `berne telemetry off`
at any time — the collector only ever receives what a consenting client sends.

## Privacy stance

- **Raw IP addresses are never stored.** The connection IP is used at most for an
  optional coarse country lookup (`geoLookup`, a no-op by default) and discarded.
- Only what the client transmitted (already redacted at the source) is persisted,
  in the `payload_json` column, so you can audit exactly what you hold.
- Put it behind TLS (a reverse proxy is fine) before exposing it publicly.

## Going further

The SQLite file is plain — query it directly, or point Berne's own dashboard
tools at it. For production you'd typically front this with a real TLS
terminator and, if you want country-level geo, wire a GeoIP database into the
`geoLookup` function (the raw IP still never gets stored).
