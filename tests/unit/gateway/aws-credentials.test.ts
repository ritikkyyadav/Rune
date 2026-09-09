/**
 * P10.5 — the AWS credential chain.
 *
 * Every rung is exercised against injected files and an injected fetch, so the
 * test says nothing about whichever cloud this machine happens to be logged
 * into. The rung ORDER is the part that matters: an environment variable must
 * beat a profile, and a profile must beat a role, because that is the
 * precedence every other AWS tool on the machine follows and a coding agent
 * that picked a different account than `aws s3 ls` would be a very confusing
 * bug to chase.
 */
import { describe, test, expect } from "bun:test";
import {
  describeAwsSource,
  parseIni,
  resolveAwsCredentials,
  resolveAwsRegion,
  createAwsCredentialResolver,
} from "../../../packages/llm-gateway/src/providers/aws/credentials";

const CREDENTIALS_FILE = `
[default]
aws_access_key_id = AKIA_DEFAULT
aws_secret_access_key = secret-default

[work]
aws_access_key_id = AKIA_WORK
aws_secret_access_key = secret-work
aws_session_token = token-work
`;

const CONFIG_FILE = `
[default]
region = us-west-2

[profile work]
region = eu-central-1
`;

/**
 * Serve the two shared files by name; anything else is "missing".
 *
 * The resolver builds its paths with `join(home, ".aws", "credentials")`, so on
 * Windows it asks for `C:\Users\…\.aws\credentials` and a `/credentials`
 * suffix match would answer ENOENT to every rung. Match on the last SEGMENT
 * instead, which is the same question on both separators.
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

const SHARED = files({ credentials: CREDENTIALS_FILE, config: CONFIG_FILE });

/** A fetch that fails the test if anything reaches the network. */
const noNetwork = (async () => {
  throw new Error("the chain must not reach the network for this rung");
}) as unknown as typeof fetch;

describe("parseIni", () => {
  test("reads sections and key = value pairs", () => {
    const ini = parseIni(CREDENTIALS_FILE);
    expect(ini.default!.aws_access_key_id).toBe("AKIA_DEFAULT");
    expect(ini.work!.aws_session_token).toBe("token-work");
  });

  test("ignores comments and blank lines", () => {
    const ini = parseIni("# a comment\n; another\n\n[x]\nk = v\n");
    expect(ini.x).toEqual({ k: "v" });
  });

  test("an indented continuation line is skipped, not mistaken for a key", () => {
    // `sso_session` blocks nest indented keys. Half-reading one would produce a
    // profile that looks complete and is not.
    const ini = parseIni(
      "[profile p]\nservices =\n  s3 =\n    endpoint_url = http://x\nregion = eu-west-1\n",
    );
    expect(ini["profile p"]).toEqual({ services: "", region: "eu-west-1" });
  });
});

describe("rung 1: environment variables", () => {
  test("static env keys win over a shared-file profile", async () => {
    const cred = await resolveAwsCredentials({
      env: {
        AWS_ACCESS_KEY_ID: "AKIA_ENV",
        AWS_SECRET_ACCESS_KEY: "secret-env",
        AWS_REGION: "us-east-1",
      },
      readFileImpl: SHARED,
      fetchImpl: noNetwork,
    });
    expect(cred).toMatchObject({
      accessKeyId: "AKIA_ENV",
      secretAccessKey: "secret-env",
      source: "env",
      region: "us-east-1",
    });
  });

  test("a session token rides along when present", async () => {
    const cred = await resolveAwsCredentials({
      env: {
        AWS_ACCESS_KEY_ID: "A",
        AWS_SECRET_ACCESS_KEY: "S",
        AWS_SESSION_TOKEN: "T",
      },
      readFileImpl: SHARED,
    });
    expect(cred!.sessionToken).toBe("T");
  });
});

describe("rung 2: the shared config files", () => {
  test("the default profile", async () => {
    const cred = await resolveAwsCredentials({
      env: {},
      readFileImpl: SHARED,
      fetchImpl: noNetwork,
    });
    expect(cred).toMatchObject({
      accessKeyId: "AKIA_DEFAULT",
      source: "profile",
      profile: "default",
      region: "us-west-2",
    });
  });

  test("AWS_PROFILE selects another profile, and its region comes from ~/.aws/config", async () => {
    const cred = await resolveAwsCredentials({
      env: { AWS_PROFILE: "work" },
      readFileImpl: SHARED,
      fetchImpl: noNetwork,
    });
    expect(cred).toMatchObject({
      accessKeyId: "AKIA_WORK",
      sessionToken: "token-work",
      profile: "work",
      region: "eu-central-1",
    });
  });

  test("a profile that exists in neither file resolves to nothing", async () => {
    const cred = await resolveAwsCredentials({
      env: { AWS_PROFILE: "nope" },
      readFileImpl: SHARED,
      fetchImpl: noNetwork,
    });
    expect(cred).toBeNull();
  });

  test("unreadable files are a missing credential, never a thrown startup", async () => {
    const cred = await resolveAwsCredentials({
      env: {},
      readFileImpl: async () => {
        throw new Error("EACCES");
      },
      fetchImpl: noNetwork,
    });
    expect(cred).toBeNull();
  });
});

