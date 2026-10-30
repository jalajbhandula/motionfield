import { expect, test } from "@playwright/test";

const base = `http://localhost:${process.env.PORT || "3100"}`;

test.describe.configure({ mode: "serial" });

test("character builder - describe, pick a face, build the set, save, land in Character Studio", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `pb-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "PB" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/character-creator");
  const name = `Rosa ${Date.now() % 100000}`;
  await page.getByTestId("pb-name").fill(name);
  await page.getByTestId("pb-description").fill("a woman in her thirties with a sharp copper bob and green eyes");
  await page.getByTestId("pb-styles").getByRole("button", { name: "Cinematic" }).click();
  await page.getByTestId("pb-faces").click();

  // four single-face jobs, each landing as it finishes
  await expect(page.getByTestId("pb-candidates").getByRole("button")).toHaveCount(4, { timeout: 90_000 });
  await expect(page.getByTestId("pb-faces")).toHaveText("Try 4 new faces");
  const face = page.getByTestId("pb-candidates").getByRole("button").first();
  await face.click();
  await expect(face).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("pb-build").click();
  for (const id of ["three-quarter", "profile", "smile", "full-body", "casual", "street", "close-up", "night"])
    await expect(page.getByTestId(`pb-shot-${id}`)).toHaveAttribute("data-status", "done", { timeout: 90_000 });

  // leave one shot out → 8 of 9 kept
  await page.getByTestId("pb-shot-night").getByRole("button", { pressed: true }).click();
  await expect(page.getByTestId("pb-save")).toHaveText(/8 images/);
  await page.getByTestId("pb-save").click();
  await expect(page.getByTestId("pb-saved")).toBeVisible();

  const { refs } = await (await page.request.get("/api/refs?category=character")).json();
  const ref = refs.find((r: { name: string }) => r.name === name.toLowerCase().replace(/ /g, "-"));
  expect(ref?.images).toHaveLength(8);
  expect(ref.images.every((u: string) => u.startsWith("/files/"))).toBe(true);

  await page.getByRole("link", { name: "All characters" }).click();
  await expect(page).toHaveURL(/\/characters/);
});

test("character builder - a photo start needs the likeness box; other users' images are refused", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const email = `pb-photo-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "PB" }, headers: { origin: base } })).ok()).toBe(true);
  await page.goto("/character-creator");
  await page.getByTestId("pb-from-photo").click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.getByTestId("pb-photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
  await page.getByTestId("pb-name").fill("Photo Pal");
  await expect(page.getByTestId("pb-consent")).not.toBeChecked();
  await page.getByTestId("pb-save").click();
  await expect(page.getByRole("alert").filter({ hasText: /right to use/ })).toBeVisible();

  // someone else can't save a character from this user's upload
  const mine = await page.locator("[data-testid=pb-set] img").first().getAttribute("src");
  const other = await browser.newContext({ baseURL: base });
  expect((await other.request.post("/api/auth/sign-up/email", { data: { email: `pb-other-${Date.now()}@test.local`, password: "test-pass-1234", name: "O" }, headers: { origin: base } })).ok()).toBe(true);
  const stolen = await other.request.post("/api/refs", { data: { name: "stolen", category: "character", kind: "person", images: [mine], likeness_consent: true }, headers: { origin: base } });
  expect(stolen.status()).toBe(404);
  await other.close();
});
