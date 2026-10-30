import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MOTION_TEMPLATES } from "@/lib/render/templates";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

const features = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/ws5-features.json"), "utf8"),
) as Record<string, unknown>;

async function boot(page: Page, spec: unknown) {
  await page.goto(`/render/motion?spec=${b64(spec)}`);
  await page.waitForFunction(() => Boolean(window.__of) || Boolean(window.__ofError), null, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__ofError ?? null);
  expect(err).toBeNull();
  await page.evaluate(() => window.__of!.ready);
}

async function pngAt(page: Page, t: number): Promise<string> {
  await page.evaluate((tt) => window.__of!.renderAt(tt), t);
  return page.evaluate(
    () => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png"),
  );
}

/** count of pixels differing from the top-left (background) pixel */
async function inkPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width;
    d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, d.width, d.height).data;
    const bg = (px[0] << 16) | (px[1] << 8) | px[2];
    let n = 0;
    for (let i = 0; i + 2 < px.length; i += 4 * 11) {
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (v !== bg) n++;
    }
    return n;
  });
}

// one tagged acceptance test per template - [OF-0504]…[OF-0510]
const TEMPLATE_TAGS = ["OF-0504", "OF-0505", "OF-0506", "OF-0507", "OF-0508", "OF-0509", "OF-0510"];
MOTION_TEMPLATES.forEach((tpl, i) => {
  test(`[${TEMPLATE_TAGS[i]}] template ${tpl.id}: renders non-blank and hash-stable`, async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page, tpl.spec);
    const p1 = await pngAt(page, 1.0);
    const ink = await inkPixels(page);
    const p2 = await pngAt(page, 1.0);
    expect(ink, `${tpl.id} should paint pixels`).toBeGreaterThan(200);
    expect(sha(p2), `${tpl.id} renderAt must be deterministic`).toBe(sha(p1));
  });
});

test("text3d stagger + line draw-on + text reveal animate over time", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, features);

  // t=0.05: caption hidden (reveal), glyphs still flying/hidden → little ink
  await pngAt(page, 0.05);
  const early = await inkPixels(page);
  // t=1.9: everything settled → more ink
  await pngAt(page, 1.9);
  const late = await inkPixels(page);
  console.log(`features ink early=${early} late=${late}`);
  expect(late).toBeGreaterThan(early);

  // kinetic stagger: the rising glyphs land over 0→0.9 + 3×0.15s
  const h05 = sha(await pngAt(page, 0.45));
  const h09 = sha(await pngAt(page, 0.95));
  expect(h05).not.toBe(h09);

  // determinism spot-check at both times
  expect(sha(await pngAt(page, 0.45))).toBe(h05);
  expect(sha(await pngAt(page, 0.95))).toBe(h09);
});

test("param slider value changes rendered pixels (depth + hue binds)", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, features);
  const a = sha(await pngAt(page, 1.9));
  await page.evaluate(() => window.__of!.setParams({ depth: 38, accentHue: 330 }));
  const b = sha(await pngAt(page, 1.9));
  expect(b).not.toBe(a);
});

test("text3d: an oblique camera distinguishes depth 26 from depth 0", async ({ page }) => {
  test.setTimeout(180_000);
  // oblique angle so the extrusion side walls actually land in frame
  const oblique = JSON.parse(JSON.stringify(features)) as Record<string, unknown>;
  (oblique as { camera: unknown }).camera = {
    fov: 50, keyframes: [{ t: 0, position: [420, 180, 720], target: [0, 20, 0] }],
  };
  await boot(page, oblique);
  await page.evaluate(() => window.__of!.setParams({ depth: 26 }));
  const deep = sha(await pngAt(page, 1.9));
  await page.evaluate(() => window.__of!.setParams({ depth: 0 }));
  const flat = sha(await pngAt(page, 1.9));
  expect(flat).not.toBe(deep);
});

test("M2: a geometry rebuild on a staggered layer still renders the animated frame", async ({ page }) => {
  test.setTimeout(240_000);
  // `depth` binds word.props.depth - writing it forces a text3d rebuild.
  // Pre-fix the rebuild dropped the per-glyph keyframe state, so the frame
  // right after the write rendered the glyphs at rest.
  await boot(page, features);
  await page.evaluate(() => window.__of!.setParams({ depth: 38 }));
  const rebuilt = sha(await pngAt(page, 0.45));
  expect(sha(await pngAt(page, 0.45))).toBe(rebuilt); // immediate re-render is stable

  // a scene that never rendered with the old value: its first 0.45 render
  // must equal the settled one, and the rebuilt frame must equal it too
  await boot(page, features);
  await page.evaluate(() => window.__of!.setParams({ depth: 38 }));
  const first = sha(await pngAt(page, 0.45));
  const settled = sha(await pngAt(page, 0.45));
  expect(settled).toBe(first);
  expect(first).toBe(rebuilt);
});
