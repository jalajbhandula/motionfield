import { test, expect } from "@playwright/test";

/** Canvas - the infinite node board. Verifies the surface is a real React
 *  Flow graph: nodes render, pan/zoom works, a node can be added, edges can
 *  be drawn handle→handle, re-wired to a different target, and deleted. */

const drag = async (page: import("@playwright/test").Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  const connecting = await page.locator(".react-flow__connection-path").count();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  return connecting > 0;
};
const center = async (loc: import("@playwright/test").Locator) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test.describe("canvas", () => {
  test("renders nodes, adds nodes, connects, rewires, deletes edges", async ({ page }) => {
    await page.goto("/canvas");
    const nodes = page.locator(".react-flow__node");
    const edges = page.locator(".react-flow__edge");

    // seeded board: prompt → image → video
    await expect(nodes).toHaveCount(3);
    await expect(edges).toHaveCount(2);

    // add a node via the toolbar
    await page.getByRole("button", { name: "+ audio", exact: true }).click();
    await expect(nodes).toHaveCount(4);
    const added = nodes.nth(3);
    const addedId = await added.getAttribute("data-id");
    expect(addedId).toBeTruthy();

    // frame everything before drawing - handles are 14px targets
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.waitForTimeout(400);

    // connect: video node's source handle → the new audio node's target
    const videoSrc = page.locator('.react-flow__node[data-id="n3"] .react-flow__handle.source');
    const audioTgt = added.locator(".react-flow__handle.target");
    const started = await drag(page, await center(videoSrc), await center(audioTgt));
    expect(started).toBe(true);
    await expect(edges).toHaveCount(3);

    // re-wire: select the edge feeding the audio node, then drag its target
    // updater onto the image node's target handle - the path re-draws
    const edgeToAudio = page.locator(`.react-flow__edge[aria-label="Edge from n3 to ${addedId}"]`);
    const edgePath = edgeToAudio.locator(".react-flow__edge-path").first();
    await edgePath.click({ force: true });
    const updater = edgeToAudio.locator('.react-flow__edgeupdater-target');
    await expect(updater).toHaveCount(1);
    const imgTgt = page.locator('.react-flow__node[data-id="n2"] .react-flow__handle.target');
    // The node handle overlays the updater's centre. Drag the exposed SVG
    // circle, as a user would; starting at the centre starts a new connection.
    const grab = await updater.evaluate((el) => {
      const box = el.getBoundingClientRect();
      for (const dx of [0.2, 0.8, 0.5]) {
        for (const dy of [0.5, 0.2, 0.8]) {
          const x = box.x + box.width * dx, y = box.y + box.height * dy;
          if (document.elementFromPoint(x, y) === el) return { x, y };
        }
      }
      return null;
    });
    expect(grab, "edge updater must expose a draggable point").not.toBeNull();
    await drag(page, grab!, await center(imgTgt));
    await expect(edges).toHaveCount(3);
    await expect(page.locator('.react-flow__edge[aria-label="Edge from n3 to n2"]')).toHaveCount(1);
    await expect(page.locator(`.react-flow__edge[aria-label="Edge from n3 to ${addedId}"]`)).toHaveCount(0);

    // delete: select an edge and press Delete
    const e1 = page.locator('.react-flow__edge').first();
    await e1.locator(".react-flow__edge-path").first().click({ force: true });
    const count = await edges.count();
    await page.keyboard.press("Delete");
    await expect(edges).toHaveCount(count - 1);

    // pan: dragging empty canvas moves the viewport transform
    const vp = page.locator(".react-flow__viewport");
    const before = await vp.evaluate((el) => el.style.transform);
    await drag(page, { x: 640, y: 640 }, { x: 740, y: 560 });
    expect(await vp.evaluate((el) => el.style.transform)).not.toBe(before);
  });
});

