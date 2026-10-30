import { expect, request as playwrightRequest, test } from "@playwright/test";

const base = `http://localhost:${process.env.PORT || "3100"}`;

test.describe.configure({ mode: "serial" });

test("compare - two models, same seed, side by side; the run URL is owner-only", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `compare-${Date.now()}@test.local`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "Compare" }, headers: { origin: base } })).ok()).toBe(true);

  await page.goto("/compare");
  await expect(page.getByTestId("compare-candidates").locator("input:checked")).toHaveCount(2);
  await expect(page.getByTestId("compare-run")).toBeDisabled();
  await page.getByTestId("compare-prompt").fill("a lighthouse on a cliff at dusk");
  await page.getByTestId("compare-advanced").locator("summary").click();
  await page.getByTestId("compare-seed").fill("1234");
  await page.getByTestId("compare-run").click();

  const cells = page.getByTestId("compare-cell");
  await expect(cells).toHaveCount(2);
  // one active job per free plan: the second model waits its turn
  await expect(cells.nth(1)).toHaveAttribute("data-status", /pending|queued|in_progress|completed/);
  for (let i = 0; i < 2; i++) {
    await expect(cells.nth(i)).toHaveAttribute("data-status", "completed", { timeout: 120_000 });
    await expect(cells.nth(i).locator("img")).toBeVisible();
    await expect(cells.nth(i)).toContainText("seed 1234");
  }
  await expect(page).toHaveURL(/\/compare\?jobs=[\w-]+,[\w-]+/);

  // both jobs carry the shared seed and prompt
  const ids = new URL(page.url()).searchParams.get("jobs")!.split(",");
  for (const id of ids) {
    const { job } = await (await page.request.get(`/api/jobs/${id}`)).json();
    expect(job.params.seed).toBe(1234);
    expect(job.prompt).toBe("a lighthouse on a cliff at dusk");
  }

  await cells.nth(1).getByTestId("compare-pick-winner").click();
  await expect(page.getByTestId("compare-winner")).toHaveCount(1);
  await expect(page).toHaveURL(/winner=/);

  // reload restores the run from the URL
  await page.reload();
  await expect(page.getByTestId("compare-cell")).toHaveCount(2);
  await expect(page.getByTestId("compare-winner")).toHaveCount(1);
  await expect(page.getByTestId("compare-run-prompt")).toContainText("lighthouse");

  // another account opening the same URL gets nothing
  const other = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  expect((await other.post("/api/auth/sign-up/email", { data: { email: `compare-b-${Date.now()}@test.local`, password: "test-pass-1234", name: "B" } })).ok()).toBe(true);
  for (const id of ids) expect((await other.get(`/api/jobs/${id}`)).status()).toBe(404);
  await other.dispose();
});

test("compare - signed out sees the setup but cannot run", async ({ page }) => {
  await page.goto("/compare");
  await expect(page.getByText("to run a comparison")).toBeVisible();
  await page.getByTestId("compare-prompt").fill("a fox in the snow");
  await expect(page.getByTestId("compare-run")).toBeDisabled();
  await page.getByTestId("compare-mode-video").click();
  await expect(page.getByTestId("compare-candidates").locator("li").first()).toBeVisible();
});
