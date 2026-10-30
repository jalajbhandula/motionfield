import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const specJson = readFileSync(path.join(process.cwd(), "tests/fixtures/ws5-launch.json"), "utf8");
const specB64 = Buffer.from(specJson).toString("base64url");

// the launch spec + params bound to geometry/rebuild props (dust.props.count,
// title.props.size) - exercises the rebuild-then-render determinism path
const launchProps = JSON.parse(specJson) as { params?: Record<string, unknown>[] } & Record<string, unknown>;
launchProps.params = [
  ...(launchProps.params ?? []),
  { id: "dustCount", label: "Dust count", min: 0, max: 2000, step: 50, default: 800, bind: "dust.props.count" },
  { id: "titleSize", label: "Title size", min: 40, max: 220, step: 5, default: 110, bind: "title.props.size" },
];
const propsB64 = Buffer.from(JSON.stringify(launchProps)).toString("base64url");

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function boot(page: Page, b64: string) {
  await page.goto(`/render/motion?spec=${b64}`);
  await page.waitForFunction(() => window.__of || window.__ofError, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__ofError ?? null)).toBeNull();
  await page.evaluate(() => window.__of!.ready);
}

async function renderPng(page: Page, t: number): Promise<string> {
  await page.evaluate((tt) => window.__of!.renderAt(tt), t);
  return page.evaluate(
    () => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png"),
  );
}

test("render page: canvas non-empty, renderAt deterministic, setParams repaints", async ({ page }) => {
  await page.goto(`/render/motion?spec=${specB64}`);
  await page.waitForFunction(() => window.__of || window.__ofError, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__ofError ?? null)).toBeNull();
  await page.evaluate(() => window.__of!.ready);
  await page.evaluate(() => window.__of!.renderAt(1.0));

  // non-empty: sample distinct colors through a 2d copy of the frame buffer
  const distinct = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, d.width, d.height).data;
    const seen = new Set<number>();
    for (let i = 0; i + 2 < px.length; i += 4 * 997) {
      seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    }
    return seen.size;
  });
  expect(distinct).toBeGreaterThan(10);

  // same t twice → identical PNG bytes
  const h1 = sha(await renderPng(page, 1.0));
  const h2 = sha(await renderPng(page, 1.0));
  console.log(`renderAt(1.0) png sha256 x2: ${h1} / ${h2}`);
  expect(h2).toBe(h1);

  // setParams changes the next frame's pixels
  await page.evaluate(() => window.__of!.setParams({ titleScale: 1.55, accentHue: 20 }));
  const h3 = sha(await renderPng(page, 1.0));
  console.log(`after setParams png sha256: ${h3}`);
  expect(h3).not.toBe(h1);
});

test("preview mode renders one slider per spec param", async ({ page }) => {
  await page.goto(`/render/motion?preview=1&spec=${specB64}`);
  await page.waitForFunction(() => window.__of || window.__ofError, null, { timeout: 60_000 });
  await expect(page.locator("input[type=range]")).toHaveCount(2);
});

test("A1: param-bound rebuild props (dust.props.count / title.props.size) render deterministically", async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, propsB64);
  await page.evaluate(() => window.__of!.setParams({ dustCount: 400, titleSize: 150 }));
  const a = sha(await renderPng(page, 1.0));
  const b = sha(await renderPng(page, 1.0));
  expect(b).toBe(a); // the post-rebuild frame is stable, not a one-frame artifact
});

test("A2: renderAt is order-independent - renderAt(0.4) then 1.0 equals a fresh renderAt(1.0)", async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, specB64);
  await renderPng(page, 0.4);
  const moved = sha(await renderPng(page, 1.0));
  await boot(page, specB64); // fresh scene, same spec
  const fresh = sha(await renderPng(page, 1.0));
  expect(moved).toBe(fresh);
});

test("the text's center pixel matches its spec color within ±6", async ({ page }) => {
  test.setTimeout(120_000);
  // a centered "X" - its diagonal crossing covers the exact canvas center -
  // face-on camera, flat type (text faces are unlit, so the color passes
  // through verbatim)
  const colorSpec = {
    version: 1, width: 640, height: 360, fps: 24, duration: 2, seed: 11,
    background: { color: "#0b0e1a" },
    camera: { keyframes: [{ t: 0, position: [0, 0, 700], target: [0, 0, 0] }] },
    layers: [{
      id: "word", type: "text",
      props: { text: "X", size: 300, weight: 700, color: "#3fa7ff" },
      transform: { position: [0, 0, 0] },
    }],
    params: [],
  };
  await boot(page, Buffer.from(JSON.stringify(colorSpec)).toString("base64url"));
  await renderPng(page, 0.5);
  const px = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width; d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const p = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [p[0], p[1], p[2]];
  });
  const expected = [0x3f, 0xa7, 0xff]; // spec color
  console.log("text center px", px, "expected", expected);
  for (let i = 0; i < 3; i++) expect(Math.abs(px[i] - expected[i])).toBeLessThanOrEqual(6);
});

test("POST /api/render/specs requires auth", async ({ request }) => {
  const res = await request.post("/api/render/specs", { data: { spec: {} } });
  expect(res.status()).toBe(401);
});
