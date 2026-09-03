/**
 * P10.5 — the SigV4 signer against AWS's own published vectors.
 *
 * Gear signs Bedrock requests itself rather than pulling in the AWS SDK (~40
 * transitive packages into a single-file compiled binary). That is only
 * defensible if the signer is checked against something OUTSIDE itself, so
 * every constant below comes from AWS's published material — the worked
 * signing-key derivation example and the `get-vanilla` / `post-vanilla` /
 * `get-vanilla-query-order-key-case` cases of the SigV4 test suite — not from a
 * previous run of this code.
 *
 * The intermediates are asserted as well as the final signature. A signer that
 * agrees on the canonical request, the string to sign AND the signature is
 * right for the right reason; one that agrees only on the last could be wrong
 * in two places that cancel.
 */
import { describe, test, expect } from "bun:test";
import {
  amzDate,
  buildCanonicalRequest,
  canonicalQuery,
  canonicalUri,
  deriveSigningKey,
  escapeUri,
  sha256Hex,
  signRequest,
} from "../../../packages/llm-gateway/src/providers/aws/sigv4";

/** The test suite's shared credentials. */
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
/** The test suite's fixed clock: 2015-08-30T12:36:00Z. */
const NOW = new Date("2015-08-30T12:36:00Z");

describe("signing key derivation", () => {
  test("matches the worked example in the AWS documentation", () => {
    // AWS publishes this exact derivation for
    // (20150830, us-east-1, iam) as its reference implementation check.
    const key = deriveSigningKey(CREDENTIALS.secretAccessKey, "20150830", "us-east-1", "iam");
    expect(key.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });

  test("the derivation is a chain, so each level changes the key", () => {
    const a = deriveSigningKey(CREDENTIALS.secretAccessKey, "20150830", "us-east-1", "iam");
    const b = deriveSigningKey(CREDENTIALS.secretAccessKey, "20150830", "us-east-1", "bedrock");
    const c = deriveSigningKey(CREDENTIALS.secretAccessKey, "20150831", "us-east-1", "iam");
    expect(a.toString("hex")).not.toBe(b.toString("hex"));
    expect(a.toString("hex")).not.toBe(c.toString("hex"));
  });
});

describe("aws-sig-v4-test-suite: get-vanilla", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    region: "us-east-1",
    service: "service",
    credentials: CREDENTIALS,
    now: NOW,
  });

  test("canonical request", () => {
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        // SHA-256 of the empty payload.
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
  });

  test("string to sign", () => {
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        sha256Hex(signed.canonicalRequest),
      ].join("\n"),
    );
  });

  test("signature", () => {
    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("authorization header", () => {
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("aws-sig-v4-test-suite: post-vanilla", () => {
  test("signature", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      credentials: CREDENTIALS,
      now: NOW,
    });
    expect(signed.signature).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });
});

describe("aws-sig-v4-test-suite: get-vanilla-query-order-key-case", () => {
  test("signature, with the query sorted by name", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/?Param1=value1&Param2=value2",
      region: "us-east-1",
      service: "service",
      credentials: CREDENTIALS,
      now: NOW,
    });
    expect(signed.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  test("query parameters are sorted regardless of the order they arrive in", () => {
    expect(canonicalQuery("?Param2=value2&Param1=value1")).toBe("Param1=value1&Param2=value2");
  });
});

describe("session tokens", () => {
  test("a temporary credential signs x-amz-security-token as a header", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      credentials: { ...CREDENTIALS, sessionToken: "SESSION" },
      now: NOW,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("SESSION");
    // A token that rode along UNSIGNED would be rejected by AWS: the header set
    // in SignedHeaders must be exactly the set the request carries.
    expect(signed.headers.authorization).toContain("host;x-amz-date;x-amz-security-token");
  });
});

describe("percent-encoding", () => {
  test("RFC 3986 encodes the five characters encodeURIComponent leaves alone", () => {
    expect(escapeUri("!'()*")).toBe("%21%27%28%29%2A");
  });

  test("unreserved characters stay literal", () => {
    expect(escapeUri("aZ0-._~")).toBe("aZ0-._~");
  });

  test("a Bedrock model id's colon is double-encoded in the canonical URI", () => {
    // The wire carries `%3A` (encodeURIComponent of the id); SigV4 requires the
    // canonical form to escape that AGAIN. Getting this wrong signs a different
    // request than the one sent, and every Bedrock call 403s with
    // "signature does not match".
    const wirePath = `/model/${encodeURIComponent("us.anthropic.claude-sonnet-4-5-20250929-v1:0")}/invoke`;
    expect(wirePath).toContain("%3A");
    expect(canonicalUri(wirePath)).toContain("%253A");
    expect(canonicalUri(wirePath).startsWith("/model/")).toBe(true);
  });
});

describe("canonical headers", () => {
  test("names lowercase and sorted, values trimmed and whitespace-collapsed", () => {
    const { canonical, signedHeaders } = buildCanonicalRequest(
      "POST",
      new URL("https://example.amazonaws.com/"),
      { "Content-Type": "  application/json  ", Accept: "a\t\tb", host: "example.amazonaws.com" },
      "",
    );
    expect(signedHeaders).toBe("accept;content-type;host");
    expect(canonical).toContain("accept:a b\n");
    expect(canonical).toContain("content-type:application/json\n");
  });

  test("an explicit x-amz-content-sha256 wins over hashing the body", () => {
    const { canonical } = buildCanonicalRequest(
      "PUT",
      new URL("https://example.amazonaws.com/"),
      { host: "example.amazonaws.com", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
      "ignored",
    );
    expect(canonical.endsWith("UNSIGNED-PAYLOAD")).toBe(true);
  });
});

describe("amzDate", () => {
  test("renders the compact ISO basic form AWS expects", () => {
    expect(amzDate(new Date("2026-09-03T04:05:06.789Z"))).toBe("20260903T040506Z");
  });
});
