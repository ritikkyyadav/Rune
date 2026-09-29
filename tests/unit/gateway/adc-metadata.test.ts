/**
 * P4a — the GCE metadata server is asked only by a caller that knows Vertex is
 * in use.
 *
 * Observed: Rune's startup credential scan probes every cloud route, and the
 * Vertex probe fell through to rung 3 of Application Default Credentials — a
 * GET to http://metadata.google.internal — on any machine without a key file.
 * On a laptop whose only provider was Codex, every launch sent that request
 * and could spend up to a second on it.
 *
 * Every test here counts requests with a fetch spy. Nothing reads a real
 * credential file: the ADC rungs that read files are either given an injected
 * reader or pointed (CLOUDSDK_CONFIG) at a directory that does not exist.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGoogleTokenResolver,
  resolveGoogleAdc,
} from "../../../packages/llm-gateway/src/providers/google/adc";
import {
  CloudChainStrategy,
  probeCloudChain,
} from "../../../packages/llm-gateway/src/auth/chain-strategy";
import { AuthError } from "../../../packages/llm-gateway/src/auth/types";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import type { CredentialStore } from "../../../packages/shared/src/credential-store";

const noFiles = async () => {
  throw new Error("ENOENT");
};

/** A fetch that records every URL and answers the metadata server with a token. */
function spyFetch() {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("/computeMetadata/")) {
      return new Response(JSON.stringify({ access_token: "meta-token", expires_in: 3599 }), {
        status: 200,
      });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { urls, impl, metadataCalls: () => urls.filter((u) => u.includes("/computeMetadata/")) };
}

describe("resolveGoogleAdc", () => {
  test("never asks the metadata server by default", async () => {
    const spy = spyFetch();
    const token = await resolveGoogleAdc({ env: {}, readFileImpl: noFiles, fetchImpl: spy.impl });
    expect(token).toBeNull();
    expect(spy.urls).toEqual([]);
  });

  test("asks it when the caller allows it", async () => {
    const spy = spyFetch();
    const token = await resolveGoogleAdc({
      env: {},
      allowMetadata: true,
      readFileImpl: noFiles,
      fetchImpl: spy.impl,
    });
    expect(spy.metadataCalls()).toEqual([
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    ]);
    expect(token).toMatchObject({ token: "meta-token", source: "metadata" });
  });

  test("a GCE_METADATA_HOST that names a server enables it, at that host", async () => {
    // That variable is how a workload says where its metadata server lives,
    // which is as explicit as a caller's flag.
    const spy = spyFetch();
    const token = await resolveGoogleAdc({
      env: { GCE_METADATA_HOST: "169.254.169.254" },
      readFileImpl: noFiles,
      fetchImpl: spy.impl,
    });
    expect(spy.metadataCalls()).toEqual([
      "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    ]);
    expect(token?.source).toBe("metadata");
  });

  test("a blank GCE_METADATA_HOST names nothing", async () => {
    const spy = spyFetch();
    await resolveGoogleAdc({
      env: { GCE_METADATA_HOST: "   " },
      readFileImpl: noFiles,
      fetchImpl: spy.impl,
    });
    expect(spy.urls).toEqual([]);
  });

  test("Google's own opt-outs still win over an explicit allow", async () => {
    for (const env of [{ NO_GCE_CHECK: "true" }, { GCE_METADATA_HOST: "" }]) {
      const spy = spyFetch();
      const token = await resolveGoogleAdc({
        env,
        allowMetadata: true,
        readFileImpl: noFiles,
        fetchImpl: spy.impl,
      });
      expect(spy.urls).toEqual([]);
      expect(token).toBeNull();
    }
  });
});

describe("the Vertex adapter's own resolver", () => {
  // It runs only when a Vertex request is about to go out, so it is the one
  // caller that may ask by default — on a GCE VM with no key file the
  // metadata server is the only credential there is.
  test("asks the metadata server unless told not to", async () => {
    const spy = spyFetch();
    const resolve = createGoogleTokenResolver({
      env: {},
      readFileImpl: noFiles,
      fetchImpl: spy.impl,
    });
    expect((await resolve())?.token).toBe("meta-token");
    expect(spy.metadataCalls()).toHaveLength(1);
  });

  test("allowMetadata: false holds even there", async () => {
    const spy = spyFetch();
    const resolve = createGoogleTokenResolver({
      env: {},
      allowMetadata: false,
      readFileImpl: noFiles,
      fetchImpl: spy.impl,
    });
    expect(await resolve()).toBeNull();
    expect(spy.urls).toEqual([]);
  });
});

describe("the cloud chain (the boot scan's path)", () => {
  // probeCloudChain resolves with the process's own fetch and file reader, so
  // the spy goes on globalThis.fetch and the gcloud ADC file is pointed at a
  // directory that does not exist — never the machine's real one.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const env: NodeJS.ProcessEnv = {
    CLOUDSDK_CONFIG: join(tmpdir(), "rune-p4a-no-such-gcloud-dir"),
  };
  const vertex = PROVIDER_PRESETS.find((p) => p.id === "vertex")!;
  const store = {} as CredentialStore; // the chain strategy never touches it
  const ctx = { providerId: "vertex", preset: vertex, store, env };

  function spyGlobalFetch() {
    const spy = spyFetch();
    globalThis.fetch = spy.impl;
    return spy;
  }

  test("probeCloudChain does not ask the metadata server by default", async () => {
    const spy = spyGlobalFetch();
    expect(await probeCloudChain("vertex", env)).toBeNull();
    expect(spy.urls).toEqual([]);
  });

  test("probeCloudChain passes an explicit allow through", async () => {
    const spy = spyGlobalFetch();
    const probe = await probeCloudChain("vertex", env, { allowMetadata: true });
    expect(spy.metadataCalls()).toHaveLength(1);
    expect(probe?.detail).toBe("metadata server");
  });

  test("the strategy's non-interactive load stays off unless its caller allows it", async () => {
    const strategy = new CloudChainStrategy();
    const spy = spyGlobalFetch();
    expect(await strategy.loadCredentials(ctx)).toBeNull();
    expect(await strategy.refresh(ctx)).toBeNull();
    expect(spy.urls).toEqual([]);

    const allowed = await strategy.loadCredentials({ ...ctx, allowMetadata: true });
    expect(spy.metadataCalls()).toHaveLength(1);
    expect(allowed).toMatchObject({ kind: "none", meta: { detail: "metadata server" } });
  });

  test("login names the provider, so it may ask — unless its caller says not to", async () => {
    const strategy = new CloudChainStrategy();
    const spy = spyGlobalFetch();
    const cred = await strategy.authenticate(ctx);
    expect(spy.metadataCalls()).toHaveLength(1);
    expect(cred.meta?.detail).toBe("metadata server");

    const before = spy.urls.length;
    await expect(strategy.authenticate({ ...ctx, allowMetadata: false })).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(spy.urls.length).toBe(before);
  });
});
