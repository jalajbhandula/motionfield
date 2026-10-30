import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { findEndpoint } from "@/lib/catalog/video-models";
import { MOTION_RENDER_ENDPOINT } from "@/lib/catalog/code/motion";

/**
 * [OF-0357] - captions + burn: overlay caption layers, transparent alpha,
 *           burnCaptions end-to-end (real mp4 + word timings → burned-in
 *           captions), Part D overlay ownership.
 * [OF-0358] - HUD + post + ramp: dial overlay, post preview, exporter post
 *           filtergraph pixels, speed-curve setpts retiming.
 * Also: overlay-mode ownership (Part D) and the export watchdog (A1).
 *
 * Captions are painted by the renderer's screen-space pass - ffmpeg has no
 * libass/drawtext here, so a green run proves the canvas pipeline itself.
 */

const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";
const base = `http://localhost:${process.env.PORT || "3100"}`;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test.describe.configure({ mode: "serial" });

async function boot(page: Page, spec: unknown) {
  await page.goto(`/render/motion?spec=${b64(spec)}`);
  await page.waitForFunction(() => Boolean(window.__of) || Boolean(window.__ofError), null, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__ofError ?? null);
  expect(err).toBeNull();
  await page.evaluate(() => window.__of!.ready);
}

async function pngAt(page: Page, t: number): Promise<string> {
  await page.evaluate((tt) => window.__of!.renderAt(tt), t);
  return page.evaluate(
    () => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png"),
  );
}

/** lit-pixel stats inside a canvas rect - bright ink vs karaoke-highlight red */
async function regionStats(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(([rx, ry, rw, rh]) => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(rx, ry, rw, rh).data;
    let bright = 0;
    let red = 0;
    for (let i = 0; i + 2 < px.length; i += 4) {
      const r = px[i];
      const gg = px[i + 1];
      const bb = px[i + 2];
      if (r > 200 && gg > 200 && bb > 200) bright++;
      if (r > 200 && gg < 110 && bb < 150) red++;
    }
    return { bright, red };
  }, [x, y, w, h]);
}

/** bright-ink bounding box + pixel count inside a canvas rect */
async function inkBox(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(([rx, ry, rw, rh]) => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(rx, ry, rw, rh).data;
    let n = 0;
    let minX = rw, minY = rh, maxX = -1, maxY = -1;
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        const i = (yy * rw + xx) * 4;
        if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) {
          n++;
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    return { n, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }, [x, y, w, h]);
}

const capLayer = {
  id: "cap", type: "captions",
  props: {
    words: [
      { text: "HELLO", start: 0.4, end: 1.0 },   // cue 1: HELLO THERE
      { text: "THERE", start: 1.0, end: 1.6 },
      { text: "WORLD", start: 2.0, end: 2.6 },   // cue 2 (0.4s gap → split)
      { text: "NOW", start: 2.6, end: 2.9 },     // cue 2's unsung tail - keeps bright base ink at probe times
    ],
    style: "karaoke", highlightColor: "#ff3355",
    size: 40, color: "#ffffff", anchor: "bottom", marginBottom: 30,
  },
};

const hudLayer = {
  id: "hud", type: "hud",
  props: { value: 40, max: 200, unit: "km/h", anchor: "topRight", size: 100, color: "#ffffff" },
};

const captionSpec = {
  version: 1, width: 320, height: 180, fps: 24, duration: 3, seed: 7,
  background: { color: "#101018" },
  camera: { keyframes: [{ t: 0, position: [0, 0, 8], target: [0, 0, 0] }] },
  layers: [capLayer],
};

const hudSpec = {
  ...captionSpec,
  layers: [hudLayer],
  params: [
    { id: "speed", label: "Speed", min: 0, max: 200, step: 1, default: 40, bind: "hud.props.value" },
  ],
};

