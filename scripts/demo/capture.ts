/**
 * capture.ts — drive the demo shots in headless Chromium and record each to
 * a real 1920×1080 clip. Writes under `<out>/capture/`:
 *   clips/<shot>.webm      one recording per shot (Playwright recordVideo)
 *   index.json             shot list + badges + clip paths + per-shot status
 *
 * The browser session is the demo user created by dry.ts — passed in as a
 * Playwright storageState so no credential is written under the out dir.
 * This script is importable; the CLI form is for hand dev only.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, request, type Browser, type Locator, type Page } from "playwright-core";
import { badgesFor, nodePackBadge, shots as allShots, type Badge, type Sel, type Step } from "./shots";
import { parseArgs, resolveDemoOutDir, writeFixtures } from "./util";
import type { DemoProfile } from "./profile-guard";

/* --------------------------- provisioning ------------------------------ */

/** Playwright's request ctx gives us a storageState (cookies) for the
 *  browser without ever writing the session to disk. */
export interface DemoSession {
  email: string;
  apiKey: string;
  storageState: unknown;
}

export async function provisionUser(base: string): Promise<DemoSession> {
  const ctx = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  try {
    const email = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.local`;
    const su = await ctx.post("/api/auth/sign-up/email", {
      data: { email, password: "demo-pass-local-1", name: "Demo" },
    });
    if (!su.ok()) throw new Error(`signup failed: ${su.status()} ${await su.text()}`);
    const pro = await ctx.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
    if (!pro.ok()) throw new Error(`plan upgrade failed: ${pro.status()}`);
    // the VFX shot shows the restricted pick — opt in up front so ltx lists
    const oi = await ctx.post("/api/licenses/opt-in", { data: { confirm: true } });
    if (!oi.ok()) throw new Error(`license opt-in failed: ${oi.status()}`);
    const kr = await ctx.post("/api/keys", { data: { label: "demo-dry" } });
    if (kr.status() !== 201) throw new Error(`api key mint failed: ${kr.status()}`);
    const apiKey = String(((await kr.json()) as { key: string }).key);
    if (!apiKey.startsWith("of_")) throw new Error("api key response malformed");
    const storageState = await ctx.storageState();
    return { email, apiKey, storageState };
  } finally {
    await ctx.dispose();
  }
}

/** Session-authed fetch for app-only endpoints (agent run views live under
 *  /api/agent/* and take the cookie, not a bearer key). */
export async function sessionGet(base: string, storageState: unknown, route: string): Promise<unknown> {
  const ctx = await request.newContext({ baseURL: base, storageState: storageState as never });
  try {
    const r = await ctx.get(route);
    if (!r.ok()) throw new Error(`GET ${route} → ${r.status()}`);
    return await r.json();
  } finally {
    await ctx.dispose();
  }
}

/* ---------------------------- step runner ------------------------------ */

const stepTimeout = (ms: number) => ({ timeout: ms });

function locate(page: Page, sel: Sel): Locator {
  let l: Locator;
  if (sel.testid) l = page.getByTestId(sel.testid);
  else if (sel.css) l = page.locator(sel.css);
  else if (sel.role) l = page.getByRole(sel.role as Parameters<Page["getByRole"]>[0], sel.text ? { name: sel.text } : undefined);
  else l = page.getByText(sel.text!); // bare text matches can multiply
  if (sel.nth != null) return l.nth(sel.nth);
  // css/testid stay strict (multi-match errors tell us the selector moved);
  // role/text picks land on the first hit
  return (sel.role || sel.text) && !sel.testid && !sel.css ? l.first() : l;
}

async function runStep(page: Page, step: Step, fixtures: Record<"clip" | "face", string>): Promise<void> {
  switch (step.do) {
    case "goto":
      await page.goto(step.route ?? "/", { waitUntil: "domcontentloaded" });
      break;
    case "click":
      await locate(page, step.sel).click(stepTimeout(30_000));
      break;
    case "fill":
      await locate(page, step.sel).fill(step.value, stepTimeout(30_000));
      break;
    case "check":
      await locate(page, step.sel).setChecked(step.on ?? true, stepTimeout(15_000));
      break;
    case "select":
      await locate(page, step.sel).selectOption({ value: step.value }, stepTimeout(15_000));
      break;
    case "upload":
      await locate(page, step.sel).setInputFiles(fixtures[step.fixture], stepTimeout(30_000));
      break;
    case "waitFor":
      await locate(page, step.sel).waitFor({ state: "visible", timeout: step.timeout_s * 1000 });
      break;
    case "scroll":
      await locate(page, step.sel).scrollIntoViewIfNeeded(stepTimeout(15_000));
      break;
    case "settle":
      await page.waitForTimeout(step.ms);
      break;
  }
}

/* ------------------------------ capture -------------------------------- */

export interface ClipMeta {
  id: string;
  title: string;
  route: string;
  source: "mac" | "gpu";
  required: boolean;
  budget_s: number;
  endpoints: string[];
  badges: Badge[];
  brain: boolean;
  ok: boolean;
  clip?: string;          // path relative to <out>/capture
  error?: string;
  duration_s?: number;
}

export interface CaptureResult { indexPath: string; metas: ClipMeta[] }

export async function captureShots(opts: {
  base: string;
  out: string;                    // demo out root (already resolveDemoOutDir'd)
  storageState: unknown;
  profile: DemoProfile;
  shotIds?: string[];             // default all
  browser?: Browser;
}): Promise<CaptureResult> {
  const outCap = path.join(opts.out, "capture");
  const clipsDir = path.join(outCap, "clips");
  const rawDir = path.join(outCap, "raw");
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const fixtures = writeFixtures(opts.out);
  const list = opts.shotIds?.length
    ? allShots().filter((s) => opts.shotIds!.includes(s.id))
    : allShots();
  const missing = (opts.shotIds ?? []).filter((id) => !list.some((s) => s.id === id));
  if (missing.length) throw new Error(`unknown shot ids: ${missing.join(", ")}`);

  const brain: Badge = {
    name: `${opts.profile.brain.model} (${opts.profile.brain.provider})`,
    license: opts.profile.brain.license,
    endpoint: null,
  };
  const packBadge = nodePackBadge();

  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({
    headless: true, chromiumSandbox: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
  });
  const metas: ClipMeta[] = [];
  try {
    for (const s of list) {
      const badges = badgesFor(s, brain);
      // stage has no catalog endpoint — the MIT node pack is its badge
      if (s.id === "stage" && !badges.length) badges.push(packBadge);
      const meta: ClipMeta = {
        id: s.id, title: s.title, route: s.route, source: s.source,
        required: s.required, budget_s: s.budget_s, endpoints: s.endpoints,
        badges, brain: !!s.brain, ok: false,
      };
      let ctx;
      // a timed-out step under parallel load gets one clean re-drive —
      // the retry navigates the real page again, nothing is fabricated
      for (let attempt = 1; attempt <= 2 && !meta.ok; attempt++) {
      const t0 = Date.now();
      try {
        if (attempt > 1) console.log(`capture: ${s.id} — retry after ${meta.error ?? "failure"}`);
        ctx = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
          recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
          storageState: opts.storageState as never,
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(opts.base + s.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(600);
        for (const st of s.steps) {
          if (process.env.DEMO_VERBOSE) console.log(`  ${s.id} » ${st.do} ${JSON.stringify("sel" in st ? st.sel : "")}`);
          await runStep(page, st, fixtures);
          if (st.do !== "settle") await page.waitForTimeout(280); // beats stay readable
        }
        meta.duration_s = Math.round((Date.now() - t0) / 100) / 10;
        meta.ok = true;
        await page.close();
        const video = page.video();
        if (video) {
          const dest = path.join(clipsDir, `${s.id}.webm`);
          await video.saveAs(dest);
          meta.clip = `clips/${s.id}.webm`;
        }
      } catch (e) {
        meta.error = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e);
        meta.duration_s = Math.round((Date.now() - t0) / 100) / 10;
        // diagnostics: which step-related testids are present at failure
        try {
          const pgs = ctx?.pages() ?? [];
          for (const p of pgs) {
            const tids = await p.locator("[data-testid]").evaluateAll((els) => els.map((x) => x.getAttribute("data-testid")).slice(0, 80));
            console.log(`  ${s.id} failure context: ${tids.join(", ")}`);
            const runCard = p.locator('[data-testid^="run-card-"]:not([data-testid="run-card-pending"])');
            if (await runCard.count()) console.log(`  run card html: ${(await runCard.first().innerHTML()).slice(0, 800)}`);
          }
        } catch { /* diagnostics are best-effort */ }
        try {
          const pgs = ctx?.pages() ?? [];
          for (const p of pgs) { await p.close().catch(() => {}); const v = p.video(); if (v) await v.saveAs(path.join(clipsDir, `${s.id}.webm`)).catch(() => {}); }
        } catch { /* best effort */ }
      } finally {
        await ctx?.close().catch(() => {});
        ctx = undefined;
      }
      }
      metas.push(meta);
      console.log(`capture: ${s.id} — ${meta.ok ? `ok ${meta.duration_s ?? 0}s` : `FAILED ${meta.error ?? ""}`}`);
    }
  } finally {
    if (ownBrowser) await browser.close();
  }
  const indexPath = path.join(outCap, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify({ base: opts.base, shots: metas }, null, 2));
  return { indexPath, metas };
}

/* -------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/capture.ts");
if (isMain) {
  void (async () => {
    const { opts } = parseArgs(process.argv.slice(2));
    const out = resolveDemoOutDir(String(opts.out ?? "/tmp/of-demo-dev"));
    const base = String(opts.base ?? "http://localhost:3110");
    // dev mode: pass --storage-state <file> or provision a fresh user
    const { loadProfile } = await import("./profile-guard");
    const profile = loadProfile();
    let storageState: unknown;
    if (typeof opts["storage-state"] === "string") storageState = JSON.parse(fs.readFileSync(opts["storage-state"] as string, "utf8"));
    else storageState = (await provisionUser(base)).storageState;
    const shotIds = typeof opts.shots === "string" ? opts.shots.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const res = await captureShots({ base, out, storageState, profile, shotIds });
    const failed = res.metas.filter((m) => !m.ok);
    if (failed.length) { console.error(`failed shots: ${failed.map((m) => m.id).join(", ")}`); process.exit(1); }
  })().catch((e) => { console.error(`capture: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
