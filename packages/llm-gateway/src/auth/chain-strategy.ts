// ─── The cloud credential chain ───
//
// The enterprise routes do not have a key. AWS Bedrock signs each request with
// SigV4 from whatever the AWS credential chain resolves; Vertex exchanges
// Application Default Credentials for a short-lived token; Azure accepts an
// Entra bearer token from the environment. In all three the machine's cloud
// login IS the credential, and Rune's job is to find it, not to hold it.
//
// So this strategy stores NOTHING. `storeCredentials` is a no-op and `logout`
// is a no-op, because there is no Rune-held secret to write or delete — and
// that is the feature, not a gap. A team whose whole reason for routing through
// Bedrock is that the model traffic must stay inside their AWS account does not
// want a second copy of their cloud credential inside a coding tool's keychain.
//
// The credential that comes back is `kind: "none"` for Bedrock and Vertex: the
// adapter re-resolves and signs per request (SigV4 has no bearer to carry, and
// a Vertex token expires in an hour), so what this strategy returns is the
// ANSWER to "is this machine authenticated?", plus a printable source. Azure's
// Entra token is a real bearer and comes back as one.
//
// Nothing here logs a secret. `meta.detail` is the human string the UI prints
// ("profile default", "service account"), and it is derived from where the
// credential was found, never from the credential.

import type { AuthContext, AuthenticationStrategy, ResolvedCredential } from "./types";
import { AuthError } from "./types";

/** What a cloud chain resolved to — a source description, never the secret. */
export interface ChainProbe {
  detail: string;
  /**
   * A bearer token, for the one chain whose ambient credential Rune can
   * actually carry (Azure's Entra token). AWS and GCP re-authenticate per
   * request inside their adapters and have nothing to hand over here.
   */
  secret?: string;
}

export interface ChainProbeOpts {
  /**
   * Let the Vertex probe ask the GCE metadata server. Off unless the caller
   * says so: the boot scan probes EVERY cloud route, and on a machine that is
   * not on Google Cloud that request is a stray packet to
   * metadata.google.internal and up to a second of startup. AWS already
   * refuses its instance-metadata endpoint outright (providers/aws/credentials).
   */
  allowMetadata?: boolean;
}

/**
 * Probe one provider's ambient credentials.
 *
 * Split out from the strategy so the boot resolver, `rune providers` and the
 * adapters all ask the same question, and so a provider that has no chain
 * simply returns null instead of throwing.
 */
export async function probeCloudChain(
  providerId: string,
  env: NodeJS.ProcessEnv,
  opts: ChainProbeOpts = {},
): Promise<ChainProbe | null> {
  switch (providerId) {
    case "bedrock": {
      const { resolveAwsCredentials, describeAwsSource } =
        await import("../providers/aws/credentials");
      const cred = await resolveAwsCredentials({ env });
      return cred ? { detail: describeAwsSource(cred) } : null;
    }
    case "vertex": {
      const { resolveGoogleAdc, describeAdcSource } = await import("../providers/google/adc");
      const token = await resolveGoogleAdc({ env, allowMetadata: opts.allowMetadata === true });
      return token ? { detail: describeAdcSource(token) } : null;
    }
    // Azure's ambient credential is an Entra ID access token in the
    // environment — `az account get-access-token` or a workload-identity
    // sidecar puts it there. Unlike AWS and GCP it IS a bearer Rune can carry,
    // so it comes back as one; the resource-key path stays `api_key`.
    case "azure-openai": {
      const token = env.AZURE_OPENAI_AD_TOKEN;
      return token ? { detail: "Entra ID token", secret: token } : null;
    }
    default:
      return null;
  }
}

