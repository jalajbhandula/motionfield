/**
 * ws4 preset-verify gate e2e - playwright.config.ts sets
 *  PRESET_VERIFY_FILE=tests/fixtures/preset-verify-e2e.json itself, so a
 *  plain `npx playwright test tests/e2e/ws4-catalog.spec.ts` works (regenerate
 *  the fixture via `npx tsx scripts/preset-verify.ts --e2e-fixture`).
 *
 *  The fixture verifies lead-swap (app), dolly-in (motion/trajectory),
 *  candid-take (effect/post) and comic-panel (effect/restyle); marble-gold
 *  carries a stale mechanism hash and every other preset is missing. Motion
 *  presets are WS3's own catalog - visible with no records at all.
 *
 *  Asserts the one display rule everywhere: /api/catalog presets_visible,
 *  /apps and /effects render exactly that set with real counts, the ReCut
 *  and restyle-studio pickers show only verified restyle ids, the /generate
 *  camera picker lists the motion catalog regardless of records, and
 *  /api/jobs 400s hidden, stale-hash, unknown and invalid-combination
 *  preset usage.
 */
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allSpecs, specVisible, catalogSpecs } from "../../src/lib/catalog/presets/schema";
import { EFFECT_PRESETS } from "../../src/lib/catalog/presets/effects";
import "../../src/lib/catalog/presets/effects";
import "../../src/lib/catalog/presets/styles";
import "../../src/lib/catalog/presets/apps";
import "../../src/lib/catalog/presets/person-swap";

// the expected visible set - computed exactly like the server does, from
// PRESET_VERIFY_FILE (tests/fixtures/preset-verify-e2e.json for this suite)
const VERIFIED_IDS = allSpecs().filter((s) => specVisible(s)).map((s) => s.id);
// the tiles /re-edit-video should offer = verified restyle-mechanism specs
const RESTYLE_TITLES = catalogSpecs("effect")
  .filter((s) => s.mechanism.kind === "restyle" && specVisible(s))
  .map((s) => EFFECT_PRESETS.find((p) => p.id === s.id)!.title);

