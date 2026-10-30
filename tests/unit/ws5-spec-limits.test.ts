import { describe, expect, it } from "vitest";
import { safeParseSceneSpec, type SceneSpec } from "@/lib/render/spec";
import fixture from "../fixtures/ws5-launch.json";

const base = () => JSON.parse(JSON.stringify(fixture)) as Record<string, unknown> & SceneSpec;

const plane = (id: string, image?: string) => ({
  id, type: "plane", props: { width: 100, height: 100, ...(image ? { image } : {}) },
});
const particles = (id: string, count: number) => ({
  id, type: "particles", props: { count, radius: 100, size: 4 },
});
const nest = (id: string, depth: number): Record<string, unknown> => ({
  id, type: "group",
  props: { children: depth <= 1 ? [] : [nest(`${id}-n`, depth - 1)] },
});

describe("SceneSpec hard limits", () => {
  it("accepts the launch fixture (regression)", () => {
    expect(safeParseSceneSpec(base()).ok).toBe(true);
  });

  it("accepts 3840×2160 but rejects a long edge over 3840", () => {
    expect(safeParseSceneSpec({ ...base(), width: 3840, height: 2160 }).ok).toBe(true);
    const r = safeParseSceneSpec({ ...base(), width: 3841, height: 1080 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/long edge/);
  });

  it("rejects width×height over 3840×2160 even under the edge cap", () => {
    const r = safeParseSceneSpec({ ...base(), width: 3000, height: 3000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pixel budget/);
  });

  it("rejects round(duration×fps) over 3600", () => {
    expect(safeParseSceneSpec({ ...base(), duration: 150, fps: 24 }).ok).toBe(true); // 3600 exactly
    const r = safeParseSceneSpec({ ...base(), duration: 150.1, fps: 24 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/3600 frames/);
  });

  it("rejects more than 128 layers including nested children", () => {
    const kids = Array.from({ length: 127 }, (_, i) => plane(`k${i}`));
    expect(safeParseSceneSpec({ ...base(), layers: [...base().layers, { id: "g", type: "group", props: { children: kids } }] }).ok).toBe(false);
    const fits = Array.from({ length: 120 }, (_, i) => plane(`k${i}`));
    expect(safeParseSceneSpec({ ...base(), layers: [...base().layers, { id: "g", type: "group", props: { children: fits } }] }).ok).toBe(true);
  });

  it("rejects group nesting deeper than 4", () => {
    expect(safeParseSceneSpec({ ...base(), layers: [nest("g", 4)], params: [] }).ok).toBe(true);
    const r = safeParseSceneSpec({ ...base(), layers: [nest("g", 5)], params: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nesting/);
  });

  it("rejects captions/hud nested inside a group - screen-space overlays must be top-level", () => {
    const w = { text: "hi", start: 0, end: 1 };
    for (const child of [
      { id: "c", type: "captions", props: { words: [w] } },
      { id: "h", type: "hud", props: { value: 1 } },
    ]) {
      const r = safeParseSceneSpec({ ...base(), layers: [{ id: "g", type: "group", props: { children: [child] } }], params: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/top-level/);
    }
    // top-level captions/hud are still fine
    expect(safeParseSceneSpec({
      ...base(),
      layers: [
        { id: "c", type: "captions", props: { words: [w] } },
        { id: "h", type: "hud", props: { value: 1 } },
      ],
      params: [],
    }).ok).toBe(true);
  });

  it("rejects more than 50,000 particles in total", () => {
    const r = safeParseSceneSpec({ ...base(), layers: [particles("a", 20000), particles("b", 20000), particles("c", 10001)], params: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/particles/);
    expect(safeParseSceneSpec({ ...base(), layers: [particles("a", 20000), particles("b", 20000)], params: [] }).ok).toBe(true);
  });

  it("rejects props.* paths on groups (keyframe and param)", () => {
    const withGroup = base();
    withGroup.layers = [{ id: "g", type: "group", props: { children: [plane("c")] } }] as never;
    withGroup.params = [];
    withGroup.layers[0]!.keyframes = [{ t: 0, path: "props.children", value: 1 }];
    const rk = safeParseSceneSpec(withGroup);
    expect(rk.ok).toBe(false);
    if (!rk.ok) expect(rk.error).toMatch(/no animatable props/);

    const withParam = base();
    withParam.layers = [{ id: "g", type: "group", props: { children: [plane("c")] } }] as never;
    withParam.params = [{ id: "p", label: "x", min: 0, max: 1, step: 0.1, default: 0.5, bind: "g.props.children" }];
    const r = safeParseSceneSpec(withParam);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no animatable props/);
  });

  it("image only accepts /files/… or data:image/(png|jpeg|webp)", () => {
    for (const ok of ["/files/gen/x.png", "data:image/png;base64,iVBORw0KGgo=", "data:image/webp,UklGRg==", "data:image/jpeg;base64,/9j/"]) {
      const s = base();
      s.layers = [plane("p", ok)] as never;
      s.params = [];
      const r = safeParseSceneSpec(s);
      expect(r.ok, ok).toBe(true);
    }
    for (const bad of ["https://evil.example/x.png", "http://localhost:3150/x.png", "files/x.png", "/etc/passwd", "data:image/svg+xml,<svg/>", "javascript:alert(1)"]) {
      const s = base();
      s.layers = [plane("p", bad)] as never;
      s.params = [];
      const r = safeParseSceneSpec(s);
      expect(r.ok, bad).toBe(false);
    }
  });
});
