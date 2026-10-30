import { describe, expect, it } from "vitest";
import { DEFAULT_SETUP, lightingPrompt, MAX_LIGHTS, RELIGHT_PRESETS, relightSetupSchema } from "@/lib/relight/light";
import { lightDir, prepare, relightInto } from "@/lib/relight/shade";
import { RELIGHT, relightSetupFromParams } from "@/lib/catalog/image/relight";
import { findEndpoint } from "@/lib/catalog/video-models";

const render = RELIGHT.workflows.find((w) => w.id === "render")!;

function img(w: number, h: number, px: (x: number, y: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = px(x, y);
    data.set([r, g, b, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data, colorSpace: "srgb" } as ImageData;
}

/** A sphere's normal map: (x right, y up, z toward camera) encoded 0..255. */
function sphere(n: number): ImageData {
  return img(n, n, (x, y) => {
    const u = ((x + 0.5) / n) * 2 - 1, v = 1 - ((y + 0.5) / n) * 2;
    const z = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    return [Math.round((u + 1) * 127.5), Math.round((v + 1) * 127.5), Math.round((z + 1) * 127.5)];
  });
}

describe("relight - light model", () => {
  it("every preset is a valid setup, ids unique", () => {
    expect(new Set(RELIGHT_PRESETS.map((p) => p.id)).size).toBe(RELIGHT_PRESETS.length);
    for (const p of RELIGHT_PRESETS) expect(relightSetupSchema.safeParse(p.setup).success, p.id).toBe(true);
    expect(DEFAULT_SETUP).toBe(RELIGHT_PRESETS[0].setup);
  });

  it("light directions: front, right, overhead, behind", () => {
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
    close(lightDir(0, 0), [0, 0, 1]);
    close(lightDir(90, 0), [1, 0, 0]);
    close(lightDir(0, 90), [0, 1, 0]);
    close(lightDir(180, 0), [0, 0, -1]);
  });

  it("the prompt names direction, colour and quality", () => {
    const p = lightingPrompt(RELIGHT_PRESETS.find((x) => x.id === "neon")!.setup);
    expect(p).toMatch(/magenta key light low from the left/);
    expect(p).toMatch(/cyan fill light low from the right/);
    expect(p).toMatch(/dark, moody/);
    expect(lightingPrompt(RELIGHT_PRESETS.find((x) => x.id === "rim")!.setup)).toMatch(/hard white rim light behind the subject/);
    expect(lightingPrompt(RELIGHT_PRESETS.find((x) => x.id === "overhead")!.setup)).toMatch(/directly overhead/);
  });
});

describe("relight - browser shading", () => {
  it("a light from frame right brightens the right half of a sphere", () => {
    const n = 32;
    const prep = prepare(img(n, n, () => [160, 160, 160]), sphere(n));
    const out = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) } as ImageData;
    relightInto(prep, { lights: [{ az: 90, el: 0, color: "#ffffff", power: 1.5, soft: 0.2 }], ambient: 0.1, ambientColor: "#ffffff", strength: 1 }, out);
    const at = (x: number, y: number) => out.data[(y * n + x) * 4];
    expect(at(26, 16)).toBeGreaterThan(at(5, 16) + 60);
    expect(out.data[3]).toBe(255);
  });

  it("light colour tints the lit side; strength 0 keeps the photo", () => {
    const n = 24;
    const photo = img(n, n, () => [150, 150, 150]);
    const prep = prepare(photo, sphere(n));
    const out = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) } as ImageData;
    relightInto(prep, { lights: [{ az: 0, el: 10, color: "#ff3020", power: 1.4, soft: 0.4 }], ambient: 0.05, ambientColor: "#ffffff", strength: 1 }, out);
    const i = (12 * n + 12) * 4;
    expect(out.data[i]).toBeGreaterThan(out.data[i + 2] + 80);
    relightInto(prep, { ...DEFAULT_SETUP, strength: 0 }, out);
    expect(Math.abs(out.data[i] - 150)).toBeLessThanOrEqual(2);
  });
});

describe("relight - catalog", () => {
  it("both endpoints resolve and run on ComfyUI", () => {
    expect(findEndpoint("motionfield/relight/normals")?.workflow.providers.comfy?.workflow).toBe("relight-normals.json");
    expect(findEndpoint("motionfield/relight/render")?.workflow.providers.comfy?.workflow).toBe("relight-klein.json");
  });

  it("validate accepts a JSON light list and refuses bad ones", () => {
    const ok = { image_url: "/files/x.png", lights: JSON.stringify(DEFAULT_SETUP.lights) };
    expect(render.validate!(ok)).toBeNull();
    expect(render.validate!({ ...ok, lights: "not json" })).toMatch(/JSON/);
    expect(render.validate!({ ...ok, lights: "[]" })).toMatch(/lights/);
    const four = Array.from({ length: MAX_LIGHTS + 1 }, () => DEFAULT_SETUP.lights[0]);
    expect(render.validate!({ ...ok, lights: JSON.stringify(four) })).toMatch(/lights/);
    expect(render.validate!({ ...ok, lights: JSON.stringify([{ ...DEFAULT_SETUP.lights[0], color: "red" }]) })).toMatch(/colour/);
    expect(render.validate!({ ...ok, strength: 3 })).toMatch(/strength/);
  });

  it("map feeds the OF_Relight node and klein's prompt", () => {
    const m = render.providers.comfy!.map!({ image_url: "/files/x.png", lights: JSON.stringify(DEFAULT_SETUP.lights), ambient: 0.4, ambient_color: "#102030", strength: 0.7, prompt: "light haze" });
    expect(JSON.parse(m.LIGHTS as string)).toEqual(DEFAULT_SETUP.lights);
    expect(m).toMatchObject({ AMBIENT: "0.4", AMBIENT_COLOR: "#102030", STRENGTH: "0.7", STEPS: "4" });
    expect(m.PROMPT).toMatch(/^Relight this photo with .* light haze$/);
    expect(relightSetupFromParams({ lights: DEFAULT_SETUP.lights })).toMatchObject({ ambient: 0.35, strength: 0.85 });
  });
});
