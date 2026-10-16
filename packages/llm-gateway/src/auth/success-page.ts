import { createHash } from "crypto";

// This runs locally after credential storage. No assets, fonts, dependencies,
// analytics, or network requests are needed for the completion experience.
const MOTION = String.raw`(() => {
  "use strict";
  try { history.replaceState(null, "", location.pathname); } catch {}

  const canvas = document.getElementById("field");
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, active: false };
  const palette = ["69,88,145", "91,102,168", "124,105,170", "154,130,165"];
  let width = 0, height = 0, particles = [], frame = 0, last = 0, phase = 0, paused = false;
  let seed = 73129;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  function resize() {
    width = document.documentElement.clientWidth;
    height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 73129;
    const count = Math.min(2200, Math.round(width * height / 480));
    particles = Array.from({ length: count }, () => ({
      u: random() * Math.PI * 2,
      v: random() * Math.PI * 2,
      spread: 0.13 + random() * 0.22,
      size: 0.7 + random() * 1.6,
      speed: 0.6 + random() * 0.8,
      color: Math.floor(random() * palette.length),
      ox: 0, oy: 0
    }));
    pointer.x = pointer.targetX = width / 2;
    pointer.y = pointer.targetY = height / 2;
    start();
  }

  function draw(now) {
    frame = 0;
    const dt = last ? Math.min((now - last) / 1000, 0.04) : 0;
    last = now;
    if (!motion.matches && !paused) phase += dt;
    context.clearRect(0, 0, width, height);
    pointer.x += (pointer.targetX - pointer.x) * 0.075;
    pointer.y += (pointer.targetY - pointer.y) * 0.075;

    const rx = Math.min(width * 0.43, 670);
    const ry = Math.min(height * 0.39, 350);
    const cx = width / 2;
    const cy = height * 0.51;
    const parallaxX = pointer.active && !motion.matches && !paused ? (pointer.x / width - 0.5) : 0;
    const parallaxY = pointer.active && !motion.matches && !paused ? (pointer.y / height - 0.5) : 0;
    const influence = Math.min(width * 0.28, 210);

    for (const p of particles) {
      const u = p.u + phase * 0.075 * p.speed;
      const v = p.v + phase * 0.12;
      const band = 1 + Math.cos(v) * p.spread;
      const depth = Math.sin(v) * 0.55 + Math.sin(u) * 0.35;
      const perspective = 1 + depth * 0.14;
      let x = cx + (Math.cos(u) * rx * band + Math.sin(v) * rx * 0.08) * perspective;
      let y = cy + (Math.sin(u) * ry * band + Math.cos(u * 2 + v) * ry * 0.10) * perspective;
      x += parallaxX * (20 + depth * 35);
      y += parallaxY * (15 + depth * 25);

      let pushX = 0, pushY = 0;
      if (pointer.active && !motion.matches && !paused) {
        const dx = x - pointer.x, dy = y - pointer.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const pressure = Math.exp(-(distance * distance) / (influence * influence)) * 54;
        const ripple = Math.sin(distance * 0.035 - phase * 3) * pressure * 0.12;
        pushX = dx / distance * (pressure + ripple);
        pushY = dy / distance * (pressure + ripple);
      }
      p.ox += (pushX - p.ox) * 0.09;
      p.oy += (pushY - p.oy) * 0.09;
      x += p.ox; y += p.oy;
      const alpha = 0.12 + (depth + 0.9) / 1.8 * 0.53;
      const tangentX = -Math.sin(u), tangentY = Math.cos(u) * 0.7;
      const length = p.size * (1.2 + perspective);
      context.strokeStyle = "rgba(" + palette[p.color] + "," + alpha.toFixed(3) + ")";
      context.lineWidth = p.size * 0.64;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + tangentX * length, y + tangentY * length);
      context.stroke();
    }
    if (!motion.matches && !paused && !document.hidden) frame = requestAnimationFrame(draw);
  }

  function start() {
    cancelAnimationFrame(frame);
    frame = 0; last = 0;
    if (!document.hidden) draw(performance.now());
  }
  function move(event) {
    if (motion.matches || paused) return;
    pointer.targetX = event.clientX;
    pointer.targetY = event.clientY;
    pointer.active = true;
    document.body.classList.add("pointer-active");
    document.documentElement.style.setProperty("--pointer-x", event.clientX + "px");
    document.documentElement.style.setProperty("--pointer-y", event.clientY + "px");
  }
  function leave() {
    pointer.active = false;
    document.body.classList.remove("pointer-active");
  }
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerdown", move, { passive: true });
  document.addEventListener("pointerleave", leave);
  window.addEventListener("blur", leave);
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", start);
  motion.addEventListener("change", start);
  const toggle = document.getElementById("motion-toggle");
  toggle.addEventListener("click", () => {
    paused = !paused;
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "Resume motion" : "Pause motion";
    leave();
    start();
  });
  resize();
})();`;

