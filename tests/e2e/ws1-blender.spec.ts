import { expect, test, type BrowserContext } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WS1 s11 Blender add-on e2e (#131) - the built extension zip, unpacked,
 * driving its own core.py through `python3 -I` against the real dev server
 * (mock provider). The flows are the panel's own: texture → PNG download
 * [OF-0554], render-to-video still → image-to-video [OF-0555], a blockout
 * clip → restyle [OF-0559] - plus the key-hygiene and insecure-url guards.
 * Blender itself is NOT required here (bpy is untested - see the skipped
 * smoke row at the bottom).
 */

/* serial - the beforeAll mints the shared key through the /settings/keys UI
 * exactly once (parallel workers would race signups) */
test.describe.configure({ mode: "serial" });

const base = `http://localhost:${process.env.PORT || "3100"}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let tmp = "";
let extDir = "";
let zipPath = "";
let apiKey = "";
let browserCtx: BrowserContext | null = null;

const runCore = (args: string[], key = apiKey, outDir?: string) =>
  spawnSync("python3", ["-I", "tests/blender/client_e2e.py", extDir, ...args], {
    env: {
      ...process.env, MOTIONFIELD_URL: base, MOTIONFIELD_API_KEY: key,
      ...(outDir ? { OF_E2E_OUT: outDir } : {}),
    },
    encoding: "utf8",
    timeout: 240_000,
  });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  tmp = mkdtempSync(join(tmpdir(), "of-blender-"));

  /* build + unpack the real extension zip - the same artifact a user gets */
  const distDir = join(tmp, "dist");
  execFileSync("python3", ["plugins/blender/build.py", "--out", distDir], { timeout: 60_000 });
  zipPath = join(distDir, readdirSync(distDir).find((f) => f.endsWith(".zip"))!);
  extDir = join(tmp, "ext");
  execFileSync("python3", ["-c",
    "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zipPath, extDir], { timeout: 60_000 });
  expect(existsSync(join(extDir, "core.py"))).toBe(true);
  expect(existsSync(join(extDir, "vendor", "motionfield", "client.py"))).toBe(true);
  expect(existsSync(join(extDir, "vendor", "motionfield", "LICENSE"))).toBe(true);

  /* signup → pro → the key minted through the real /settings/keys UI -
   * beforeAll has no page fixture, so make the context ourselves */
  browserCtx = await browser.newContext({ baseURL: base });
  const page = await browserCtx.newPage();
  const email = `blender-${Date.now()}@e2e.test`;
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("Blender E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
  const sub = await page.request.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
  expect(sub.ok()).toBeTruthy();
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("blender-e2e");
  await page.getByTestId("create-key").click();
  const keyEl = page.getByTestId("key-value");
  await expect(keyEl).toBeVisible({ timeout: 15_000 });
  apiKey = (await keyEl.textContent())!.trim();
  expect(apiKey).toMatch(/^of_/);
});

test.afterAll(async () => {
  await browserCtx?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("[#131][OF-0554] texture flow - prompt → image endpoint → downloaded PNG", async () => {
  test.setTimeout(240_000);
  const outDir = join(tmp, `out-tex-${Date.now()}`);
  const r = runCore(["texture"], apiKey, outDir);
  expect(r.status, `texture: ${r.stdout}\n${r.stderr}`).toBe(0);
  const ep = /^ENDPOINT (.+)$/m.exec(r.stdout);
  expect(ep, r.stdout).toBeTruthy();
  expect(ep![1]).toBe("motionfield/z-image-turbo/text-to-image");
  expect(ep![1].toLowerCase()).not.toContain("ltx");
  const m = /^PATH (.+)$/m.exec(r.stdout);
  expect(m, r.stdout).toBeTruthy();
  const data = readFileSync(m![1]);
  expect(data.length).toBeGreaterThan(0);
  expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  rmSync(outDir, { recursive: true, force: true });
  expect(existsSync(outDir)).toBe(false);
});

test("[#131][OF-0555] render-to-video - still → upload → image-to-video → MP4", async () => {
  test.setTimeout(240_000);
  const fixture = join(tmp, "render.png");
  writeFileSync(fixture, PNG);
  const outDir = join(tmp, `out-still-${Date.now()}`);
  const r = runCore(["render-video", fixture, "still"], apiKey, outDir);
  expect(r.status, `render-video: ${r.stdout}\n${r.stderr}`).toBe(0);
  const ep = /^ENDPOINT (.+)$/m.exec(r.stdout);
  expect(ep, r.stdout).toBeTruthy();
  expect(ep![1]).toBe("motionfield/wan-vace/image-to-video");
  expect(ep![1].toLowerCase()).not.toContain("ltx");
  const m = /^PATH (.+)$/m.exec(r.stdout);
  expect(m, r.stdout).toBeTruthy();
  const data = readFileSync(m![1]);
  expect(data.length).toBeGreaterThan(0);
  expect(data.subarray(0, 16).toString("latin1")).toContain("ftyp");
  rmSync(outDir, { recursive: true, force: true });
  expect(existsSync(outDir)).toBe(false);
});

test("[#131][OF-0559] blockout clip → restyle - a cinematic render of a blockout", async () => {
  test.setTimeout(240_000);
  /* the fixture clip stands in for a Blender frame-range render */
  const clip = join(tmp, "blockout.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    // the swap family's video_url gate is ≥4 s - a 2 s fixture now 400s
    // before it ever charges, so the blockout stands in at 5 s
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=5:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  const outDir = join(tmp, `out-clip-${Date.now()}`);
  const r = runCore(["render-video", clip, "clip"], apiKey, outDir);
  expect(r.status, `restyle: ${r.stdout}\n${r.stderr}`).toBe(0);
  const ep = /^ENDPOINT (.+)$/m.exec(r.stdout);
  expect(ep, r.stdout).toBeTruthy();
  expect(ep![1]).toBe("motionfield/wan-vace/restyle");
  expect(ep![1].toLowerCase()).not.toContain("ltx");
  const m = /^PATH (.+)$/m.exec(r.stdout);
  expect(m, r.stdout).toBeTruthy();
  const data = readFileSync(m![1]);
  expect(data.length).toBeGreaterThan(0);
  expect(data.subarray(0, 16).toString("latin1")).toContain("ftyp");
  rmSync(outDir, { recursive: true, force: true });
  expect(existsSync(outDir)).toBe(false);
});

test("[#131][OF-0554] a bad key prints the 401 envelope - the key appears nowhere", async () => {
  const bad = "of_deadbeefbad_wrongsecret";
  const r = runCore(["me"], bad);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("unauthorized");
  expect(r.stderr).toContain("invalid or revoked API key");
  expect(r.stdout + r.stderr).not.toContain(bad);
});

test("[#131][OF-0555] plain http to a non-loopback host is refused unless allow-insecure", async () => {
  const r = runCore(["insecure"]);
  expect(r.status, `insecure: ${r.stdout}\n${r.stderr}`).toBe(0);
  expect(r.stdout).toContain("OK insecure guard");
});

test("[#131][OF-0559] blender background smoke - skipped when no blender binary", async () => {
  test.setTimeout(300_000);
  const probe = spawnSync("blender", ["--version"], { encoding: "utf8" });
  test.skip(probe.status !== 0,
    "no blender binary on this machine - run `blender --background " +
    "--factory-startup --python tests/blender/ws1_addon_smoke.py` manually " +
    "with OF_ZIP + MOTIONFIELD_URL + MOTIONFIELD_API_KEY set (needs manual test)");
  const r = spawnSync("blender", ["--background", "--factory-startup",
    "--python", "tests/blender/ws1_addon_smoke.py"], {
    env: { ...process.env, OF_ZIP: zipPath, MOTIONFIELD_URL: base, MOTIONFIELD_API_KEY: apiKey },
    encoding: "utf8", timeout: 300_000,
  });
  expect(r.status, `smoke: ${r.stdout}\n${r.stderr}`).toBe(0);
  expect(r.stdout).toContain("SMOKE-OK");
});
