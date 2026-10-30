/**
 * Licenses settings page + picker badges (GENERATION_PROVIDER=mock):
 *  - /settings/licenses lists restricted endpoints + banned-known components
 *    and the accept/revoke controls flip state via /api/licenses/opt-in
 *  - a graph_json with an unlisted node class → 403 banned_license even AFTER
 *    opt-in, and the error body never advertises enable_at
 *  - the /generate model picker shows Restricted vs Open badges
 */
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("ws3 licenses ui + gate", () => {
  test("/settings/licenses lists the restricted and known-violation inventory", async ({ page }) => {
    const email = `ws3-lic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Licenses" },
    });
    expect(su.ok()).toBeTruthy();

    await page.goto("/settings/licenses");
    // restricted endpoints listed (ltx + ltx-backed motion)
    await expect(page.getByText(/LTX-2.5/).first()).toBeVisible();
    await expect(page.getByText(/LTX-2.x Community/).first()).toBeVisible();
    // no banned-known components remain - the MuseTalk patch blends through
    // OF_MouthMask (no face-parse BiSeNet) and the vace graphs use OF_DWPose
    // instead of controlnet_aux - the "known issues" section stays hidden
    await expect(page.getByText(/known issues being replaced/i)).toHaveCount(0);
    await expect(page.getByText(/BiSeNet/)).toHaveCount(0);
    // opt-in state starts off
    await expect(page.getByRole("switch", { name: /allow restricted models/i })).toHaveAttribute("aria-checked", "false");

    // flip the switch → confirm dialog → accept
    await page.getByRole("switch", { name: /allow restricted models/i }).click();
    await page.getByRole("button", { name: /i accept/i }).click();
    await expect(page.getByRole("switch", { name: /allow restricted models/i })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(/opted in/i).first()).toBeVisible();

    // API agrees
    const st = await page.request.get("/api/licenses/opt-in");
    expect((await st.json()).opted_in).toBe(true);

    // flip again → revoked
    await page.getByRole("switch", { name: /allow restricted models/i }).click();
    const st2 = await page.request.get("/api/licenses/opt-in");
    expect((await st2.json()).opted_in).toBe(false);
  });

  test("banned overrides 403 even after opt-in - code banned_license, no enable_at", async ({ request }) => {
    const email = `ws3-ban-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Banned" },
    });
    expect(su.ok()).toBeTruthy();

    // opt in - restricted endpoints would now pass
    const opt = await request.post("/api/licenses/opt-in", { data: { confirm: true } });
    expect(opt.status()).toBe(200);

    const r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/z-image-turbo/text-to-image",
        params: { prompt: "a red cube" },
        graph_json: { "1": { class_type: "NotInTheNodeTable", inputs: {} } },
      },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("banned_license");
    expect(body.error.enable_at).toBeUndefined();

    // the camera chain itself is clean - but one unlisted class anywhere in
    // the override refuses the job before any upload or submit exists
    const funGraph = {
      "6": { class_type: "LoadImage", inputs: { image: "start.png" } },
      "7": { class_type: "OF_Trajectory", inputs: { moves: "arc-left-45", duration: 3, fps: 16 } },
      "17": { class_type: "OF_CameraEmbed", inputs: { poses_json: ["7", 0], width: 480, height: 272 } },
      "18": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip_vision_h.safetensors" } },
      "19": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["18", 0], image: ["6", 0] } },
      "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors" } },
      "20": { class_type: "WanCameraImageToVideo", inputs: { camera_conditions: ["17", 0], clip_vision_output: ["19", 0] } },
      "21": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["20", 0], negative: ["20", 1], latent_image: ["20", 2] } },
    };
    const r2 = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/camera/image-to-video",
        params: { image_url: "/files/start.png", moves: "arc-left-45", duration: 3 },
        graph_json: { ...funGraph, "99": { class_type: "TotallyUnlistedNode", inputs: {} } },
      },
    });
    expect(r2.status()).toBe(403);
    const body2 = await r2.json();
    expect(body2.error.code).toBe("banned_license");
    expect(body2.error.enable_at).toBeUndefined();
  });

  test("graph_json with a Hunyuan3D class → 403 banned_license and no charge", async ({ request }) => {
    const email = `ws3-hun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Hunyuan" },
    });
    expect(su.ok()).toBeTruthy();
    const me0 = await (await request.get("/api/me")).json();
    const before = Number(me0.profile.credits);

    const r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/z-image-turbo/text-to-image",
        params: { prompt: "a red cube" },
        graph_json: { "1": { class_type: "VAEDecodeHunyuan3D", inputs: {} } },
      },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("banned_license");
    expect(body.error.enable_at).toBeUndefined();

    const me1 = await (await request.get("/api/me")).json();
    expect(Number(me1.profile.credits), "a banned refusal must not charge").toBe(before);
  });

  test("graph_json with a Trellis2 class → 403 restricted_license, accepted after opt-in", async ({ request }) => {
    const email = `ws3-tr2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Trellis" },
    });
    expect(su.ok()).toBeTruthy();

    const payload = {
      endpoint_id: "motionfield/z-image-turbo/text-to-image",
      params: { prompt: "a red cube" },
      graph_json: { "1": { class_type: "Trellis2Conditioning", inputs: {} } },
    };
    const r1 = await request.post("/api/jobs", { data: payload });
    expect(r1.status()).toBe(403);
    const body = await r1.json();
    expect(body.error.code).toBe("restricted_license");
    expect(body.error.enable_at).toBe("/settings/licenses");

    const opt = await request.post("/api/licenses/opt-in", { data: { confirm: true } });
    expect(opt.status()).toBe(200);

    const r2 = await request.post("/api/jobs", { data: payload });
    expect([201, 202]).toContain(r2.status());
    const job = (await r2.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`).catch(() => {});
  });

  test("picker badge: open on Wan default; restricted models stay out until opt-in, then badge restricted", async ({ page }) => {
    await page.goto("/generate");
    // the default is Director · Wan VACE → open chip next to the picker
    await expect(page.getByText(/^Open/).first()).toBeVisible();

    // without opt-in the model dropdown shows no restricted entries at all
    await page.getByRole("button", { name: /Camera Control · Wan VACE/ }).first().click();
    await expect(page.getByRole("button", { name: /^Wan 2\.1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /LTX-2.5/ })).toHaveCount(0);

    // opt in → the restricted model appears with its restricted badge
    // (page.request is context-bound - its session cookie lands on the page)
    const email = `ws3-lic-badge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Badge" },
    });
    expect(su.ok()).toBeTruthy();
    const opt = await page.request.post("/api/licenses/opt-in", { data: {} });
    expect(opt.status()).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: /Camera Control · Wan VACE/ }).first().click();
    const ltxRow = page.getByRole("button", { name: /^LTX-2\.5 - LTX-2\.x Community/ });
    await expect(ltxRow).toBeVisible();
    await expect(ltxRow.getByText("Restricted · opt-in")).toBeVisible();
  });

  test("settings → licenses lists the 3D weight packs with honest classes", async ({ page }) => {
    const email = `ws3-lic3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 3D Licenses" },
    });
    expect(su.ok()).toBeTruthy();

    await page.goto("/settings/licenses");
    await expect(page.getByText(/Weight packs/i).first()).toBeVisible();
    // open packs listed
    await expect(page.getByText(/TripoSG/).first()).toBeVisible();
    await expect(page.getByText(/TRELLIS image-large/).first()).toBeVisible();
    await expect(page.getByText(/UniRig/).first()).toBeVisible();
    await expect(page.getByText(/Marigold V2/).first()).toBeVisible();
    // restricted packs surface the gate + the DINOv3 notice
    await expect(page.getByText(/TRELLIS\.2 native/).first()).toBeVisible();
    await expect(page.getByText(/TripoSplat/).first()).toBeVisible();
    await expect(page.getByText(/Built with DINOv3/).first()).toBeVisible();
    await expect(page.getByText("Restricted · opt-in").nth(1)).toBeVisible();
    // the CMU mocap pack is permissive-terms - "Open · attribution" + credit notice
    await expect(page.getByText(/CMU mocap/).first()).toBeVisible();
    await expect(page.getByText("Open · attribution").first()).toBeVisible();
    await expect(page.getByText(/Carnegie Mellon/).first()).toBeVisible();
  });
});
