When the model provider reports that the model no longer exists — HTTP 404 or 410; Rune's gateway already says "… is gone … The model was retired or renamed: pick a current one with /model." — a headless run (`rune -P`) currently ends with stopReason `provider_lost` and envelope subtype `error_provider`, exactly like a provider that stopped answering, so a script or CI job cannot tell "this model was retired" from "the provider is down".

Give it its own ending: stopReason `model_unavailable`, envelope subtype `error_model_unavailable`, `ok: false`, and exit code 5 (the provider cannot go on — unchanged). The request must not be retried. Every other provider failure (a refused key, credits, rate limits, outages) must end exactly as it does now. Update the table of endings in docs/ci.md, and add tests for the new ending.

Work in this repository (it is Rune's own source). Make the change, run the relevant tests, and keep the existing tests passing. Do not commit.