test("[OF-0357] captions: words appear in their windows, karaoke highlight follows the live word", async ({ page }) => {
  await boot(page, captionSpec);
  const bottom = () => regionStats(page, 0, 100, 320, 80);

  await page.evaluate(() => window.__of!.renderAt(0.2));
  let s = await bottom();
  expect(s.bright + s.red).toBeLessThan(50);         // before HELLO

  await page.evaluate(() => window.__of!.renderAt(0.7));
  s = await bottom();
  expect(s.bright).toBeGreaterThan(100);        // caption ink
  expect(s.red).toBeGreaterThan(50);            // HELLO highlighted

  await page.evaluate(() => window.__of!.renderAt(1.3));
  s = await bottom();
  expect(s.red).toBeGreaterThan(100);           // both words sung → highlighted
  expect(s.bright).toBeLessThan(s.red);         // little/no base-white ink left

  await page.evaluate(() => window.__of!.renderAt(1.8));
  s = await bottom();
  expect(s.bright + s.red).toBeLessThan(50);    // gap between cues → nothing

  await page.evaluate(() => window.__of!.renderAt(2.3));
  expect((await bottom()).red).toBeGreaterThan(100);    // WORLD (sung → highlighted)

  await page.evaluate(() => window.__of!.renderAt(2.9));
  s = await bottom();
  expect(s.bright + s.red).toBeLessThan(50);         // after last word
});

test("[OF-0357] captions: the rendered frame is hash-stable at a fixed t", async ({ page }) => {
  await boot(page, captionSpec);
  const h1 = sha(await pngAt(page, 1.3));
  const h2 = sha(await pngAt(page, 1.3));
  expect(h2).toBe(h1);
});

test("[OF-0357] punch style: a punch word's ink box is larger just after its start than at rest", async ({ page }) => {
  const punchSpec = {
    ...captionSpec,
    layers: [{
      id: "cap", type: "captions",
      props: {
        words: [
          { text: "CALM", start: 0.4, end: 1.0 },
          { text: "BOOM", start: 1.0, end: 1.6 },  // punch index 1
        ],
        style: "punch", punch: [1],
        size: 40, color: "#ffffff", anchor: "bottom", marginBottom: 30,
      },
    }],
  };
  await boot(page, punchSpec);
  // the punched word takes the highlight color - count any ink that differs
  // from the #101018 background, not just white
  const band = () => page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width; d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 100, 320, 80).data;
    let n = 0, minX = 320, minY = 80, maxX = -1, maxY = -1;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      if (px[i] > 60 || px[i + 1] > 60 || px[i + 2] > 60) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { n, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  });

  // rest: BOOM not started → both words at scale 1
  await page.evaluate(() => window.__of!.renderAt(0.9));
  const rest = await band();
  expect(rest.n).toBeGreaterThan(100);

  // exactly at the punch word's start - it must NOT vanish (regression:
  // punchPulse(0) was 0) and its ink box is ~1.5× rest
  await page.evaluate(() => window.__of!.renderAt(1.0));
  const pop = await band();
  expect(pop.n).toBeGreaterThan(rest.n * 1.1);
  expect(pop.w * pop.h).toBeGreaterThan(rest.w * rest.h * 1.1);

  // settled again well after the pulse decays
  await page.evaluate(() => window.__of!.renderAt(1.5));
  const settled = await band();
  expect(settled.w * settled.h).toBeLessThan(pop.w * pop.h);
});

test("[OF-0357] pop style: a word is absent before its start", async ({ page }) => {
  const popSpec = {
    ...captionSpec,
    layers: [{ ...capLayer, props: { ...capLayer.props, style: "pop" } }],
  };
  await boot(page, popSpec);
  const band = () => inkBox(page, 0, 100, 320, 80);

  await page.evaluate(() => window.__of!.renderAt(0.2));
  expect((await band()).n).toBeLessThan(20);          // before HELLO - nothing

  await page.evaluate(() => window.__of!.renderAt(0.7));
  const one = await band();                            // HELLO in, THERE absent
  expect(one.n).toBeGreaterThan(80);

  await page.evaluate(() => window.__of!.renderAt(1.3));
  const two = await band();                            // THERE joins → wider box
  expect(two.n).toBeGreaterThan(one.n);
  expect(two.maxX).toBeGreaterThan(one.maxX + 20);
});

