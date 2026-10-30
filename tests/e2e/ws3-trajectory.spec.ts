/**
 * Trajectory picker (GENERATION_PROVIDER=mock): the Camera dropdown on
 * /generate groups motion presets by trajectory group. On a non-executing
 * model (wan-2-1 here - the director leads the picker now and executes its
 * stack) every preset row is labelled "prompt-guided" and the stack lives in
 * the row tooltip - chips would promise motion that never reaches the render.
 */
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("ws3 trajectory picker", () => {
  test("[OF-0138] group headers + prompt-guided labels render; selection sticks", async ({ page }) => {
    await page.goto("/generate?model=wan-2-1");

    // the setup row's Camera picker - closed state shows the value
    const trigger = page.getByRole("button", { name: /Camera\s+Auto/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // every trajectory group with presets renders a labelled header
    for (const g of ["basic", "cinematic", "energetic", "lens", "time", "transition"]) {
      const hdr = page.locator(`[data-trajectory-group="${g}"]`);
      await expect(hdr, `group ${g}`).toBeVisible();
    }

    // hidden catalogue entries never reach the menu
    await expect(page.getByRole("button", { name: /Two-Stage Push/ })).toHaveCount(0);

    // wan-2-1 executes no trajectory spec - every preset row says so;
    // a prompt-guided label must be visible right on /generate's menu
    const guided = page.getByText("prompt-guided");
    await expect(guided.first(), "prompt-guided labels").toBeVisible();
    expect(await guided.count()).toBeGreaterThan(30);

    // the arc row's stack only survives in the tooltip, not as visible chips
    const arc = page.getByRole("button", { name: /^Arc Left/ });
    await expect(arc).toHaveAttribute("title", /Arc Left 45°/);

    // picking a preset closes the menu and shows its title in the trigger
    await arc.click();
    await expect(page.getByRole("button", { name: /Camera\s+Arc Left/ })).toBeVisible();
  });
});