const tmp = mkdtempSync(join(tmpdir(), "of-ws4-catalog-"));
const portrait = join(tmp, "portrait.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=red:size=64x64:duration=1", "-frames:v", "1", portrait]);

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.describe("ws4 catalog verify gate", () => {
  test("/api/catalog presets_visible equals the verified set; pages and the API enforce it [OF-0071][OF-0072][OF-0076][OF-0077][OF-0078][OF-0130][OF-0131][OF-0146]", async ({ request, page }) => {
    // page-context signup so the browser session is authed (retried - under
    // parallel load a sign-up's user row can drain late)
    let attempt = 0;
    await expect.poll(async () => {
      const email = `ws4-cat-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.context().request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS4 Catalog" },
      });
      if (!su.ok()) return 0;
      return (await page.context().request.get("/api/me")).status();
    }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

    const cat = await (await request.get("/api/catalog")).json();
    expect(new Set(cat.presets_visible), "catalog's visible set").toEqual(new Set(VERIFIED_IDS));

    const nApps = allSpecs().filter((s) => s.catalog === "app" && specVisible(s)).length;
    const nFx = catalogSpecs("effect").filter((s) => specVisible(s)).length;
    const nMotion = catalogSpecs("motion").filter((s) => specVisible(s)).length;

    // /apps - exactly the verified app tiles
    await page.goto("/apps");
    await expect(page.getByText(new RegExp(`${nApps} verified apps?`))).toBeVisible();
    await expect(page.getByText("Lead Swap")).toBeVisible();
    await expect(page.getByText("Outfit Try-On")).toHaveCount(0); // hidden
    await expect(page.getByText("Macro Shot")).toHaveCount(0);    // unverified
    // the catalog API drops hidden/unverified tiles too
    expect(cat.apps.map((a: { slug: string }) => a.slug).sort()).toEqual(
      allSpecs().filter((s) => s.catalog === "app" && specVisible(s)).map((s) => s.id).sort());

    // /effects - verified effects + motion presets, real counts
    await page.goto("/effects");
    await expect(page.getByText(new RegExp(`Visual effects · ${nFx}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`Camera motion · ${nMotion}`))).toBeVisible();
    await expect(page.getByText("Comic Panel", { exact: true })).toBeVisible();
    await expect(page.getByText("Marble & Gold")).toHaveCount(0);
    await expect(page.getByTestId("effects-coming-soon")).toHaveCount(0);

    // collection chip filters to that collection's visible members
    await page.getByRole("link", { name: /Restyle a clip/ }).click();
    await expect(page).toHaveURL(/col=restyle/);
    await expect(page.getByText("Comic Panel", { exact: true })).toBeVisible();
    await expect(page.getByText("Candid Take")).toHaveCount(0);
    await expect(page.getByText(/Camera motion/)).toHaveCount(0);
    await page.getByRole("link", { name: /^All$/ }).click();

    // the restyle studio offers ONLY verified restyle ids - the field's enum
    // is the "not hidden" allowlist, so it must be narrowed by `visible`
    await page.goto("/ai/video?model=wan-vace&flow=restyle");
    const presetField = page.locator("label", { hasText: "Style preset" }).first().locator("xpath=../..");
    await expect(presetField.locator("button.chip")).toHaveText(RESTYLE_TITLES);
    await expect(page.getByRole("button", { name: "Marble & Gold" })).toHaveCount(0); // stale
    await expect(page.getByRole("button", { name: "Kaleidoscope" })).toHaveCount(0);  // unverified
    await expect(page.getByRole("button", { name: "Noir Venetian" })).toHaveCount(0); // unverified

    // the /generate camera picker is WS3's catalog - every motion preset
    // lists with no verify records at all
    await page.goto("/generate");
    await page.getByRole("button", { name: /^Camera (?!Control)/ }).click();
    await expect(page.getByRole("button", { name: "Arc Left" })).toBeVisible();
    await expect(page.getByRole("button", { name: "360 Orbit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "POV" })).toBeVisible();

    // deep links to hidden/unverified presets 404
    for (const slug of ["flash-frost", "marble-gold", "weightless"]) {
      const r = await request.get(`/effects/use/${slug}`);
      expect(r.status(), `/effects/use/${slug}`).toBe(404);
    }

    // /re-edit-video - the tiles are exactly the verified restyle specs
    const clip = join(tmp, "two-shot.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error",
      "-f", "lavfi", "-i", "color=black:size=320x180:rate=24:duration=1.0",
      "-f", "lavfi", "-i", "color=white:size=320x180:rate=24:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2.2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a", "-c:a", "aac", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    await page.goto("/re-edit-video");
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(clip);
    await expect(page.getByText(/shots · \d+ generation windows/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /Restyle/ }).click();
    const tiles = page.locator(".grid.grid-cols-4 > button");
    await expect(tiles).toHaveText(RESTYLE_TITLES);
    await expect(page.getByText("Marble & Gold")).toHaveCount(0);

    // ── the API side of the gate ── (authed calls go through the page's
    // request context - it shares the browser session)
    const api = page.context().request;
    const up = await api.post("/api/uploads", {
      multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: readFileSync(portrait) } },
    });
    expect(up.ok()).toBeTruthy();
    const { url: imgUrl } = await up.json();

    const post = (data: Record<string, unknown>) =>
      api.post("/api/jobs", { data, headers: { "Idempotency-Key": crypto.randomUUID() } });

    // hidden preset → 400
    let r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "x", preset_id: "flash-frost" } });
    expect(r.status()).toBe(400);
    // unknown id → 400
    r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "x", preset_id: "nope-not-real" } });
    expect(r.status()).toBe(400);
    // unverified → 400
    r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "x", preset_id: "weightless" } });
    expect(r.status()).toBe(400);
    // stale mechanism hash → 400
    r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "x", preset_id: "marble-gold" } });
    expect(r.status()).toBe(400);
    // exclusive + combinable (restyle + trajectory) → 400 "cannot be combined"
    r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "x", preset_id: "comic-panel", motion_preset: "dolly-in" } });
    expect(r.status()).toBe(400);
    // trajectory + post → 201, and the merged params carry the mechanism
    r = await post({ endpoint_id: "motionfield/wan-vace/image-to-video", params: { image_url: imgUrl, prompt: "a dancer", motion_preset: "dolly-in", effect_preset: "candid-take" } });
    expect(r.status(), await r.text()).toBe(201);
    const { job } = await r.json();
    const full = await (await api.get(`/api/jobs/${job.id}`)).json();
    expect(full.job.params.trajectory).toBeTruthy();
    expect(String(full.job.params.prompt)).toContain("mid-gesture");

    // /api/re-edit - only verified restyle presets pass
    const r2 = await api.post("/api/re-edit", { data: { video_url: "https://example.com/v.mp4", flow: "restyle", preset_id: "marble-gold" } });
    expect(r2.status()).toBe(400);
    expect((await r2.json()).error).toContain("preset not available");
  });
});