test("[OF-0358] hud: dial paints in its corner and follows props.value - 0 vs max differ", async ({ page }) => {
  await boot(page, hudSpec);
  const probe = () => regionStats(page, 220, 0, 100, 155); // topRight dial + readout

  await page.evaluate(() => { window.__of!.setParams({ speed: 40 }); });
  await page.evaluate(() => window.__of!.renderAt(0.5));
  const low = await probe();
  expect(low.bright).toBeGreaterThan(50); // dial + ticks + readout

  // needle/readout move with the bound param - the corner's ink changes
  await page.evaluate(() => { window.__of!.setParams({ speed: 190 }); });
  await page.evaluate(() => window.__of!.renderAt(0.5));
  const high = await probe();
  expect(high.bright).toBeGreaterThan(50);
  expect(high.bright).not.toBe(low.bright);

  // the dial at 0 vs at max paints measurably different ink
  await page.evaluate(() => { window.__of!.setParams({ speed: 0 }); });
  await page.evaluate(() => window.__of!.renderAt(0.5));
  const zero = await probe();
  await page.evaluate(() => { window.__of!.setParams({ speed: 200 }); });
  await page.evaluate(() => window.__of!.renderAt(0.5));
  const max = await probe();
  expect(max.bright).not.toBe(zero.bright);
});

test("[OF-0357] transparent background renders real alpha (not black)", async ({ page }) => {
  const spec = {
    ...captionSpec,
    background: { transparent: true },
  };
  await boot(page, spec);
  await page.evaluate(() => window.__of!.renderAt(0.7));
  const a = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const at = (x: number, y: number) => px[(y * c.width + x) * 4 + 3];
    let caption = 0; // max alpha in the caption band - glyph holes included
    for (let y = 105; y < 150; y++) {
      for (let x = 40; x < 280; x++) caption = Math.max(caption, at(x, y));
    }
    return { corner: at(4, 4), caption };
  });
  expect(a.corner).toBe(0);         // true alpha where nothing drew
  expect(a.caption).toBeGreaterThan(100); // caption ink is opaque
});

