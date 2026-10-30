/* Headless Stage → control/previz video exporter.
 *
 *   node --experimental-strip-types scripts/render/stage.ts \
 *     --job <job.json> --base http://localhost:PORT
 *
 * Job file:
 *   { "scene": <StageScene>, "startS": <sec>, "fps": 16, "frames": <4n+1>,
 *     "passes": [ { "kind": "previz"|"depth"|"pose", "w": N, "h": N, "out": "…mp4" } ] }
 *
 * Loads the app's /render/stage page with the scene injected, then for each
 * pass calls __ofStage.setPass + renderFrame(i), piping PNG frames to ffmpeg
 * (libx264, yuv420p). Each pass writes <out>.part and renames at the end —
 * a killed run never leaves a "finished" mp4. Deadlines: 60 s + 2 s/frame.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { chromium, type Browser } from "playwright-core";

type Pass = { kind: "previz" | "depth" | "pose"; w: number; h: number; out: string };
type JobSpec = { scene: unknown; startS?: number; fps?: number; frames: number; passes: Pass[] };

const argv = process.argv.slice(2);
const args: { job?: string; base?: string } = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--job") args.job = argv[++i];
  else if (argv[i] === "--base") args.base = argv[++i];
}
if (!args.job || !args.base) {
  console.error("usage: stage.ts --job job.json --base http://localhost:PORT");
  process.exit(2);
}

let job: JobSpec;
try {
  job = JSON.parse(fs.readFileSync(path.resolve(args.job), "utf8")) as JobSpec;
  if (!job.scene || !job.frames || !Array.isArray(job.passes) || !job.passes.length) throw new Error("bad shape");
} catch (e) {
  console.error(`stage: invalid job file: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const base = new URL(args.base!).origin;
const FFMPEG = process.env.MOTIONFIELD_FFMPEG || process.env.FFMPEG_BIN || "ffmpeg";

class ExportError extends Error { name = "ExportError"; }
const fail = (m: string): never => { throw new ExportError(m); };

async function main() {
  const frames = Math.max(1, job.frames);
  const total = frames * job.passes.length;
  const deadlineMs = 60_000 + total * 2_000;
  const startedAt = Date.now();

  let browser: Browser | null = null;
  let ff: ChildProcess | null = null;
  let ffGone: Promise<never> | null = null;

  const watchdog = setTimeout(() => {
    console.error(`stage: deadline exceeded (60 s + 2 s/frame × ${total}) — killing render`);
    try { ff?.kill("SIGKILL"); } catch { /* gone */ }
    void browser?.close().catch(() => {});
    setTimeout(() => process.exit(1), 1500);
  }, deadlineMs);
  watchdog.unref();

  let cleanupP: Promise<void> | null = null;
  const cleanup = () => (cleanupP ??= (async () => {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    if (ff && ff.exitCode == null) ff.kill("SIGKILL");
    for (const p of job.passes) {
      try { fs.rmSync(`${p.out}.part`, { force: true }); } catch { /* gone */ }
    }
  })());

  const onSignal = () => {
    void cleanup().finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 6_000).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
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
    const maxW = Math.max(...job.passes.map((p) => p.w));
    const maxH = Math.max(...job.passes.map((p) => p.h));
    const page = await browser.newPage({ viewport: { width: maxW, height: maxH } });
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`[page:error]`, m.text().slice(0, 300));
    });
    // same-origin lockdown — only --base may be fetched
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== base) {
        return route.abort();
      }
      return route.continue();
    });
    await page.addInitScript(
      (payload) => { (window as { __OF_STAGE_RENDER__?: unknown }).__OF_STAGE_RENDER__ = payload; },
      { scene: job.scene, startS: job.startS ?? 0, fps: job.fps ?? 16, frames },
    );
    await page.goto(`${base}/render/stage`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const remaining = () => Math.max(1000, deadlineMs - (Date.now() - startedAt));
    await page.waitForFunction(
      () => Boolean(
        (window as { __ofStage?: unknown; __ofStageError?: string }).__ofStage
          || (window as { __ofStageError?: string }).__ofStageError,
      ),
      null,
      { timeout: remaining() },
    ).catch((e) => fail(`render page never became ready: ${e instanceof Error ? e.message : e}`));
    const pageErr = await page.evaluate(
      () => (window as { __ofStageError?: string }).__ofStageError ?? null,
    );
    if (pageErr) fail(`scene build failed: ${pageErr}`);
    await page.evaluate(
      () => (window as { __ofStage?: { ready: Promise<void> } }).__ofStage!.ready,
    );

    let done = 0;
    for (const [pi, p] of job.passes.entries()) {
      const part = `${p.out}.part`;
      ff = spawn(FFMPEG, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-c:v", "png", "-framerate", String(job.fps ?? 16), "-i", "pipe:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-r", String(job.fps ?? 16), "-an", "-f", "mp4", part,
      ], { stdio: ["pipe", "ignore", "pipe"] });
      let ffErr = "";
      ff.stderr!.on("data", (d) => { ffErr = (ffErr + String(d)).slice(-3000); process.stderr.write(d); });
      ff.on("error", (e) => { ffErr += `\nstage: failed to spawn ffmpeg (${e.message}) — is ffmpeg on PATH?`; });
      ff.stdin!.on("error", (e) => { ffErr += `\nstage: ffmpeg stdin: ${(e as Error).message}`; });
      ffGone = new Promise<never>((_res, rej) => {
        ff!.once("error", (e) => rej(e));
        ff!.once("close", (c) => rej(new Error(`ffmpeg exited mid-write (${c})${ffErr ? `: ${ffErr.trim().slice(-300)}` : ""}`)));
      });
      ffGone.catch(() => {});

      await page.evaluate(
        ({ p: pp }) => (window as { __ofStage?: { setPass(x: { kind: string; w: number; h: number }): void } })
          .__ofStage!.setPass(pp),
        { p: { kind: p.kind, w: p.w, h: p.h } },
      );

      for (let i = 0; i < frames; i++) {
        if (Date.now() > startedAt + deadlineMs) fail(`exceeded render deadline at frame ${i}/${frames}`);
        const dataUrl: string = await page.evaluate(
          ({ ii }) => (window as { __ofStage?: { renderFrame(x: number): Promise<string> } })
            .__ofStage!.renderFrame(ii),
          { ii: i },
        );
        const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        const ok = ff!.stdin!.write(buf);
        if (!ok) {
          await Promise.race([
            new Promise((r) => ff!.stdin!.once("drain", r)),
            ffGone!,
          ]);
        }
        done += 1;
        if (done % 8 === 0 || done === total) console.log(`frame ${done}/${total}`);
      }

      await Promise.race([
        new Promise<void>((res) => { ff!.stdin!.end(); ff!.stdin!.once("finish", res); }),
        ffGone!,
      ]);
      const code = await new Promise<number>((res) => {
        if (ff!.exitCode !== null) { res(ff!.exitCode); return; }
        ff!.once("close", (c) => res(c ?? 1));
      });
      if (code !== 0) fail(`ffmpeg exited ${code}${ffErr ? `: ${ffErr.trim()}` : ""}`);
      fs.renameSync(part, p.out); // publish only a complete mp4
      console.log(`stage: wrote ${p.out} (${frames} frames @ ${job.fps ?? 16}fps, ${p.kind} ${p.w}x${p.h})`);
      ff = null;
      ffGone = null;
    }
  } finally {
    await cleanup();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

main().then(() => { process.exitCode = 0; }).catch((e) => {
  console.error(`stage: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