const SCRIPT_HASH = createHash("sha256").update(MOTION).digest("base64");

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'">
<link rel="icon" href="data:,">
<title>Logged in successfully — Rune</title>
<style>
:root{color-scheme:light;--paper:#fbfcfd;--ink:#202328;--muted:#6c737e;--hairline:#e6e9ee}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--paper)}
body{min-height:100svh;color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
#field{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;animation:appear 2s ease both}
.pointer-glow{position:fixed;left:var(--pointer-x,50%);top:var(--pointer-y,50%);width:440px;height:440px;transform:translate(-50%,-50%);pointer-events:none;background:radial-gradient(circle,rgba(111,124,201,.055),transparent 68%);opacity:0;transition:opacity .6s ease}
.pointer-active .pointer-glow{opacity:1}
.veil{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 32% 29% at 50% 51%,var(--paper) 10%,rgba(251,252,253,.91) 52%,rgba(251,252,253,0) 100%)}
header{position:absolute;z-index:2;top:0;left:0;width:100%;padding:30px 38px;display:flex;justify-content:space-between;align-items:center;gap:18px}
.wordmark{font-size:24px;line-height:1;font-weight:620;letter-spacing:-.065em;animation:arrive .9s cubic-bezier(.2,.7,.2,1) both}
.header-note{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;color:#727a86}
main{position:relative;z-index:1;min-height:100svh;display:grid;place-items:center;padding:112px 24px 100px;text-align:center}
.message{width:min(100%,650px);animation:arrive 1.15s .12s cubic-bezier(.2,.7,.2,1) both}
.status{display:inline-flex;align-items:center;gap:9px;margin:0 0 26px;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#7a818d}
.status::before{content:"";width:6px;height:6px;border-radius:50%;background:#56836c;box-shadow:0 0 0 4px rgba(86,131,108,.075)}
h1{margin:0;font-size:clamp(46px,6.4vw,88px);line-height:1.04;letter-spacing:-.045em;word-spacing:.09em;font-weight:500}
h1 span{display:block;color:#7c828c}
.provider{margin:27px auto 0;max-width:470px;font-size:15px;line-height:1.7;color:var(--muted);overflow-wrap:anywhere}
.provider strong{color:#464b55;font-weight:500}
.return{display:inline-flex;align-items:center;gap:13px;margin-top:38px;padding:13px 18px;border:1px solid var(--hairline);border-radius:100px;background:rgba(251,252,253,.82);font-size:12px;line-height:1.5;color:#636a76}
.return span{height:15px;width:1px;background:#d9dde5}
.return strong{color:#303640;font-weight:500}
footer{position:absolute;z-index:2;bottom:0;left:0;width:100%;display:flex;justify-content:space-between;gap:24px;align-items:center;padding:28px 38px;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.01em;color:#737d8b}
.motion-controls{display:flex;align-items:center;gap:18px}
.motion-toggle{padding:3px 0;border:0;background:none;font:inherit;color:#65707f;cursor:pointer;text-decoration:underline;text-underline-offset:4px;text-decoration-color:#d2d7e0}
.motion-toggle:hover{color:#303640}
.motion-toggle:focus-visible{outline:2px solid #596780;outline-offset:5px}
.motion-note{display:flex;align-items:center;gap:8px}
.motion-note::before{content:"";height:3px;width:3px;border-radius:50%;background:currentColor}
@keyframes arrive{from{opacity:0;transform:translateY(14px);filter:blur(5px)}to{opacity:1;transform:none;filter:blur(0)}}
@keyframes appear{from{opacity:0}to{opacity:1}}
@media(max-width:600px){.motion-note{display:none}header{padding:25px 24px}.wordmark{font-size:23px}.header-note{font-size:9px}.status{margin-bottom:22px}h1{font-size:clamp(45px,11vw,66px)}.provider{max-width:300px;font-size:14px;margin-top:24px}.return{margin-top:29px;padding:12px 15px;font-size:11px;gap:10px}footer{padding:24px;font-size:9px}.veil{background:radial-gradient(ellipse 48% 30% at 50% 50%,var(--paper) 0%,rgba(251,252,253,.92) 52%,rgba(251,252,253,0) 100%)}}
@media(max-height:540px){main{padding:90px 24px 76px}h1{font-size:52px}.status{margin-bottom:16px}.provider{margin-top:16px}.return{margin-top:20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.pointer-glow,.motion-note,.motion-toggle{display:none}}
@media(pointer:coarse){.motion-note{display:none}}
</style>
</head>
<body>
<canvas id="field" aria-hidden="true"></canvas>
<div class="pointer-glow" aria-hidden="true"></div>
<div class="veil" aria-hidden="true"></div>
<header><div class="wordmark" aria-label="Rune">Rune</div><div class="header-note">Your workspace awaits</div></header>
<main><section class="message" aria-labelledby="success-title">
<p class="status">Connection established</p>
<h1 id="success-title">Logged in<span>successfully.</span></h1>
<p class="provider"><strong>__PROVIDER__</strong> is now connected to Rune.<br>You're ready to pick up where you left off.</p>
<div class="return"><strong>Return to your terminal</strong><span aria-hidden="true"></span>You can close this tab</div>
</section></main>
<footer><span>Ready when you are.</span><div class="motion-controls"><span class="motion-note">Move your pointer to explore</span><button class="motion-toggle" id="motion-toggle" type="button" aria-pressed="false" aria-controls="field">Pause motion</button></div></footer>
<script>${MOTION}</script>
</body>
</html>`;

/** A self-contained completion page. Provider text never enters script or CSS. */
export function successPage(providerLabel = "Your account"): string {
  const safe = providerLabel.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
  return PAGE.replace("__PROVIDER__", () => safe);
}
