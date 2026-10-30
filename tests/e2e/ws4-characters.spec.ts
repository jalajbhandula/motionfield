/**
 * Character Studio e2e - the page talks to /api/refs (category=character,
 * kind=person): upload a reference photo, save a character, and it appears in
 * the saved-characters list - including after a reload (GET list path).
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

const tmp = mkdtempSync(join(tmpdir(), "of-ws4-character-"));

test("[OF-0020][OF-0021] character studio: save a character and it appears in the list", async ({ page }) => {
  // Under parallel e2e load the pglite drain can lose a sign-up's user row -
  // the response is still 2xx but the session never reads back. Retry the
  // whole signup (fresh email each try) until /api/me answers 200.
  let attempt = 0;
  await expect.poll(async () => {
    const email = `ws4-character-${Date.now()}-${attempt++}-${Math.random().toString(36).slice(2, 6)}@test.local`;
    const su = await page.context().request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS4 Character" },
    });
    if (!su.ok()) return 0;
    return (await page.context().request.get("/api/me")).status();
  }, { timeout: 90_000, intervals: [1000, 3000, 6000, 10000] }).toBe(200);

  const png = join(tmp, "ref.png");
  writeFileSync(png, PNG);

  await page.goto("/character-studio");
  // person refs need the likeness-consent box first - the upload stays
  // disabled until it's ticked (docs/POLICY.md)
  const fileInput = page.locator('input[type="file"][accept="image/*"]');
  await expect(fileInput).toBeDisabled();
  await page.getByText("I have the right to use this person's likeness").click();
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles(png);
  await expect(page.locator('img[src^="/files/uploads/"]')).toHaveCount(1);

  const name = `e2e-character-${Date.now().toString(36)}`;
  await page.getByPlaceholder("Character name").fill(name);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/refs") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Save character" }).click(),
  ]);
  expect(resp.status()).toBe(201);
  expect(resp.request().postDataJSON()).toMatchObject({ category: "character", kind: "person" });

  // the new character's chip appears, and survives a reload (GET /api/refs list)
  await expect(page.getByRole("button", { name })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name })).toBeVisible();
});
