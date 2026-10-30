import { expect, request, test } from "@playwright/test";

/**
 * v1 API end-to-end (mock provider): signup → create key → submit job →
 * poll → result bytes → idempotent replay → mismatch → bad key →
 * per-key concurrency → revoke.
 */
test("v1 job api flow", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const ctx = await request.newContext({ baseURL });
  const email = `ws1-${Date.now()}@e2e.test`;

  // sign up through better-auth (autoSignIn sets the session cookie on ctx)
  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: "WS1 E2E" },
  });
  expect(su.ok(), `signup failed: ${su.status()} ${await su.text()}`).toBeTruthy();

  // upgrade plan so the plan-level gate (free = 1 live job) doesn't mask the
  // per-key concurrency check later in this test
  const up = await ctx.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
  expect(up.ok()).toBeTruthy();

  // create an API key - full token returned once
  const k = await ctx.post("/api/keys", { data: { label: "e2e", max_concurrency: 2 } });
  expect(k.status()).toBe(201);
  const keyBody = await k.json();
  const key: string = keyBody.key;
  const keyRowId: string = keyBody.id;
  expect(key).toMatch(/^of_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{40,}$/);

  const auth = { Authorization: `Bearer ${key}` };

  // model catalog - pick an image endpoint
  const models = await (await ctx.get("/api/v1/models", { headers: auth })).json();
  const image = models.models.find((m: { kind: string }) => m.kind === "image");
  expect(image).toBeTruthy();
  expect(image.inputs.type).toBe("object");

  const body = { endpoint: image.id, params: { prompt: "e2e lighthouse" } };
  const idem = `e2e-${Date.now()}`;

  // create the job
  const j1 = await ctx.post("/api/v1/jobs", { data: body, headers: { ...auth, "Idempotency-Key": idem } });
  expect(j1.status(), `create: ${await j1.text()}`).toBe(202);
  const job = await j1.json();
  expect(job.id).toBeTruthy();
  expect(job.links.self).toBe(`/api/v1/jobs/${job.id}`);

  // poll until done (mock provider completes in ~5s; GET ticks the queue)
  let status = job.status;
  let fresh: Record<string, unknown> = {};
  for (let i = 0; i < 60 && !["completed", "failed", "nsfw", "canceled"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await ctx.get(`/api/v1/jobs/${job.id}`, { headers: auth });
    expect(res.ok()).toBeTruthy();
    fresh = await res.json();
    status = fresh.status as string;
  }
  expect(status).toBe("completed");
  const outs = fresh.outputs as { url: string; type: string; bytes: number | null }[];
  expect(outs.length).toBeGreaterThan(0);
  // outputs carry MIME types, not coarse kinds
  expect(outs[0].type).toMatch(/^[\w.-]+\/[\w.+-]+$/);

  // result streams real bytes with a media content-type
  const res = await ctx.get(`/api/v1/jobs/${job.id}/result`, { headers: auth });
  expect(res.ok()).toBeTruthy();
  const bytes = await res.body();
  expect(bytes.length).toBeGreaterThan(0);
  expect(res.headers()["content-type"]).toMatch(/image|video|audio|octet-stream/);

  // same key + same body → replay returns the original job with 200
  const j1b = await ctx.post("/api/v1/jobs", { data: body, headers: { ...auth, "Idempotency-Key": idem } });
  expect(j1b.status()).toBe(200);
  expect((await j1b.json()).id).toBe(job.id);

  // same key + different body → 422 idempotency_mismatch
  const j2 = await ctx.post("/api/v1/jobs", {
    data: { ...body, params: { prompt: "a different request" } },
    headers: { ...auth, "Idempotency-Key": idem },
  });
  expect(j2.status()).toBe(422);
  expect((await j2.json()).error.code).toBe("idempotency_mismatch");

  // bad key → 401
  const bad = await ctx.get(`/api/v1/jobs/${job.id}`, { headers: { Authorization: "Bearer of_aaaaaaaaaaaa_wrong" } });
  expect(bad.status()).toBe(401);

  // per-key concurrency (max_concurrency = 2): two live jobs, third → 429
  const c1 = await ctx.post("/api/v1/jobs", { data: { ...body, params: { prompt: "conc-1" } }, headers: auth });
  expect(c1.status(), `c1: ${await c1.text()}`).toBe(202);
  const c1Job = await c1.json();
  const c2 = await ctx.post("/api/v1/jobs", { data: { ...body, params: { prompt: "conc-2" } }, headers: auth });
  expect(c2.status(), `c2: ${await c2.text()}`).toBe(202);
  const c2Job = await c2.json();
  const c3 = await ctx.post("/api/v1/jobs", { data: { ...body, params: { prompt: "conc-3" } }, headers: auth });
  expect(c3.status(), `c3: ${await c3.text()}`).toBe(429);
  expect(c3.headers()["retry-after"]).toBe("5");
  expect((await c3.json()).error.code).toBe("concurrency_limit");

  // cancel the two live jobs to keep the run tidy
  await ctx.post(`/api/v1/jobs/${c1Job.id}/cancel`, { headers: auth });
  await ctx.post(`/api/v1/jobs/${c2Job.id}/cancel`, { headers: auth });

  // revoke the key → every v1 call is now 401
  const del = await ctx.delete(`/api/keys/${keyRowId}`);
  expect(del.ok()).toBeTruthy();
  const gone = await ctx.get("/api/v1/models", { headers: auth });
  expect(gone.status()).toBe(401);

  await ctx.dispose();
});
