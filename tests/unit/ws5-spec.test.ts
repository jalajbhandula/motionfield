import { describe, expect, it } from "vitest";
import { parseSceneSpec, safeParseSceneSpec } from "@/lib/render/spec";
import { EASING, makePrng } from "@/lib/render/runtime";
import fixture from "../fixtures/ws5-launch.json";

describe("SceneSpec v1 schema", () => {
  it("round-trips the launch fixture unchanged", () => {
    const parsed = parseSceneSpec(JSON.parse(JSON.stringify(fixture)));
    expect(parsed).toEqual(fixture);
    expect(parsed.layers.length).toBe(5);
    expect(parsed.params?.length).toBe(2);
  });

  it("rejects a wrong version", () => {
    const r = safeParseSceneSpec({ ...fixture, version: 2 });
    expect(r.ok).toBe(false);
  });

  it("rejects bad colors", () => {
    const r = safeParseSceneSpec({ ...fixture, background: { color: "blue" } });
    expect(r.ok).toBe(false);
  });

  it("rejects a param bound to an unknown layer", () => {
    const bad = {
      ...fixture,
      params: [{ id: "p1", label: "x", min: 0, max: 1, step: 0.1, default: 0.5, bind: "ghost.scale" }],
    };
    const r = safeParseSceneSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
  });

  it("rejects a param bound to a string prop", () => {
    const bad = {
      ...fixture,
      params: [{ id: "p1", label: "x", min: 0, max: 1, step: 0.1, default: 0.5, bind: "title.props.text" }],
    };
    expect(safeParseSceneSpec(bad).ok).toBe(false);
  });

  it("rejects duplicate layer ids", () => {
    const bad = { ...fixture, layers: [fixture.layers[1], fixture.layers[1]] };
    const r = safeParseSceneSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("duplicate");
  });

  it("rejects param defaults outside [min,max]", () => {
    const bad = {
      ...fixture,
      params: [{ id: "p1", label: "x", min: 0, max: 1, step: 0.1, default: 2, bind: "title.scale" }],
    };
    expect(safeParseSceneSpec(bad).ok).toBe(false);
  });

  it("rejects keyframe paths with invalid components", () => {
    const bad = JSON.parse(JSON.stringify(fixture));
    bad.layers[0].keyframes = [{ t: 0, path: "position.q", value: 1 }];
    expect(safeParseSceneSpec(bad).ok).toBe(false);
  });
});

describe("easings", () => {
  it("linear is identity", () => {
    expect(EASING.linear(0)).toBe(0);
    expect(EASING.linear(0.5)).toBe(0.5);
    expect(EASING.linear(1)).toBe(1);
  });

  it("easeInOut hits 0 / 0.5 / 1", () => {
    expect(EASING.easeInOut(0)).toBe(0);
    expect(EASING.easeInOut(0.5)).toBeCloseTo(0.5, 10);
    expect(EASING.easeInOut(1)).toBe(1);
  });

  it("easeOut is cubic-out", () => {
    expect(EASING.easeOut(0)).toBe(0);
    expect(EASING.easeOut(0.5)).toBeCloseTo(0.875, 10);
    expect(EASING.easeOut(1)).toBe(1);
  });

  it("spring pins endpoints and overshoots mid-flight", () => {
    expect(EASING.spring(0)).toBe(0);
    expect(EASING.spring(1)).toBe(1);
    expect(EASING.spring(0.5)).toBeCloseTo(0.9612, 3);
    expect(EASING.spring(0.25)).toBeGreaterThan(1); // bounce
  });
});

describe("seeded PRNG", () => {
  it("same seed → same stream", () => {
    const a = makePrng(42);
    const b = makePrng(42);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
  });

  it("different seeds differ", () => {
    const a = makePrng(1);
    const b = makePrng(2);
    expect(a()).not.toBe(b());
  });

  it("stays in [0,1)", () => {
    const r = makePrng(7);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