describe("rung 3: web identity", () => {
  test("exchanges the OIDC token at STS and returns temporary credentials", async () => {
    let seen: { url: string; body: string } | null = null;
    const cred = await resolveAwsCredentials({
      env: {
        AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
        AWS_ROLE_ARN: "arn:aws:iam::1:role/rune",
        AWS_REGION: "us-east-2",
      },
      readFileImpl: files({ token: "oidc-token-value" }),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url: String(url), body: String(init.body) };
        return new Response(
          `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
             <AccessKeyId>ASIA_STS</AccessKeyId>
             <SecretAccessKey>secret-sts</SecretAccessKey>
             <SessionToken>token-sts</SessionToken>
             <Expiration>2030-01-01T00:00:00Z</Expiration>
           </Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(cred).toMatchObject({
      accessKeyId: "ASIA_STS",
      sessionToken: "token-sts",
      source: "web-identity",
    });
    expect(cred!.expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(seen!.url).toBe("https://sts.us-east-2.amazonaws.com/");
    expect(seen!.body).toContain("Action=AssumeRoleWithWebIdentity");
    expect(seen!.body).toContain("WebIdentityToken=oidc-token-value");
  });

  test("an STS refusal resolves to nothing rather than throwing", async () => {
    const cred = await resolveAwsCredentials({
      env: { AWS_WEB_IDENTITY_TOKEN_FILE: "/t", AWS_ROLE_ARN: "arn:x" },
      readFileImpl: files({ t: "tok" }),
      fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch,
    });
    expect(cred).toBeNull();
  });
});

describe("rung 4: container credentials", () => {
  test("the relative URI resolves against the ECS link-local address", async () => {
    let seen = "";
    const cred = await resolveAwsCredentials({
      env: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
        AWS_CONTAINER_AUTHORIZATION_TOKEN: "hdr-token",
      },
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = String(url);
        expect((init.headers as Record<string, string>).authorization).toBe("hdr-token");
        return new Response(
          JSON.stringify({
            AccessKeyId: "ASIA_ECS",
            SecretAccessKey: "secret-ecs",
            Token: "token-ecs",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(seen).toBe("http://169.254.170.2/v2/credentials/abc");
    expect(cred).toMatchObject({ accessKeyId: "ASIA_ECS", source: "container" });
  });
});

describe("no rung resolves", () => {
  test("an empty machine reports null, and the caller prints 'no credential'", async () => {
    // The honest answer. `rune providers` renders this as an em dash rather
    // than a row that claims a credential nobody has.
    const cred = await resolveAwsCredentials({
      env: {},
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
      fetchImpl: noNetwork,
    });
    expect(cred).toBeNull();
  });

  test("IMDS is deliberately not probed, so nothing hangs on a laptop", async () => {
    // The SDKs' last rung is a link-local metadata request that does not answer
    // off EC2 and costs a timeout on every cold start. `rune providers` runs
    // this resolver on the no-credential path, so the probe is omitted.
    let touched = false;
    await resolveAwsCredentials({
      env: {},
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
      fetchImpl: (async () => {
        touched = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(touched).toBe(false);
  });
});

describe("region resolution", () => {
  test("AWS_REGION wins, then AWS_DEFAULT_REGION, then the profile", async () => {
    expect(
      await resolveAwsRegion({ env: { AWS_REGION: "ap-south-1" }, readFileImpl: SHARED }),
    ).toBe("ap-south-1");
    expect(
      await resolveAwsRegion({ env: { AWS_DEFAULT_REGION: "sa-east-1" }, readFileImpl: SHARED }),
    ).toBe("sa-east-1");
    expect(await resolveAwsRegion({ env: {}, readFileImpl: SHARED })).toBe("us-west-2");
    expect(await resolveAwsRegion({ env: { AWS_PROFILE: "work" }, readFileImpl: SHARED })).toBe(
      "eu-central-1",
    );
  });
});

describe("describeAwsSource", () => {
  test("names the source without ever naming the secret", () => {
    expect(describeAwsSource({ accessKeyId: "A", secretAccessKey: "S", source: "env" })).toBe(
      "environment",
    );
    expect(
      describeAwsSource({
        accessKeyId: "A",
        secretAccessKey: "SUPERSECRET",
        source: "profile",
        profile: "work",
      }),
    ).toBe("profile work");
    expect(describeAwsSource({ accessKeyId: "A", secretAccessKey: "S", source: "container" })).toBe(
      "container role",
    );
  });
});

describe("the cached resolver", () => {
  test("re-resolves when a temporary credential is near expiry", async () => {
    let resolutions = 0;
    const makeEnv = () => ({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/creds",
    });
    const resolve = createAwsCredentialResolver({
      env: makeEnv(),
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
      fetchImpl: (async () => {
        resolutions++;
        return new Response(
          JSON.stringify({
            AccessKeyId: `ASIA_${resolutions}`,
            SecretAccessKey: "s",
            Token: "t",
            // Already inside the 60s refresh window.
            Expiration: new Date(Date.now() + 30_000).toISOString(),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect((await resolve())!.accessKeyId).toBe("ASIA_1");
    expect((await resolve())!.accessKeyId).toBe("ASIA_2");
    expect(resolutions).toBe(2);
  });

  test("a static credential is reused rather than re-read every request", async () => {
    let reads = 0;
    const resolve = createAwsCredentialResolver({
      env: {},
      readFileImpl: async (path: string) => {
        reads++;
        return (path.split(/[\\/]/).pop() ?? path) === "credentials"
          ? CREDENTIALS_FILE
          : CONFIG_FILE;
      },
    });
    await resolve();
    const readsAfterFirst = reads;
    await resolve();
    await resolve();
    expect(reads).toBe(readsAfterFirst);
  });
});
