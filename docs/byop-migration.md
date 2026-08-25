# BYOP migration notes

**No action is required for existing users.** The BYOP authentication layer is
purely additive. If you never run `gear login`, Gear resolves provider keys
exactly as it did before.

## Backward-compatibility guarantees

These hold and are asserted by the test suite
(`tests/unit/orchestrator/provider-registry.test.ts`,
`tests/unit/orchestrator/provider-cli.test.ts`,
`tests/unit/shared/credential-store.test.ts`):

1. **Env-only users are unchanged.** A user with `GOOGLE_API_KEY` /
   `ANTHROPIC_API_KEY` / etc. in the environment gets the same registered
   providers as before. The gateway falls back to the exact legacy key
   resolution whenever no stored credential is present.
2. **`~/.gear/secrets.json` users are unchanged.** Keys in the legacy secrets
   file continue to resolve. The old `/keys` panel still reads and writes that
   file. The credential store never rewrites it.
3. **`config.toml` without `authentication` is unchanged.** The auth method is
   auto-selected (`api_key` for cloud, `local` for runtimes).
4. **Existing commands and flags are unchanged.** `/keys`, `/providers`,
   `/model`, `--provider`, `--model` behave as before.
5. **Public types are stable.** `ProviderName`, `ProviderConfig`, and the
   existing `PROVIDER_PRESETS` fields are untouched; `LlmProvider` only gains one
   _optional_ method (`listModels?`).

## Resolution precedence

For a provider's API key, from highest to lowest priority:

```
secure store (keychain / OAuth token)  →  ~/.gear/secrets.json  →  config.toml  →  env var
```

The secure store is simply **prepended** to the chain that already existed. If the
store is empty (the state for every user upgrading), the chain is identical to
before — `secrets.json → config.toml → env`.

## Insecure fallback

If no OS keychain is available (`security` / `secret-tool` / PowerShell all
missing or non-functional), the credential store falls back to
`~/.gear/credentials.json` (mode `0600`, plaintext) and reports `secure = false`.
In that state Gear:

- prints a one-line notice on every credential write, and
- shows a persistent notice in `gear providers`:
  `⚠ credentials stored unencrypted at ~/.gear/credentials.json (no OS keychain available)`

Gear never silently writes a secret to plaintext when a secure store is
available.

## Opt-in migration

`gear login --migrate` copies API keys from `~/.gear/secrets.json` into the
secure store:

- It only writes accounts **not already present** in the store.
- It **never deletes** `secrets.json` — rollback is just "don't use the store."
- Web-search keys (`tavily` / `brave`) and the custom endpoint are skipped (they
  aren't provider keys, or carry a base URL + model the store can't hold).

OAuth is strictly additive: it does not exist until you run
`gear login <provider>` for a provider that supports it.