test("[OF-0358] post: studio preview shows the approximation label + CSS hint", async ({ page }) => {
  const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `ws5p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 Post" } })).ok()
        || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) break;
    } catch { /* ECONNRESET under load - retry */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  const spec = {
    ...captionSpec,
    layers: [{ id: "box", type: "box", props: { width: 2, height: 2, depth: 2, color: "#3366ff" } }],
    params: [],
    post: { mono: [{ t0: 0.4, t1: 1.2 }] },
  };
  const mk = await ctx.post("/api/render/specs", { data: { spec } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();
  // the bare request context holds the session - hand its cookies to the page
  const state = await ctx.storageState();
  await ctx.dispose();
  await page.context().addCookies(state.cookies);

  await page.goto(`/motion-graphics?id=${id}`);
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("post fx · preview approximation")).toBeVisible();

  // pause, scrub into the mono window → the CSS hint flips on
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByLabel("Seek").fill("0.8");
  await page.waitForTimeout(300);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).style.filter)).toContain("grayscale");

  await page.getByLabel("Seek").fill("1.6");
  await page.waitForTimeout(300);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).style.filter)).not.toContain("grayscale");
});

/* ---------- node-side video probes ---------- */

/** bright-pixel count in the bottom third of a video frame at t */
function burnedInk(file: string, t: number, w = 320, h = 180): number {
  const raw = execFileSync(FFMPEG, [
    "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-v", "error", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 24 });
  let n = 0;
  for (let i = Math.floor(w * h * 2 / 3); i < raw.length; i++) if (raw[i] > 200) n++;
  return n;
}

/** mean luma + channel deltas of frame index n (rgb24), for post checks */
function frameStats(file: string, n: number): { luma: number; diffRG: number; diffGB: number } {
  const raw = execFileSync(FFMPEG, [
    "-v", "error", "-i", file, "-vf", `select='eq(n,${n})'`, "-vsync", "0",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26 });
  let luma = 0, rg = 0, gb = 0;
  const px = raw.length / 3;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rg += Math.abs(r - g);
    gb += Math.abs(g - b);
  }
  return { luma: luma / px, diffRG: rg / px, diffGB: gb / px };
}

function frameCount(file: string): number {
  const j = JSON.parse(execFileSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "json", file,
  ], { encoding: "utf8" })) as { streams: { nb_read_frames: string }[] };
  return Number(j.streams[0].nb_read_frames);
}

test("[OF-0357] burnCaptions: real mp4 → burned words in windows, aac audio, same frame count, parseable sidecars", async () => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(path.join(tmpdir(), "of-burn-"));
  try {
  const src = path.join(dir, "src.mp4");
  const out = path.join(dir, "burned.mp4");
  execFileSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=3:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);

  const { burnCaptions } = await import("@/lib/captions/burn");
  const words = [
    { text: "HELLO", start: 0.5, end: 1.5 },
    { text: "WORLD", start: 1.9, end: 2.8 }, // 0.4s gap > breakGap → own cue
  ];
  const res = await burnCaptions({
    video: src, words, out, base, style: { size: 42, marginBottom: 24 },
    signal: AbortSignal.timeout(280_000),
  });

  // burned mp4: video stream ~3s, audio carried through as aac, frame count kept
  const probe = JSON.parse(
    execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", res.mp4], { encoding: "utf8" }),
  ) as { streams: { codec_type: string; codec_name: string; width: number; height: number }[]; format: { duration: string } };
  const vs = probe.streams.find((s) => s.codec_type === "video")!;
  expect(vs.codec_name).toBe("h264");
  expect([vs.width, vs.height]).toEqual([320, 180]);
  expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThan(0.5);
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  expect(audio?.codec_name).toBe("aac");
  expect(Math.abs(frameCount(res.mp4) - 72)).toBeLessThanOrEqual(1); // 3s × 24fps source

  // the caption ink lands inside the word windows - nowhere else
  expect(burnedInk(res.mp4, 1.0)).toBeGreaterThan(80);   // HELLO
  expect(burnedInk(res.mp4, 2.3)).toBeGreaterThan(80);   // WORLD
  expect(burnedInk(res.mp4, 0.2)).toBeLessThan(10);      // before HELLO
  expect(burnedInk(res.mp4, 1.7)).toBeLessThan(10);      // cue gap

  // sidecars: ASS PlayRes is the frame size; \k centiseconds sum to each cue's
  // length (±1 cs rounding); SRT/VTT parse to real cues
  const ass = readFileSync(res.ass, "utf8");
  expect(ass).toContain("PlayResX: 320");
  expect(ass).toContain("PlayResY: 180");
  // karaoke colour order: Primary = highlight, Secondary = base (the burn
  // fills sung words with the highlight colour)
  const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Default,"))!;
  const fields = styleLine.split(",");
  expect(fields[3]).toBe("&H004DD3FF");   // #ffd34d highlight → Primary
  expect(fields[4]).toBe("&H00FFFFFF");   // #ffffff base → Secondary
  const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  expect(dialogues.length).toBe(2);
  for (const line of dialogues) {
    const m = /^Dialogue: \d,(\d+):(\d+):(\d+)\.(\d+),(\d+):(\d+):(\d+)\.(\d+),/.exec(line)!;
    const startCs = (((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 100) + +m[4];
    const endCs = (((+m[5] * 60 + +m[6]) * 60 + +m[7]) * 100) + +m[8];
    const kSum = [...line.matchAll(/\{\\k(\d+)\}/g)].reduce((a, k) => a + Number(k[1]), 0);
    expect(Math.abs(kSum - (endCs - startCs))).toBeLessThanOrEqual(1);
  }

  const srt = readFileSync(res.srt, "utf8");
  const srtCues = srt.trim().split(/\n\n+/);
  expect(srtCues.length).toBe(2);
  expect(srtCues[0]).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\nHELLO$/);
  expect(srtCues[1]).toContain("WORLD");

  const vtt = readFileSync(res.vtt, "utf8");
  expect(vtt).toMatch(/^WEBVTT\n/);
  const vttCues = vtt.trim().split(/\n\n+/).slice(1);
  expect(vttCues.length).toBe(2);
  expect(vttCues[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} --> \d\d:\d\d:\d\d\.\d{3}\nHELLO$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const renderReady = Boolean(findEndpoint(MOTION_RENDER_ENDPOINT));

async function signupCtx(label: string) {
  const c = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await c.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 Own" } })).ok()
        || (await c.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return c;
    } catch { /* ECONNRESET under load - retry */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

test("Part D: user A's own upload as source → completed MP4 with audio + caption pixels", async () => {
  test.skip(!renderReady, "motion render endpoint not registered in the catalog yet");
  test.setTimeout(300_000);

  // user A owns a real upload - black video + sine so caption ink stands out
  const dir = mkdtempSync(path.join(tmpdir(), "of-own-"));
  try {
  const clip = path.join(dir, "clip.mp4");
  execFileSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=3:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  const a = await signupCtx("ws5od");
  const up = await a.post("/api/uploads", {
    multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(clip) } },
  });
  expect(up.status()).toBe(201);
  const { url: sourceUrl } = await up.json();
  expect(String(sourceUrl)).toMatch(/^\/files\//);

  const mk = await a.post("/api/render/specs", { data: { spec: captionSpec } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();
  const r = await a.post(`/api/render/motion/${id}/render`, { data: { source: sourceUrl } });
  expect(r.status()).toBe(201);
  const { job_id } = await r.json();

  let job: { status: string; outputs?: { type: string; url: string }[]; error?: string } | undefined;
  for (let i = 0; i < 200; i++) {
    job = (await (await a.get(`/api/jobs/${job_id}`)).json()).job;
    if (job && ["completed", "failed", "canceled"].includes(job.status)) break;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  expect(job?.status, job?.error).toBe("completed");

  const video = (job?.outputs ?? []).find((o) => o.type === "video" && o.url);
  expect(video?.url).toMatch(/^\/files\//);
  const vr = await a.get(video!.url);
  expect(vr.ok()).toBeTruthy();
  const out = path.join(dir, "overlay.mp4");
  writeFileSync(out, Buffer.from(await vr.body()));

  // audio carried through, caption pixels burned inside the word windows
  const probe = JSON.parse(
    execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", out], { encoding: "utf8" }),
  ) as { streams: { codec_type: string; codec_name: string }[] };
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  expect(audio?.codec_name).toBe("aac");
  expect(burnedInk(out, 0.7)).toBeGreaterThan(60);   // HELLO window
  expect(burnedInk(out, 2.3)).toBeGreaterThan(60);   // WORLD window
  await a.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlay mode refuses someone else's /files/… footage (job fails, not spawned)", async () => {
  test.skip(!renderReady, "motion render endpoint not registered in the catalog yet");
  test.setTimeout(120_000);

  // user A owns a real upload
  const dir = mkdtempSync(path.join(tmpdir(), "of-own-"));
  try {
  const clip = path.join(dir, "clip.mp4");
  execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=0.5:rate=24:size=64x64", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const a = await signupCtx("ws5oa");
  const up = await a.post("/api/uploads", {
    multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(clip) } },
  });
  expect(up.status()).toBe(201);
  const { url: sourceUrl } = await up.json();
  expect(String(sourceUrl)).toMatch(/^\/files\//);

  // user B: their own spec, A's footage
  const b = await signupCtx("ws5ob");
  const mk = await b.post("/api/render/specs", { data: { spec: captionSpec } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();
  const r = await b.post(`/api/render/motion/${id}/render`, { data: { source: sourceUrl } });
  expect(r.status()).toBe(201);
  const { job_id } = await r.json();

  let job: { status: string; error?: string } | undefined;
  for (let i = 0; i < 40; i++) {
    job = (await (await b.get(`/api/jobs/${job_id}`)).json()).job;
    if (job && ["completed", "failed", "canceled"].includes(job.status)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  expect(job?.status).toBe("failed");
  expect(String(job?.error ?? "")).toMatch(/source not found/i);
  await a.dispose();
  await b.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[OF-0358] export: post filtergraph pixels - mono is grayscale, flash is near-white, glow brightens", async () => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(path.join(tmpdir(), "of-exp-"));
  try {
  const specFile = path.join(dir, "spec.json");
  const out = path.join(dir, "out.mp4");
  const spec = {
    ...captionSpec,
    layers: [{ id: "box", type: "box", props: { width: 2, height: 2, depth: 2, color: "#ff6600" } }],
    duration: 0.5,
    params: [],
    // disjoint windows so each filter's pixels are checkable; "#fff" exercises
    // the #rgb normalisation and "#66ccffcc" the dropped alpha byte (1e)
    post: {
      mono: [{ t0: 0.05, t1: 0.2 }],
      flash: [{ t: 0.3, frames: 2, color: "#fff" }],
      glow: [{ t0: 0.4, t1: 0.5, strength: 0.8, color: "#66ccffcc" }],
    },
  };
  writeFileSync(specFile, JSON.stringify(spec));
  execFileSync(process.execPath, [
    "--experimental-strip-types", "scripts/render/export.ts",
    "--spec", specFile, "--out", out, "--base", base,
  ], { cwd: process.cwd(), stdio: "pipe", timeout: 240_000 });
  expect(existsSync(out)).toBe(true);
  const probe = JSON.parse(
    execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", out], { encoding: "utf8" }),
  ) as { streams: { codec_type: string; codec_name: string }[] };
  expect(probe.streams.find((s) => s.codec_type === "video")?.codec_name).toBe("h264");

  // frame 3 (t≈0.125) is inside the mono window → grayscale pixels
  const mono = frameStats(out, 3);
  expect(mono.diffRG).toBeLessThanOrEqual(3);
  expect(mono.diffGB).toBeLessThanOrEqual(3);
  // frame 7 (t≈0.29) is inside the 2-frame white flash → near-white luma
  expect(frameStats(out, 7).luma).toBeGreaterThan(235);
  // frame 10 (t≈0.417) is inside the glow window - screen-blend brightens vs
  // frame 0 (t=0, outside every window)
  expect(frameStats(out, 10).luma).toBeGreaterThan(frameStats(out, 0).luma);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[OF-0358] ramp: setptsExpr at speed 2 halves a 2 s testsrc; speed 1 keeps the frame count", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "of-ramp-"));
  try {
  const src = path.join(dir, "src.mp4");
  execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=duration=2:rate=24:size=64x64",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
  const { setptsExpr } = await import("@/lib/render/ramp");

  const retime = (expr: string, out: string) => execFileSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", src,
    // fps=24 re-samples at the source rate - the way a retime is actually muxed
    "-vf", `setpts='${expr}',fps=24`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);

  const fast = path.join(dir, "fast.mp4");
  retime(setptsExpr([{ t: 0, speed: 2 }]), fast);
  expect(Math.abs(frameCount(fast) - 24)).toBeLessThanOrEqual(1); // 48 source frames → 24

  const same = path.join(dir, "same.mp4");
  retime(setptsExpr([{ t: 0, speed: 1 }]), same);
  expect(Math.abs(frameCount(same) - 48)).toBeLessThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 export watchdog: a --base that never sets __of fails inside the deadline and leaves no orphans", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(tmpdir(), "of-exp-wd-"));
  try {
  const specFile = path.join(dir, "spec.json");
  const out = path.join(dir, "out.mp4");
  // one frame → deadline = 60 s + 2 s = 62 s
  writeFileSync(specFile, JSON.stringify({ ...captionSpec, duration: 1 / 24, params: [] }));

  // a local HTTP server that serves a page which never defines window.__of
  const stub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><p>no render handle here</p></body></html>");
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = (stub.address() as AddressInfo).port;

  const t0 = Date.now();
  const proc = spawn(process.execPath, [
    "--experimental-strip-types", "scripts/render/export.ts",
    "--spec", specFile, "--out", out, "--base", `http://127.0.0.1:${stubPort}`,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.resume();
  proc.stderr?.resume();

  // snapshot the exporter's live process tree while the render is stuck -
  // every one of those pids must be dead once the watchdog fires
  const descendants = new Set<number>();
  const collect = () => {
    try {
      const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
      const parent = new Map<number, number>();
      for (const line of ps.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid) parent.set(pid, ppid);
      }
      const under = (p: number) => {
        let cur = p;
        for (let i = 0; i < 40; i++) {
          const pp = parent.get(cur);
          if (pp == null) return false;
          if (pp === proc.pid) return true;
          cur = pp;
        }
        return false;
      };
      for (const pid of parent.keys()) if (under(pid)) descendants.add(pid);
    } catch { /* ps is best-effort */ }
  };
  const samplers = [8_000, 30_000, 55_000].map((ms) => setTimeout(collect, ms));

  const code = await new Promise<number>((res) => {
    proc.on("close", (c) => res(c ?? 1));
    setTimeout(() => res(-9), 120_000); // test-level bound, above the spec deadline
  });
  const elapsed = Date.now() - t0;
  samplers.forEach(clearTimeout);
  stub.close();

  expect(code).not.toBe(0);                       // watchdog / waitForFunction path exits ≠0
  expect(elapsed).toBeLessThan(62_000 + 5_000);   // inside deadline + 5 s
  expect(existsSync(out)).toBe(false);           // never wrote a file

  // no orphaned chromium or ffmpeg: every collected descendant must be dead
  const alive: number[] = [];
  for (const pid of descendants) {
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); }
      catch { break; }
      if (i === 29) alive.push(pid);
    }
  }
  expect(alive).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
