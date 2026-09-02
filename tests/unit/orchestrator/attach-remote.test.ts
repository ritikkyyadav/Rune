/**
 * `gear attach ws://host:port` — the parts that decide what credential goes
 * where, and the page-token rule they mirror on the server side.
 *
 * Both are places where a wrong answer is silent: a token picked up from the
 * wrong source is either a disclosure or a confusing 401, and a page handed a
 * token it should not have is the whole reason the remote link carries its
 * token in a fragment.
 */

import { describe, expect, test } from "bun:test";

import { isLoopbackUrl, resolveToken } from "../../../packages/orchestrator/src/bin/attach-remote";
import {
  lanAddresses,
  mayReceiveEmbeddedToken,
} from "../../../packages/orchestrator/src/bin/serve-cli";

const localFile = { token: "from-the-file", url: "ws://127.0.0.1:4762" };

describe("which token gear attach uses", () => {
  test("--token wins", () => {
    const got = resolveToken("ws://10.0.0.5:7788", "flag-token", { GEAR_SERVE_TOKEN: "env" }, null);
    expect(got).toEqual({ token: "flag-token", from: "--token" });
  });

  test("GEAR_SERVE_TOKEN when there is no flag", () => {
    const got = resolveToken("ws://10.0.0.5:7788", undefined, { GEAR_SERVE_TOKEN: "env" }, null);
    expect(got).toEqual({ token: "env", from: "GEAR_SERVE_TOKEN" });
  });

  test("the local serve.json only for a loopback URL", () => {
    expect(resolveToken("ws://127.0.0.1:4762", undefined, {}, localFile)?.from).toBe(
      "~/.gear/serve.json",
    );
    // A token minted for the server on THIS machine is not a credential for
    // someone else's. Trying it against a remote host would be useless and a
    // disclosure, so the file is never consulted for one.
    expect(resolveToken("ws://10.0.0.5:7788", undefined, {}, localFile)).toBeNull();
  });

  test("no token at all is a refusal, not a guess", () => {
    expect(resolveToken("ws://10.0.0.5:7788", undefined, {}, null)).toBeNull();
    expect(resolveToken("ws://10.0.0.5:7788", "", { GEAR_SERVE_TOKEN: "" }, null)).toBeNull();
  });

  test("knows a loopback URL from a LAN one", () => {
    for (const u of ["ws://127.0.0.1:1", "ws://localhost:1", "ws://[::1]:1", "ws://127.5.5.5:1"]) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
    for (const u of ["ws://10.0.0.5:1", "wss://gear.example:443", "not a url"]) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });
});

describe("who gets a page with the token baked in", () => {
  test("loopback does", () => {
    // Any process that could make the request already runs as the user and can
    // read ~/.gear/serve.json, so refusing buys nothing.
    expect(mayReceiveEmbeddedToken(true, null, "secret")).toBe(true);
  });

  test("off-loopback does not, unless it already had the token", () => {
    expect(mayReceiveEmbeddedToken(false, null, "secret")).toBe(false);
    expect(mayReceiveEmbeddedToken(false, "wrong", "secret")).toBe(false);
    expect(mayReceiveEmbeddedToken(false, "secret", "secret")).toBe(true);
  });
});

describe("the addresses a --host bind is reachable on", () => {
  test("never reports the bind wildcard or a loopback address", () => {
    // `http://0.0.0.0:7788` is not a URL a phone can open, and an Origin
    // allowlist containing it matches nothing the browser will actually send.
    for (const a of lanAddresses()) {
      expect(a).not.toBe("0.0.0.0");
      expect(a.startsWith("127.")).toBe(false);
    }
  });
});
