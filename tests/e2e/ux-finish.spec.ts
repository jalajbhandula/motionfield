import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";

const base = `http://localhost:${process.env.PORT || "3100"}`;

test.describe.configure({ mode: "serial" });

async function signup(label: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
  expect((await ctx.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "Finish" } })).ok()).toBe(true);
  return ctx;
}

async function waitJob(ctx: APIRequestContext, id: string) {
  for (let i = 0; i < 120; i++) {
    const { job } = await (await ctx.get(`/api/jobs/${id}`)).json();
    if (!["queued", "in_progress"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timed out");
}

test("finish toggle: a video final comes back finished + raw, opt-out keeps one output", async () => {
  test.setTimeout(180_000);
  const ctx = await signup("ux-finish");

  // finish:true - the mock provider stands in for the comfy graph; the host
  // polish is real ffmpeg either way
  const r1 = await ctx.post("/api/jobs", {
    data: { endpoint_id: "motionfield/wan-2.1/text-to-video", params: { prompt: "a lighthouse at dusk, slow pan", finish: true } },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  expect(r1.ok()).toBe(true);
  const j1 = await waitJob(ctx, (await r1.json()).job.id);
  expect(j1.status).toBe("completed");
  const fin = (j1.outputs ?? []).filter((o: { role?: string }) => o.role !== "raw");
  const raw = (j1.outputs ?? []).filter((o: { role?: string }) => o.role === "raw");
  expect(fin.length).toBe(1);
  expect(raw.length).toBe(1);
  expect(fin[0].type).toBe("video");
  expect(fin[0].url).toContain("/files/");
  expect(raw[0].type).toBe("video");
  // both artifacts really exist on disk
  for (const o of [...fin, ...raw]) {
    expect((await ctx.get(o.url)).ok()).toBe(true);
  }

  // finish:false - the toggle off means one plain output, no roles
  const r2 = await ctx.post("/api/jobs", {
    data: { endpoint_id: "motionfield/wan-2.1/text-to-video", params: { prompt: "calm sea", finish: false } },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  expect(r2.ok()).toBe(true);
  const j2 = await waitJob(ctx, (await r2.json()).job.id);
  expect(j2.status).toBe("completed");
  expect(j2.outputs).toHaveLength(1);
  expect(j2.outputs[0].role).toBeUndefined();
});

test("finish toggle renders on video finals and defaults on", async ({ page }) => {
  const email = `ux-finish-ui-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "F" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/ai/video");
  const toggle = page.locator("text=Finish: 2× sharper + smoother").first();
  await expect(toggle).toBeVisible();
});
