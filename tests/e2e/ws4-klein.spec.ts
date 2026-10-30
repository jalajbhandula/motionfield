/**
 * WS4 s7 - the klein lane (GENERATION_PROVIDER=mock: this proves the plumbing -
 * endpoints resolve, params validate, jobs queue/run - never pixels; the GPU
 * smoke lane owns pixel evidence once the klein weights land):
 *  - /ai/image exposes FLUX.2 klein 4B with its three flows and keeps
 *    Z-Image-Turbo as the default t2i; no schnell tile remains
 *  - old schnell endpoint ids answer a normal 404 unknown-endpoint
 *  - motionfield/flux2-klein/{edit,inpaint} validate mask/bbox-free shapes and a
 *    valid job completes through the mock provider
 *  - motionfield/product-placement consumes product_image_url (required media
 *    param), routes scene→compose / no-scene→scene-graph (workflowFor), and
 *    enforces the normalised-bbox contract + ≤10 refs at the API boundary -
 *    bbox_* without a scene is ignored (the ugc-ad skill always sends its
 *    defaults), so a ugc-ad run on ONE product input completes its first step
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

async function signUp(request: APIRequestContext, tag: string) {
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, password: "test-pass-1234", name: tag },
  });
  expect(su.ok()).toBeTruthy();
}

async function uploadPng(request: APIRequestContext, name = "p.png") {
  const up = await request.post("/api/uploads", { multipart: { file: { name, mimeType: "image/png", buffer: PNG } } });
  expect(up.ok()).toBeTruthy();
  return (await up.json()).url as string;
}

async function postJob(request: APIRequestContext, endpoint: string, params: Record<string, unknown>) {
  return request.post("/api/jobs", { data: { endpoint_id: endpoint, params } });
}

type JobRow = { status: string; error: string | null; outputs?: { type: string; url: string }[] };

async function waitDone(request: APIRequestContext, id: string): Promise<JobRow> {
  let row: JobRow | null = null;
  await expect.poll(async () => {
    const g = await request.get(`/api/jobs/${id}`);
    row = (await g.json()).job;
    const s = row!.status;
    return s === "completed" ? "done" : s === "failed" ? `FAILED:${row!.error}` : null;
  }, { timeout: 120_000, intervals: [2000] }).toBe("done");
  return row!;
}

test.describe("ws4 klein lane", () => {
  test("studio surface: klein model + flows render, schnell is gone, z-image stays", async ({ page }) => {
    const res = await page.goto("/ai/image?model=flux2-klein&flow=edit");
    expect(res!.ok()).toBeTruthy();
    const html = await res!.text();
    expect(html).toContain("FLUX.2 klein 4B");
    expect(html.toLowerCase()).not.toContain("schnell");
    expect(html).toContain("Z-Image-Turbo");
    expect(html).toContain("Product Placement");
    // the edit flow exposes its real params - refs field, no dead inputs
    expect(html).toContain("Reference images");
    expect(html).toContain("first 3");
  });

  test("removed schnell endpoints 404 as unknown endpoints", async ({ request }) => {
    await signUp(request, "ws4-klein-404");
    for (const e of [
      "motionfield/flux-schnell/text-to-image",
      "motionfield/flux-schnell/img2img",
      "motionfield/flux-schnell/inpaint",
    ]) {
      const r = await postJob(request, e, { prompt: "x" });
      expect(r.status(), `${e} must not resolve`).toBe(404);
      expect((await r.json()).error).toContain("unknown endpoint");
    }
  });

  test("klein edit + inpaint run through the mock provider end to end", async ({ request }) => {
    await signUp(request, "ws4-klein-edit");
    const img = await uploadPng(request);
    const mask = await uploadPng(request, "mask.png");

    const edit = await postJob(request, "motionfield/flux2-klein/edit", {
      prompt: "swap the jacket for a red hoodie", image_url: img,
      image_urls: [img, img, img, img], // 4 refs ≤ the 10-cap
      seed: 7,
    });
    expect(edit.status(), await edit.text()).toBe(201);
    const editJob = (await edit.json()).job;
    const done = await waitDone(request, editJob.id);
    expect(done.outputs?.length).toBeGreaterThan(0);

    // inpaint needs the brushed mask - a missing one is a clean 400
    const noMask = await postJob(request, "motionfield/flux2-klein/inpaint", {
      prompt: "replace with grass", image_url: img,
    });
    expect(noMask.status()).toBe(400);
    expect((await noMask.json()).error).toContain("mask_url");

    const inp = await postJob(request, "motionfield/flux2-klein/inpaint", {
      prompt: "replace with grass", image_url: img, mask_url: mask, mode: "remove",
    });
    expect(inp.status(), await inp.text()).toBe(201);
    await waitDone(request, (await inp.json()).job.id);
  });

  test("product-placement: bbox contract, dual workflow pick, refs cap", async ({ request }) => {
    await signUp(request, "ws4-klein-pp");
    const product = await uploadPng(request, "product.png");
    const scene = await uploadPng(request, "scene.png");

    // scene without a box → the API must name the missing field
    const noBox = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, image_url: scene, prompt: "on a desk",
    });
    expect(noBox.status()).toBe(400);
    expect((await noBox.json()).error).toContain("bbox_x");

    // out-of-range / overflowing boxes are rejected at the boundary
    const badRange = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, image_url: scene, bbox_x: 1.5, bbox_y: 0, bbox_w: 0.2, bbox_h: 0.2,
    });
    expect(badRange.status()).toBe(400);
    expect((await badRange.json()).error).toContain("between 0 and 1");
    const overflow = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, image_url: scene, bbox_x: 0.8, bbox_y: 0.5, bbox_w: 0.3, bbox_h: 0.6,
    });
    expect(overflow.status()).toBe(400);
    expect((await overflow.json()).error).toContain("fit inside the frame");

    // a box without a scene is ignored - the generated-scene arm still runs
    // (skills like ugc-ad send their bbox defaults unconditionally)
    const boxless = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.3, bbox_h: 0.3,
      prompt: "product on a studio plinth",
    });
    expect(boxless.status(), await boxless.text()).toBe(201);
    await waitDone(request, (await boxless.json()).job.id);

    // >10 refs is rejected; 11 refs never reach the graph
    const tooMany = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, image_urls: Array(11).fill(product),
    });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).error).toContain("10");

    // valid scene+box job completes - and the graph pick is the compose arm
    const ok = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, image_url: scene, prompt: "mug on a walnut desk",
      bbox_x: 0.3, bbox_y: 0.4, bbox_w: 0.25, bbox_h: 0.35,
    });
    expect(ok.status(), await ok.text()).toBe(201);
    const okJob = await waitDone(request, (await ok.json()).job.id);
    expect(okJob.outputs?.length).toBeGreaterThan(0);

    // no scene → the generated-scene arm - the Ad Lab / packshot path
    const gen = await postJob(request, "motionfield/product-placement", {
      product_image_url: product, prompt: "sunlit kitchen counter, morning light", batch_size: 1,
    });
    expect(gen.status(), await gen.text()).toBe(201);
    await waitDone(request, (await gen.json()).job.id);
  });

  test("klein t2i runs as the extra local t2i (z-image default untouched)", async ({ request }) => {
    await signUp(request, "ws4-klein-t2i");
    const r = await postJob(request, "motionfield/flux2-klein/text-to-image", {
      prompt: "a brass compass on a map", aspect_ratio: "1:1", resolution: "720p", steps: 4,
    });
    expect(r.status(), await r.text()).toBe(201);
    const job = await waitDone(request, (await r.json()).job.id);
    expect(job.outputs?.length).toBeGreaterThan(0);
    // and the prior default still resolves
    const z = await postJob(request, "motionfield/z-image-turbo/text-to-image", { prompt: "x", aspect_ratio: "1:1" });
    expect(z.status(), await z.text()).toBe(201);
  });

  test("ugc-ad skill run on ONE product input - step 1 completes", async ({ request }) => {
    await signUp(request, "ws4-klein-ugc");
    const product = await uploadPng(request, "product.png");
    // the same key-mint path the v1 client uses (session → /api/keys → Bearer)
    const k = await request.post("/api/keys", { data: { label: "ugc-e2e" } });
    expect(k.ok(), await k.text()).toBeTruthy();
    const auth = { Authorization: `Bearer ${(await k.json()).key}` };

    const mk = await request.post("/api/v1/runs", {
      data: {
        skill: "ugc-ad", brief: "wireless headphones for commuters",
        inputs: [{ url: product, mime: "image/png" }],
      },
      headers: auth,
    });
    expect(mk.status(), await mk.text()).toBe(201);
    const run = await mk.json();
    // step 1 is the product hero shot - its bbox defaults must not 400 when
    // the run only carries the product photo (no scene image)
    await expect.poll(async () => {
      const v = await (await request.get(`/api/v1/runs/${run.id}`, { headers: auth })).json();
      const s = v.steps?.[0];
      return s?.status === "done" ? "done" : s?.status === "failed" ? `FAILED:${s.error}` : null;
    }, { timeout: 120_000, intervals: [2000] }).toBe("done");
  });
});
