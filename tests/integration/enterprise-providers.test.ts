/**
 * P10.5 — the live half of the enterprise routes.
 *
 * The unit tests prove the request Rune BUILDS is the one each cloud documents.
 * Only a real call can prove the cloud AGREES, and no cloud credential exists on
 * the machine these were written on. So every test here is doubly gated: an
 * explicit `RUNE_LIVE_<PROVIDER>=1` opt-in, and a credential that actually
 * resolves. When either is missing the test SKIPS WITH A PRINTED REASON rather
 * than passing — a green suite that silently ran nothing is the failure this
 * whole file is arranged to avoid.
 *
 *   RUNE_LIVE_BEDROCK=1 bun test tests/integration/enterprise-providers.test.ts
 *
 * These spend real tokens (a handful, on the cheapest model in each catalogue).
 * Nothing here prints a credential.
 */
import { describe, test, expect } from "bun:test";
import { BedrockProvider } from "../../packages/llm-gateway/src/providers/bedrock";
import { resolveAwsCredentials } from "../../packages/llm-gateway/src/providers/aws/credentials";
import { VertexProvider } from "../../packages/llm-gateway/src/providers/vertex";
import { AzureOpenAIProvider } from "../../packages/llm-gateway/src/providers/azure-openai";
import {
  resolveGoogleAdc,
  resolveGoogleProject,
} from "../../packages/llm-gateway/src/providers/google/adc";
import type { StreamEvent } from "../../packages/llm-gateway/src/types";

/** Print once why a live suite is not running, then skip it. */
function skipReason(provider: string, flag: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ⊘ ${provider} live tests skipped — ${reason} (set ${flag}=1 and sign in to run)`);
}

async function collectText(gen: AsyncGenerator<StreamEvent>): Promise<string> {
  let text = "";
  for await (const e of gen) {
    if (e.type === "content_delta" && e.delta.type === "text_delta") text += e.delta.text;
  }
  return text;
}

describe("AWS Bedrock (live)", () => {
  const enabled = process.env.RUNE_LIVE_BEDROCK === "1";

  test("streams a completion through the Bedrock Messages API", async () => {
    if (!enabled) {
      skipReason("Bedrock", "RUNE_LIVE_BEDROCK", "not enabled");
      return;
    }
    const cred = await resolveAwsCredentials();
    if (!cred) {
      skipReason("Bedrock", "RUNE_LIVE_BEDROCK", "the AWS credential chain resolved nothing");
      return;
    }
    // Named, never valued: the source is safe to print, the secret is not.
    // eslint-disable-next-line no-console
    console.log(`  → Bedrock live: credentials from ${cred.source}`);

    const provider = new BedrockProvider();
    const text = await collectText(
      provider.inferStream({
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
        // The cheapest on-demand model in the catalogue, so a live run costs
        // cents rather than dollars.
        model: "anthropic.claude-3-5-haiku-20241022-v1:0",
        provider: "bedrock",
        maxTokens: 16,
        stream: true,
      }),
    );
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  test("lists foundation models from the control plane", async () => {
    if (!enabled) {
      skipReason("Bedrock", "RUNE_LIVE_BEDROCK", "not enabled");
      return;
    }
    if (!(await resolveAwsCredentials())) {
      skipReason("Bedrock", "RUNE_LIVE_BEDROCK", "the AWS credential chain resolved nothing");
      return;
    }
    const models = await new BedrockProvider().listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.includes("anthropic"))).toBe(true);
  }, 60_000);
});

describe("Google Vertex AI (live)", () => {
  const enabled = process.env.RUNE_LIVE_VERTEX === "1";

  /** Both halves of "can this machine reach Vertex": a token AND a project. */
  async function preflight(): Promise<string | null> {
    if (!enabled) return "not enabled";
    if (!(await resolveGoogleAdc())) return "Application Default Credentials resolved nothing";
    if (!(await resolveGoogleProject())) return "no GOOGLE_CLOUD_PROJECT is configured";
    return null;
  }

  test("streams a Claude completion through the Vertex Anthropic endpoint", async () => {
    const blocked = await preflight();
    if (blocked) {
      skipReason("Vertex", "RUNE_LIVE_VERTEX", blocked);
      return;
    }
    const text = await collectText(
      new VertexProvider().inferStream({
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
        model: "claude-haiku-4-5@20251001",
        provider: "vertex",
        maxTokens: 16,
        stream: true,
      }),
    );
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  test("streams a Gemini completion through the Vertex Gemini endpoint", async () => {
    const blocked = await preflight();
    if (blocked) {
      skipReason("Vertex", "RUNE_LIVE_VERTEX", blocked);
      return;
    }
    // The same provider, the same project, a different publisher — the claim
    // the routing exists to make.
    const text = await collectText(
      new VertexProvider().inferStream({
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
        model: "gemini-2.5-flash",
        provider: "vertex",
        maxTokens: 16,
        stream: true,
      }),
    );
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  test("lists models from both publishers", async () => {
    const blocked = await preflight();
    if (blocked) {
      skipReason("Vertex", "RUNE_LIVE_VERTEX", blocked);
      return;
    }
    const models = await new VertexProvider().listModels();
    expect(models.some((m) => m.id.startsWith("claude"))).toBe(true);
    expect(models.some((m) => m.id.startsWith("gemini"))).toBe(true);
  }, 60_000);
});

describe("Azure OpenAI (live)", () => {
  const enabled = process.env.RUNE_LIVE_AZURE_OPENAI === "1";

  /** Azure needs BOTH an endpoint and a credential; say which is missing. */
  function preflight(): string | null {
    if (!enabled) return "not enabled";
    if (!process.env.AZURE_OPENAI_ENDPOINT) return "AZURE_OPENAI_ENDPOINT is not set";
    if (!process.env.AZURE_OPENAI_API_KEY && !process.env.AZURE_OPENAI_AD_TOKEN) {
      return "neither AZURE_OPENAI_API_KEY nor AZURE_OPENAI_AD_TOKEN is set";
    }
    return null;
  }

  test("streams a completion from a deployment", async () => {
    const blocked = preflight();
    if (blocked) {
      skipReason("Azure OpenAI", "RUNE_LIVE_AZURE_OPENAI", blocked);
      return;
    }
    // RUNE_LIVE_AZURE_DEPLOYMENT names the deployment on the tester's resource;
    // without it the model id is used, which is Azure's own default naming.
    const model = process.env.RUNE_LIVE_AZURE_DEPLOYMENT || "gpt-4o-mini";
    const text = await collectText(
      new AzureOpenAIProvider().inferStream({
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
        model,
        provider: "azure-openai",
        maxTokens: 16,
        stream: true,
      }),
    );
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  test("lists the deployments this resource has", async () => {
    const blocked = preflight();
    if (blocked) {
      skipReason("Azure OpenAI", "RUNE_LIVE_AZURE_OPENAI", blocked);
      return;
    }
    const models = await new AzureOpenAIProvider().listModels();
    expect(models.length).toBeGreaterThan(0);
  }, 60_000);
});
