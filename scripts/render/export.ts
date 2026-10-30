/* Headless SceneSpec → MP4 exporter for local renders.
 *
 *   node --experimental-strip-types scripts/render/export.ts \
 *     --spec <spec.json> --out <out.mp4> [--base http://localhost:PORT]
 *     [--params '{"speed":2}'] [--video <source.mp4>]
 *
 * How it works:
 *  - spawns ffmpeg reading PNG frames on stdin (libx264, yuv420p)
 *  - launches headless Chromium (SwiftShader — deterministic CPU GL)
 *  - loads the app's /render/motion page and injects the spec as
 *    window.__OF_SPEC__ — the same code path as the live preview
 *  - calls __of.renderAt(i/fps) per frame, pulls canvas PNG, pipes to ffmpeg
 *
 * With --video the spec is rendered transparent at the source's size/fps/
 * duration and composited over it (PNG frames arrive as ffmpeg's second
 * input); the source's audio is copied through.
 * spec.post (mono/flash/glow windows) is applied in the ffmpeg filtergraph in
 * either mode — the live preview only ever approximates it.
 * Deadlines: 60 s + 2 s/frame hard wall-clock — a hung page.evaluate or a
 * blocked stdin drain gets the browser closed and ffmpeg SIGKILLed.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import type { SceneSpec } from "../../src/lib/render/spec";

/* ---------- args ---------- */
type Args = { spec: string; out: string; base?: string; params?: string; video?: string };
const argv = process.argv.slice(2);
const args: Args = { spec: "", out: "" };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--spec") args.spec = argv[++i];
  else if (argv[i] === "--out") args.out = argv[++i];
  else if (argv[i] === "--base") args.base = argv[++i];
  else if (argv[i] === "--params") args.params = argv[++i];
  else if (argv[i] === "--video") args.video = argv[++i];
}
if (!args.spec || !args.out) {
  console.error("usage: export.ts --spec spec.json --out out.mp4 [--base URL] [--params JSON] [--video source]");
  process.exit(2);
}

const specPath = path.resolve(args.spec);
const outPath = path.resolve(args.out);
/* ffmpeg writes to <out>.part — the .mp4 only appears as an atomic rename at
 * the very end, so a failed/killed export can never leave a "finished" file */
const partPath = `${outPath}.part`;
const videoPath = args.video ? path.resolve(args.video) : undefined;

class ExportError extends Error { name = "ExportError"; }
/* throws (never process.exit) — failures inside main() must run the finally
 * that kills ffmpeg/Chromium/a spawned dev server */
function fail(msg: string): never {
  throw new ExportError(msg);
}

/* ---------- spec ----------
 * Trusted-shape load: callers (the motion-render recipe, burnCaptions) already
 * ran parseSceneSpec upstream — the browser page would fail a malformed spec
 * anyway. Only the fields this script itself needs get sanity-checked. */
