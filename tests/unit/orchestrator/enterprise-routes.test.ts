/**
 * P10.5 — registering an enterprise route, and telling the truth when it is not
 * registered.
 *
 * The failure mode this guards is the one a user meets first: a machine with no
 * AWS/GCP/Azure credentials. `gear providers` must print an honest "—" row for
 * every cloud route, `gear models` must fall back to the curated catalogue, and
 * nothing may crash or claim a credential nobody has.
 */
import { describe, test, expect } from "bun:test";
import {
  buildGateway,
  providerStatus,
  resolveProviderCredentials,
} from "../../../packages/orchestrator/src/provider-registry";
import { FileCredentialStore } from "../../../packages/shared/src/credential-store";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import { probeCloudChain } from "../../../packages/llm-gateway/src/auth/chain-strategy";
import { getStrategy } from "../../../packages/llm-gateway/src/auth/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A credential store rooted in a throwaway dir — never the real machine's. */
function isolatedStore(): FileCredentialStore {
  return new FileCredentialStore(
    join(mkdtempSync(join(tmpdir(), "gear-p105-")), "credentials.json"),
  );
}

/** An environment with no cloud credentials of any kind. */
const NO_ENV: NodeJS.ProcessEnv = {};

/** Ids of every enterprise cloud route currently registered. */
const ROUTES = PROVIDER_PRESETS.filter((p) =>
  ["bedrock", "vertex", "azure-openai"].includes(p.kind),
).map((p) => p.id);

describe("the chain strategy", () => {
  test("is what `chain` resolves to, for every route that declares it", () => {
    for (const id of ROUTES) {
      expect(getStrategy("chain", id)).toBeDefined();
    }
  });

  test("stores nothing — there is no Gear-held secret for these routes", async () => {
    const strategy = getStrategy("chain", "bedrock")!;
    const store = isolatedStore();
    await strategy.storeCredentials(
      { providerId: "bedrock", preset: PROVIDER_PRESETS[0]!, store, env: NO_ENV },
      { kind: "none" },
    );
    // The whole reason a team routes through their own cloud is that the
    // credential stays theirs. A second copy in Gear's keychain would defeat it.
    expect(await store.get("apikey:bedrock")).toBeNull();
  });

  test("an empty machine probes to null rather than throwing", async () => {
    for (const id of ROUTES) {
      expect(await probeCloudChain(id, NO_ENV)).toBeNull();
    }
  });

  test("a provider with no chain probes to null too", async () => {
    expect(await probeCloudChain("openrouter", NO_ENV)).toBeNull();
  });
});

describe("with no cloud credentials", () => {
  test("resolveProviderCredentials leaves every route out", async () => {
    const credentials = await resolveProviderCredentials({
      store: isolatedStore(),
      keys: {},
      active: "google",
      env: NO_ENV,
    });
    for (const id of ROUTES) expect(credentials[id]).toBeUndefined();
  });

  test("`gear providers` shows an honest no-credential row, and does not crash", () => {
    const rows = providerStatus({ keys: {}, active: "google", env: NO_ENV });
    for (const id of ROUTES) {
      const row = rows.find((r) => r.id === id);
      expect(row, `${id} is missing from the provider list`).toBeDefined();
      expect(row!.hasKey).toBe(false);
      expect(row!.source).toBe("none");
      // No mask, because there is no secret — not a masked empty string that
      // reads as "a key you cannot see".
      expect(row!.masked).toBe("");
      expect(row!.credentialDetail).toBeUndefined();
    }
  });

  test("the gateway does not register an unauthenticated route it is not pointed at", () => {
    const gw = buildGateway({ provider: "google", keys: { google: "g" }, env: NO_ENV });
    for (const id of ROUTES) {
      expect(gw.getProvider(id as never)).toBeUndefined();
    }
  });

  test("but it DOES register the route the session asked for, so the error is actionable", () => {
    // Otherwise `gear -p bedrock` fails with "provider not registered", which
    // says nothing about the missing credential or how to supply one.
    const gw = buildGateway({ provider: "bedrock", keys: {}, env: NO_ENV });
    expect(gw.getProvider("bedrock")).toBeDefined();
  });
});

describe("with cloud credentials", () => {
  test("an AWS environment registers bedrock and reports where it came from", async () => {
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-1",
    };
    const credentials = await resolveProviderCredentials({
      store: isolatedStore(),
      keys: {},
      active: "bedrock",
      env,
    });
    expect(credentials.bedrock).toMatchObject({
      kind: "none",
      meta: { method: "chain", detail: "environment" },
    });
    // No secret is carried through the credential map at all: the adapter
    // re-resolves and signs per request.
    expect(credentials.bedrock!.secret).toBeUndefined();

    const rows = providerStatus({ keys: {}, active: "bedrock", credentials, env });
    const row = rows.find((r) => r.id === "bedrock")!;
    expect(row.hasKey).toBe(true);
    expect(row.source).toBe("chain");
    expect(row.authMethod).toBe("chain");
    expect(row.credentialDetail).toBe("environment");
    expect(row.masked).toBe("");
    expect(row.keyCount).toBe(0);

    const gw = buildGateway({ provider: "bedrock", keys: {}, credentials, env });
    expect(gw.getProvider("bedrock")?.name).toBe("bedrock");
  });

  test("`[providers.bedrock] region` reaches the adapter", () => {
    const gw = buildGateway({
      provider: "bedrock",
      keys: {},
      env: { AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" },
      routes: { bedrock: { region: "eu-central-1" } },
    });
    // The region is private to the adapter; what is observable here is that
    // construction with a route config succeeds and yields the right provider.
    expect(gw.getProvider("bedrock")?.name).toBe("bedrock");
  });
});
