#!/usr/bin/env tsx
/**
 * record-live.ts — gpu-batch.md Order 11's four LIVE demo shots.
 *
 * Same driver style as scripts/demo/capture.ts: headless Chromium,
 * Playwright recordVideo at 1920×1080, one real job per shot driven through
 * the app's own UI — the recording keeps the real submit→result wait so the
 * edit can label it "sped up N×" from index.json's render_s.
 *
 *   --shot <id|all>     director · reshoot · vfx-lab · klein-edit · all (default)
 *                       (order ids 11.1–11.4 are accepted aliases)
 *   --base-url <url>    app under test (default http://localhost:3150)
 *   --out <dir>         clip dir (default <repo>/../of-reports/evidence/demo-live)
 *   --effect <g>        11.3's winning Order-4 graph: plate|image|keyframe
 *                       (default plate — the graph 4.5–4.7 judged best on the day)
 *   --vfx-preset <id|label>  pin the 11.3 effect preset (default: first verified)
 *   --move <id>         11.2's re-shoot trajectory id (default arc-left-45 —
 *                       the catalog's "45° orbit left")
 *   --timeout-s <n>     per-shot result wait, seconds (default 900)
 *   --hold-s <n>        dwell on the landed result, seconds (default 3)
 *   --dry-run           print the resolved plan; launch nothing, write nothing
 *
 * Proof run (no GPU): GENERATION_PROVIDER=mock dev server on :3150 —
 *   tsx scripts/demo/record-live.ts --shot all
 * Mock clips must be deleted afterwards — they are never demo footage.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { provisionUser } from "./capture";
import { parseArgs, writeFixtures, REPO } from "./util";
import { trajectoryOf } from "../../src/lib/catalog/presets/trajectories";
import { vfxPresetById } from "../../src/lib/catalog/presets/vfx-lab";

/* ------------------------------- options -------------------------------- */

type VfxEffect = "plate" | "image" | "keyframe";

interface Opts {
  shot: string;
  base: string;
  out: string;
  effect: VfxEffect;
  vfxPreset?: string;
  move: string;
  timeoutMs: number;
  holdMs: number;
  dryRun: boolean;
  verbose: boolean;
}

interface ShotCtx extends Opts {
  page: Page;
  fixtures: Record<"clip" | "face", string>;
}

export interface LiveShotMeta {
  shot: string;                 // internal id + clip basename
  order: string;                // gpu-batch Order-11 row
  shotlist: string;             // demo-shotlist.md shot number
  title: string;
  route: string;
  endpoint_id: string | null;
  job_id: string | null;
  clip: string | null;          // "<shot>.webm" relative to the out dir
  /** wall seconds from Generate-click to result-on-screen — the "sped up
   *  N×" numerator the edit divides by the wait's on-screen length */
  render_s: number | null;
  hold_s: number;
  duration_s: number | null;    // whole clip, end to end
  ok: boolean;
  error?: string;
}

interface ShotDef {
  id: string;
  order: string;
  shotlist: string;
  title: string;
  route: (o: Opts) => string;
  run: (ctx: ShotCtx) => Promise<{ job_id: string; render_s: number }>;
}

const DIRECTOR_PROMPT =
  "A lone explorer crosses a neon-lit marsh at dusk — drone haze, volumetric glow";
const KLEIN_PROMPT = "make it night";

/* ------------------------------ helpers --------------------------------- */

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Click the submit control, capture the job id off the POST response, then
 * wait for the result to land on screen. `result` is either a locator
 * (vfx-output / reshoot-output) or "new-completed-tile" — the studio's job
 * grid: a *new* `[data-job-status="completed"]` tile over the count already
 * on screen, so a stale completed card can never satisfy the wait.
 * render_s is the wall span the recording shows between the click and the
 * result — the wait the edit retimes with its true "sped up N×" label.
 */