let spec: SceneSpec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as SceneSpec;
  if (spec.version !== 1 || !Array.isArray(spec.layers)) throw new Error("not a SceneSpec v1");
} catch (e) {
  // nothing spawned yet — a direct exit is the whole cleanup
  console.error(`export: invalid spec: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

/* ---------- ffprobe (overlay mode) ---------- */
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";
interface SourceInfo { width: number; height: number; fps: number; duration: number; hasAudio: boolean }

/** ffprobe -print_format json — validated, never cast */
const ffprobeJson = z.object({
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
  })).optional(),
  format: z.object({ duration: z.string().optional() }).optional(),
});

function probeSource(video: string): SourceInfo {
  let j: z.infer<typeof ffprobeJson>;
  try {
    const raw = execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", video], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    j = ffprobeJson.parse(JSON.parse(raw));
  } catch (e) {
    fail(`could not probe --video source: ${e instanceof Error ? e.message : e}`);
  }
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) fail("--video source has no video stream");
  const rate = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : (v.r_frame_rate ?? "24/1");
  const [rn, rd] = rate.split("/").map(Number);
  const fps = rd ? rn / rd : rn || 24;
  const duration = Number(j.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail("--video source has no usable duration");
  return { width: v.width, height: v.height, fps, duration, hasAudio: Boolean(j.streams?.some((s) => s.codec_type === "audio")) };
}

let source: SourceInfo | null = null;
try {
  source = videoPath ? probeSource(videoPath) : null;
} catch (e) {
  console.error(`export: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (source) {
  spec = {
    ...spec,
    width: source.width,
    height: source.height,
    fps: source.fps,
    duration: source.duration,
    background: { transparent: true },
  };
}

const frames = Math.max(1, Math.round(spec.duration * spec.fps));
const paramJson = args.params ? JSON.parse(args.params) as Record<string, number> : null;

/* ---------- ffmpeg ---------- */
const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";

/**
 * Filter graph — rendered PNGs are the last input (index `pipeIdx`).
 * Video mode: [src][pipe]overlay → post chain.
 * Bare mode:  [pipe] → post chain.
 * post = mono (hue=s=0 windows) → flash (color overlay frames) → glow
 * (split→gblur→blend screen); if()/enable commas are single-quoted for the
 * ffmpeg lexer.
 */
function buildFilterGraph(pipeIdx: number, src: SourceInfo | null): string {
  const post = spec.post;
  const chains: string[] = [];
  let cur: string;
  let n = 0;
  const next = () => `x${n++}`;

  if (src) {
    cur = next();
    chains.push(`[0:v][${pipeIdx}:v]overlay=0:0:eof_action=pass[${cur}]`);
  } else {
    cur = `${pipeIdx}:v`;
  }

  for (const w of post?.mono ?? []) {
    const o = next();
    chains.push(`[${cur}]hue=s=0:enable='between(t,${w.t0},${w.t1})'[${o}]`);
    cur = o;
  }
  // flash color inputs sit between the video input (0) and the pipe — their
  // indices are 1..F in video mode, 0..F-1 bare
  const flashes = post?.flash ?? [];
  flashes.forEach((f, i) => {
    const o = next();
    const n0 = Math.round(f.t * spec.fps);
    const n1 = n0 + f.frames - 1;
    const inIdx = (src ? 1 : 0) + i;
    chains.push(`[${cur}][${inIdx}:v]overlay=0:0:enable='between(n,${n0},${n1})':eof_action=pass[${o}]`);
    cur = o;
  });
  for (const w of post?.glow ?? []) {
    const a = next();
    const b = next();
    const g = next();
    const o = next();
    const sigma = Math.max(0.5, 4 + w.strength * 26);
    const glowStage = w.color
      ? (() => {
        const [r, gg, bb] = hexRgb01(w.color!);
        return `[${b}]gblur=sigma=${fmt(sigma)},geq=r='r(X,Y)*${fmt(r)}':g='g(X,Y)*${fmt(gg)}':b='b(X,Y)*${fmt(bb)}'[${g}]`;
      })()
      : `[${b}]gblur=sigma=${fmt(sigma)}[${g}]`;
    chains.push(
      `[${cur}]split[${a}][${b}]`,
      glowStage,
      `[${a}][${g}]blend=all_mode='screen':enable='between(t,${w.t0},${w.t1})'[${o}]`,
    );
    cur = o;
  }

  // libx264 needs even dims — guard odd sources/specs
  const o = next();
  chains.push(`[${cur}]scale=trunc(iw/2)*2:trunc(ih/2)*2[${o}]`);
  return `${chains.join(";")}`;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** "#rgb" | "#rrggbb" | "#rrggbbaa" → "rrggbb" (alpha byte dropped), else null */
function toHex6(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return h.slice(0, 6);
}

function hexRgb01(hex: string): [number, number, number] {
  const h = toHex6(hex);
  return h
    ? [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
    : [1, 1, 1];
}

/* ---------- dev server ---------- */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer().listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(p));
    }).on("error", rej);
  });
}

