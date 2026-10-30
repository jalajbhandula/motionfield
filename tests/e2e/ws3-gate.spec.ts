/**
 * License gate e2e (GENERATION_PROVIDER=mock via playwright.config):
 *  - restricted (LTX) endpoint → 403 without opt-in, structured error body
 *  - open endpoint → job created
 *  - explainer with motion_model "ltx" → 403; default motion → job created
 *  - POST /api/licenses/opt-in → the same restricted endpoint then creates
 */
import { test, expect } from "@playwright/test";

// sign-up fires a profile-insert hook that can't see a concurrently-committing
// user row on PGlite - keep the sign-ups serial.
test.describe.configure({ mode: "serial" });

test.describe("ws3 license gate", () => {
  test("restricted endpoints 403 until opt-in; explainer motion_model gates", async ({ request }) => {
    const email = `ws3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Test" },
    });
    expect(su.ok()).toBeTruthy();

    // ltx-backed endpoint without opt-in → 403 + structured body
    let r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/ltx-video/text-to-video", params: { prompt: "a red cube", duration: 3, resolution: "480p" } },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("restricted_license");
    expect(body.error.license).toContain("LTX-2.x Community");
    expect(body.error.enable_at).toBe("/settings/licenses");

    // open endpoint → accepted (cancel right away - free plan allows 1 slot)
    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/z-image-turbo/text-to-image", params: { prompt: "a red cube on a table" } },
    });
    expect(r.status()).toBe(201);
    const zjob = (await r.json()).job;
    if (zjob?.id) await request.post(`/api/jobs/${zjob.id}/cancel`);

    // explainer: motion_model "ltx" → 403
    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/explainer/video", params: { prompt: "First scene happens. Second scene follows.", motion_model: "ltx" } },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error.code).toBe("restricted_license");

    // explainer default params → accepted (cancel immediately - the recipe
    // would otherwise keep hitting whatever runs at COMFY_BASE_URL)
    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/explainer/video", params: { prompt: "First scene happens. Second scene follows." } },
    });
    expect([201, 202]).toContain(r.status());
    const created = (await r.json()).job;
    if (created?.id) await request.post(`/api/jobs/${created.id}/cancel`).catch(() => {});

    // opt in → the same restricted endpoint now submits
    r = await request.post("/api/licenses/opt-in", { data: {} });
    expect(r.status()).toBe(200);

    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/ltx-video/text-to-video", params: { prompt: "a red cube", duration: 3, resolution: "480p" } },
    });
    expect(r.status()).toBe(201);
  });

  test("graph_json override is gated - open endpoint + restricted weight → 403", async ({ request }) => {
    const email = `ws3-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Graph Test" },
    });
    expect(su.ok()).toBeTruthy();

    // the override loads an LTX weight - the gate must scan it even though the
    // endpoint itself is open
    const r = await request.post("/api/jobs", {
      data: {
        endpoint_id: "motionfield/z-image-turbo/text-to-image",
        params: { prompt: "a red cube" },
        graph_json: {
          "1": { class_type: "UNETLoader", inputs: { unet_name: "ltx-video-2b-v0.9.5.safetensors" } },
        },
      },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("restricted_license");
    expect(body.error.license).toContain("Open RAIL-M");
  });

  test("signed-out /settings/licenses redirects to /login; revoke re-gates LTX", async ({ page, request }) => {
    // signed out → the settings page bounces to login
    await page.goto("/settings/licenses");
    await expect(page).toHaveURL(/\/login(\?.*)?$/);

    const email = `ws3-rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const su = await request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 Revoke" },
    });
    expect(su.ok()).toBeTruthy();

    // opt in → LTX submits (201); revoke → same endpoint 403s again
    let r = await request.post("/api/licenses/opt-in", { data: {} });
    expect(r.status()).toBe(200);
    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/ltx-video/text-to-video", params: { prompt: "a red cube", duration: 3, resolution: "480p" } },
    });
    expect(r.status()).toBe(201);
    const job = (await r.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    r = await request.delete("/api/licenses/opt-in");
    expect(r.status()).toBe(200);

    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/ltx-video/text-to-video", params: { prompt: "a red cube", duration: 3, resolution: "480p" } },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error.code).toBe("restricted_license");
  });
});
