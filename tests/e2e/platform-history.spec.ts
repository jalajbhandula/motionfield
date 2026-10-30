import { expect, request, test } from "@playwright/test";

// Real authentication, upload, job/asset persistence and browser navigation;
// generation is mocked by the isolated test server, never a quality claim.
test("owned upload → edit → history → Recreate preserves workflow, media and percent text", async ({ page, baseURL }) => {
  const auth = await page.request.post("/api/auth/sign-up/email", { data: {
    email: `history-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    password: "test-password-123", name: "History test",
  } });
  expect(auth.ok()).toBe(true);
  const upload = await page.request.post("/api/uploads", { multipart: { file: {
    name: "reference.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  } } });
  expect(upload.status()).toBe(201);
  const imageUrl = (await upload.json()).url;
  const params = { prompt: "Keep 100% of the label: %20 stays literal", image_url: imageUrl, seed: 12345, steps: 4 };
  const submit = await page.request.post("/api/jobs", { data: {
    endpoint_id: "motionfield/flux2-klein/edit", params,
  } });
  expect(submit.status(), await submit.text()).toBe(201);
  const job = (await submit.json()).job;
  await expect.poll(async () => (await (await page.request.get(`/api/jobs/${job.id}`)).json()).job.status,
    { timeout: 60_000, intervals: [500, 1000] }).toBe("completed");
  const list = await page.request.get("/api/assets");
  expect(list.ok()).toBe(true);
  const asset = (await list.json()).assets.find((a: { jobId?: string }) => a.jobId === job.id);
  expect(asset).toBeTruthy();
  const foreign = await request.newContext({ baseURL });
  try {
    const signup = await foreign.post("/api/auth/sign-up/email", { data: {
      email: `history-other-${Date.now()}@test.local`, password: "test-password-123", name: "Other owner",
    } });
    expect(signup.ok()).toBe(true);
    expect((await foreign.get(`/api/jobs/${job.id}`)).status()).toBe(404);
    const otherAssets = await (await foreign.get("/api/assets")).json();
    expect(otherAssets.assets).toEqual([]);
  } finally { await foreign.dispose(); }


  await page.goto(`/jobs/${job.id}`);
  const jobLink = page.getByRole("link", { name: "Recreate", exact: true });
  const href = await jobLink.getAttribute("href");
  const destination = new URL(href!, "http://localhost");
  expect(destination.searchParams.get("flow")).toBe("edit");
  expect(destination.searchParams.get("model")).toBe("flux2-klein");
  await jobLink.click();
  await expect(page.getByRole("button", { name: "Edit (instruction)", exact: true })).toHaveClass(/chip-on/);
  await expect(page.locator("textarea").first()).toHaveValue(params.prompt);
  await expect(page.locator(`img[src="${imageUrl}"]`).first()).toBeVisible();

  await page.goto("/assets");
  const tile = page.locator(".media-tile").filter({ has: page.locator(`img[src="${asset.url}"]`) });
  await tile.hover();
  const assetHref = await tile.getByTitle("Recreate").getAttribute("href");
  expect(assetHref).toBe(href);
  await tile.getByTitle("Recreate").click();
  await expect(page.locator("textarea").first()).toHaveValue(params.prompt);
  await expect(page.getByRole("button", { name: "Edit (instruction)", exact: true })).toHaveClass(/chip-on/);
});

test("history polling stops on an expired session and offers a working retry", async ({ page }) => {
  const id = "55555555-5555-4555-8555-555555555555";
  let calls = 0, allow = false;
  await page.route(`**/api/jobs/${id}`, async (route) => {
    calls++;
    await route.fulfill(allow ? { status: 200, json: { job: {
      id, status: "completed", progress: 100, modelId: "flux2-klein", workflow: "edit", kind: "image",
      prompt: "History retry", params: { prompt: "History retry" }, costCredits: "1", error: null,
      createdAt: new Date().toISOString(), outputs: [],
    } } } : { status: 401, json: { error: "unauthorized" } });
  });
  await page.goto(`/jobs/${id}`);
  await expect(page.getByRole("alert").filter({ hasText: /not logged in/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Log in/ }).last()).toHaveAttribute("href", "/login");
  await page.waitForTimeout(2500);
  expect(calls).toBe(1);
  allow = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "flux2-klein · edit" })).toBeVisible();
  expect(calls).toBe(2);
});
