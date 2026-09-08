/**
 * P10.5 — Application Default Credentials.
 *
 * The signed-JWT exchange is the part that cannot be checked by inspection, so
 * it is checked against a FIXED RSA key generated in the test: the assertion is
 * signed by the implementation and verified with the public half by
 * `node:crypto`, which is an independent check that the bytes are a real RS256
 * signature over the claims Google documents — not a hash the test computed
 * itself and compared to itself.
 *
 * Every other rung runs against injected files and an injected fetch, so
 * nothing here depends on whichever Google account this machine has.
 */
import { describe, test, expect } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  buildServiceAccountJwt,
  createGoogleTokenResolver,
  describeAdcSource,
  gcloudAdcPath,
  resolveGoogleAdc,
  resolveGoogleProject,
} from "../../../packages/llm-gateway/src/providers/google/adc";

/** A throwaway RSA key pair — the "service account" for these tests. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "rune-test-project",
  private_key_id: "key-1",
  private_key: privateKey,
  client_email: "rune@rune-test-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

const AUTHORIZED_USER = JSON.stringify({
  type: "authorized_user",
  client_id: "client-abc.apps.googleusercontent.com",
  client_secret: "secret-abc",
  refresh_token: "refresh-abc",
  quota_project_id: "rune-quota-project",
});

/**
 * Serve a key file by name; anything else is "missing".
 *
 * `gcloudAdcPath` builds its path with `join`, so on Windows it asks for
 * `\home\dev\.config\gcloud\application_default_credentials.json` and a
 * `/application_default_credentials.json` suffix match would answer ENOENT.
 * Match on the last SEGMENT, which is the same question on both separators.
 */
function files(map: Record<string, string>) {
  return async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    for (const [key, body] of Object.entries(map)) {
      if (name === key) return body;
    }
    throw new Error("ENOENT");
  };
}

const noFiles = async () => {
  throw new Error("ENOENT");
};

/**
 * A token endpoint that records what it was sent and answers with a token.
 * Anything else — notably the metadata server, which is the rung AFTER a bad
 * key file — 404s, so a test about rung 1 cannot be satisfied by rung 3.
 */