/** The recovery line printed when a chain resolves to nothing. */
export function chainSetupHint(providerId: string): string {
  switch (providerId) {
    case "bedrock":
      return (
        "No AWS credentials found. Run `aws configure`, export " +
        "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or select a profile with " +
        "AWS_PROFILE — then set the region with AWS_REGION or " +
        "`[llm.bedrock] region` and request model access in the Bedrock console."
      );
    case "azure-openai":
      return (
        "No Azure OpenAI credential found. Set AZURE_OPENAI_API_KEY (or " +
        "AZURE_OPENAI_AD_TOKEN for Entra ID) alongside AZURE_OPENAI_ENDPOINT, " +
        "and name your deployments under `[providers.azure-openai.deployments]`."
      );
    case "vertex":
      return (
        "No Google Cloud credentials found. Run `gcloud auth application-default " +
        "login`, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key — " +
        "then name the project with GOOGLE_CLOUD_PROJECT or `[providers.vertex] " +
        "project`, and enable the Vertex AI API."
      );
    default:
      return `${providerId} has no cloud credential chain.`;
  }
}

/**
 * The auth context, plus the one question only this strategy asks. The boot
 * scan (provider-registry's resolveProviderCredentials) builds one context per
 * preset; it should set `allowMetadata` only on the context of the provider
 * the session actually selected.
 */
export interface ChainAuthContext extends AuthContext {
  /** See ChainProbeOpts.allowMetadata. */
  allowMetadata?: boolean;
}

export class CloudChainStrategy implements AuthenticationStrategy {
  readonly method = "chain" as const;

  /** The non-interactive load (the boot scan): no metadata probe unless the caller allows it. */
  async loadCredentials(ctx: ChainAuthContext): Promise<ResolvedCredential | null> {
    return this.probe(ctx, ctx.allowMetadata === true);
  }

  private async probe(
    ctx: ChainAuthContext,
    allowMetadata: boolean,
  ): Promise<ResolvedCredential | null> {
    const probe = await probeCloudChain(ctx.providerId, ctx.env, { allowMetadata });
    if (!probe) return null;
    return {
      ...(probe.secret
        ? { kind: "bearer" as const, secret: probe.secret }
        : { kind: "none" as const }),
      meta: { method: "chain", source: "chain", detail: probe.detail },
    };
  }

  /**
   * There is no interactive flow to run: signing in happens in `aws`/`gcloud`/
   * `az`, not here. `rune login bedrock` therefore REPORTS — it says whether
   * the chain resolves and, when it does not, exactly which command fixes it.
   * Pretending to have a flow (a prompt asking for an access key) would invite
   * someone to paste a long-lived cloud credential into a tool that has no
   * business holding one.
   *
   * Login names the provider, which is exactly the explicit selection the
   * metadata probe waits for — so here it is on unless the caller turns it
   * off. On a GCE VM with no key file the metadata server IS the credential,
   * and `rune login vertex` answering "no credentials" there would be false.
   */
  async authenticate(ctx: ChainAuthContext): Promise<ResolvedCredential> {
    const cred = await this.probe(ctx, ctx.allowMetadata !== false);
    if (!cred) {
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: `no ${ctx.preset.label} credentials on this machine`,
        recovery: chainSetupHint(ctx.providerId),
      });
    }
    ctx.log?.(`Found ${ctx.preset.label} credentials: ${cred.meta?.detail ?? "resolved"}`);
    ctx.log?.("Nothing was stored — Rune reads your cloud credentials at request time.");
    return cred;
  }

  /** Re-probing IS the refresh: expiry is the chain's problem, not Rune's. */
  async refresh(ctx: ChainAuthContext): Promise<ResolvedCredential | null> {
    return this.loadCredentials(ctx);
  }

  /** Valid when the chain resolved. Offline for env/profile, bounded otherwise. */
  async validate(_ctx: AuthContext, cred: ResolvedCredential): Promise<boolean> {
    return cred.kind === "none" || !!cred.secret;
  }

  /** Nothing to store — see the header. */
  async storeCredentials(): Promise<void> {}

  /** Nothing to delete. Logging out of a cloud is that cloud's own command. */
  async logout(): Promise<void> {}
}
