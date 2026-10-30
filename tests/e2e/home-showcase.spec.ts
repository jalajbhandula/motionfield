import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`homepage features playable games and 3D at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await page.goto("/");

    const featured = page.getByRole("navigation", { name: "Featured creative tools" });
    await expect(featured.getByRole("link", { name: "Image" })).toHaveAttribute("href", "/ai/image");
    await expect(featured.getByRole("link", { name: "Video & VFX" })).toHaveAttribute("href", "/ai/video?example=motionfield%2Fltx-video%2Fvfx-keyframe");
    await expect(featured.getByRole("link", { name: "Product Ads" })).toHaveAttribute("href", "/product-ads");
    await expect(featured.getByRole("link", { name: "Dub & Lip sync" })).toHaveAttribute("href", "/dub-translate");
    await expect(featured.getByRole("link", { name: "Game Builder" })).toHaveAttribute("href", "/games");
    await expect(page.getByRole("link", { name: "3D perfume model" })).toHaveAttribute(
      "href", "/ai/image?example=motionfield%2Ftrellis2%2Fimage-to-3d",
    );
    for (const title of [
      "Lisbon morning · FLUX.2 klein",
      "Neon night edit · FLUX.2 klein",
      "Coastal drive · Wan 2.2 A14B",
      "Sneaker packshot · Product Ads",
    ]) {
      await expect(page.getByRole("link", { name: title })).toBeVisible();
    }

    const game = page.getByTestId("showcase-game");
    await game.scrollIntoViewIfNeeded();
    await expect(game.getByRole("link", { name: /Make a game/ })).toHaveAttribute("href", "/games");
    const frame = game.getByTestId("showcase-game-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const canvas = page.frameLocator('[data-testid="showcase-game-frame"]').locator("#game");
    await expect(canvas).toBeVisible();
    await canvas.click();

    const model = page.getByTestId("showcase-trellis");
    await expect(model.getByRole("link", { name: /Make a model/ })).toHaveAttribute(
      "href", "/ai/image?example=motionfield%2Ftrellis2%2Fimage-to-3d",
    );
    await expect(model.locator("canvas")).toBeVisible();
    const dub = page.getByTestId("showcase-dub");
    await dub.scrollIntoViewIfNeeded();
    const video = dub.getByTestId("showcase-dub-video");
    const sound = dub.getByTestId("showcase-dub-sound");
    await expect(video).toHaveJSProperty("muted", true);
    await expect(sound).toHaveAccessibleName("Unmute Spanish dub");
    await sound.click();
    await expect(video).toHaveJSProperty("muted", false);
    await expect(sound).toHaveAccessibleName("Mute Spanish dub");
    await sound.click();
    await expect(video).toHaveJSProperty("muted", true);
    await page.getByTestId("showcase-game").screenshot({ path: testInfo.outputPath("showcase-game.png"), animations: "disabled" });
    await page.getByTestId("showcase-trellis").screenshot({ path: testInfo.outputPath("showcase-model.png"), animations: "disabled" });
  });
}

