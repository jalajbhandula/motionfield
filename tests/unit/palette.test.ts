import { describe, expect, it } from "vitest";
import {
  applyLut, buildLut, dominantColors, gradeSpecSchema, labStats, labToRgb, rgbToLab, toCube, withIntensity,
} from "@/lib/grade/palette";
import { paletteSpecFromParams, PALETTE_GRADE } from "@/lib/catalog/video/post";

function solid(r: number, g: number, b: number, n = 64): Uint8ClampedArray {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) a.set([r, g, b, 255], i * 4);
  return a;
}

describe("palette · colour space", () => {
  it("OKLab round-trips sRGB", () => {
    for (const c of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5], [0.2, 0.7, 0.4]]) {
      const back = labToRgb(...rgbToLab(c[0], c[1], c[2]));
      back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 3));
    }
  });
});

describe("palette · LUTs", () => {
  it("intensity 0 is identity and lattice points match the grade", () => {
    const lut = buildLut({ kind: "look", id: "cinema-amber" }, 17);
    const px = solid(255, 0, 0);
    applyLut(px, lut, 0);
    expect([...px.slice(0, 3)]).toEqual([255, 0, 0]);
    applyLut(px, lut, 1);
    expect(px[0]).toBeGreaterThan(px[2]); // red stays red
  });

  it("a warm look warms grey; a palette pulls toward its colours", () => {
    const warm = solid(128, 128, 128);
    applyLut(warm, buildLut({ kind: "look", id: "cinema-amber" }), 1);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const blue = solid(128, 128, 128);
    applyLut(blue, buildLut({ kind: "palette", colors: ["#001030", "#1f4f9f", "#cfe0ff"] }), 1);
    expect(blue[2]).toBeGreaterThan(blue[0] + 10);
  });

  it("match moves the source's mean colour toward the reference", () => {
    const src = solid(120, 120, 120), ref = solid(200, 120, 60);
    const spec = { kind: "match" as const, source: labStats(src), reference: labStats(ref) };
    const px = solid(120, 120, 120);
    applyLut(px, buildLut(spec), 1);
    expect(px[0]).toBeGreaterThan(px[2] + 30);
  });

  it(".cube rows run red-fastest and intensity bakes toward identity", () => {
    const lut = withIntensity(buildLut({ kind: "palette", colors: ["#000000", "#ff0000", "#ffffff"] }, 5), 0);
    const rows = toCube(lut, 'x"y').trim().split("\n");
    expect(rows[0]).toBe('TITLE "xy"');
    const data = rows.slice(4).map((r) => r.split(" ").map(Number));
    expect(data).toHaveLength(125);
    expect(data[4]).toEqual([1, 0, 0]); // index r=4,g=0,b=0
    expect(data[100]).toEqual([0, 0, 1]); // r=0,g=0,b=4
  });

  it("extracts dominant colours dark → light", () => {
    const a = new Uint8ClampedArray([...solid(10, 10, 40, 500), ...solid(240, 200, 120, 500), ...solid(200, 40, 40, 500)]);
    const cs = dominantColors(a, 3);
    expect(cs).toHaveLength(3);
    expect(cs[0]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("palette · job params", () => {
  it("needs exactly one source", () => {
    expect(() => paletteSpecFromParams({})).toThrow(/exactly one/);
    expect(() => paletteSpecFromParams({ look: "cinema-amber", colors: "#000000,#111111,#222222" })).toThrow(/exactly one/);
    expect(paletteSpecFromParams({ look: "cinema-amber" })).toEqual({ kind: "look", id: "cinema-amber" });
    expect(paletteSpecFromParams({ colors: "#000000, #111111,#222222" })).toEqual({ kind: "palette", colors: ["#000000", "#111111", "#222222"] });
    expect(() => paletteSpecFromParams({ colors: "red,green,blue" })).toThrow(/rrggbb/);
    expect(() => paletteSpecFromParams({ look: "../../etc" })).toThrow(/unknown look/);
    expect(paletteSpecFromParams({ reference_url: "/files/x.png" }).kind).toBe("match");
  });

  it("workflow validate rejects bad intensity and source mixes", () => {
    const v = PALETTE_GRADE.workflows[0].validate!;
    expect(v({ image_url: "/files/a.png", look: "cinema-amber", intensity: 0.5 })).toBeNull();
    expect(v({ image_url: "/files/a.png", look: "cinema-amber", intensity: 3 })).toMatch(/intensity/);
    expect(v({ image_url: "/files/a.png" })).toMatch(/exactly one/);
  });

  it("the grade spec schema bounds palettes", () => {
    expect(gradeSpecSchema.safeParse({ kind: "palette", colors: ["#000000", "#ffffff"] }).success).toBe(false);
    expect(gradeSpecSchema.safeParse({ kind: "look", id: "nope" }).success).toBe(false);
  });
});