function tokenEndpoint(onCall?: (url: string, body: string) => void) {
  return (async (url: string, init: RequestInit) => {
    const href = String(url);
    if (!href.includes("oauth2.googleapis.com")) return new Response("", { status: 404 });
    onCall?.(href, String(init?.body ?? ""));
    return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 3599 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<string, unknown>;
}

describe("the service-account assertion JWT", () => {
  const jwt = buildServiceAccountJwt(
    {
      client_email: "rune@rune-test-project.iam.gserviceaccount.com",
      private_key: privateKey,
      private_key_id: "key-1",
    },
    1_800_000_000,
  );
  const [header, claims, signature] = jwt.split(".") as [string, string, string];

  test("declares RS256 and the key id", () => {
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
  });

  test("asserts the service account, the cloud-platform scope, and a one-hour life", () => {
    // One hour is Google's documented maximum; a longer exp is rejected
    // outright, which would look like a credential problem rather than a bug.
    expect(decodeSegment(claims)).toEqual({
      iss: "rune@rune-test-project.iam.gserviceaccount.com",
      sub: "rune@rune-test-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
  });

  test("the signature verifies against the public key", () => {
    // The independent check: node verifies bytes this module produced, using
    // the half of the key pair the module never saw.
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  test("a tampered claim set fails verification", () => {
    const forged = base64urlJson({ ...decodeSegment(claims), scope: "everything" });
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${forged}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(false);
  });
});

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

describe("rung 1: GOOGLE_APPLICATION_CREDENTIALS", () => {
  test("a service-account key is exchanged under the jwt-bearer grant", async () => {
    let seen: { url: string; body: string } | null = null;
    const token = await resolveGoogleAdc({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" },
      readFileImpl: files({ "sa.json": SERVICE_ACCOUNT }),
      fetchImpl: tokenEndpoint((url, body) => {
        seen = { url, body };
      }),
      now: () => 1_800_000_000_000,
    });

    expect(token).toMatchObject({
      token: "ya29.test-token",
      source: "service-account",
      detail: "rune@rune-test-project.iam.gserviceaccount.com",
      projectId: "rune-test-project",
    });
    expect(token!.expiresAt).toBe(1_800_000_000_000 + 3599_000);
    expect(seen!.url).toBe("https://oauth2.googleapis.com/token");
    expect(seen!.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
    expect(seen!.body).toContain("assertion=");
    // The private key must never reach the wire — only an assertion signed by it.
    expect(seen!.body).not.toContain("PRIVATE KEY");
  });

  test("an authorized-user key is a plain refresh-token grant", async () => {
    let body = "";
    const token = await resolveGoogleAdc({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/user.json" },
      readFileImpl: files({ "user.json": AUTHORIZED_USER }),
      fetchImpl: tokenEndpoint((_u, b) => {
        body = b;
      }),
    });
    expect(token).toMatchObject({ source: "gcloud", projectId: "rune-quota-project" });
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-abc");
  });

  test("a malformed key file falls through instead of throwing", async () => {
    const token = await resolveGoogleAdc({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/broken.json" },
      readFileImpl: files({ "broken.json": "{ not json" }),
      fetchImpl: tokenEndpoint(),
    });
    expect(token).toBeNull();
  });

  test("a key file with an unusable PEM is a missing credential, not a crash", async () => {
    const token = await resolveGoogleAdc({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/bad-pem.json" },
      readFileImpl: files({
        "bad-pem.json": JSON.stringify({
          type: "service_account",
          client_email: "x@y.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n",
        }),
      }),
      fetchImpl: tokenEndpoint(),
    });
    expect(token).toBeNull();
  });
});

describe("rung 2: the gcloud ADC file", () => {
  test("is read when no explicit key file is set", async () => {
    const token = await resolveGoogleAdc({
      env: {},
      home: "/home/dev",
      readFileImpl: files({ "application_default_credentials.json": AUTHORIZED_USER }),
      fetchImpl: tokenEndpoint(),
    });
    expect(token).toMatchObject({ source: "gcloud", detail: "gcloud ADC" });
  });

  test("CLOUDSDK_CONFIG relocates it", () => {
    // The path is joined, so it wears the host's separator: gcloud on Windows
    // reads `C:\…\application_default_credentials.json`. Assert the join, not
    // one platform's spelling of it.
    expect(gcloudAdcPath({ env: { CLOUDSDK_CONFIG: "/custom/gcloud" } })).toBe(
      join("/custom/gcloud", "application_default_credentials.json"),
    );
  });
});

describe("rung 3: the metadata server", () => {
  test("answers with a token on GCE", async () => {
    let seenUrl = "";
    const token = await resolveGoogleAdc({
      env: {},
      readFileImpl: noFiles,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        expect((init.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
        return new Response(JSON.stringify({ access_token: "metadata-token", expires_in: 3599 }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    expect(seenUrl).toContain("metadata.google.internal");
    expect(token).toMatchObject({ token: "metadata-token", source: "metadata" });
  });

  test("is skipped when Google's own opt-out is set, so nothing is probed", async () => {
    let touched = false;
    const token = await resolveGoogleAdc({
      env: { NO_GCE_CHECK: "true" },
      readFileImpl: noFiles,
      fetchImpl: (async () => {
        touched = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(touched).toBe(false);
    expect(token).toBeNull();
  });

  test("an unreachable metadata server resolves to null, never a hang or a throw", async () => {
    const token = await resolveGoogleAdc({
      env: {},
      readFileImpl: noFiles,
      fetchImpl: (async () => {
        throw new Error("ETIMEDOUT");
      }) as unknown as typeof fetch,
    });
    expect(token).toBeNull();
  });
});

describe("project resolution", () => {
  test("config wins, then the env, then the credential's own project", async () => {
    expect(await resolveGoogleProject({ configured: "explicit-proj", env: {} })).toBe(
      "explicit-proj",
    );
    expect(await resolveGoogleProject({ env: { GOOGLE_CLOUD_PROJECT: "env-proj" } })).toBe(
      "env-proj",
    );
    expect(
      await resolveGoogleProject({
        env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" },
        readFileImpl: files({ "sa.json": SERVICE_ACCOUNT }),
        fetchImpl: tokenEndpoint(),
      }),
    ).toBe("rune-test-project");
  });

  test("an empty machine has no project, and the caller must say so", async () => {
    expect(
      await resolveGoogleProject({ env: {}, readFileImpl: noFiles, fetchImpl: tokenEndpoint() }),
    ).toBeUndefined();
  });
});

describe("describeAdcSource", () => {
  test("names the source without ever naming the token", () => {
    expect(
      describeAdcSource({
        token: "ya29.SECRET",
        expiresAt: 0,
        source: "service-account",
        detail: "rune@p.iam.gserviceaccount.com",
      }),
    ).toBe("service account rune@p.iam.gserviceaccount.com");
    expect(
      describeAdcSource({ token: "ya29.SECRET", expiresAt: 0, source: "gcloud", detail: "x" }),
    ).toBe("gcloud ADC");
  });
});

describe("the cached resolver", () => {
  test("reuses a live token and refreshes one near expiry", async () => {
    let exchanges = 0;
    let clock = 1_800_000_000_000;
    const resolve = createGoogleTokenResolver({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" },
      readFileImpl: files({ "sa.json": SERVICE_ACCOUNT }),
      fetchImpl: (async () => {
        exchanges++;
        return new Response(JSON.stringify({ access_token: `t${exchanges}`, expires_in: 3599 }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
      now: () => clock,
    });

    expect((await resolve())!.token).toBe("t1");
    expect((await resolve())!.token).toBe("t1");
    expect(exchanges).toBe(1);

    // Inside the 60s refresh window.
    clock += 3_560_000;
    expect((await resolve())!.token).toBe("t2");
    expect(exchanges).toBe(2);
  });
});
