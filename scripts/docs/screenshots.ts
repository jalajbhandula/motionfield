/* screenshots.ts — regenerate every README screenshot, headless.

   Boots `next dev` on PORT (default 3399) with the mock provider, signs up
   a throwaway demo user, submits two public mock jobs so the feed/history
   have real content, then captures the live pages into docs/screenshots/.

     node --experimental-strip-types scripts/docs/screenshots.ts [--port N] [--keep]

   Re-run it whenever pages change — the README embeds these files. */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";

const OUT = join(process.cwd(), "docs", "screenshots");
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1] || process.env.PORT || 3399);
const BASE = `http://localhost:${PORT}`;
const KEEP = args.includes("--keep");

/* (href, filename) — the shots the README embeds. Finished pages only. */
const SHOTS: [string, string][] = [
  ["/", "home.png"],
  ["/ai/image", "image.png"],
  ["/ai/video", "video.png"],
  ["/ai-assistant", "assistant.png"],
  ["/games", "games.png"],
  ["/product-ads", "ads.png"],
  ["/scene-3d", "scene3d.png"],
  ["/dub-translate", "dub.png"],
  ["/audio", "audio.png"],
  ["/canvas", "canvas.png"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await sleep(800);
  }
  throw new Error(`server at ${url} never came up`);
}

async function signUp(ctx: BrowserContext): Promise<void> {
  const r = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: {
      email: `docs-${Date.now()}@shots.local`,
      password: "docs-shots-pass-1",
      name: "Demo User",
    },
  });
  if (!r.ok()) throw new Error(`signup failed: ${r.status()} ${await r.text()}`);
}

/** One public image + one public video through the mock provider so the
 *  gallery/feed/history screenshots carry real generated content. */
async function seedJobs(ctx: BrowserContext): Promise<void> {
  const specs: [string, Record<string, unknown>][] = [
    ["motionfield/z-image-turbo/text-to-image",
      { prompt: "a lone figure under a copper sunset, cinematic haze" }],
    ["motionfield/wan-2.1/text-to-video",
      { prompt: "slow dolly across a rain-lit street at night" }],
  ];
  for (const [endpoint_id, params] of specs) {
    const r = await ctx.request.post(`${BASE}/api/jobs`, {
      data: { endpoint_id, params, visibility: "public" },
    });
    if (!r.ok()) { console.warn(`seed job ${endpoint_id}: ${r.status()} (page still shoots)`); continue; }
    const { job } = (await r.json()) as { job: { id: string } };
    for (let i = 0; i < 60; i++) {
      const j = await ctx.request.get(`${BASE}/api/jobs/${job.id}`);
      const st = ((await j.json()) as { job: { status: string } }).job.status;
      if (st === "completed" || st === "failed") break;
      await sleep(1000);
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  let server: ChildProcess | null = null;
  const selfHosted = process.env.SHOTS_BASE === undefined;
  const base = process.env.SHOTS_BASE ?? BASE;
  if (selfHosted) {
    server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
      env: {
        ...process.env,
        GENERATION_PROVIDER: "mock",
        BETTER_AUTH_URL: base,
        PUBLIC_BASE_URL: base,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    server.stdout?.on("data", () => {});
    process.on("exit", () => server?.kill("SIGTERM"));
  }
  await waitReady(base, 180_000);
  console.log(`· server ready at ${base}`);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await signUp(ctx);
    await seedJobs(ctx);
    const page = await ctx.newPage();
    for (const [href, file] of SHOTS) {
      const r = await page.goto(`${base}${href}`, { waitUntil: "domcontentloaded" });
      if (!r || r.status() >= 400) { console.warn(`skip ${href}: ${r?.status()}`); continue; }
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(400);                                  // let fonts/animations settle
      await page.screenshot({ path: join(OUT, file) });
      console.log(`✓ ${file}  ← ${href}`);
    }
  } finally {
    await browser.close();
    if (!KEEP) server?.kill("SIGTERM");
  }
  console.log(`done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
