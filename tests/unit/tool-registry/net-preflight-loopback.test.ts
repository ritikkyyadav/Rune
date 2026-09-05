/**
 * The sandboxed-bash preflight lets a loopback HTTP request through.
 *
 * Loopback is open inside the sandbox (rune-sandbox: bind, inbound and
 * outbound pinned to localhost), and `curl http://127.0.0.1:8080` is how a
 * page the run just served gets verified. Blocking it "because it would hang"
 * was false, and it sent one run through five failed attempts to check its
 * own site. A remote host anywhere in the segment still counts as network.
 */

import { describe, test, expect } from "bun:test";
import {
  loopbackOnly,
  needsNetwork,
} from "../../../packages/tool-registry/src/tools/net-preflight";

describe("loopbackOnly", () => {
  test("loopback hosts, with and without scheme or port", () => {
    expect(loopbackOnly("curl http://127.0.0.1:8080/")).toBe(true);
    expect(loopbackOnly("curl -s http://localhost:3000/api")).toBe(true);
    expect(loopbackOnly("curl http://[::1]:8080")).toBe(true);
    expect(loopbackOnly("curl localhost:3000")).toBe(true);
    expect(loopbackOnly("wget -qO- 127.0.0.1:8000/index.html")).toBe(true);
  });

  test("a remote host anywhere makes it network", () => {
    expect(loopbackOnly("curl https://example.com")).toBe(false);
    expect(loopbackOnly("curl http://localhost:3000 http://example.com")).toBe(false);
    expect(loopbackOnly("curl example.com")).toBe(false);
    // localhost as a path or a word is not a target.
    expect(loopbackOnly("curl https://docs.example.com/localhost")).toBe(false);
  });
});

describe("needsNetwork with loopback", () => {
  test("a loopback curl is not a network call", () => {
    expect(needsNetwork("curl http://127.0.0.1:8080/")).toBeNull();
    expect(
      needsNetwork("python3 -m http.server 8080 & sleep 1; curl -s localhost:8080"),
    ).toBeNull();
  });

  test("a remote curl still is, alone or beside a loopback one", () => {
    expect(needsNetwork("curl https://example.com")).toBe("HTTP request");
    expect(needsNetwork("curl localhost:3000 && curl https://example.com")).toBe("HTTP request");
  });

  test("the other patterns are untouched", () => {
    expect(needsNetwork("npm install")).toBe("package install");
    expect(needsNetwork("git push origin main")).toBe("git remote operation");
  });
});
