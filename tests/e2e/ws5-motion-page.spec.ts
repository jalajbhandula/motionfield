import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { llmEnvConfigured } from "@/lib/llm/index";
import { findEndpoint } from "@/lib/catalog/video-models";
import { MOTION_RENDER_ENDPOINT } from "@/lib/catalog/code/motion";

const features = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/ws5-features.json"), "utf8"),
) as Record<string, unknown>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// sign-ups serialize (PGlite profile hook) - keep this file serial
test.describe.configure({ mode: "serial" });

// the no-LLM assertions below only hold when the dev server's env has no
// provider - LLM_* exported in the runner env makes them unobservable
const envLlm = llmEnvConfigured();
const renderReady = Boolean(findEndpoint(MOTION_RENDER_ENDPOINT));

/** non-background pixel count sampled off the studio canvas */
async function canvasInk(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, d.width, d.height).data;
    const bg = (px[0] << 16) | (px[1] << 8) | px[2];
    let n = 0;
    for (let i = 0; i + 2 < px.length; i += 4 * 11) {
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (v !== bg) n++;
    }
    return n;
  });
}

async function canvasSha(page: import("@playwright/test").Page): Promise<string> {
  return sha(
    await page.evaluate(() => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png")),
  );
}

/** sign-up retries on PGlite's transient concurrent-commit 500s (sign-in covers
 *  the row that committed before the hook failed). BETTER_AUTH_RATE_TEST=1 in
 *  playwright.config lifts the sign-up rate cap - no faked IPs needed. */
async function signup(page: import("@playwright/test").Page, label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    if ((await page.request.post("/api/auth/sign-up/email", {
      data: { email, password, name: "WS5 Motion" },
    })).ok()
      || (await page.request.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    await page.waitForTimeout(400 * (i + 1));
  }
  throw new Error(`signup/signin failed for ${email}`);
}

test("/motion-graphics with no spec-writer configured: Generate shows the note and no canvas", async ({ page }) => {
  test.skip(envLlm, "LLM_* is set in the runner env - no-LLM behavior can't be observed");
  await page.goto("/motion-graphics");
  await page.locator("textarea").fill("a bold title card");
  await page.getByRole("button", { name: "Generate spec" }).click();
  await expect(page.getByText(/Spec-writing LLM isn't configured/)).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("/motion-graphics with no LLM + a template: the button reads 'Use template' and needs no prompt", async ({ page }) => {
  test.skip(envLlm, "LLM_* is set in the runner env - no-LLM behavior can't be observed");
  test.setTimeout(120_000);
  await signup(page, "ws5t");

  await page.goto("/motion-graphics");
  // pick a template → prompt optional, button switches to "Use template"
  await page.getByRole("button", { name: "Presentation" }).click();
  const btn = page.getByRole("button", { name: "Use template" });
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasInk(page), { timeout: 30_000 }).toBeGreaterThan(50);
});

test("[OF-0500] /motion-graphics?id= reopens a stored spec - canvas inks, two customize sliders, drag is local", async ({ page }) => {
  test.setTimeout(120_000);
  await signup(page, "ws5m");

  const mk = await page.request.post("/api/render/specs", { data: { spec: features } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();

  await page.goto(`/motion-graphics?id=${id}`);
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => canvasInk(page), { timeout: 30_000 }).toBeGreaterThan(50);

  // the resolution dropdown says what the cap is (the UI must be honest)
  await expect(page.getByText("up to 4K")).toBeVisible();

  // Customize = spec params minus the player Seek slider
  const sliders = page.locator('input[type=range]:not([aria-label="Seek"])');
  await expect(sliders).toHaveCount(2);

  // watch for stray API traffic during a purely-local param change
  const apiHits: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) apiHits.push(r.url()); });

  await page.getByRole("button", { name: "Pause" }).click();
  const before = await canvasSha(page);
  const depth = sliders.nth(1); // accentHue, then depth in spec order
  await depth.focus();
  await depth.press("End"); // keyboard drag → max (40)
  await expect.poll(() => canvasSha(page), { timeout: 10_000 }).not.toBe(before);
  expect(apiHits).toHaveLength(0);
});

test("[A9] no spec-writer: Refine is absent + the URL field is disabled; Render MP4 shows live progress then a playable <video> + Download", async ({ page }) => {
  test.skip(envLlm, "LLM_* is set in the runner env - no-LLM behavior can't be observed");
  test.skip(!renderReady, "motion render endpoint not registered in the catalog yet");
  test.setTimeout(300_000);
  await signup(page, "ws5a9");

  const mk = await page.request.post("/api/render/specs", { data: { spec: features } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();

  await page.goto(`/motion-graphics?id=${id}`);
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 60_000 });

  // llmReady=false: the Refine block must not render at all, and the
  // URL field is disabled - a dead control would be a lie
  await expect(page.getByText("Refine", { exact: true })).toHaveCount(0);
  const urlInput = page.locator('input[placeholder*="your-site"]');
  await expect(urlInput).toBeVisible();
  await expect(urlInput).toBeDisabled();

  // Render MP4 → the job's own progress endpoint must rise above 5% BEFORE
  // completion (the exporter writes "frame i/N" to stdout - 2%-stuck was the bug)
  const renderResp = page.waitForResponse(
    (r) => r.url().includes(`/api/render/motion/${id}/render`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Render MP4" }).click();
  const { job_id } = await (await renderResp).json();
  expect(job_id).toBeTruthy();

  const progresses: number[] = [];
  let job: { status: string; progress?: number; outputs?: { type: string; url: string }[]; error?: string } | undefined;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    job = (await (await page.request.get(`/api/jobs/${job_id}`)).json()).job;
    if (job && ["completed", "failed", "canceled"].includes(job.status)) break;
    progresses.push(job?.progress ?? 0);
    await page.waitForTimeout(400);
  }
  expect(job?.status, job?.error).toBe("completed");
  // exporter progress fed the job: something between the 2% start and 100%
  expect(Math.max(...progresses), `observed job progress values: ${progresses.join(",")}`).toBeGreaterThan(5);

  // then a playable <video> and a Download link appear
  const videoEl = page.locator("video").first();
  await expect(videoEl).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Download MP4/ })).toBeVisible();
  // playable: the element points at a real /files/… mp4 that serves 200
  const src = await videoEl.getAttribute("src");
  expect(src).toMatch(/^\/files\//);
  expect((await page.request.get(src!)).ok()).toBeTruthy();
});