test("runs added nodes with current prompts, connections and upstream outputs", async ({ page }) => {
  const submitted: { endpoint_id: string; params: Record<string, unknown> }[] = [];
  await page.route("**/api/jobs", async (route) => {
    const data = route.request().postDataJSON();
    submitted.push(data);
    await route.fulfill({ json: { job: { id: "canvas-job" } }, status: 201 });
  });
  await page.route("**/api/jobs/canvas-job", (route) =>
    route.fulfill({ json: { job: { status: "completed", outputs: [{ url: "/files/generated/canvas.png" }] } } }));
  await page.goto("/canvas");
  const nodes = page.locator(".react-flow__node");
  const prompt = nodes.filter({ hasText: "Prompt" }).first();
  const image = nodes.filter({ hasText: "Image" }).first();
  const video = nodes.filter({ hasText: "Video" }).first();
  await prompt.locator("textarea").fill("The edited prompt");
  await image.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].params.prompt).toBe("The edited prompt");
  await expect(image.getByText("completed", { exact: true })).toBeVisible();
  await video.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1].params.image_url).toBe("/files/generated/canvas.png");
  await page.getByRole("button", { name: "+ audio", exact: true }).click();
  await page.getByRole("button", { name: "Fit View" }).click();
  const audio = nodes.filter({ hasText: "Audio" }).first();
  await audio.locator("textarea").fill("Say this newly added line");
  await audio.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => submitted.length).toBe(3);
  expect(submitted[2].params).toMatchObject({ prompt: "Say this newly added line" });
});

test("uploads media into a connected node and shows actionable login errors", async ({ page }) => {
  let uploadAllowed = false;
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/uploads", (route) => route.fulfill(uploadAllowed
    ? { status: 201, json: { url: "/files/uploads/canvas-source.png" } }
    : { status: 401, json: { error: "unauthorized" } }));
  await page.route("**/api/jobs", async (route) => {
    submitted = route.request().postDataJSON().params;
    await route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  await page.goto("/canvas");
  const image = page.locator(".react-flow__node").filter({ hasText: "Image" }).first();
  const file = { name: "source.png", mimeType: "image/png", buffer: Buffer.from("owned-image-bytes") };
  await image.getByLabel("Upload image", { exact: true }).setInputFiles(file);
  await expect(image.getByRole("alert")).toContainText("not logged in");
  await expect(image.getByRole("link", { name: /Log in/ })).toHaveAttribute("href", "/login");
  uploadAllowed = true;
  await image.getByLabel("Upload image", { exact: true }).setInputFiles(file);
  await expect(image.getByText("completed", { exact: true })).toBeVisible();
  const video = page.locator(".react-flow__node").filter({ hasText: "Video" }).first();
  await video.getByRole("button", { name: "Run", exact: true }).click();
  await expect(video.getByRole("alert")).toContainText("not logged in");
  expect(submitted?.image_url).toBe("/files/uploads/canvas-source.png");
  await expect(video.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});

test("keeps the board across reloads, undoes structure edits and exports JSON", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(3);

  // structural edit → autosave → reload restores
  await page.getByRole("button", { name: "+ audio", exact: true }).click();
  await expect(nodes).toHaveCount(4);
  await page.waitForTimeout(800); // autosave debounce
  await page.reload();
  await expect(nodes).toHaveCount(4);

  // undo brings the removed node back; redo drops it again
  const audio = nodes.filter({ hasText: "Audio" }).first();
  await audio.locator("button[title='Remove node']").click();
  await expect(nodes).toHaveCount(3);
  await page.keyboard.press("Meta+z");
  await expect(nodes).toHaveCount(4);
  await page.keyboard.press("Meta+Shift+z");
  await expect(nodes).toHaveCount(3);

  // the chain picker drops a prewired runnable chain
  const before = await nodes.count();
  await page.getByLabel("Load a starter chain").selectOption("Dub a clip");
  await expect(nodes).toHaveCount(before + 3);

  // export produces a valid board document
  const download = page.waitForEvent("download");
  await page.getByTitle("Download board JSON").click();
  const file = await download;
  const path = testInfo.outputPath("board.json");
  await file.saveAs(path);
  const doc = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  expect(doc.v).toBe(1);
  expect(doc.nodes.length).toBeGreaterThan(3);
  expect(doc.nodes.every((n: { kind: string }) => typeof n.kind === "string")).toBe(true);
});

test("stops polling when the session expires and allows a retry", async ({ page }) => {
  let polls = 0;
  await page.route("**/api/jobs", (route) => route.fulfill({ status: 201, json: { job: { id: "expired-session" } } }));
  await page.route("**/api/jobs/expired-session", (route) => {
    polls++;
    return route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  await page.goto("/canvas");
  const image = page.locator(".react-flow__node").filter({ hasText: "Image" }).first();
  await image.getByRole("button", { name: "Run", exact: true }).click();
  await expect(image.getByRole("alert")).toContainText("not logged in");
  await expect(image.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.waitForTimeout(1400);
  expect(polls).toBe(1);
});
