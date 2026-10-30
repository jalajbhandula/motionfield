import { expect, test } from "@playwright/test";
import { NAV_ENTRIES } from "../../src/lib/nav";

test("home page renders with the expected visible nav", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/MotionField/);
  const links = page.locator("header nav a");
  await expect(links).toHaveCount(NAV_ENTRIES.filter((e) => e.ready).length);
});

test("GET /api/catalog returns JSON", async ({ request }) => {
  const res = await request.get("/api/catalog");
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(data.models.video.length).toBeGreaterThan(0);
});
