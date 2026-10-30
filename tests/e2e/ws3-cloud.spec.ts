/**
 * Cloud-tier endpoint e2e (GENERATION_PROVIDER=mock via playwright.config):
 * the new Wan 2.2 cloud rows are catalog endpoints like any other - they
 * submit through /api/jobs, keep params, and are never defaults.
 */
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function signUp(request: import("@playwright/test").APIRequestContext, tag: string) {
  const email = `ws3cloud-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: "WS3 Cloud" },
  });
  expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();
}

test.describe("ws3 cloud endpoints", () => {
  test("[OF-0152] a14b t2v+i2v endpoints submit open and store params", async ({ request }) => {
    await signUp(request, "a14b");

    let r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/wan-2.2/a14b-t2v", params: { prompt: "waves on a basalt shore", duration: 3, resolution: "720p", steps: 20 } },
    });
    expect(r.status()).toBe(201);
    const t2v = (await r.json()).job;
    expect(t2v.params.prompt).toBe("waves on a basalt shore");
    if (t2v?.id) await request.post(`/api/jobs/${t2v.id}/cancel`);

    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/wan-2.2/a14b-i2v", params: { prompt: "waves on a basalt shore", image_url: "/files/start.png", duration: 3, resolution: "720p", steps: 20 } },
    });
    expect(r.status()).toBe(201);
    const i2v = (await r.json()).job;
    if (i2v?.id) await request.post(`/api/jobs/${i2v.id}/cancel`);
  });
});