async function submitAndWatch(
  page: Page,
  click: Locator,
  postPath: string,
  result: Locator | "new-completed-tile",
  timeoutMs: number,
): Promise<{ job_id: string; render_s: number }> {
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes(postPath),
    { timeout: 60_000 },
  );
  const doneBefore = result === "new-completed-tile"
    ? await page.locator('[data-job-status="completed"]').count()
    : 0;
  const t0 = Date.now();
  await click.click();
  const resp = await posted;
  const body = (await resp.json().catch(() => null)) as { job?: { id?: string } } | null;
  if (!resp.ok()) throw new Error(`POST ${postPath} → ${resp.status()}: ${JSON.stringify(body).slice(0, 200)}`);
  const jobId = body?.job?.id;
  if (!jobId) throw new Error(`POST ${postPath} returned no job id`);
  if (result === "new-completed-tile") {
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-job-status="completed"]').length > n,
      doneBefore, { timeout: timeoutMs },
    );
  } else {
    await result.waitFor({ state: "visible", timeout: timeoutMs });
  }
  return { job_id: jobId, render_s: Math.round((Date.now() - t0) / 100) / 10 };
}

/** endpoint_id from the job row — recorded so the index pins which graph ran. */
async function jobEndpoint(page: Page, base: string, jobId: string): Promise<string | null> {
  try {
    const r = await page.context().request.get(`${base}/api/jobs/${jobId}`);
    const d = (await r.json()) as { job?: { endpointId?: string; endpoint_id?: string } };
    return d.job?.endpointId ?? d.job?.endpoint_id ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------- shots --------------------------------- */

const SHOTS: ShotDef[] = [
  {
    id: "director", order: "11.1", shotlist: "#2",
    title: "Director — dolly-in LIVE",
    route: () => "/ai/video?model=director",
    async run(ctx) {
      const { page } = ctx;
      // "Camera moves" is a text field — "dolly-in" is a catalog id, so it
      // executes on the trajectory rig rather than steering the prompt
      const moves = page.locator('input[placeholder*="dolly-in"]');
      await moves.waitFor({ state: "visible", timeout: 30_000 });
      await moves.fill("dolly-in");
      await page.locator("textarea").first().fill(DIRECTOR_PROMPT);
      return submitAndWatch(
        page,
        page.locator('button.btn-primary:has-text("Generate")'),
        "/api/jobs",
        "new-completed-tile",
        ctx.timeoutMs,
      );
    },
  },
  {
    id: "reshoot", order: "11.2", shotlist: "#3",
    title: "Re-shoot · New Camera Move — orbit-left LIVE",
    route: () => "/new-camera-move",
    async run(ctx) {
      const { page } = ctx;
      const label = trajectoryOf(ctx.move)?.label ?? ctx.move;
      await page.locator('input[type="file"][accept="video/*"]').setInputFiles(ctx.fixtures.clip);
      await page.getByTestId("probe-card").waitFor({ state: "visible", timeout: 60_000 });
      await page.getByTestId("move-chips")
        .getByRole("button", { name: new RegExp(`^${esc(label)}`) })
        .first().click();
      return submitAndWatch(
        page,
        page.getByRole("button", { name: "Apply new camera move" }),
        "/api/reshoot/submit",
        page.getByTestId("reshoot-output"),
        ctx.timeoutMs,
      );
    },
  },
  {
    id: "vfx-lab", order: "11.3", shotlist: "#5",
    title: "VFX Lab — LTX effect LIVE",
    route: () => "/visual-effects",
    async run(ctx) {
      const { page } = ctx;
      // plate kind: "plate" runs a clip plate (vfx-lab-plate graph);
      // "image"/"keyframe" run a still plate (vfx-lab-image graph — keyframe
      // adds a klein-made end frame, the keyframe-effect mechanism)
      if (ctx.effect === "plate") {
        await page.locator('input[type="file"][accept="video/*"]').setInputFiles(ctx.fixtures.clip);
      } else {
        await page.getByRole("button", { name: "a still", exact: true }).click();
        await page.locator('input[type="file"][accept="image/*"]').setInputFiles(ctx.fixtures.face);
      }
      await page.getByTestId("vfx-probe-card").waitFor({ state: "visible", timeout: 60_000 });

      const grid = page.getByTestId("vfx-preset-grid");
      let pick: Locator;
      if (ctx.vfxPreset) {
        const label = vfxPresetById(ctx.vfxPreset)?.label ?? ctx.vfxPreset;
        pick = grid.getByRole("button", { name: new RegExp(`^${esc(label)}`) }).first();
      } else if (ctx.effect === "keyframe") {
        pick = grid.getByRole("button", { name: /^Frostbite/ }).first();
      } else {
        pick = grid.locator("button:not([disabled])").first();
      }
      await pick.waitFor({ state: "visible", timeout: 30_000 });
      if (await pick.isDisabled())
        throw new Error("picked vfx preset is not verified — pass --vfx-preset <id|label>");
      await pick.click();

      if (ctx.effect === "keyframe") {
        const mk = page.getByRole("button", { name: "make it with klein-edit" });
        await mk.waitFor({ state: "visible", timeout: 30_000 });
        await mk.click();
        // the klein target job lands as the end-frame thumbnail
        await page.locator('img[alt="target"]').waitFor({ state: "visible", timeout: ctx.timeoutMs });
      }
      return submitAndWatch(
        page,
        page.getByTestId("vfx-run"),
        "/api/vfx-lab/submit",
        page.getByTestId("vfx-output"),
        ctx.timeoutMs,
      );
    },
  },
  {
    id: "klein-edit", order: "11.4", shotlist: "#6",
    title: "klein edit — 'make it night' LIVE",
    route: () => "/ai/image?model=flux2-klein&flow=edit",
    async run(ctx) {
      const { page } = ctx;
      // image_url is the only single-file image input on the edit flow —
      // the optional ref list is its multiple sibling
      await page.locator('input[type="file"][accept="image/*"]:not([multiple])')
        .setInputFiles(ctx.fixtures.face);
      // the upload tile landing proves the /files/ url was set
      await page.locator('.media-tile img[src^="/files/"]').first()
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.locator("textarea").first().fill(KLEIN_PROMPT);
      return submitAndWatch(
        page,
        page.locator('button.btn-primary:has-text("Generate")'),
        "/api/jobs",
        "new-completed-tile",
        ctx.timeoutMs,
      );
    },
  },
];

const SHOT_ALIASES: Record<string, string> = {
  "11.1": "director", "11.2": "reshoot", "11.3": "vfx-lab", "11.4": "klein-edit",
};

/* ------------------------------ recorder -------------------------------- */

export async function recordLive(opts: Opts): Promise<{ indexPath: string | null; metas: LiveShotMeta[] }> {
  const picked = opts.shot === "all"
    ? SHOTS
    : SHOTS.filter((s) => s.id === (SHOT_ALIASES[opts.shot] ?? opts.shot));
  if (!picked.length)
    throw new Error(`unknown --shot ${opts.shot} — one of ${SHOTS.map((s) => s.id).join(", ")}, 11.1–11.4, or all`);

  const rawDir = path.join(opts.out, ".raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const fixtures = writeFixtures(rawDir); // <raw>/fixtures/{clip.mp4,face.png} — swept with .raw

  const session = await provisionUser(opts.base);
  const browser = await chromium.launch({
    headless: true, chromiumSandbox: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
  });
  const metas: LiveShotMeta[] = [];
  try {
    for (const s of picked) {
      const meta: LiveShotMeta = {
        shot: s.id, order: s.order, shotlist: s.shotlist, title: s.title,
        route: s.route(opts), endpoint_id: null, job_id: null, clip: null,
        render_s: null, hold_s: opts.holdMs / 1000, duration_s: null, ok: false,
      };
      let ctxBrowser;
      for (let attempt = 1; attempt <= 2 && !meta.ok; attempt++) {
        const t0 = Date.now();
        try {
          if (attempt > 1) console.log(`record-live: ${s.id} — retake after ${meta.error ?? "failure"}`);
          else if (opts.verbose) console.log(`record-live: ${s.order} ${s.id} — driving ${opts.base}${s.route(opts)}`);
          ctxBrowser = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
            storageState: session.storageState as never,
          });
          const page = await ctxBrowser.newPage();
          page.setDefaultTimeout(30_000);
          await page.goto(opts.base + s.route(opts), { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(600);
          const res = await s.run({ ...opts, page, fixtures });
          await page.waitForTimeout(opts.holdMs);
          meta.job_id = res.job_id;
          meta.render_s = res.render_s;
          meta.endpoint_id = await jobEndpoint(page, opts.base, res.job_id);
          meta.ok = true;
          await page.close();
          const video = page.video();
          if (video) {
            await video.saveAs(path.join(opts.out, `${s.id}.webm`));
            meta.clip = `${s.id}.webm`;
          }
        } catch (e) {
          meta.error = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e);
          // a failed take's partial clip is still evidence — keep it
          try {
            const pgs = ctxBrowser?.pages() ?? [];
            for (const p of pgs) {
              const v = p.video();
              if (v) { await p.close().catch(() => {}); await v.saveAs(path.join(opts.out, `${s.id}.webm`)).catch(() => {}); }
            }
          } catch { /* best effort */ }
        } finally {
          meta.duration_s = Math.round((Date.now() - t0) / 100) / 10;
          await ctxBrowser?.close().catch(() => {});
          ctxBrowser = undefined;
        }
      }
      metas.push(meta);
      console.log(`record-live: ${s.order} ${s.id} — ${meta.ok
        ? `ok job=${meta.job_id} render=${meta.render_s}s` : `FAILED ${meta.error ?? ""}`}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(rawDir, { recursive: true, force: true });
  }

  const indexPath = path.join(opts.out, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify({
    recorded_at: new Date().toISOString(),
    base_url: opts.base,
    note: "render_s = true submit→result wall seconds — the edit labels the wait 'sped up N×' = render_s ÷ shown_s",
    shots: metas,
  }, null, 2));
  return { indexPath, metas };
}

/* --------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/record-live.ts");
if (isMain) {
  void (async () => {
    const { opts } = parseArgs(process.argv.slice(2));
    const effect = String(opts.effect ?? "plate") as VfxEffect;
    if (!["plate", "image", "keyframe"].includes(effect))
      throw new Error(`--effect must be plate|image|keyframe (got ${effect})`);
    const out = path.resolve(REPO, String(opts.out ?? "../of-reports/evidence/demo-live"));
    const parsed: Opts = {
      shot: String(opts.shot ?? "all"),
      base: String(opts["base-url"] ?? "http://localhost:3150"),
      out,
      effect,
      vfxPreset: typeof opts["vfx-preset"] === "string" ? String(opts["vfx-preset"]) : undefined,
      move: String(opts.move ?? "arc-left-45"),
      timeoutMs: Math.round(Number(opts["timeout-s"] ?? 900) * 1000),
      holdMs: Math.round(Number(opts["hold-s"] ?? 3) * 1000),
      dryRun: opts["dry-run"] === true,
      verbose: opts.verbose === true || !!process.env.DEMO_VERBOSE,
    };
    if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) throw new Error("--timeout-s must be > 0");
    if (!Number.isFinite(parsed.holdMs) || parsed.holdMs < 0) throw new Error("--hold-s must be ≥ 0");
    if (parsed.dryRun) {
      const list = parsed.shot === "all" ? SHOTS : SHOTS.filter((s) => s.id === (SHOT_ALIASES[parsed.shot] ?? parsed.shot));
      if (!list.length) throw new Error(`unknown --shot ${parsed.shot}`);
      console.log(`dry-run — ${list.length} shot(s) against ${parsed.base}`);
      for (const s of list) {
        const extra = s.id === "vfx-lab" ? ` effect=${parsed.effect}${parsed.vfxPreset ? ` preset=${parsed.vfxPreset}` : " preset=<first verified>"}`
          : s.id === "reshoot" ? ` move=${parsed.move} ("${trajectoryOf(parsed.move)?.label ?? "?"}")` : "";
        console.log(`  ${s.order} ${s.id}: ${parsed.base}${s.route(parsed)} → ${out}/${s.id}.webm${extra} timeout=${parsed.timeoutMs / 1000}s hold=${parsed.holdMs / 1000}s`);
      }
      return;
    }
    const res = await recordLive(parsed);
    console.log(`record-live: index → ${res.indexPath}`);
    const failed = res.metas.filter((m) => !m.ok);
    if (failed.length) { console.error(`failed shots: ${failed.map((m) => m.shot).join(", ")}`); process.exit(1); }
  })().catch((e) => { console.error(`record-live: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
