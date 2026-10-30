/**
 * WS2 s11 explainer e2e (GENERATION_PROVIDER=mock):
 *  XE1 the real studio form offers the 9 looks + custom and
 *      karaoke/pop/off captions; a clay+pop submit carries both on the job.
 *  XE2 a direct job with an unknown look 400s before charge; a custom plan
 *      accepts a valid explainer step and 422s a bad captions value, naming
 *      the allowed values.
 *  XE3 /api/agent/tools exposes the look + captions enums on the explainer
 *      schema - the agent surface needs no special-casing.
 *  All assertions sit at the job/plan level - the mock provider produces no
 *  fake media.
 */
import { test, expect, request } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const EP = "motionfield/explainer/video";

const LOOK_IDS = ["pixel-art", "clay", "collage", "flat-2d", "whiteboard", "low-poly", "glossy-3d", "isometric", "plush"];
const CAPTION_MODES = ["karaoke", "pop", "off"];

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2xpl-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
    });
    if (r.ok()) return ctx;
    if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));
  }
  return ctx;
}

test.describe("ws2 explainer (s11)", () => {
  test("XE1 the real form offers 9 looks + custom and 3 caption modes; clay+pop lands on the job row", async ({ page }) => {
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2xpl-form-${Date.now()}@test.local`, password: "test-pass-1234", name: "XE1" },
    });
    expect(su.ok(), `sign-up: ${su.status()}`).toBeTruthy();

    await page.goto("/ai/video?model=explainer");

    // Look: the nine catalog looks plus Custom
    const lookChips = page.locator('[data-field="look"] .chip');
    await expect(lookChips).toHaveCount(10);
    await expect(page.locator('[data-field="look"] .chip', { hasText: "Custom" })).toHaveCount(1);

    // Captions: karaoke / pop / off
    await expect(page.locator('[data-field="captions"] .chip')).toHaveCount(3);
    for (const label of ["Karaoke", "Pop", "Off"])
      await expect(page.locator('[data-field="captions"] .chip', { hasText: label })).toHaveCount(1);

    // pick clay + pop, fill the topic, submit - the job row carries both
    await page.locator('[data-field="look"] .chip', { hasText: "Clay" }).click();
    await page.locator('[data-field="captions"] .chip', { hasText: "Pop" }).click();
    await page.getByPlaceholder(/What should the explainer cover/).fill("Explain how a battery works");
    const req = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
    const resp = page.waitForResponse((r) => r.url().includes("/api/jobs") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Generate/ }).click();
    const body = (await req).postDataJSON() as { params: Record<string, unknown> };
    expect(body.params.look).toBe("clay");
    expect(body.params.captions).toBe("pop");
    const job = (await (await resp).json()).job as { id: string; params: Record<string, unknown> };
    expect(job.params).toMatchObject({ look: "clay", captions: "pop" });
    // persisted on the row, not just echoed
    const again = await page.request.get(`/api/jobs/${job.id}`);
    expect((await again.json()).job.params).toMatchObject({ look: "clay", captions: "pop" });
    await page.request.post(`/api/jobs/${job.id}/cancel`);
  });

  test("XE2 API: unknown look 400s; a plan accepts a valid step and 422s captions 'subtitles' naming the values", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "XE2");

    // a direct job submit with a look the catalog doesn't declare → 400
    const bad = await ctx.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "the water cycle", look: "nope" } },
    });
    expect(bad.status(), `look=nope: ${await bad.text()}`).toBe(400);

    // a custom plan with a declared look + captions mode → 201 (parks, no job)
    const step = (params: Record<string, unknown>) =>
      ({ id: "s1", title: "s1", endpoint_id: EP, params, depends_on: [] });
    const ok = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "explainer", steps: [
        step({ prompt: "the water cycle", look: "isometric", captions: "karaoke" })] } },
    });
    expect(ok.status(), `valid step: ${await ok.text()}`).toBe(201);

    // captions:"subtitles" → 422 that names the real allowed values
    const badC = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "explainer2", steps: [
        step({ prompt: "the water cycle", captions: "subtitles" })] } },
    });
    expect(badC.status()).toBe(422);
    const msg = await badC.text();
    for (const v of CAPTION_MODES) expect(msg).toContain(v);

    // a plan step with an undeclared look 422s the same way
    const badL = await ctx.post("/api/agent/runs", {
      data: { mode: "custom", plan: { title: "explainer3", steps: [
        step({ prompt: "the water cycle", look: "nope" })] } },
    });
    expect(badL.status()).toBe(422);
    expect(await badL.text()).toContain("flat-2d");
    await ctx.dispose();
  });

  test("XE3 /api/agent/tools lists both enums on the explainer schema", async ({ baseURL }) => {
    const ctx = await signUpCtx(baseURL, "XE3");
    const r = await ctx.get("/api/agent/tools?mode=auto");
    expect(r.ok(), `tools: ${await r.text()}`).toBeTruthy();
    const tools = ((await r.json()).tools) as {
      endpoint_id: string;
      schema?: { properties?: Record<string, { enum?: unknown[] }> };
    }[];
    const expl = tools.find((t) => t.endpoint_id === EP);
    expect(expl, "explainer tool").toBeTruthy();
    const props = expl?.schema?.properties ?? {};
    expect(props.look?.enum).toEqual(expect.arrayContaining([...LOOK_IDS, "custom"]));
    expect(props.look?.enum).toHaveLength(10);
    expect(props.captions?.enum).toEqual(expect.arrayContaining(CAPTION_MODES));
    expect(props.captions?.enum).toHaveLength(3);
    await ctx.dispose();
  });
});
