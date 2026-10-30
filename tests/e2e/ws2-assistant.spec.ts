import { test, expect } from "@playwright/test";

/**
 * [OF-0595] Assistant mode menu shows exactly Auto, Offline and Custom.
 * [OF-0411] The UGC tile shows "(silent)".
 * [OF-0498] Clean-room skill names are the ones on screen ("Lead Swap"),
 * and the page never reaches 127.0.0.1:11434.
 */
test.describe("ws2-assistant", () => {
  test("mode menu, renamed skills, silent UGC tile, no ollama traffic", async ({ page, request, context }) => {
    let ollamaHits = 0;
    await context.route(/(127\.0\.0\.1|localhost|0\.0\.0\.0):11434/, (route) => {
      ollamaHits++;
      return route.abort();
    });

    // the pglite post-signup hook races the user row's commit occasionally -
    // retry the sign-up with a fresh email each attempt (a failed sign-up can
    // still leave the user row committed)
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await request.post("/api/auth/sign-up/email", {
        data: { email: `ws2orch${Date.now()}${attempt}@test.dev`, password: "pw-pw-pw-pw", name: "O" },
      });
      if (r.ok()) break;
      if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
      await new Promise((res) => setTimeout(res, 500));
    }

    await page.goto("/ai-assistant");
    // Only skills with real generated examples belong in the gallery.
    await expect(page.getByText("Product Shots", { exact: true })).toBeVisible();
    await expect(page.getByText("Ad Variants", { exact: true })).toBeVisible();
    await expect(page.getByText("Game Art Pack", { exact: true })).toBeVisible();
    await expect(page.getByText("Lead Swap", { exact: true })).toHaveCount(0);
    await expect(page.getByText("UGC Ad (silent)", { exact: true })).toHaveCount(0);

    // mode menu: exactly Auto, Offline and Custom
    await page.getByTestId("mode-menu-button").click();
    const menu = page.getByTestId("mode-menu");
    await expect(menu.getByRole("button")).toHaveCount(3);
    await expect(menu.getByText("Auto", { exact: true })).toBeVisible();
    await expect(menu.getByText("Offline", { exact: true })).toBeVisible();
    await expect(menu.getByText("Custom", { exact: true })).toBeVisible();

    expect(ollamaHits, "the page must never reach 127.0.0.1:11434").toBe(0);
  });
});
