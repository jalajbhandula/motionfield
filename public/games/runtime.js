/*
 * MotionField Games runtime — plays a GameSpec v1 (see src/lib/games/spec.ts)
 * on one <canvas>. Six genres share one loop, one input layer and one art
 * kit drawn entirely in code. Loaded by /api/games/<id>/play inside a
 * sandboxed iframe (allow-scripts only); it makes no network requests.
 * MIT, part of MotionField.
 */
(function () {
  "use strict";

  var W = 960, H = 540;
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");

  /* ------------------------------------------------------------ spec */

  var GENRES = ["platformer", "runner", "shooter", "adventure", "puzzle", "racer"];
  var THEMES = ["forest", "city", "space", "desert", "ocean", "cave", "snow", "neon"];
  var PLAYER_LOOKS = ["hero", "knight", "robot", "blob", "cat", "ship", "car", "wizard", "frog", "bird", "fish", "ninja"];
  var ENEMY_LOOKS = ["slime", "bat", "drone", "ghost", "spike", "rock", "car", "beetle"];
  var BEHAVIORS = ["patrol", "chase", "zigzag", "shoot", "fall"];
  var PICKUP_LOOKS = ["coin", "gem", "star", "heart", "bolt", "key", "fruit"];
  var GOALS = ["reach_end", "score", "survive", "collect"];

  function pick(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
  function num(v, lo, hi, d) { v = Number(v); if (!isFinite(v)) v = d; return Math.max(lo, Math.min(hi, Math.round(v))); }
  function str(v, max, d) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : d; }
  function col(v, d) { return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d; }

  function clampSpec(s) {
    s = s && typeof s === "object" ? s : {};
    var p = s.palette || {}, pl = s.player || {}, st = s.story || {}, g = s.goal || {}, pk = s.pickup || {};
    var en = Array.isArray(s.enemies) && s.enemies.length ? s.enemies.slice(0, 3) : [{}];
    return {
      genre: pick(s.genre, GENRES, "platformer"),
      title: str(s.title, 48, "Untitled Game"),
      tagline: str(s.tagline, 90, ""),
      story: { intro: str(st.intro, 240, ""), win: str(st.win, 120, "You win!"), lose: str(st.lose, 120, "Game over") },
      theme: pick(s.theme, THEMES, "forest"),
      palette: {
        sky: col(p.sky, "#8fd3ff"), ground: col(p.ground, "#3f7d3a"), player: col(p.player, "#ff6b3d"),
        enemy: col(p.enemy, "#7a3fa0"), pickup: col(p.pickup, "#ffd23f"), accent: col(p.accent, "#ffffff"),
      },
      player: {
        name: str(pl.name, 24, "Player"), look: pick(pl.look, PLAYER_LOOKS, "hero"),
        speed: num(pl.speed, 1, 10, 5), jump: num(pl.jump, 1, 10, 5), lives: num(pl.lives, 1, 5, 3),
      },
      enemies: en.map(function (e) {
        e = e || {};
        return { name: str(e.name, 24, "Enemy"), look: pick(e.look, ENEMY_LOOKS, "slime"), behavior: pick(e.behavior, BEHAVIORS, "patrol"), speed: num(e.speed, 1, 10, 4) };
      }),
      pickup: { name: str(pk.name, 24, "coin"), look: pick(pk.look, PICKUP_LOOKS, "coin") },
      goal: { kind: pick(g.kind, GOALS, "reach_end"), target: num(g.target, 1, 500, 1) },
      difficulty: num(s.difficulty, 1, 5, 2),
      length: num(s.length, 1, 5, 3),
      seed: num(s.seed, 0, 4294967295, 1),
    };
  }

  var raw = {};
  try { raw = JSON.parse(document.getElementById("spec").textContent || "{}"); } catch (e) { raw = {}; }
  var S = clampSpec(raw);

  /* ------------------------------------------------------------ utils */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(S.seed);
  function rr(a, b) { return a + rng() * (b - a); }
  function ri(a, b) { return Math.floor(rr(a, b + 1)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hit(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  function hexRgb(h) {
    var x = h.slice(1);
    if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
    var n = parseInt(x, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function shade(h, f) {
    var c = hexRgb(h);
    return rgb(f >= 0 ? [c[0] + (255 - c[0]) * f, c[1] + (255 - c[1]) * f, c[2] + (255 - c[2]) * f] : [c[0] * (1 + f), c[1] * (1 + f), c[2] * (1 + f)]);
  }
  function alpha(h, a) { var c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function luma(h) { var c = hexRgb(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }

  /* ------------------------------------------------------------ canvas fit */

  function fit() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var s = Math.min(window.innerWidth / W, window.innerHeight / H) || 1;
    canvas.style.width = Math.floor(W * s) + "px";
    canvas.style.height = Math.floor(H * s) + "px";
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", fit);
  fit();

  /* ------------------------------------------------------------ input */

  var keys = { left: false, right: false, up: false, down: false, action: false };
  var pressed = { action: false, up: false, start: false, restart: false, left: false, right: false, down: false };
  var KEYMAP = {
    ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
    ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
    Space: "action", KeyJ: "action", KeyK: "action",
  };
  window.addEventListener("keydown", function (e) {
    var k = KEYMAP[e.code];
    if (k) { if (!keys[k]) pressed[k] = true; keys[k] = true; e.preventDefault(); }
    if (e.code === "Space" || e.code === "Enter") pressed.start = true;
    if (e.code === "KeyR") pressed.restart = true;
    audioOn();
  });
  window.addEventListener("keyup", function (e) { var k = KEYMAP[e.code]; if (k) keys[k] = false; });
  window.addEventListener("blur", function () { keys.left = keys.right = keys.up = keys.down = keys.action = false; });

  // touch: on-screen pads (bottom-left steer, bottom-right action), taps elsewhere start
  var touchMode = false, pointers = {}, lastTap = null;
  function toLogical(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }
  var PADS = {
    left: { x: 70, y: H - 70, r: 44 }, right: { x: 180, y: H - 70, r: 44 },
    up: { x: W - 190, y: H - 70, r: 44 }, action: { x: W - 80, y: H - 70, r: 50 },
  };
  function padAt(p) {
    for (var k in PADS) if (dist(p.x, p.y, PADS[k].x, PADS[k].y) < PADS[k].r + 10) return k;
    return null;
  }
  function syncPads() {
    var on = { left: false, right: false, up: false, action: false };
    for (var id in pointers) { var k = pointers[id].pad; if (k) on[k] = true; }
    for (var k2 in on) { if (on[k2] && !keys[k2]) pressed[k2] = true; keys[k2] = on[k2]; }
  }
  canvas.addEventListener("pointerdown", function (e) {
    audioOn();
    var p = toLogical(e);
    if (e.pointerType === "touch") touchMode = true;
    var pad = touchMode && state === "play" && S.genre !== "puzzle" ? padAt(p) : null;
    pointers[e.pointerId] = { pad: pad, x: p.x, y: p.y };
    if (pad) syncPads(); else { lastTap = p; pressed.start = true; }
    // preventDefault (no touch scroll) also cancels the click's focus move,
    // which left keyboard players typing into the parent page - focus here
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    e.preventDefault();
  });
  function up(e) { delete pointers[e.pointerId]; syncPads(); }
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointermove", function (e) {
    var ptr = pointers[e.pointerId];
    if (!ptr) return;
    var p = toLogical(e); ptr.x = p.x; ptr.y = p.y;
    if (ptr.pad) { ptr.pad = padAt(p) || ptr.pad; syncPads(); }
  });

  /* ------------------------------------------------------------ sound */

  var actx = null;
  function audioOn() {
    if (actx) return;
    try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); } catch (e) { actx = null; }
  }
  function beep(f, d, type, v, slide) {
    if (!actx) return;
    try {
      var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = type || "square"; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f * slide), t + d);
      g.gain.setValueAtTime(v || 0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d + 0.02);
    } catch (e) { /* audio is optional */ }
  }
  var sfx = {
    jump: function () { beep(420, 0.16, "square", 0.05, 1.9); },
    coin: function () { beep(880, 0.07, "square", 0.05); setTimeout(function () { beep(1320, 0.1, "square", 0.045); }, 60); },
    hit: function () { beep(160, 0.3, "sawtooth", 0.07, 0.4); },
    shoot: function () { beep(760, 0.08, "square", 0.03, 0.5); },
    pop: function () { beep(300, 0.12, "triangle", 0.07, 2.2); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { beep(f, 0.18, "square", 0.05); }, i * 110); }); },
    lose: function () { [392, 330, 262].forEach(function (f, i) { setTimeout(function () { beep(f, 0.25, "triangle", 0.06); }, i * 160); }); },
  };

  /* ------------------------------------------------------------ art kit */

  var P = S.palette;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function eyes(cx, cy, gap, r, dir) {
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(cx - gap, cy, r, 0, 7); ctx.arc(cx + gap, cy, r, 0, 7); ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath(); ctx.arc(cx - gap + dir * r * 0.35, cy, r * 0.5, 0, 7); ctx.arc(cx + gap + dir * r * 0.35, cy, r * 0.5, 0, 7); ctx.fill();
  }
  function outline() { ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.stroke(); }

  /** player art centred on (x,y), size s (~box height), facing dir ±1; top-down looks point up */
  function drawPlayer(look, x, y, s, dir, t, c) {
    c = c || P.player;
    ctx.save(); ctx.translate(x, y);
    var bob = Math.sin(t * 10) * s * 0.03;
    if (look === "ship") {
      ctx.fillStyle = alpha(P.accent, 0.8);
      ctx.beginPath(); ctx.moveTo(-s * 0.18, s * 0.42); ctx.lineTo(0, s * (0.62 + Math.sin(t * 40) * 0.08)); ctx.lineTo(s * 0.18, s * 0.42); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, -s * 0.55); ctx.lineTo(s * 0.45, s * 0.45); ctx.lineTo(0, s * 0.25); ctx.lineTo(-s * 0.45, s * 0.45); ctx.closePath(); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.55); ctx.beginPath(); ctx.ellipse(0, -s * 0.08, s * 0.1, s * 0.2, 0, 0, 7); ctx.fill();
    } else if (look === "car") {
      ctx.fillStyle = "#111";
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) { roundRect(q[0] * s * 0.3 - s * 0.07, q[1] * s * 0.28 - s * 0.1, s * 0.14, s * 0.2, 3); ctx.fill(); });
      ctx.fillStyle = c; roundRect(-s * 0.3, -s * 0.5, s * 0.6, s, s * 0.14); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.6); roundRect(-s * 0.22, -s * 0.28, s * 0.44, s * 0.2, 4); ctx.fill();
      ctx.fillStyle = shade(c, -0.35); roundRect(-s * 0.22, s * 0.12, s * 0.44, s * 0.16, 4); ctx.fill();
      ctx.fillStyle = P.accent; ctx.fillRect(-s * 0.04, -s * 0.5, s * 0.08, s);
    } else if (look === "blob") {
      var sq = 1 + Math.sin(t * 8) * 0.06;
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, s * 0.1, s * 0.42 * sq, s * 0.4 / sq, 0, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.35); ctx.beginPath(); ctx.ellipse(-s * 0.15, -s * 0.08, s * 0.1, s * 0.07, -0.5, 0, 7); ctx.fill();
      eyes(dir * s * 0.06, 0, s * 0.13, s * 0.09, dir);
    } else if (look === "robot") {
      ctx.translate(0, bob);
      ctx.strokeStyle = shade(c, -0.4); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -s * 0.45); ctx.lineTo(0, -s * 0.6); ctx.stroke();
      ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(0, -s * 0.62, s * 0.06, 0, 7); ctx.fill();
      ctx.fillStyle = c; roundRect(-s * 0.28, -s * 0.46, s * 0.56, s * 0.36, 6); ctx.fill(); outline();
      ctx.fillStyle = shade(c, -0.25); roundRect(-s * 0.32, -s * 0.06, s * 0.64, s * 0.42, 6); ctx.fill(); outline();
      ctx.fillStyle = "#1b1b2a"; roundRect(-s * 0.2, -s * 0.38, s * 0.4, s * 0.16, 4); ctx.fill();
      ctx.fillStyle = P.accent; ctx.fillRect(-s * 0.13 + dir * s * 0.04, -s * 0.33, s * 0.08, s * 0.06); ctx.fillRect(s * 0.05 + dir * s * 0.04, -s * 0.33, s * 0.08, s * 0.06);
      ctx.fillStyle = shade(c, -0.45); ctx.fillRect(-s * 0.24, s * 0.36, s * 0.16, s * 0.14); ctx.fillRect(s * 0.08, s * 0.36, s * 0.16, s * 0.14);
    } else if (look === "cat") {
      ctx.translate(0, bob);
      ctx.strokeStyle = c; ctx.lineWidth = s * 0.08; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-dir * s * 0.3, s * 0.15); ctx.quadraticCurveTo(-dir * s * 0.55, -s * 0.05, -dir * s * 0.45, -s * 0.3); ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, s * 0.18, s * 0.32, s * 0.26, 0, 0, 7); ctx.fill(); outline();
      ctx.beginPath(); ctx.arc(dir * s * 0.1, -s * 0.16, s * 0.24, 0, 7); ctx.fill(); outline();
      ctx.beginPath(); ctx.moveTo(dir * s * 0.1 - s * 0.2, -s * 0.28); ctx.lineTo(dir * s * 0.1 - s * 0.12, -s * 0.5); ctx.lineTo(dir * s * 0.1 - s * 0.02, -s * 0.34); ctx.fill();
      ctx.beginPath(); ctx.moveTo(dir * s * 0.1 + s * 0.2, -s * 0.28); ctx.lineTo(dir * s * 0.1 + s * 0.12, -s * 0.5); ctx.lineTo(dir * s * 0.1 + s * 0.02, -s * 0.34); ctx.fill();
      eyes(dir * s * 0.14, -s * 0.18, s * 0.09, s * 0.06, dir);
    } else if (look === "wizard") {
      ctx.translate(0, bob);
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(-s * 0.32, s * 0.5); ctx.lineTo(0, -s * 0.15); ctx.lineTo(s * 0.32, s * 0.5); ctx.closePath(); ctx.fill(); outline();
      ctx.fillStyle = "#f2d0a9"; ctx.beginPath(); ctx.arc(0, -s * 0.15, s * 0.16, 0, 7); ctx.fill();
      ctx.fillStyle = shade(c, -0.3); ctx.beginPath(); ctx.moveTo(-s * 0.26, -s * 0.22); ctx.lineTo(dir * s * 0.12, -s * 0.66); ctx.lineTo(s * 0.26, -s * 0.22); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(dir * s * 0.36, s * 0.5); ctx.lineTo(dir * s * 0.36, -s * 0.3); ctx.stroke();
      ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(dir * s * 0.36, -s * 0.34, s * 0.07 + Math.sin(t * 6) * 2, 0, 7); ctx.fill();
      eyes(dir * s * 0.04, -s * 0.16, s * 0.06, s * 0.04, dir);
    } else if (look === "knight") {
      ctx.translate(0, bob);
      ctx.fillStyle = shade(c, -0.2); roundRect(-s * 0.26, -s * 0.04, s * 0.52, s * 0.46, 8); ctx.fill(); outline();
      ctx.fillStyle = "#c9ced6"; ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.24, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = "#2b2f3a"; ctx.fillRect(-s * 0.16 + dir * s * 0.05, -s * 0.24, s * 0.32, s * 0.07);
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(-s * 0.04, -s * 0.44); ctx.quadraticCurveTo(-dir * s * 0.3, -s * 0.6, -dir * s * 0.34, -s * 0.36); ctx.lineTo(s * 0.04, -s * 0.42); ctx.fill();
      ctx.strokeStyle = "#e8edf3"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(dir * s * 0.34, s * 0.2); ctx.lineTo(dir * s * 0.34, -s * 0.24); ctx.stroke();
      ctx.fillStyle = shade(c, -0.45); ctx.fillRect(-s * 0.22, s * 0.42, s * 0.16, s * 0.1); ctx.fillRect(s * 0.06, s * 0.42, s * 0.16, s * 0.1);
    } else if (look === "frog") {
      var hop = Math.abs(Math.sin(t * 9)) * s * 0.06;
      ctx.translate(0, -hop);
      ctx.fillStyle = shade(c, -0.25);
      ctx.beginPath(); ctx.ellipse(-s * 0.28, s * 0.36, s * 0.18, s * 0.09, 0, 0, 7); ctx.ellipse(s * 0.28, s * 0.36, s * 0.18, s * 0.09, 0, 0, 7); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, s * 0.12, s * 0.38, s * 0.3, 0, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.45); ctx.beginPath(); ctx.ellipse(0, s * 0.2, s * 0.24, s * 0.16, 0, 0, 7); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(-s * 0.17, -s * 0.16, s * 0.14, 0, 7); ctx.arc(s * 0.17, -s * 0.16, s * 0.14, 0, 7); ctx.fill(); outline();
      eyes(dir * s * 0.02, -s * 0.17, s * 0.17, s * 0.09, dir);
      ctx.strokeStyle = shade(c, -0.5); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(dir * s * 0.04, s * 0.04, s * 0.16, 0.25, Math.PI - 0.25); ctx.stroke();
    } else if (look === "bird") {
      var flap = Math.sin(t * 16) * 0.7;
      ctx.translate(0, bob);
      ctx.fillStyle = shade(c, -0.25); ctx.beginPath(); ctx.moveTo(-dir * s * 0.05, 0); ctx.quadraticCurveTo(-dir * s * 0.5, -s * (0.2 + flap * 0.3), -dir * s * 0.45, s * 0.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, s * 0.06, s * 0.32, s * 0.28, 0, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.5); ctx.beginPath(); ctx.ellipse(dir * s * 0.06, s * 0.14, s * 0.18, s * 0.14, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#ffb703"; ctx.beginPath(); ctx.moveTo(dir * s * 0.3, -s * 0.06); ctx.lineTo(dir * s * 0.5, 0); ctx.lineTo(dir * s * 0.3, s * 0.06); ctx.fill();
      ctx.fillStyle = shade(c, -0.35); ctx.beginPath(); ctx.moveTo(-dir * s * 0.1, -s * 0.24); ctx.lineTo(-dir * s * 0.02, -s * 0.38); ctx.lineTo(dir * s * 0.06, -s * 0.24); ctx.fill();
      eyes(dir * s * 0.14, -s * 0.06, s * 0.0, s * 0.07, dir);
    } else if (look === "fish") {
      var sw = Math.sin(t * 10) * 0.25;
      ctx.translate(0, bob);
      ctx.fillStyle = shade(c, -0.2); ctx.beginPath(); ctx.moveTo(-dir * s * 0.28, 0); ctx.lineTo(-dir * s * 0.55, -s * (0.22 + sw * 0.2)); ctx.lineTo(-dir * s * 0.55, s * (0.22 - sw * 0.2)); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, 0, s * 0.36, s * 0.26, 0, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.4); ctx.beginPath(); ctx.moveTo(-s * 0.06, -s * 0.26); ctx.quadraticCurveTo(-dir * s * 0.1, -s * 0.44, -dir * s * 0.24, -s * 0.2); ctx.fill();
      ctx.strokeStyle = shade(c, -0.35); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(dir * s * 0.02, 0, s * 0.16, -1, 1); ctx.stroke();
      eyes(dir * s * 0.18, -s * 0.06, 0, s * 0.07, dir);
    } else if (look === "ninja") {
      ctx.translate(0, bob);
      ctx.fillStyle = P.accent; ctx.beginPath(); ctx.moveTo(-dir * s * 0.12, -s * 0.28); ctx.quadraticCurveTo(-dir * s * 0.45, -s * 0.3 + Math.sin(t * 14) * 4, -dir * s * 0.5, -s * 0.18); ctx.lineTo(-dir * s * 0.12, -s * 0.22); ctx.fill();
      ctx.fillStyle = shade(c, -0.55); roundRect(-s * 0.22, -s * 0.04, s * 0.44, s * 0.44, 9); ctx.fill(); outline();
      ctx.fillStyle = c; ctx.fillRect(-s * 0.22, s * 0.12, s * 0.44, s * 0.06);
      ctx.fillStyle = shade(c, -0.55); ctx.beginPath(); ctx.arc(0, -s * 0.24, s * 0.21, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = "#f2d0a9"; roundRect(-s * 0.15 + dir * s * 0.04, -s * 0.3, s * 0.3, s * 0.1, 4); ctx.fill();
      ctx.fillStyle = "#111"; ctx.fillRect(-s * 0.08 + dir * s * 0.07, -s * 0.27, s * 0.05, s * 0.05); ctx.fillRect(s * 0.04 + dir * s * 0.07, -s * 0.27, s * 0.05, s * 0.05);
      ctx.fillStyle = shade(c, -0.6); ctx.fillRect(-s * 0.2, s * 0.4, s * 0.15, s * 0.1); ctx.fillRect(s * 0.05, s * 0.4, s * 0.15, s * 0.1);
    } else { // hero
      ctx.translate(0, bob);
      ctx.fillStyle = P.accent; ctx.beginPath(); ctx.moveTo(-dir * s * 0.1, -s * 0.05); ctx.quadraticCurveTo(-dir * s * 0.5, s * 0.05 + Math.sin(t * 12) * 4, -dir * s * 0.42, s * 0.3); ctx.lineTo(-dir * s * 0.05, s * 0.2); ctx.fill();
      ctx.fillStyle = c; roundRect(-s * 0.24, -s * 0.06, s * 0.48, s * 0.46, 10); ctx.fill(); outline();
      ctx.fillStyle = "#f2d0a9"; ctx.beginPath(); ctx.arc(dir * s * 0.03, -s * 0.24, s * 0.22, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = shade(c, -0.4); ctx.beginPath(); ctx.arc(dir * s * 0.03, -s * 0.3, s * 0.22, Math.PI, 0); ctx.fill();
      eyes(dir * s * 0.09, -s * 0.22, s * 0.08, s * 0.055, dir);
      ctx.fillStyle = shade(c, -0.45); ctx.fillRect(-s * 0.2, s * 0.4, s * 0.15, s * 0.1); ctx.fillRect(s * 0.05, s * 0.4, s * 0.15, s * 0.1);
    }
    ctx.restore();
  }

  function drawEnemy(look, x, y, s, dir, t, c) {
    c = c || P.enemy;
    ctx.save(); ctx.translate(x, y);
    if (look === "bat") {
      var f = Math.sin(t * 18) * 0.6;
      ctx.fillStyle = shade(c, -0.25);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-s * 0.4, -s * (0.4 + f * 0.4), -s * 0.65, s * 0.05); ctx.quadraticCurveTo(-s * 0.35, -s * 0.05, 0, s * 0.12); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(s * 0.4, -s * (0.4 + f * 0.4), s * 0.65, s * 0.05); ctx.quadraticCurveTo(s * 0.35, -s * 0.05, 0, s * 0.12); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, 7); ctx.fill(); outline();
      eyes(0, -s * 0.02, s * 0.08, s * 0.06, dir);
    } else if (look === "drone") {
      ctx.strokeStyle = shade(c, -0.4); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-s * 0.45, -s * 0.2); ctx.lineTo(s * 0.45, -s * 0.2); ctx.stroke();
      ctx.fillStyle = alpha(P.accent, 0.5);
      ctx.beginPath(); ctx.ellipse(-s * 0.45, -s * 0.24, s * 0.2 * Math.abs(Math.sin(t * 30)) + 2, 3, 0, 0, 7); ctx.ellipse(s * 0.45, -s * 0.24, s * 0.2 * Math.abs(Math.cos(t * 30)) + 2, 3, 0, 0, 7); ctx.fill();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, 7); ctx.fill(); outline();
      ctx.fillStyle = "#151520"; ctx.beginPath(); ctx.arc(0, 0, s * 0.16, 0, 7); ctx.fill();
      ctx.fillStyle = "#ff3b3b"; ctx.beginPath(); ctx.arc(dir * s * 0.04, 0, s * 0.07, 0, 7); ctx.fill();
    } else if (look === "ghost") {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = shade(c, 0.35);
      ctx.beginPath(); ctx.arc(0, -s * 0.08, s * 0.34, Math.PI, 0);
      for (var i = 0; i <= 4; i++) ctx.lineTo(s * 0.34 - i * s * 0.17, s * 0.32 + (i % 2 ? -1 : 1) * s * 0.06 * Math.sin(t * 8 + i));
      ctx.closePath(); ctx.fill(); outline();
      ctx.globalAlpha = 1; eyes(dir * s * 0.05, -s * 0.1, s * 0.11, s * 0.08, dir);
    } else if (look === "spike") {
      ctx.fillStyle = c;
      ctx.beginPath();
      for (var k = 0; k < 3; k++) { var bx = -s * 0.45 + k * s * 0.3; ctx.moveTo(bx, s * 0.4); ctx.lineTo(bx + s * 0.15, -s * 0.35); ctx.lineTo(bx + s * 0.3, s * 0.4); }
      ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.5); ctx.beginPath(); ctx.moveTo(-s * 0.3, -s * 0.35); ctx.lineTo(-s * 0.27, -s * 0.1); ctx.lineTo(-s * 0.33, -s * 0.1); ctx.fill();
    } else if (look === "rock") {
      ctx.rotate(t * 0.8 * dir);
      ctx.fillStyle = shade(c, -0.15);
      ctx.beginPath();
      for (var j = 0; j < 8; j++) { var a = j / 8 * Math.PI * 2, rad = s * (0.36 + ((j * 37) % 5) * 0.025); ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); }
      ctx.closePath(); ctx.fill(); outline();
      ctx.fillStyle = shade(c, -0.4); ctx.beginPath(); ctx.arc(s * 0.1, -s * 0.08, s * 0.08, 0, 7); ctx.arc(-s * 0.12, s * 0.12, s * 0.06, 0, 7); ctx.fill();
    } else if (look === "car") {
      drawPlayer("car", 0, 0, s, dir, t, c);
    } else if (look === "beetle") {
      ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 2.5;
      for (var l = -1; l <= 1; l++) { var w = Math.sin(t * 16 + l) * 3; ctx.beginPath(); ctx.moveTo(-s * 0.3, l * s * 0.14); ctx.lineTo(-s * 0.48, l * s * 0.2 + w); ctx.moveTo(s * 0.3, l * s * 0.14); ctx.lineTo(s * 0.48, l * s * 0.2 - w); ctx.stroke(); }
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, s * 0.04, s * 0.32, s * 0.36, 0, 0, 7); ctx.fill(); outline();
      ctx.strokeStyle = shade(c, -0.4); ctx.beginPath(); ctx.moveTo(0, -s * 0.3); ctx.lineTo(0, s * 0.4); ctx.stroke();
      ctx.fillStyle = shade(c, -0.35); ctx.beginPath(); ctx.arc(0, -s * 0.32, s * 0.16, 0, 7); ctx.fill();
      eyes(0, -s * 0.36, s * 0.07, s * 0.05, dir);
    } else { // slime
      var sq2 = 1 + Math.sin(t * 7) * 0.08;
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(-s * 0.42 * sq2, s * 0.32);
      ctx.quadraticCurveTo(-s * 0.42 * sq2, -s * 0.36 / sq2, 0, -s * 0.36 / sq2); ctx.quadraticCurveTo(s * 0.42 * sq2, -s * 0.36 / sq2, s * 0.42 * sq2, s * 0.32);
      ctx.closePath(); ctx.fill(); outline();
      ctx.fillStyle = shade(c, 0.4); ctx.beginPath(); ctx.ellipse(-s * 0.16, -s * 0.12, s * 0.08, s * 0.05, -0.6, 0, 7); ctx.fill();
      eyes(dir * s * 0.05, -s * 0.02, s * 0.12, s * 0.08, dir);
    }
    ctx.restore();
  }

  function drawPickup(look, x, y, s, t, c) {
    c = c || P.pickup;
    ctx.save(); ctx.translate(x, y + Math.sin(t * 4 + x * 0.05) * 3);
    ctx.shadowColor = alpha(c, 0.8); ctx.shadowBlur = 10;
    ctx.fillStyle = c;
    if (look === "gem") {
      ctx.beginPath(); ctx.moveTo(0, -s * 0.5); ctx.lineTo(s * 0.4, -s * 0.1); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.4, -s * 0.1); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = shade(c, 0.55); ctx.beginPath(); ctx.moveTo(0, -s * 0.5); ctx.lineTo(s * 0.12, -s * 0.1); ctx.lineTo(-s * 0.4, -s * 0.1); ctx.fill();
    } else if (look === "star") {
      ctx.rotate(t * 1.5);
      ctx.beginPath();
      for (var i = 0; i < 10; i++) { var r = i % 2 ? s * 0.22 : s * 0.5, a = i / 10 * Math.PI * 2 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
    } else if (look === "heart") {
      ctx.beginPath(); ctx.moveTo(0, s * 0.42);
      ctx.bezierCurveTo(-s * 0.6, 0, -s * 0.35, -s * 0.5, 0, -s * 0.18); ctx.bezierCurveTo(s * 0.35, -s * 0.5, s * 0.6, 0, 0, s * 0.42); ctx.fill();
    } else if (look === "bolt") {
      ctx.beginPath(); ctx.moveTo(s * 0.12, -s * 0.5); ctx.lineTo(-s * 0.28, s * 0.06); ctx.lineTo(-s * 0.02, s * 0.06); ctx.lineTo(-s * 0.12, s * 0.5); ctx.lineTo(s * 0.28, -s * 0.06); ctx.lineTo(s * 0.02, -s * 0.06); ctx.closePath(); ctx.fill();
    } else if (look === "key") {
      ctx.beginPath(); ctx.arc(-s * 0.18, 0, s * 0.18, 0, 7); ctx.fill();
      ctx.fillRect(-s * 0.04, -s * 0.06, s * 0.5, s * 0.12); ctx.fillRect(s * 0.3, 0, s * 0.08, s * 0.18); ctx.fillRect(s * 0.16, 0, s * 0.08, s * 0.14);
      ctx.shadowBlur = 0; ctx.fillStyle = shade(c, -0.4); ctx.beginPath(); ctx.arc(-s * 0.18, 0, s * 0.07, 0, 7); ctx.fill();
    } else if (look === "fruit") {
      ctx.beginPath(); ctx.arc(0, s * 0.06, s * 0.36, 0, 7); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = "#3d9a3a"; ctx.beginPath(); ctx.ellipse(s * 0.12, -s * 0.34, s * 0.14, s * 0.07, -0.6, 0, 7); ctx.fill();
      ctx.fillStyle = shade(c, 0.5); ctx.beginPath(); ctx.arc(-s * 0.12, -s * 0.06, s * 0.08, 0, 7); ctx.fill();
    } else { // coin
      var sx = Math.abs(Math.cos(t * 3 + x * 0.02));
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.4 * Math.max(0.15, sx), s * 0.4, 0, 0, 7); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = shade(c, -0.25); ctx.beginPath(); ctx.ellipse(0, 0, s * 0.24 * Math.max(0.1, sx), s * 0.24, 0, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ backgrounds */

  var BG = { stars: [], flakes: [], bubbles: [] };
  (function seedBg() {
    var r = mulberry32(S.seed ^ 0x9e3779b9);
    for (var i = 0; i < 120; i++) BG.stars.push({ x: r() * W, y: r() * H, s: r() * 1.8 + 0.4, p: r() * 6 });
    for (var j = 0; j < 70; j++) BG.flakes.push({ x: r() * W, y: r() * H, s: r() * 2.5 + 1, v: r() * 30 + 20 });
    for (var k = 0; k < 30; k++) BG.bubbles.push({ x: r() * W, y: r() * H, s: r() * 5 + 2, v: r() * 30 + 15 });
  })();

  function skyGradient() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    var dark = luma(P.sky) < 0.35;
    g.addColorStop(0, dark ? shade(P.sky, -0.3) : shade(P.sky, -0.15));
    g.addColorStop(1, dark ? shade(P.sky, 0.15) : shade(P.sky, 0.45));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  /** side-view parallax backdrop; cam = world x of the left screen edge */
  function drawSideBackground(cam, t) {
    skyGradient();
    var th = S.theme, gnd = P.ground;
    function layer(f, draw) { ctx.save(); draw(-((cam * f) % W)); ctx.restore(); }
    if (th === "space" || th === "neon" || th === "cave") {
      BG.stars.forEach(function (s) {
        ctx.fillStyle = "rgba(255,255,255," + (0.35 + 0.35 * Math.sin(t * 2 + s.p)) + ")";
        var x = ((s.x - cam * 0.05) % W + W) % W; ctx.fillRect(x, s.y * 0.7, s.s, s.s);
      });
    }
    if (th === "space") {
      ctx.fillStyle = alpha(P.accent, 0.18); ctx.beginPath(); ctx.arc(760 - cam * 0.02 % 200, 130, 70, 0, 7); ctx.fill();
      ctx.strokeStyle = alpha(P.accent, 0.3); ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(760 - cam * 0.02 % 200, 130, 110, 18, -0.3, 0, 7); ctx.stroke();
      layer(0.25, function (o) { ctx.fillStyle = shade(gnd, -0.3); for (var i = -1; i < 4; i++) { ctx.beginPath(); ctx.arc(o + i * 320 + 160, H - 60, 140, Math.PI, 0); ctx.fill(); } });
    } else if (th === "neon") {
      ctx.fillStyle = alpha(P.enemy, 0.85);
      var sunY = H * 0.42; ctx.beginPath(); ctx.arc(W * 0.5, sunY, 110, Math.PI, 0); ctx.fill();
      ctx.fillStyle = shade(P.sky, -0.2); for (var b = 0; b < 5; b++) ctx.fillRect(W * 0.5 - 115, sunY - 70 + b * 14, 230, 3 + b);
      ctx.strokeStyle = alpha(P.player, 0.5); ctx.lineWidth = 1.5;
      for (var gx = -10; gx <= 10; gx++) { ctx.beginPath(); ctx.moveTo(W / 2 + gx * 40 - ((cam * 0.6) % 40), sunY); ctx.lineTo(W / 2 + gx * 160 - ((cam * 2.4) % 160), H); ctx.stroke(); }
      for (var gy = 0; gy < 8; gy++) { var yy = sunY + Math.pow(gy / 8, 2) * (H - sunY); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke(); }
    } else if (th === "city") {
      layer(0.15, function (o) { ctx.fillStyle = alpha(shade(gnd, -0.2), 0.55); for (var i = -1; i < 12; i++) { var h = 120 + ((i * 53) % 7) * 22; ctx.fillRect(o + i * 90, H - 120 - h, 80, h + 120); } });
      layer(0.35, function (o) {
        for (var i = -1; i < 9; i++) {
          var h = 160 + ((i * 71) % 5) * 30, x = o + i * 130;
          ctx.fillStyle = shade(gnd, -0.05); ctx.fillRect(x, H - 100 - h, 110, h + 100);
          ctx.fillStyle = alpha("#ffe9a8", 0.6);
          for (var wy = 0; wy < h - 20; wy += 26) for (var wx = 10; wx < 100; wx += 24) if (((i + wx + wy) * 13) % 5 > 1) ctx.fillRect(x + wx, H - 90 - h + wy, 12, 14);
        }
      });
    } else if (th === "desert") {
      ctx.fillStyle = alpha("#fff4c2", 0.9); ctx.beginPath(); ctx.arc(780, 110, 60, 0, 7); ctx.fill();
      layer(0.2, function (o) { ctx.fillStyle = shade(gnd, 0.2); ctx.beginPath(); ctx.moveTo(o, H); for (var x = 0; x <= W * 2; x += 40) ctx.lineTo(o + x, H - 170 - Math.sin(x * 0.006) * 50); ctx.lineTo(o + W * 2, H); ctx.fill(); });
      layer(0.45, function (o) { ctx.fillStyle = "#2f7d4a"; for (var i = 0; i < 6; i++) { var x = o + i * 220 + 60; ctx.fillRect(x, H - 200, 16, 90); ctx.fillRect(x - 16, H - 180, 16, 10); ctx.fillRect(x - 16, H - 200, 8, 28); ctx.fillRect(x + 16, H - 170, 14, 10); ctx.fillRect(x + 22, H - 190, 8, 28); } });
    } else if (th === "ocean") {
      ctx.fillStyle = alpha("#ffffff", 0.08);
      for (var ray = 0; ray < 6; ray++) { ctx.beginPath(); ctx.moveTo(100 + ray * 160 + Math.sin(t + ray) * 20, 0); ctx.lineTo(160 + ray * 160, 0); ctx.lineTo(60 + ray * 160, H); ctx.lineTo(0 + ray * 160, H); ctx.fill(); }
      BG.bubbles.forEach(function (b) { var y = ((b.y - t * b.v) % H + H) % H; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.arc(((b.x - cam * 0.2) % W + W) % W, y, b.s, 0, 7); ctx.stroke(); });
      layer(0.4, function (o) { ctx.strokeStyle = "#2a9d63"; ctx.lineWidth = 6; ctx.lineCap = "round"; for (var i = 0; i < 10; i++) { var x = o + i * 110 + 30; ctx.beginPath(); ctx.moveTo(x, H); ctx.quadraticCurveTo(x + Math.sin(t * 2 + i) * 18, H - 80, x + Math.sin(t * 2 + i) * 10, H - 150); ctx.stroke(); } });
    } else if (th === "cave") {
      layer(0.3, function (o) { ctx.fillStyle = shade(gnd, -0.35); for (var i = -1; i < 14; i++) { var x = o + i * 80, h = 50 + ((i * 29) % 4) * 25; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 40, h); ctx.lineTo(x + 80, 0); ctx.fill(); } });
      layer(0.5, function (o) { for (var i = 0; i < 7; i++) { var x = o + i * 170 + 50; ctx.fillStyle = alpha(P.pickup, 0.35 + 0.2 * Math.sin(t * 3 + i)); ctx.beginPath(); ctx.moveTo(x, H - 110); ctx.lineTo(x + 10, H - 150); ctx.lineTo(x + 20, H - 110); ctx.fill(); } });
    } else if (th === "snow") {
      layer(0.15, function (o) {
        for (var i = -1; i < 6; i++) {
          var x = o + i * 260;
          ctx.fillStyle = shade(P.sky, -0.25); ctx.beginPath(); ctx.moveTo(x, H - 90); ctx.lineTo(x + 130, H - 330); ctx.lineTo(x + 260, H - 90); ctx.fill();
          ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.moveTo(x + 92, H - 260); ctx.lineTo(x + 130, H - 330); ctx.lineTo(x + 168, H - 260); ctx.lineTo(x + 140, H - 272); ctx.lineTo(x + 120, H - 256); ctx.fill();
        }
      });
      BG.flakes.forEach(function (f) { var y = ((f.y + t * f.v) % H + H) % H; ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.arc(((f.x + Math.sin(t + f.y) * 10 - cam * 0.3) % W + W) % W, y, f.s, 0, 7); ctx.fill(); });
    } else { // forest
      layer(0.15, function (o) { ctx.fillStyle = shade(gnd, 0.25); for (var i = -1; i < 6; i++) { ctx.beginPath(); ctx.ellipse(o + i * 260 + 130, H - 90, 200, 150, 0, Math.PI, 0); ctx.fill(); } });
      layer(0.4, function (o) {
        for (var i = -1; i < 12; i++) {
          var x = o + i * 95 + 20, h = 110 + ((i * 41) % 4) * 25;
          ctx.fillStyle = "#6b4a2b"; ctx.fillRect(x + 18, H - 100 - h * 0.35, 12, h * 0.35 + 10);
          ctx.fillStyle = shade(gnd, -0.15); ctx.beginPath(); ctx.moveTo(x - 10, H - 90 - h * 0.3); ctx.lineTo(x + 24, H - 100 - h); ctx.lineTo(x + 58, H - 90 - h * 0.3); ctx.fill();
        }
      });
    }
  }

  /* ------------------------------------------------------------ fx */

  var parts = [];
  function burst(x, y, c, n, sp) {
    for (var i = 0; i < (n || 12); i++) {
      var a = rng() * Math.PI * 2, v = (sp || 160) * (0.4 + rng());
      parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + rng() * 0.4, c: c, s: 2 + rng() * 3 });
    }
  }
  var floats = [];
  function floatText(x, y, txt, c) { floats.push({ x: x, y: y, t: txt, c: c || P.accent, life: 0.9 }); }
  function updateFx(dt) {
    parts = parts.filter(function (p) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; return p.life > 0; });
    floats = floats.filter(function (f) { f.life -= dt; f.y -= 40 * dt; return f.life > 0; });
  }
  function drawFx(camX, camY) {
    camX = camX || 0; camY = camY || 0;
    parts.forEach(function (p) { ctx.globalAlpha = Math.min(1, p.life * 2); ctx.fillStyle = p.c; ctx.fillRect(p.x - camX, p.y - camY, p.s, p.s); });
    ctx.globalAlpha = 1;
    ctx.font = "bold 18px system-ui, sans-serif"; ctx.textAlign = "center";
    floats.forEach(function (f) { ctx.globalAlpha = Math.min(1, f.life * 2); ctx.fillStyle = "#000"; ctx.fillText(f.t, f.x - camX + 1, f.y - camY + 1); ctx.fillStyle = f.c; ctx.fillText(f.t, f.x - camX, f.y - camY); });
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------ shared game state */

  var state = "title", score = 0, lives = S.player.lives, elapsed = 0, collected = 0, shake = 0, flash = 0;
  var G = null; // the active genre module
  var D = S.difficulty, L = S.length;
  var speedF = 0.75 + S.player.speed * 0.06; // 0.81 … 1.35
  var jumpF = 0.85 + S.player.jump * 0.035;  // 0.885 … 1.2

  function enemyDef(i) { return S.enemies[i % S.enemies.length]; }
  function enemySpeed(e) { return 0.6 + e.speed * 0.09 + (D - 1) * 0.06; }

  function addScore(n, x, y) { score += n; if (x !== undefined) floatText(x, y, "+" + n); }
  function hurt() {
    if (state !== "play") return false;
    lives -= 1; shake = 0.3; flash = 0.25; sfx.hit();
    if (lives <= 0) { end(false); return true; }
    return false;
  }
  function end(won) {
    if (state !== "play") return;
    state = won ? "win" : "lose";
    if (won) { sfx.win(); addScore(lives * 25); } else sfx.lose();
    report(state);
  }
  function report(ev) {
    window.__ofGame = { state: state, score: score, genre: S.genre, lives: lives, collected: collected };
    try { window.parent.postMessage({ type: "motionfield-game-event", event: ev, score: score, state: state }, "*"); } catch (e) { /* no parent */ }
  }

  /** goal check shared by genres that don't own a finish line */
  function goalMet() {
    var g = S.goal;
    if (g.kind === "score") return score >= g.target;
    if (g.kind === "survive") return elapsed >= g.target;
    if (g.kind === "collect") return collected >= G.collectTarget;
    return false;
  }
  function goalText() {
    var g = S.goal;
    if (g.kind === "score") return "Score " + score + " / " + g.target;
    if (g.kind === "survive") return "Survive " + Math.max(0, Math.ceil(g.target - elapsed)) + "s";
    if (g.kind === "collect") return cap(S.pickup.name) + " " + collected + " / " + G.collectTarget;
    return G.progressText ? G.progressText() : "";
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ------------------------------------------------------------ genre: platformer */

  function Platformer() {
    var GRAV = 2300, RUN = 300 * speedF, JUMP = 820 * jumpF;
    var air = 2 * JUMP / GRAV, reach = RUN * air;
    var maxGap = Math.min(reach * 0.62, 230), groundY = H - 80;
    var len = 2600 + L * 1500;
    var solids = [], foes = [], items = [], shots = [], x = 0;
    solids.push({ x: -200, y: groundY, w: 900, h: 200 });
    x = 700;
    while (x < len - 500) {
      var gap = rr(60, maxGap * (0.65 + D * 0.07));
      x += gap;
      var w = rr(260, 620) - D * 25;
      var seg = { x: x, y: groundY - (rng() < 0.3 ? ri(1, 2) * 40 : 0), w: w, h: 300 };
      solids.push(seg);
      if (rng() < 0.55) {
        var pw = rr(110, 180), py = seg.y - rr(100, Math.min(150, JUMP * JUMP / (2 * GRAV) - 20));
        var plat = { x: seg.x + rr(20, Math.max(30, w - pw - 20)), y: py, w: pw, h: 18, thin: true };
        solids.push(plat);
        for (var c = 0; c < 3; c++) items.push({ x: plat.x + 20 + c * (pw - 40) / 2, y: plat.y - 34, got: false });
      }
      for (var k = 0; k < 3; k++) items.push({ x: seg.x + 40 + k * 46, y: seg.y - 40, got: false });
      if (rng() < 0.35 + D * 0.1 && w > 240) {
        var ed = enemyDef(ri(0, 9)), es = enemySpeed(ed);
        var flying = ed.behavior === "zigzag";
        foes.push({ def: ed, x: seg.x + w * 0.6, y: flying ? seg.y - 130 : seg.y - 34, w: 34, h: 34, vx: (rng() < 0.5 ? -1 : 1) * 70 * es, min: seg.x + 8, max: seg.x + w - 42, base: seg.y - 130, ph: rng() * 6, cd: rr(1, 2.5), alive: true, top: seg.y, fallen: false });
      }
      x += w;
    }
    x += rr(60, maxGap * 0.6);
    solids.push({ x: x, y: groundY, w: 900, h: 200 });
    var flagX = x + 380;
    len = x + 900;
    var collectTarget = Math.min(S.goal.target, Math.floor(items.length * 0.7));
    var p = { x: 80, y: groundY - 60, w: 30, h: 46, vx: 0, vy: 0, ground: false, dir: 1, inv: 0, coyote: 0, buf: 0 };
    var safe = { x: 80, y: groundY - 60 }, cam = 0;

    function collide(axis, prevBottom) {
      for (var i = 0; i < solids.length; i++) {
        var s = solids[i];
        if (!hit(p, s)) continue;
        if (axis === "x") {
          if (s.thin) continue;
          if (p.vx > 0) p.x = s.x - p.w; else if (p.vx < 0) p.x = s.x + s.w;
          p.vx = 0;
        } else {
          if (p.vy > 0 && (!s.thin || prevBottom <= s.y + 2)) { p.y = s.y - p.h; p.vy = 0; p.ground = true; }
          else if (p.vy < 0 && !s.thin) { p.y = s.y + s.h; p.vy = 0; }
        }
      }
    }

    return {
      collectTarget: collectTarget,
      progressText: function () { return "Distance " + Math.min(100, Math.floor(p.x / flagX * 100)) + "%"; },
      update: function (dt) {
        var mv = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        if (mv) p.dir = mv;
        p.vx += (mv * RUN - p.vx) * Math.min(1, dt * (p.ground ? 14 : 6));
        if (pressed.up || pressed.action) p.buf = 0.12;
        p.buf -= dt; p.coyote -= dt;
        if (p.ground) p.coyote = 0.1;
        if (p.buf > 0 && p.coyote > 0) { p.vy = -JUMP; p.buf = 0; p.coyote = 0; sfx.jump(); }
        if (!(keys.up || keys.action) && p.vy < -JUMP * 0.45) p.vy = -JUMP * 0.45;
        p.vy = Math.min(p.vy + GRAV * dt, 1400);
        p.x += p.vx * dt; collide("x");
        var prevBottom = p.y + p.h;
        p.ground = false; p.y += p.vy * dt; collide("y", prevBottom);
        if (p.x < 0) p.x = 0;
        if (p.ground) safe = { x: p.x, y: p.y };
        if (p.inv > 0) p.inv -= dt;
        if (p.y > H + 120) {
          if (!hurt()) { p.x = Math.max(0, safe.x - 40); p.y = safe.y - 80; p.vx = 0; p.vy = 0; p.inv = 1.5; }
        }
        items.forEach(function (it) {
          if (!it.got && dist(p.x + p.w / 2, p.y + p.h / 2, it.x, it.y) < 30) { it.got = true; collected++; addScore(10, it.x, it.y - 10); sfx.coin(); burst(it.x, it.y, P.pickup, 8, 120); }
        });
        foes.forEach(function (f) {
          if (!f.alive) return;
          var b = f.def.behavior;
          f.ph += dt;
          if (b === "chase" && Math.abs(f.x - p.x) < 340) f.vx = Math.sign(p.x - f.x || 1) * Math.abs(f.vx);
          if (b === "zigzag") { f.x += f.vx * dt; f.y = f.base + Math.sin(f.ph * 3) * 40; if (f.x < f.min || f.x > f.max) f.vx *= -1; }
          else if (b === "fall") {
            if (!f.fallen && Math.abs(p.x - f.x) < 140) f.fallen = true;
            if (f.fallen) { f.vy = (f.vy || 0) + GRAV * 0.5 * dt; f.y += f.vy * dt; if (f.y > f.top - f.h) { f.y = f.top - f.h; f.vy = 0; f.x += f.vx * 0.6 * dt; if (f.x < f.min || f.x > f.max) f.vx *= -1; } }
            else f.y = f.top - 260;
          } else if (b === "shoot") {
            f.cd -= dt;
            if (f.cd <= 0 && Math.abs(f.x - p.x) < 520) { f.cd = 2.6 - D * 0.25; var a = Math.atan2(p.y - f.y, p.x - f.x); shots.push({ x: f.x + 17, y: f.y + 12, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240, life: 3 }); }
          } else { f.x += f.vx * dt; if (f.x < f.min || f.x > f.max) { f.vx *= -1; f.x = clamp(f.x, f.min, f.max); } }
          if (p.inv <= 0 && hit(p, f)) {
            var stompable = f.def.look !== "spike" && f.def.look !== "rock";
            if (stompable && p.vy > 0 && p.y + p.h - f.y < 22) { f.alive = false; p.vy = -JUMP * 0.6; addScore(50, f.x, f.y); sfx.pop(); burst(f.x + 17, f.y + 17, P.enemy, 16); }
            else if (!hurt()) { p.inv = 1.5; p.vy = -JUMP * 0.5; p.vx = -p.dir * 250; }
          }
        });
        shots = shots.filter(function (s) {
          s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
          if (p.inv <= 0 && dist(s.x, s.y, p.x + p.w / 2, p.y + p.h / 2) < 22) { if (!hurt()) p.inv = 1.5; return false; }
          return s.life > 0;
        });
        cam += (clamp(p.x - W * 0.35, 0, len - W) - cam) * Math.min(1, dt * 8);
        if (S.goal.kind === "reach_end" ? p.x > flagX : goalMet()) end(true);
      },
      draw: function (t) {
        drawSideBackground(cam, t);
        ctx.save(); ctx.translate(-Math.round(cam), 0);
        solids.forEach(function (s) {
          if (s.x + s.w < cam - 20 || s.x > cam + W + 20) return;
          if (s.thin) {
            ctx.fillStyle = shade(P.ground, -0.2); roundRect(s.x, s.y, s.w, s.h, 8); ctx.fill();
            ctx.fillStyle = shade(P.ground, 0.25); roundRect(s.x, s.y, s.w, 6, 4); ctx.fill();
          } else {
            ctx.fillStyle = shade(P.ground, -0.3); ctx.fillRect(s.x, s.y + 12, s.w, s.h);
            ctx.fillStyle = P.ground; ctx.fillRect(s.x, s.y, s.w, 16);
            ctx.fillStyle = shade(P.ground, 0.3); ctx.fillRect(s.x, s.y, s.w, 4);
            ctx.fillStyle = alpha("#000", 0.12);
            for (var i = 18; i < s.w; i += 36) ctx.fillRect(s.x + i, s.y + 28 + (i % 3) * 14, 10, 6);
          }
        });
        items.forEach(function (it) { if (!it.got && it.x > cam - 30 && it.x < cam + W + 30) drawPickup(S.pickup.look, it.x, it.y, 26, t); });
        // finish flag
        ctx.fillStyle = "#e8e8e8"; ctx.fillRect(flagX, groundY - 170, 6, 170);
        ctx.fillStyle = P.accent === "#ffffff" ? P.player : P.accent; ctx.beginPath(); ctx.moveTo(flagX + 6, groundY - 168); ctx.lineTo(flagX + 70, groundY - 148 + Math.sin(t * 6) * 4); ctx.lineTo(flagX + 6, groundY - 126); ctx.fill();
        foes.forEach(function (f) { if (f.alive) drawEnemy(f.def.look, f.x + 17, f.y + 17, 40, Math.sign(f.vx) || 1, t + f.ph); });
        ctx.fillStyle = P.enemy; shots.forEach(function (s) { ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 7); ctx.fill(); });
        if (!(p.inv > 0 && Math.floor(t * 20) % 2)) drawPlayer(S.player.look, p.x + p.w / 2, p.y + p.h / 2 + 2, 52, p.dir, Math.abs(p.vx) > 20 && p.ground ? t : 0);
        drawFx();
        ctx.restore();
      },
    };
  }

  /* ------------------------------------------------------------ genre: runner */

  function Runner() {
    var GRAV = 2500, JUMP = 900 * jumpF, groundY = H - 90;
    var base = 330 * speedF, spd = base, distRun = 0, spawn = 1.2, itemT = 0.8;
    var obs = [], items = [];
    var p = { x: 170, y: groundY - 50, w: 34, h: 50, vy: 0, ground: true, inv: 0, duck: false };
    var collectTarget = S.goal.target, acc = 0;
    var finish = 4000 + L * 3000;
    return {
      collectTarget: collectTarget,
      progressText: function () { return "Distance " + Math.min(100, Math.floor(distRun / finish * 100)) + "%"; },
      update: function (dt) {
        spd = base * (1 + Math.min(0.9, elapsed * 0.012 * D));
        distRun += spd * dt;
        p.duck = keys.down && p.ground;
        var h = p.duck ? 28 : 50;
        if (p.h !== h) { p.y += p.h - h; p.h = h; }
        if ((pressed.up || pressed.action) && p.ground) { p.vy = -JUMP; p.ground = false; sfx.jump(); }
        if (!(keys.up || keys.action) && p.vy < -JUMP * 0.5) p.vy = -JUMP * 0.5;
        p.vy += GRAV * dt * (keys.down ? 1.8 : 1); p.y += p.vy * dt;
        if (p.y + p.h >= groundY) { p.y = groundY - p.h; p.vy = 0; p.ground = true; }
        if (p.inv > 0) p.inv -= dt;
        spawn -= dt;
        if (spawn <= 0) {
          var ed = enemyDef(ri(0, 9)), flying = ed.behavior === "zigzag" || ed.look === "bat" || ed.look === "drone" || ed.look === "ghost";
          var o = { def: ed, x: W + 40, w: 36, h: 36, y: flying ? groundY - 92 - (rng() < 0.4 ? 40 : 0) : groundY - 36, ph: rng() * 6, fly: flying, vy: 0 };
          if (ed.behavior === "fall") { o.y = -40; o.fly = false; o.falling = true; o.x = W + 60 + rr(0, 160); }
          obs.push(o);
          spawn = rr(0.9, 1.7) / (0.75 + D * 0.12) * (base / spd) * 1.3;
        }
        itemT -= dt;
        if (itemT <= 0) { var hy = groundY - rr(50, 170); for (var i = 0; i < 4; i++) items.push({ x: W + 40 + i * 40, y: hy, got: false }); itemT = rr(1.2, 2.4); }
        obs = obs.filter(function (o) {
          o.ph += dt;
          o.x -= spd * dt * (o.def.behavior === "chase" ? 1.25 : 1);
          if (o.fly && o.def.behavior === "zigzag") o.y += Math.sin(o.ph * 4) * 60 * dt;
          if (o.falling) { o.vy += 1600 * dt; o.y = Math.min(groundY - o.h, o.y + o.vy * dt); }
          if (p.inv <= 0 && hit({ x: p.x + 4, y: p.y + 4, w: p.w - 8, h: p.h - 8 }, o)) { if (!hurt()) p.inv = 1.4; }
          return o.x > -80;
        });
        items = items.filter(function (it) {
          it.x -= spd * dt;
          if (!it.got && dist(p.x + p.w / 2, p.y + p.h / 2, it.x, it.y) < 32) { it.got = true; collected++; addScore(10, it.x, it.y); sfx.coin(); burst(it.x, it.y, P.pickup, 6, 100); }
          return it.x > -40 && !it.got;
        });
        acc += spd * dt / 25;
        while (acc >= 1) { score++; acc--; }
        if (S.goal.kind === "reach_end" ? distRun >= finish : goalMet()) end(true);
      },
      draw: function (t) {
        drawSideBackground(distRun, t);
        ctx.fillStyle = shade(P.ground, -0.3); ctx.fillRect(0, groundY + 10, W, H - groundY);
        ctx.fillStyle = P.ground; ctx.fillRect(0, groundY, W, 14);
        ctx.fillStyle = shade(P.ground, 0.3); ctx.fillRect(0, groundY, W, 4);
        ctx.fillStyle = alpha("#000", 0.15);
        for (var x = -((distRun) % 60); x < W; x += 60) ctx.fillRect(x, groundY + 26, 26, 6);
        items.forEach(function (it) { if (!it.got) drawPickup(S.pickup.look, it.x, it.y, 26, t); });
        obs.forEach(function (o) { drawEnemy(o.def.look, o.x + o.w / 2, o.y + o.h / 2, 44, -1, t + o.ph); });
        if (!(p.inv > 0 && Math.floor(t * 20) % 2)) {
          ctx.save();
          if (p.duck) { ctx.translate(p.x + p.w / 2, p.y + p.h); ctx.scale(1.2, 0.62); drawPlayer(S.player.look, 0, -26, 52, 1, t); }
          else drawPlayer(S.player.look, p.x + p.w / 2, p.y + p.h / 2, 54, 1, p.ground ? t * 1.6 : 0);
          ctx.restore();
        }
        drawFx();
      },
    };
  }

  /* ------------------------------------------------------------ genre: shooter */

  function Shooter() {
    var p = { x: W / 2, y: H - 80, r: 20, inv: 0, cd: 0, power: 0 };
    var foes = [], bullets = [], ebullets = [], drops = [], wave = 0, waveT = 0.4, scroll = 0;
    var SPD = 360 * speedF;
    var collectTarget = Math.min(S.goal.target, 40);
    function spawnWave() {
      wave++;
      var n = 4 + wave + D;
      for (var i = 0; i < n; i++) {
        var ed = enemyDef(i), es = enemySpeed(ed), b = ed.behavior;
        var f = { def: ed, x: 80 + (i % 8) * ((W - 160) / 7), y: -30 - Math.floor(i / 8) * 50 - rr(0, 40), vx: 0, vy: 85 * es, hp: ed.look === "rock" ? 3 : 1, ph: rng() * 6, cd: rr(1, 3), r: 22, es: es };
        if (b === "patrol") { f.vx = (i % 2 ? 1 : -1) * 90 * es; f.vy = 25 * es; }
        if (b === "fall") { f.x = rr(40, W - 40); f.vy = rr(110, 170) * es; f.y = -rr(40, 400); }
        foes.push(f);
      }
    }
    return {
      collectTarget: collectTarget,
      progressText: function () { return "Wave " + wave; },
      update: function (dt) {
        scroll += dt * 120;
        var mx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0), my = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
        p.x = clamp(p.x + mx * SPD * dt, 24, W - 24); p.y = clamp(p.y + my * SPD * dt, H * 0.45, H - 34);
        p.cd -= dt; if (p.inv > 0) p.inv -= dt; if (p.power > 0) p.power -= dt;
        if ((keys.action || touchMode) && p.cd <= 0) {
          p.cd = 0.17; sfx.shoot();
          bullets.push({ x: p.x, y: p.y - 24, vx: 0 });
          if (p.power > 0) { bullets.push({ x: p.x - 14, y: p.y - 14, vx: -90 }); bullets.push({ x: p.x + 14, y: p.y - 14, vx: 90 }); }
        }
        waveT -= dt;
        if (!foes.length && waveT > 1.2) waveT = 1.2;
        if (waveT <= 0) { spawnWave(); waveT = 9 - Math.min(4, D); }
        bullets = bullets.filter(function (b) { b.y -= 620 * dt; b.x += b.vx * dt; return b.y > -20; });
        foes = foes.filter(function (f) {
          f.ph += dt; var b = f.def.behavior;
          if (b === "zigzag") { f.x += Math.cos(f.ph * 2.5) * 140 * f.es * dt; f.y += f.vy * dt; }
          else if (b === "chase") { var a = Math.atan2(p.y - f.y, p.x - f.x); f.x += Math.cos(a) * 80 * f.es * dt; f.y += Math.max(30, Math.sin(a) * 90) * f.es * dt; }
          else if (b === "shoot") {
            if (f.y < 120 + (f.ph * 7 % 80)) f.y += f.vy * dt; else f.x += Math.sin(f.ph) * 100 * dt;
            f.cd -= dt;
            if (f.cd <= 0) { f.cd = rr(1.6, 2.8) - D * 0.15; var a2 = Math.atan2(p.y - f.y, p.x - f.x); ebullets.push({ x: f.x, y: f.y + 10, vx: Math.cos(a2) * 230, vy: Math.sin(a2) * 230 }); }
          } else if (b === "patrol") { f.x += f.vx * dt; f.y += f.vy * dt; if (f.x < 30 || f.x > W - 30) f.vx *= -1; }
          else f.y += f.vy * dt;
          for (var i = 0; i < bullets.length; i++) {
            var bl = bullets[i];
            if (dist(bl.x, bl.y, f.x, f.y) < f.r + 6) {
              bullets.splice(i, 1); f.hp--;
              burst(bl.x, bl.y, P.accent, 4, 80);
              if (f.hp <= 0) {
                addScore(10 + f.def.speed * 2, f.x, f.y); sfx.pop(); burst(f.x, f.y, P.enemy, 18, 200);
                if (rng() < 0.22) drops.push({ x: f.x, y: f.y });
                return false;
              }
              break;
            }
          }
          if (p.inv <= 0 && dist(f.x, f.y, p.x, p.y) < f.r + p.r - 6) { burst(f.x, f.y, P.enemy, 14); if (!hurt()) p.inv = 1.5; return false; }
          return f.y < H + 60;
        });
        ebullets = ebullets.filter(function (b) {
          b.x += b.vx * dt; b.y += b.vy * dt;
          if (p.inv <= 0 && dist(b.x, b.y, p.x, p.y) < p.r) { if (!hurt()) p.inv = 1.5; return false; }
          return b.y < H + 20 && b.y > -20 && b.x > -20 && b.x < W + 20;
        });
        drops = drops.filter(function (d) {
          d.y += 90 * dt;
          if (dist(d.x, d.y, p.x, p.y) < 30) {
            collected++; sfx.coin(); addScore(15, d.x, d.y);
            if (S.pickup.look === "heart") lives = Math.min(lives + 1, 5); else p.power = 7;
            return false;
          }
          return d.y < H + 30;
        });
        if (goalMet()) end(true);
      },
      draw: function (t) {
        skyGradient();
        BG.stars.forEach(function (s) { ctx.fillStyle = "rgba(255,255,255," + (0.3 + 0.4 * Math.sin(t * 2 + s.p)) + ")"; ctx.fillRect(s.x, (s.y + scroll * s.s * 0.6) % H, s.s, s.s * 2); });
        if (S.theme !== "space" && S.theme !== "neon") {
          ctx.fillStyle = alpha(P.ground, 0.35);
          for (var i = 0; i < 6; i++) { var y = ((i * 140 + scroll * 0.8) % (H + 200)) - 100; ctx.beginPath(); ctx.ellipse((i * 233) % W, y, 90, 40, 0, 0, 7); ctx.fill(); }
        }
        drops.forEach(function (d) { drawPickup(S.pickup.look, d.x, d.y, 26, t); });
        foes.forEach(function (f) { drawEnemy(f.def.look, f.x, f.y, 44, 1, t + f.ph); });
        ctx.fillStyle = P.accent; bullets.forEach(function (b) { roundRect(b.x - 3, b.y - 10, 6, 18, 3); ctx.fill(); });
        ctx.fillStyle = P.enemy; ebullets.forEach(function (b) { ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, 7); ctx.fill(); });
        if (!(p.inv > 0 && Math.floor(t * 20) % 2)) drawPlayer(S.player.look === "robot" || S.player.look === "wizard" ? S.player.look : "ship", p.x, p.y, 52, 1, t);
        if (p.power > 0) { ctx.strokeStyle = alpha(P.pickup, 0.6); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 32, 0, 7); ctx.stroke(); }
        drawFx();
      },
    };
  }

  /* ------------------------------------------------------------ genre: adventure */

  function Adventure() {
    var T = 60, COLS = 16, ROWS = 8, OY = 50;
    var grid = [], walls = [];
    for (var r = 0; r < ROWS; r++) { grid.push([]); for (var c = 0; c < COLS; c++) grid[r].push(r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1 ? 1 : 0); }
    var density = 0.12 + D * 0.025;
    for (var r2 = 1; r2 < ROWS - 1; r2++) for (var c2 = 1; c2 < COLS - 1; c2++) if (rng() < density && !(r2 <= 2 && c2 <= 2)) grid[r2][c2] = 1;
    // keep only what the start can reach
    var seen = {}, queue = [[1, 1]], open = [];
    seen["1,1"] = true;
    while (queue.length) {
      var q = queue.shift(); open.push(q);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nr = q[0] + d[0], nc = q[1] + d[1], key = nr + "," + nc;
        if (!seen[key] && grid[nr] && grid[nr][nc] === 0) { seen[key] = true; queue.push([nr, nc]); }
      });
    }
    for (var r3 = 0; r3 < ROWS; r3++) for (var c3 = 0; c3 < COLS; c3++) if (grid[r3][c3] === 1) walls.push({ x: c3 * T, y: OY + r3 * T, w: T, h: T });
    function cell(rc) { return { x: rc[1] * T + T / 2, y: OY + rc[0] * T + T / 2 }; }
    var far = open.filter(function (o) { return o[0] + o[1] > 6; });
    for (var i = far.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), tmp = far[i]; far[i] = far[j]; far[j] = tmp; }
    var exitCell = far.pop() || [ROWS - 2, COLS - 2];
    var nItems = Math.min(far.length - 4, S.goal.kind === "collect" ? S.goal.target : 10 + L * 2);
    var items = far.splice(0, Math.max(3, nItems)).map(function (o) { var p0 = cell(o); return { x: p0.x, y: p0.y, got: false }; });
    var nFoes = Math.min(far.length, 2 + D + Math.floor(L / 2));
    var foes = far.splice(0, nFoes).map(function (o, k) {
      var ed = enemyDef(k), p0 = cell(o), es = enemySpeed(ed);
      return { def: ed, x: p0.x - 17, y: p0.y - 17, w: 34, h: 34, vx: (rng() < 0.5 ? 1 : -1) * 80 * es, vy: (rng() < 0.5 ? 1 : -1) * 80 * es, es: es, alive: true, cd: rr(1, 3), ph: rng() * 6, horiz: rng() < 0.5 };
    });
    var collectTarget = items.length;
    var ex = cell(exitCell), exit = { x: ex.x - 24, y: ex.y - 24, w: 48, h: 48 };
    var p = { x: T + 12, y: OY + T + 10, w: 34, h: 38, inv: 0, dir: 1, fx: 1, fy: 0, swing: 0, cd: 0 };
    var shots = [], SPD = 210 * speedF;

    function blocked(b) { for (var i = 0; i < walls.length; i++) if (hit(b, walls[i])) return walls[i]; return null; }
    function moveBox(b, dx, dy) {
      b.x += dx; var w1 = blocked(b); if (w1) { b.x = dx > 0 ? w1.x - b.w : w1.x + w1.w; dx = 0; }
      b.y += dy; var w2 = blocked(b); if (w2) { b.y = dy > 0 ? w2.y - b.h : w2.y + w2.h; dy = 0; }
      return { dx: dx, dy: dy };
    }
    var doorOpen = function () { return S.goal.kind === "collect" ? collected >= collectTarget : goalMet(); };

    return {
      collectTarget: collectTarget,
      update: function (dt) {
        var mx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0), my = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
        if (mx || my) { var n = Math.sqrt(mx * mx + my * my); mx /= n; my /= n; p.fx = mx; p.fy = my; if (mx) p.dir = mx > 0 ? 1 : -1; }
        moveBox(p, mx * SPD * dt, my * SPD * dt);
        if (p.inv > 0) p.inv -= dt; p.cd -= dt; if (p.swing > 0) p.swing -= dt;
        if (pressed.action && p.cd <= 0) {
          p.swing = 0.2; p.cd = 0.35; beep(240, 0.08, "triangle", 0.05, 1.8);
          var sx = p.x + p.w / 2 + p.fx * 34, sy = p.y + p.h / 2 + p.fy * 34;
          foes.forEach(function (f) {
            if (f.alive && f.def.look !== "spike" && f.def.look !== "rock" && dist(sx, sy, f.x + 17, f.y + 17) < 46) { f.alive = false; addScore(30, f.x, f.y); sfx.pop(); burst(f.x + 17, f.y + 17, P.enemy, 16); }
          });
        }
        items.forEach(function (it) {
          if (!it.got && dist(p.x + p.w / 2, p.y + p.h / 2, it.x, it.y) < 30) { it.got = true; collected++; addScore(10, it.x, it.y); sfx.coin(); burst(it.x, it.y, P.pickup, 8); }
        });
        foes.forEach(function (f) {
          if (!f.alive) return;
          f.ph += dt; var b = f.def.behavior, sp = 80 * f.es;
          if (b === "chase") {
            var a = Math.atan2(p.y - f.y, p.x - f.x), r = moveBox(f, Math.cos(a) * sp * 0.85 * dt, Math.sin(a) * sp * 0.85 * dt);
            if (!r.dx && !r.dy) moveBox(f, Math.cos(a + 1.6) * sp * dt, Math.sin(a + 1.6) * sp * dt);
          } else if (b === "shoot") {
            f.cd -= dt;
            if (f.cd <= 0 && dist(f.x, f.y, p.x, p.y) < 420) { f.cd = 2.4 - D * 0.2; var a2 = Math.atan2(p.y - f.y, p.x - f.x); shots.push({ x: f.x + 17, y: f.y + 17, vx: Math.cos(a2) * 220, vy: Math.sin(a2) * 220, life: 3 }); }
          } else if (b === "zigzag" || b === "fall") {
            var r2 = moveBox(f, f.vx * dt, f.vy * dt); if (!r2.dx) f.vx *= -1; if (!r2.dy) f.vy *= -1;
          } else {
            var r3 = f.horiz ? moveBox(f, f.vx * dt, 0) : moveBox(f, 0, f.vy * dt);
            if (f.horiz && !r3.dx) f.vx *= -1; if (!f.horiz && !r3.dy) f.vy *= -1;
          }
          if (p.inv <= 0 && hit(p, f)) { if (!hurt()) p.inv = 1.5; }
        });
        shots = shots.filter(function (s) {
          s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
          if (blocked({ x: s.x - 3, y: s.y - 3, w: 6, h: 6 })) return false;
          if (p.inv <= 0 && dist(s.x, s.y, p.x + p.w / 2, p.y + p.h / 2) < 20) { if (!hurt()) p.inv = 1.5; return false; }
          return s.life > 0;
        });
        if (S.goal.kind === "collect" || S.goal.kind === "reach_end") { if (doorOpen() && hit(p, exit)) end(true); }
        else if (goalMet()) end(true);
      },
      draw: function (t) {
        ctx.fillStyle = shade(P.ground, -0.45); ctx.fillRect(0, 0, W, H);
        for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
          var x = c * T, y = OY + r * T;
          if (grid[r][c]) continue;
          ctx.fillStyle = (r + c) % 2 ? shade(P.ground, 0.08) : shade(P.ground, 0.0); ctx.fillRect(x, y, T, T);
        }
        walls.forEach(function (w) {
          ctx.fillStyle = shade(P.sky, -0.35); ctx.fillRect(w.x, w.y, w.w, w.h);
          ctx.fillStyle = shade(P.sky, -0.15); ctx.fillRect(w.x + 3, w.y + 3, w.w - 6, w.h - 14);
          ctx.fillStyle = alpha("#000", 0.18); ctx.fillRect(w.x + 3, w.y + w.h - 11, w.w - 6, 8);
        });
        var open = doorOpen();
        if (S.goal.kind === "collect" || S.goal.kind === "reach_end") {
        ctx.fillStyle = open ? P.pickup : shade(P.sky, -0.5); roundRect(exit.x, exit.y, exit.w, exit.h, 8); ctx.fill();
        ctx.strokeStyle = open ? "#fff" : alpha("#fff", 0.3); ctx.lineWidth = 3; ctx.stroke();
        if (open) { ctx.fillStyle = alpha("#fff", 0.4 + 0.3 * Math.sin(t * 6)); roundRect(exit.x + 8, exit.y + 8, exit.w - 16, exit.h - 16, 5); ctx.fill(); }
        }
        items.forEach(function (it) { if (!it.got) drawPickup(S.pickup.look, it.x, it.y, 26, t); });
        foes.forEach(function (f) { if (f.alive) drawEnemy(f.def.look, f.x + 17, f.y + 17, 42, f.vx >= 0 ? 1 : -1, t + f.ph); });
        ctx.fillStyle = P.enemy; shots.forEach(function (s) { ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 7); ctx.fill(); });
        if (p.swing > 0) {
          ctx.strokeStyle = alpha(P.accent, 0.9); ctx.lineWidth = 6; ctx.lineCap = "round";
          var a = Math.atan2(p.fy, p.fx); ctx.beginPath(); ctx.arc(p.x + p.w / 2, p.y + p.h / 2, 38, a - 1 + (0.2 - p.swing) * 8, a + 0.2 + (0.2 - p.swing) * 4); ctx.stroke();
        }
        if (!(p.inv > 0 && Math.floor(t * 20) % 2)) drawPlayer(S.player.look, p.x + p.w / 2, p.y + p.h / 2, 46, p.dir, keys.left || keys.right || keys.up || keys.down ? t : 0);
        drawFx();
      },
    };
  }

  /* ------------------------------------------------------------ genre: puzzle (match-3) */

  function Puzzle() {
    var N = 8, TS = 56, OX = (W - N * TS) / 2, OYp = 62;
    var KINDS = 5 + (D >= 4 ? 1 : 0);
    // fixed jewel hues: palette colours can sit too close together to tell tiles apart
    var colors = ["#ff5d73", "#ffd23f", "#4cc9f0", "#6ee7a0", "#c77dff", "#ff9f43"];
    var shapes = [S.pickup.look === "coin" ? "key" : S.pickup.look, "star", "heart", "gem", "fruit", "bolt", "key"]
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    var board = [], anim = [], sel = null, cur = { r: 3, c: 3 }, busy = 0, combo = 0, shakeCell = null;
    var moves = Math.max(12, 30 - D * 3 + L * 3);
    function rand() { return Math.floor(rng() * KINDS); }
    function fill() {
      board = [];
      for (var r = 0; r < N; r++) { board.push([]); for (var c = 0; c < N; c++) { var k; do { k = rand(); } while ((c >= 2 && board[r][c - 1] === k && board[r][c - 2] === k) || (r >= 2 && board[r - 1][c] === k && board[r - 2][c] === k)); board[r].push(k); } }
    }
    fill();
    for (var guard = 0; guard < 50 && !hasMove(); guard++) fill();
    var off = []; for (var r1 = 0; r1 < N; r1++) { off.push([]); for (var c1 = 0; c1 < N; c1++) off[r1].push(0); }

    function findMatches() {
      var m = {};
      for (var r = 0; r < N; r++) for (var c = 0; c < N - 2; c++) { var k = board[r][c]; if (k >= 0 && board[r][c + 1] === k && board[r][c + 2] === k) { m[r + "," + c] = m[r + "," + (c + 1)] = m[r + "," + (c + 2)] = true; } }
      for (var c2 = 0; c2 < N; c2++) for (var r2 = 0; r2 < N - 2; r2++) { var k2 = board[r2][c2]; if (k2 >= 0 && board[r2 + 1][c2] === k2 && board[r2 + 2][c2] === k2) { m[r2 + "," + c2] = m[(r2 + 1) + "," + c2] = m[(r2 + 2) + "," + c2] = true; } }
      return Object.keys(m).map(function (s) { return s.split(",").map(Number); });
    }
    function swap(a, b) { var t0 = board[a.r][a.c]; board[a.r][a.c] = board[b.r][b.c]; board[b.r][b.c] = t0; }
    function hasMove() {
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
        var cand = [{ r: r, c: c + 1 }, { r: r + 1, c: c }];
        for (var i = 0; i < 2; i++) { var b = cand[i]; if (b.r >= N || b.c >= N) continue; swap({ r: r, c: c }, b); var ok = findMatches().length > 0; swap({ r: r, c: c }, b); if (ok) return true; }
      }
      return false;
    }
    function resolve() {
      var m = findMatches();
      if (!m.length) {
        combo = 0;
        if (goalMet()) { end(true); return; }
        if (moves <= 0) { end(false); return; }
        if (!hasMove()) { fill(); for (var g2 = 0; g2 < 50 && !hasMove(); g2++) fill(); floatText(W / 2, H / 2, "Shuffle!"); }
        return;
      }
      combo++;
      m.forEach(function (rc) { var x = OX + rc[1] * TS + TS / 2, y = OYp + rc[0] * TS + TS / 2; burst(x, y, colors[board[rc[0]][rc[1]]], 6, 140); board[rc[0]][rc[1]] = -1; });
      var pts = m.length * 10 * combo;
      addScore(pts, OX + m[0][1] * TS + TS / 2, OYp + m[0][0] * TS);
      if (m.length > 0) collected += m.length;
      sfx.pop();
      for (var c3 = 0; c3 < N; c3++) {
        var write = N - 1;
        for (var r3 = N - 1; r3 >= 0; r3--) if (board[r3][c3] >= 0) { if (write !== r3) { board[write][c3] = board[r3][c3]; off[write][c3] = (write - r3) * TS; } write--; }
        for (var r4 = write; r4 >= 0; r4--) { board[r4][c3] = rand(); off[r4][c3] = (write + 1) * TS + 20; }
      }
      busy = 0.32;
    }
    function trySwap(a, b) {
      if (Math.abs(a.r - b.r) + Math.abs(a.c - b.c) !== 1) return false;
      swap(a, b);
      if (!findMatches().length) { swap(a, b); shakeCell = { r: b.r, c: b.c, t: 0.25 }; beep(140, 0.12, "triangle", 0.05); return false; }
      moves--; resolve(); return true;
    }
    function cellAt(pt) { var c = Math.floor((pt.x - OX) / TS), r = Math.floor((pt.y - OYp) / TS); return r >= 0 && r < N && c >= 0 && c < N ? { r: r, c: c } : null; }
    return {
      collectTarget: S.goal.target,
      progressText: function () { return "Moves " + moves; },
      movesLeft: function () { return moves; },
      update: function (dt) {
        for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (off[r][c] > 0) off[r][c] = Math.max(0, off[r][c] - dt * 900);
        if (shakeCell) { shakeCell.t -= dt; if (shakeCell.t <= 0) shakeCell = null; }
        if (busy > 0) { busy -= dt; if (busy <= 0) resolve(); return; }
        if (pressed.left) cur.c = Math.max(0, cur.c - 1);
        if (pressed.right) cur.c = Math.min(N - 1, cur.c + 1);
        if (pressed.up) cur.r = Math.max(0, cur.r - 1);
        if (pressed.down) cur.r = Math.min(N - 1, cur.r + 1);
        var clickCell = null;
        if (pressed.action) clickCell = { r: cur.r, c: cur.c };
        if (lastTap) { clickCell = cellAt(lastTap); if (clickCell) cur = { r: clickCell.r, c: clickCell.c }; lastTap = null; }
        if (clickCell) {
          if (!sel) sel = clickCell;
          else if (sel.r === clickCell.r && sel.c === clickCell.c) sel = null;
          else { if (!trySwap(sel, clickCell)) { if (Math.abs(sel.r - clickCell.r) + Math.abs(sel.c - clickCell.c) !== 1) { sel = clickCell; return; } } sel = null; }
        }
      },
      draw: function (t) {
        drawSideBackground(t * 20, t);
        ctx.fillStyle = alpha("#000", 0.35); roundRect(OX - 12, OYp - 12, N * TS + 24, N * TS + 24, 16); ctx.fill();
        for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
          var x = OX + c * TS, y = OYp + r * TS - off[r][c];
          ctx.fillStyle = (r + c) % 2 ? alpha("#fff", 0.06) : alpha("#fff", 0.1); ctx.fillRect(OX + c * TS, OYp + r * TS, TS, TS);
          var k = board[r][c]; if (k < 0) continue;
          var sx = shakeCell && shakeCell.r === r && shakeCell.c === c ? Math.sin(t * 80) * 4 : 0;
          var isSel = sel && sel.r === r && sel.c === c;
          ctx.save();
          if (isSel) { ctx.translate(x + TS / 2, y + TS / 2); ctx.scale(1.12, 1.12); ctx.translate(-x - TS / 2, -y - TS / 2); }
          ctx.fillStyle = alpha("#ffffff", 0.13); ctx.beginPath(); ctx.arc(x + TS / 2 + sx, y + TS / 2, TS * 0.4, 0, 7); ctx.fill();
          drawPickup(shapes[k], x + TS / 2 + sx, y + TS / 2, 40, isSel ? t * 3 : 0, colors[k]);
          ctx.restore();
        }
        if (!touchMode) { ctx.strokeStyle = alpha(P.accent, 0.9); ctx.lineWidth = 3; roundRect(OX + cur.c * TS + 2, OYp + cur.r * TS + 2, TS - 4, TS - 4, 8); ctx.stroke(); }
        if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; roundRect(OX + sel.c * TS + 4, OYp + sel.r * TS + 4, TS - 8, TS - 8, 8); ctx.stroke(); }
        drawFx();
      },
    };
  }

  /* ------------------------------------------------------------ genre: racer */

  function Racer() {
    var LANES = 4, RW = 440, RX = (W - RW) / 2, LW = RW / LANES;
    var p = { x: W / 2, y: H - 90, w: 40, h: 64, inv: 0, boost: 0, meter: 40 };
    var base = 380 * speedF, spd = base, travel = 0, finish = 9000 + L * 6000, spawn = 0.6, itemT = 1, cars = [], items = [], decor = [];
    var collectTarget = Math.min(S.goal.target, 40);
    var r0 = mulberry32(S.seed ^ 0x1234);
    for (var i = 0; i < 16; i++) decor.push({ side: i % 2, y: r0() * H * 1.6, k: Math.floor(r0() * 3) });
    function laneX(l) { return RX + LW * l + LW / 2; }
    return {
      collectTarget: collectTarget,
      progressText: function () { return "Distance " + Math.min(100, Math.floor(travel / finish * 100)) + "%"; },
      update: function (dt) {
        var mx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        p.x = clamp(p.x + mx * 330 * speedF * dt, RX + 24, RX + RW - 24);
        var boosting = (keys.up || keys.action) && p.meter > 0;
        if (boosting) p.meter = Math.max(0, p.meter - 30 * dt);
        var target = base * (1 + elapsed * 0.006 * D) * (boosting ? 1.45 : 1) * (p.inv > 0.9 ? 0.55 : 1);
        spd += (target - spd) * Math.min(1, dt * 3);
        travel += spd * dt;
        if (p.inv > 0) p.inv -= dt;
        spawn -= dt;
        if (spawn <= 0) {
          var ed = enemyDef(ri(0, 9)), lane = ri(0, LANES - 1), es = enemySpeed(ed);
          var stat = ed.behavior === "fall" || ed.look === "spike" || ed.look === "rock";
          cars.push({ def: ed, x: laneX(lane), y: -80, v: stat ? 0 : base * rr(0.35, 0.6) * es * 0.6, lane: lane, ph: rng() * 6, cd: rr(1, 3), stat: stat, w: stat ? 34 : 40, h: stat ? 34 : 64 });
          spawn = rr(0.45, 1.0) / (0.7 + D * 0.15);
        }
        itemT -= dt;
        if (itemT <= 0) { var ln = ri(0, LANES - 1); for (var j = 0; j < 3; j++) items.push({ x: laneX(ln), y: -40 - j * 60 }); itemT = rr(1.4, 2.6); }
        var spawned = [];
        cars = cars.filter(function (c) {
          c.ph += dt;
          c.y += (spd - c.v) * dt;
          var b = c.def.behavior;
          if (!c.stat) {
            if (b === "zigzag") c.x = clamp(c.x + Math.sin(c.ph * 2) * 90 * dt, RX + 24, RX + RW - 24);
            else if (b === "chase" && c.y < p.y) c.x += clamp(p.x - c.x, -1, 1) * 60 * dt;
            else if (b === "patrol") { c.cd -= dt; if (c.cd <= 0) { c.lane = clamp(c.lane + (rng() < 0.5 ? -1 : 1), 0, LANES - 1); c.cd = rr(1.5, 3.5); } c.x += (laneX(c.lane) - c.x) * Math.min(1, dt * 2); }
            else if (b === "shoot") { c.cd -= dt; if (c.cd <= 0 && c.y > 0) { spawned.push({ def: { look: "spike", behavior: "fall", name: "debris", speed: 1 }, x: c.x, y: c.y + 50, v: 0, stat: true, ph: 0, cd: 9, lane: c.lane, w: 30, h: 30 }); c.cd = rr(2, 3.5); } }
          }
          var box = { x: c.x - c.w / 2 + 4, y: c.y - c.h / 2 + 4, w: c.w - 8, h: c.h - 8 };
          if (p.inv <= 0 && hit({ x: p.x - p.w / 2 + 5, y: p.y - p.h / 2 + 6, w: p.w - 10, h: p.h - 12 }, box)) { burst(p.x, p.y - 20, P.enemy, 16); if (!hurt()) p.inv = 1.6; }
          return c.y < H + 120;
        }).concat(spawned);
        items = items.filter(function (it) {
          it.y += spd * dt;
          if (dist(it.x, it.y, p.x, p.y) < 36) { collected++; p.meter = Math.min(100, p.meter + 18); addScore(10, it.x, it.y); sfx.coin(); return false; }
          return it.y < H + 40;
        });
        if (S.goal.kind === "reach_end" ? travel >= finish : goalMet()) end(true);
      },
      draw: function (t) {
        var side = S.theme === "ocean" ? "#2a6f97" : S.theme === "snow" ? "#eef6ff" : S.theme === "desert" ? shade(P.ground, 0.15) : S.theme === "space" || S.theme === "neon" ? shade(P.sky, 0.05) : shade(P.ground, 0);
        ctx.fillStyle = side; ctx.fillRect(0, 0, W, H);
        decor.forEach(function (d) {
          var y = ((d.y + travel * 0.9) % (H * 1.6)) - 100, x = d.side ? RX + RW + 50 + d.k * 40 : RX - 70 - d.k * 40;
          if (S.theme === "city" || S.theme === "neon") { ctx.fillStyle = shade(P.ground, -0.15 + d.k * 0.08); ctx.fillRect(x - 30, y - 40, 60, 80); ctx.fillStyle = alpha("#ffe9a8", 0.5); ctx.fillRect(x - 20, y - 30, 12, 12); ctx.fillRect(x + 6, y - 6, 12, 12); }
          else if (S.theme === "space") { ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.fillRect(x, y, 2, 2); ctx.fillRect(x + 30, y + 40, 1.5, 1.5); }
          else { ctx.fillStyle = S.theme === "desert" ? "#2f7d4a" : S.theme === "snow" ? "#5a8f5a" : shade(P.ground, -0.25); ctx.beginPath(); ctx.arc(x, y, 22 + d.k * 4, 0, 7); ctx.fill(); }
        });
        ctx.fillStyle = "#3b3d45"; ctx.fillRect(RX, 0, RW, H);
        ctx.fillStyle = "#e9e9ef"; ctx.fillRect(RX - 6, 0, 6, H); ctx.fillRect(RX + RW, 0, 6, H);
        ctx.fillStyle = alpha("#fff", 0.6);
        var dash = travel % 70;
        for (var l = 1; l < LANES; l++) for (var y = dash - 70; y < H; y += 70) ctx.fillRect(RX + LW * l - 2, y, 4, 36);
        var fy = p.y - (finish - travel);
        if (S.goal.kind === "reach_end" && fy > -40 && fy < H) { for (var cx = 0; cx < RW; cx += 20) { ctx.fillStyle = (cx / 20) % 2 ? "#111" : "#fff"; ctx.fillRect(RX + cx, fy, 20, 12); ctx.fillStyle = (cx / 20) % 2 ? "#fff" : "#111"; ctx.fillRect(RX + cx, fy + 12, 20, 12); } }
        items.forEach(function (it) { drawPickup(S.pickup.look, it.x, it.y, 28, t); });
        cars.forEach(function (c) { if (c.stat) drawEnemy(c.def.look === "car" ? "spike" : c.def.look, c.x, c.y, 36, 1, t + c.ph); else drawPlayer("car", c.x, c.y, 66, 1, t, P.enemy); });
        if (!(p.inv > 0 && Math.floor(t * 20) % 2)) drawPlayer("car", p.x, p.y, 66, 1, t);
        if ((keys.up || keys.action) && p.meter > 0) { ctx.fillStyle = alpha(P.pickup, 0.7); ctx.beginPath(); ctx.moveTo(p.x - 10, p.y + 34); ctx.lineTo(p.x, p.y + 60 + Math.sin(t * 50) * 6); ctx.lineTo(p.x + 10, p.y + 34); ctx.fill(); }
        ctx.fillStyle = alpha("#000", 0.45); roundRect(W - 46, H - 170, 22, 130, 8); ctx.fill();
        ctx.fillStyle = P.pickup; roundRect(W - 42, H - 44 - 122 * p.meter / 100, 14, 122 * p.meter / 100, 6); ctx.fill();
        drawFx();
      },
    };
  }

  /* ------------------------------------------------------------ HUD + screens */

  function wrap(text, x, y, maxW, lh) {
    var words = text.split(/\s+/), line = "", lines = [];
    words.forEach(function (w) { var test = line ? line + " " + w : w; if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; });
    if (line) lines.push(line);
    lines.forEach(function (l, i) { ctx.fillText(l, x, y + i * lh); });
    return lines.length;
  }
  function textOn(c) { return luma(c) > 0.6 ? "#111" : "#fff"; }

  function drawHud() {
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(0, 0, W, 40);
    ctx.font = "bold 17px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#fff";
    ctx.fillText(S.title, 14, 26);
    ctx.textAlign = "center"; ctx.fillText(goalText(), W / 2, 26);
    ctx.textAlign = "right"; if (S.goal.kind !== "score") ctx.fillText("Score " + score, W - 150, 26);
    for (var i = 0; i < S.player.lives || i < lives; i++) {
      ctx.save(); ctx.globalAlpha = i < lives ? 1 : 0.25; drawPickup("heart", W - 26 - i * 24, 20, 20, 0, "#ff4d6d"); ctx.restore();
      if (i > 6) break;
    }
    if (touchMode && state === "play" && S.genre !== "puzzle") {
      ctx.globalAlpha = 0.35;
      var labels = { left: "◀", right: "▶", up: S.genre === "racer" ? "▲" : "", action: S.genre === "shooter" ? "" : S.genre === "adventure" ? "⚔" : S.genre === "racer" ? "⚡" : "⤒" };
      for (var k in PADS) {
        if ((S.genre === "runner" && (k === "left" || k === "right")) || (k === "up" && !labels.up)) continue;
        if (k === "action" && !labels.action) continue;
        ctx.fillStyle = keys[k] ? "#fff" : "#000"; ctx.beginPath(); ctx.arc(PADS[k].x, PADS[k].y, PADS[k].r, 0, 7); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.fillStyle = "#fff"; ctx.font = "bold 26px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(labels[k], PADS[k].x, PADS[k].y + 9); ctx.globalAlpha = 0.35;
      }
      ctx.globalAlpha = 1;
    }
  }

  function overlay(title, body, foot, accent) {
    ctx.fillStyle = "rgba(6,8,16,.62)"; ctx.fillRect(0, 0, W, H);
    var bw = 660, bh = 360, bx = (W - bw) / 2, by = (H - bh) / 2;
    ctx.fillStyle = "rgba(18,20,30,.92)"; roundRect(bx, by, bw, bh, 22); ctx.fill();
    ctx.strokeStyle = alpha(accent, 0.8); ctx.lineWidth = 3; ctx.stroke();
    ctx.textAlign = "center"; ctx.fillStyle = accent; ctx.font = "800 44px system-ui, sans-serif";
    ctx.fillText(title, W / 2, by + 72);
    ctx.fillStyle = "#e9e9f2"; ctx.font = "17px system-ui, sans-serif";
    var n = 0;
    body.forEach(function (b) { n += wrap(b, W / 2, by + 112 + n * 24, bw - 80, 24); n += 0.4; });
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px system-ui, sans-serif";
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 300);
    ctx.fillText(foot, W / 2, by + bh - 28);
    ctx.globalAlpha = 1;
  }

  var CONTROLS = {
    platformer: "←/→ move · Space jump", runner: "Space jump · ↓ duck", shooter: "Arrows move · Space fire",
    adventure: "Arrows move · Space swing", puzzle: "Click two neighbours to swap", racer: "←/→ steer · ↑ boost",
  };
  var ACCENT = luma(P.player) > 0.25 ? P.player : P.pickup;

  /* ------------------------------------------------------------ loop */

  function newGame() {
    rng = mulberry32(S.seed);
    score = 0; lives = S.player.lives; elapsed = 0; collected = 0; parts = []; floats = [];
    G = { platformer: Platformer, runner: Runner, shooter: Shooter, adventure: Adventure, puzzle: Puzzle, racer: Racer }[S.genre]();
  }
  newGame();
  report("ready");

  var last = performance.now(), clock = 0, paused = false;
  document.addEventListener("visibilitychange", function () { paused = document.hidden; last = performance.now(); });

  function frame(now) {
    var dt = Math.min(0.033, (now - last) / 1000); last = now;
    if (!paused) {
      clock += dt;
      if (state === "title") {
        if (pressed.start || pressed.action) { state = "play"; lastTap = null; report("start"); }
      } else if (state === "play") {
        elapsed += dt;
        G.update(dt);
      } else if (pressed.restart || pressed.start) {
        newGame(); state = "play"; lastTap = null; report("start");
      }
      updateFx(dt);
      if (shake > 0) shake -= dt; if (flash > 0) flash -= dt;
    }
    for (var k in pressed) pressed[k] = false;

    ctx.save();
    if (shake > 0) ctx.translate((rng() - 0.5) * 10 * shake / 0.3, (rng() - 0.5) * 10 * shake / 0.3);
    G.draw(clock);
    ctx.restore();
    if (flash > 0) { ctx.fillStyle = "rgba(255,40,60," + flash + ")"; ctx.fillRect(0, 0, W, H); }
    if (state !== "title") drawHud();
    if (state === "title") overlay(S.title, [S.tagline, S.story.intro, CONTROLS[S.genre]].filter(Boolean), touchMode ? "Tap to start" : "Press Space or click to start", ACCENT);
    else if (state === "win") overlay("You win!", [S.story.win, "Score " + score], "Press R or tap to play again", ACCENT);
    else if (state === "lose") overlay("Game over", [S.story.lose, "Score " + score], "Press R or tap to try again", "#ff6b6b");
    if (paused) { ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(0, 0, W, H); }
    window.__ofGame = { state: state, score: score, genre: S.genre, lives: lives, collected: collected };
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // live preview: the studio posts an edited spec; restart on the title screen
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.type !== "motionfield-game-spec" || !d.spec) return;
    S = clampSpec(d.spec); P = S.palette; D = S.difficulty; L = S.length;
    speedF = 0.75 + S.player.speed * 0.06; jumpF = 0.85 + S.player.jump * 0.035;
    ACCENT = luma(P.player) > 0.25 ? P.player : P.pickup;
    newGame(); state = d.play ? "play" : "title";
    report("ready");
  });
})();
