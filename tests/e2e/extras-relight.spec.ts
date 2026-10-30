import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = `http://localhost:${process.env.PORT || "3100"}`;
const FF = process.env.FFMPEG_BIN || "ffmpeg";

test.describe.configure({ mode: "serial" });

let dir = "";
test.beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "of-relight-e2e-"));
  execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x909090:s=320x240", "-frames:v", "1", path.join(dir, "grey.png")]);
});
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** mean RGB over the canvas */
const canvasMean = (page: import("@playwright/test").Page) => page.getByTestId("relight-canvas").evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
  return s.map((v) => v / (d.length / 4));
});

test("relight - normals job, live preview follows presets and colour, render lands", async ({ page }) => {
  test.setTimeout(180_000);
  const email = `relight-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "R" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/relight");
  await expect(page.getByTestId("relight-render")).toBeDisabled();
  await page.getByTestId("relight-source").setInputFiles(path.join(dir, "grey.png"));
  await expect(page.getByTestId("relight-reading")).toBeVisible();
  await expect(page.getByTestId("relight-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("relight-presets").locator("button")).toHaveCount(10);

  // golden hour reads warmer than moonlight (mock normals are a random
  // gradient, so compare the two presets rather than absolute colour)
  const warmth = async () => { const [r, , b] = await canvasMean(page); return r - b; };
  await page.getByTestId("relight-preset-golden-hour").click();
  await expect(page.getByTestId("relight-preset-golden-hour")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(300);
  const golden = await warmth();
  await page.getByTestId("relight-preset-moonlight").click();
  await expect.poll(warmth).toBeLessThan(golden - 15);

  // add a light, recolour it: three dots on the dome, preset reads custom
  await page.getByTestId("relight-add").click();
  await expect(page.getByTestId("relight-light-1")).toBeVisible();
  await page.getByTestId("relight-color").fill("#00ff00");
  await expect(page.getByTestId("relight-preset-moonlight")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("relight-render").click();
  const result = page.getByTestId("relight-result");
  await expect(result).toHaveAttribute("data-status", "completed", { timeout: 60_000 });
  await expect(page.getByTestId("relight-download")).toBeVisible();
});

test("relight API - bad lights refused before a job is made", async ({ request }) => {
  const email = `relight-api-${Date.now()}@test.local`;
  expect((await request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "R" }, headers: { origin: base } })).ok()).toBe(true);
  const post = (params: Record<string, unknown>) => request.post("/api/jobs", { data: { endpoint_id: "motionfield/relight/render", params }, headers: { origin: base } });
  expect((await post({ image_url: "/files/x.png", lights: "nope" })).status()).toBe(400);
  expect((await post({ image_url: "/files/x.png", lights: JSON.stringify([{ az: 0, el: 200, color: "#ffffff", power: 1, soft: 0.5 }]) })).status()).toBe(400);
});
