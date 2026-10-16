/** The local completion screen: copy, safe provider text, and motion behavior. */
import { describe, test, expect } from "bun:test";
import { createHash } from "crypto";
import { runInNewContext } from "node:vm";
import { successPage } from "../../../packages/llm-gateway/src/auth/oauth-strategy";

const scriptOf = (html: string) => html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

function motionHarness(reduced = false) {
  const listeners = new Map<string, (event?: unknown) => void>();
  const scheduled = new Map<number, (time: number) => void>();
  const coordinates: number[][] = [];
  const properties = new Map<string, string>();
  const history: unknown[][] = [];
  let nextId = 1;
  const context = {
    setTransform() {},
    clearRect() {
      coordinates.length = 0;
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      coordinates.push([x, y]);
    },
    lineTo() {},
    stroke() {},
  };
  const document = {
    hidden: false,
    documentElement: {
      clientWidth: 1280,
      style: { setProperty: (k: string, v: string) => properties.set(k, v) },
    },
    body: { classList: { add() {}, remove() {} } },
    getElementById: (id: string) =>
      id === "field"
        ? { getContext: () => context }
        : {
            setAttribute() {},
            addEventListener: (_name: string, fn: () => void) => listeners.set("motion-toggle", fn),
          },
    addEventListener: (name: string, fn: (event?: unknown) => void) => listeners.set(name, fn),
  };
  const media = {
    matches: reduced,
    addEventListener: (_name: string, fn: () => void) => listeners.set("motion-change", fn),
  };
  runInNewContext(scriptOf(successPage()), {
    document,
    window: {
      innerHeight: 720,
      devicePixelRatio: 1,
      addEventListener: (name: string, fn: (event?: unknown) => void) => listeners.set(name, fn),
    },
    history: { replaceState: (...args: unknown[]) => history.push(args) },
    location: { pathname: "/auth/callback" },
    performance: { now: () => 0 },
    matchMedia: () => media,
    requestAnimationFrame: (fn: (time: number) => void) => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id: number) => scheduled.delete(id),
  });
  return {
    coordinates,
    properties,
    scheduled,
    listeners,
    history,
    document,
    media,
    tick(time = 16) {
      const [id, fn] = scheduled.entries().next().value!;
      scheduled.delete(id);
      fn(time);
    },
  };
}

describe("the page you land on after signing in", () => {
  test("states success and names the connected account without a logo", () => {
    const html = successPage("ChatGPT Plus / Pro");
    expect(html).toContain("Logged in<span>successfully.</span>");
    expect(html).toContain("<strong>ChatGPT Plus / Pro</strong> is now connected to Rune");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });

  test("needs no remote assets and only permits its own bundled script", () => {
    const html = successPage("OpenRouter");
    expect(/https?:\/\//.test(html)).toBe(false);
    const hash = createHash("sha256").update(scriptOf(html)).digest("base64");
    expect(html).toContain(`script-src 'sha256-${hash}'`);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  test("escapes provider text and preserves literal replacement characters", () => {
    const html = successPage('</strong><script>alert("x")</script>$&');
    expect(html).toContain(
      "&lt;/strong&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;$&amp;",
    );
    expect([...html.matchAll(/<script>/g)]).toHaveLength(1);
    expect(scriptOf(html)).toBe(scriptOf(successPage()));
  });

  test("defaults to an account label and keeps the requested light appearance", () => {
    expect(successPage()).toContain("Your account");
    expect(successPage()).toContain('name="color-scheme" content="light"');
  });

  test("renders a still field with reduced motion, and pauses while hidden", () => {
    const still = motionHarness(true);
    expect(still.coordinates.length).toBeGreaterThan(100);
    expect(still.scheduled.size).toBe(0);
    still.listeners.get("pointermove")!({ clientX: 100, clientY: 200 });
    expect(still.properties.size).toBe(0);
    const moving = motionHarness();
    expect(moving.scheduled.size).toBe(1);
    moving.document.hidden = true;
    moving.listeners.get("visibilitychange")!();
    expect(moving.scheduled.size).toBe(0);
    const pausable = motionHarness();
    pausable.listeners.get("motion-toggle")!();
    expect(pausable.scheduled.size).toBe(0);
    pausable.listeners.get("motion-toggle")!();
    expect(pausable.scheduled.size).toBe(1);
  });

  test("the pointer changes the field at the same animation time", () => {
    const resting = motionHarness();
    const interactive = motionHarness();
    interactive.listeners.get("pointermove")!({ clientX: 180, clientY: 270 });
    resting.tick();
    interactive.tick();
    expect(interactive.coordinates).not.toEqual(resting.coordinates);
    expect(interactive.properties.get("--pointer-x")).toBe("180px");
    expect(interactive.history[0]).toEqual([null, "", "/auth/callback"]);
  });
});