async function waitHttp(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* retry */ }
    await wait(400);
  }
  return false;
}

async function main() {
  const framesN = frames;
  const deadlineMs = 60_000 + framesN * 2_000;

  let ff: ChildProcess | null = null;
  let browser: Browser | null = null;
  let server: ChildProcess | null = null;
  /** rejects when ffmpeg dies/errors — stdin drain/finish waits race this so
   *  a dead encoder fails the render fast instead of hanging to the watchdog */
  let ffGone: Promise<never> | null = null;

  /* hard wall-clock watchdog — covers a hung page.evaluate, a blocked stdin
   * drain, or a wedged ffmpeg alike: SIGKILL the children, exit 1 */
  const startedAt = Date.now();
  const killServerGroup = (sig: "SIGTERM" | "SIGKILL") => {
    if (!server?.pid) return;
    try { process.kill(-server.pid, sig); } catch { try { server!.kill(sig); } catch { /* gone */ } }
  };
  const watchdog = setTimeout(() => {
    console.error(`export: deadline exceeded (60 s + 2 s/frame × ${framesN}) — killing render`);
    try { ff?.kill("SIGKILL"); } catch { /* best effort */ }
    killServerGroup("SIGKILL");
    // playwright kills the driver (and its chromium) on process exit — the
    // ref'd timer keeps the loop alive just long enough for that
    void browser?.close().catch(() => {});
    setTimeout(() => process.exit(1), 1500);
  }, deadlineMs);
  watchdog.unref();

  /** One cleanup path — the finally below and the signal handlers both run
   *  it: browser close, ffmpeg SIGKILL, TERM→(5 s bound)→KILL on the
   *  self-spawned dev-server group. */
  // one shared promise — the finally and a signal handler await the SAME
  // in-flight cleanup; a second caller never double-runs or finishes early
  let cleanupP: Promise<void> | null = null;
  const cleanup = () => (cleanupP ??= (async () => {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    if (ff && ff.exitCode == null) ff.kill("SIGKILL");
    // a failed run must not leave a half-written mp4 masquerading as output
    try { fs.rmSync(partPath, { force: true }); } catch { /* best effort */ }
    if (server?.pid) {
      const pid = server.pid;
      const gone = new Promise<boolean>((res) => {
        if (server!.exitCode !== null) return res(true);
        server!.once("exit", () => res(true));
        setTimeout(() => res(false), 5_000); // bounded wait — never unref'd
      });
      try { process.kill(-pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
      if (!(await gone)) {
        // turbopack children can outlive a TERM — final sweep
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  })());

  /* SIGTERM/SIGINT → the same cleanup as the finally, then 143. Without this
   * a killed exporter left its dev-server/chromium group running. */
  const onSignal = () => {
    void cleanup().finally(() => process.exit(143));
    // if cleanup itself wedges (browser.close never settles) still die
    setTimeout(() => process.exit(143), 6_000).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    /* ffmpeg first so its stdin is ready when frames arrive */
    const { ffArgs } = (() => {
      const flashes = spec.post?.flash ?? [];
      const a: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
      if (source) a.push("-i", videoPath!);
      for (const f of flashes) {
        // ffmpeg color=c takes 0xRRGGBB — #rgb expands, #rrggbbaa drops alpha
        const c = toHex6(f.color ?? "#ffffff") ?? "ffffff";
        a.push("-f", "lavfi", "-i", `color=c=0x${c}:s=${spec.width}x${spec.height}:r=${fmt(spec.fps)}`);
      }
      const pipeIdx = (source ? 1 : 0) + flashes.length;
      a.push("-f", "image2pipe", "-c:v", "png", "-framerate", fmt(spec.fps), "-i", "pipe:0");
      const graph = buildFilterGraph(pipeIdx, source);
      const outLabel = (() => {
        // the final labeled output of the chain
        const labels = [...graph.matchAll(/\[x\d+\]/g)].map((m) => m[0]);
        return labels[labels.length - 1];
      })();
      a.push("-filter_complex", graph, "-map", outLabel);
      if (source?.hasAudio) a.push("-map", "0:a?", "-c:a", "aac"); // mp4 audio is always aac
      a.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", fmt(spec.fps), "-f", "mp4", partPath);
      return { ffArgs: a };
    })();

    ff = spawn(FFMPEG, ffArgs, { stdio: ["pipe", "ignore", "pipe"] });
    let ffErr = "";
    ff.stderr!.on("data", (d) => { ffErr = (ffErr + String(d)).slice(-3000); process.stderr.write(d); });
    ff.on("error", (e) => { ffErr += `\nexport: failed to spawn ffmpeg (${e.message}) — is ffmpeg on PATH?`; });
    ff.stdin!.on("error", (e) => { ffErr += `\nexport: ffmpeg stdin: ${(e as Error).message}`; });
    // rejects the moment ffmpeg is gone — drain/finish waits race this so a
    // dead encoder surfaces as its own error, not a watchdog timeout
    ffGone = new Promise<never>((_res, rej) => {
      ff!.once("error", (e) => rej(e));
      ff!.once("close", (c) => rej(new Error(`ffmpeg exited mid-write (${c})${ffErr ? `: ${ffErr.trim().slice(-300)}` : ""}`)));
    });
    ffGone.catch(() => {}); // raced at write sites — an unwatched rejection would crash the run

    /* dev server: a --base is used as-is — a cold compile just means it's
     * slow, so it gets the whole deadline (never spawn a second server, that
     * doubles RAM and splits rendering). Only an absent --base spawns our
     * own — detached, so kill(-pid) reaps turbopack children too. */
    let base = args.base;
    if (base) {
      // normalize to the origin — a trailing slash or a stray path would
      // mis-join `${base}/render/motion` and the page lockdown would wrongly
      // keep allowing (or silently break) the request
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") fail("--base must be an http(s) URL");
      base = u.origin;
    }
    if (!base) {
      const port = await freePort();
      const target = `http://localhost:${port}`;
      /* respawn once on an early exit: agent-aware CLIs can self-terminate on
       * their first spawn in a fresh project dir (one-shot nudge receipts);
       * the respawn in the same project lands past the marker. A server that
       * survives is never killed here — we fail on the wait instead. */
      for (let attempt = 1; attempt <= 2; attempt++) {
        server = spawn(process.execPath, [path.join(process.cwd(), "node_modules/next/dist/bin/next"), "dev", "-p", String(port)], {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, PORT: String(port) },
          detached: true,
        });
        server.unref();
        let srvLog = "";
        server.stderr!.on("data", (d) => { srvLog = (srvLog + String(d)).slice(-3000); });
        server.on("error", (e) => { console.error(`export: dev server spawn failed: ${e.message}`); });
        const exited = new Promise<"exit">((res) => server!.once("exit", () => res("exit")));
        const up = await Promise.race([
          waitHttp(`${target}/render/motion`, Math.max(5000, deadlineMs - (Date.now() - startedAt))),
          exited,
        ]);
        if (up === true) { base = target; break; }
        killServerGroup("SIGKILL");
        server = null;
        if (up === "exit" && attempt === 1) {
          console.error("export: dev server exited before serving — respawning once");
          continue;
        }
        fail(`dev server did not come up on ${target}${srvLog ? ` - ${srvLog.trim().slice(-1500)}` : ""}`);
      }
    } else {
      const up = await waitHttp(`${base}/render/motion`, Math.max(5000, deadlineMs - (Date.now() - startedAt)));
      if (!up) fail(`--base ${base} did not answer before the deadline`);
    }
    if (!base) fail("dev server did not come up — pass --base <url> to use a running app");

    /* headless Chromium — chromiumSandbox keeps the OS sandbox on
     * (no --no-sandbox/--disable-gpu-sandbox flags); SwiftShader supplies
     * the deterministic CPU GL */
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: [
          "--headless=new",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Executable doesn't exist|playwright install|browser.*(not|isn't) installed/i.test(msg)) {
        fail("Chromium for rendering isn't installed — run: npx playwright install chromium");
      }
      throw e;
    }
    const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height } });
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console.error(`[page:${m.type()}]`, m.text().slice(0, 300));
    });
    // same-origin lockdown — only --base may be fetched (A5)
    const allowedOrigin = new URL(base).origin;
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== allowedOrigin) {
        return route.abort();
      }
      return route.continue();
    });
    // the spec must exist before the page's own scripts run — an evaluate
    // after goto races loadSpec() and shows up as "no spec"
    await page.addInitScript((s) => { (window as { __OF_SPEC__?: unknown }).__OF_SPEC__ = s; }, spec);
    await page.goto(`${base}/render/motion`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const remaining = () => Math.max(1000, deadlineMs - (Date.now() - startedAt));
    await page.waitForFunction(
      () => Boolean((window as { __of?: unknown; __ofError?: string }).__of
        || (window as { __ofError?: string }).__ofError),
      null,
      { timeout: remaining() },
    ).catch((e) => {
      fail(`render page never became ready: ${e instanceof Error ? e.message : e}`);
    });
    // a bad spec resolves __ofError (a string), not __of — read it directly
    const pageErr = await page.evaluate(() => (window as { __ofError?: string }).__ofError ?? null);
    if (pageErr) fail(`scene build failed: ${pageErr}`);
    await page.evaluate(() => (window as { __of?: { ready: Promise<void> } }).__of!.ready);

    if (paramJson) {
      await page.evaluate(
        ({ values }) => (window as { __of?: { setParams(v: Record<string, number>): void } }).__of!.setParams(values),
        { values: paramJson },
      );
    }

    for (let i = 0; i < framesN; i++) {
      if (Date.now() > startedAt + deadlineMs) fail(`exceeded render deadline at frame ${i}/${framesN}`);
      const t = i / spec.fps;
      const dataUrl: string = await page.evaluate(
        ({ tt }) => new Promise<string>((resolve, reject) => {
          const of = (window as { __of?: { renderAt(t: number): Promise<void>; spec: { width: number } } }).__of;
          if (!of) { reject(new Error("window.__of missing")); return; }
          of.renderAt(tt).then(() => {
            const cv = document.querySelector("canvas");
            if (!cv) { reject(new Error("no canvas")); return; }
            resolve(cv.toDataURL("image/png"));
          }).catch(reject);
        }),
        { tt: t },
      );
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      const ok = ff!.stdin!.write(buf);
      if (!ok) {
        // a dead ffmpeg never drains — race the wait against its close/error
        await Promise.race([
          new Promise((r) => ff!.stdin!.once("drain", r)),
          ffGone!,
        ]);
      }
      // stdout — the render recipe parses "frame i/N" for job progress (A9)
      if (i % 8 === 0 || i === framesN - 1) console.log(`frame ${i + 1}/${framesN}`);
    }

    await Promise.race([
      new Promise<void>((res) => {
        ff!.stdin!.end();
        ff!.stdin!.once("finish", res);
      }),
      ffGone!,
    ]);
    const code = await new Promise<number>((res) => {
      if (ff!.exitCode !== null) { res(ff!.exitCode); return; }
      ff!.once("close", (c) => res(c ?? 1));
    });
    if (code !== 0) fail(`ffmpeg exited ${code}${ffErr ? `: ${ffErr.trim()}` : ""}`);
    fs.renameSync(partPath, outPath); // ffmpeg is done and clean — publish

    console.log(`export: wrote ${outPath} (${framesN} frames @ ${spec.fps}fps${source ? ", overlay" : ""})`);
  } finally {
    // handlers stay armed until the shared cleanup resolves — a TERM landing
    // in this window still takes the graceful path instead of the default kill
    await cleanup();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

main().then(() => { process.exitCode = 0; }).catch((e) => {
  console.error(`export: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
