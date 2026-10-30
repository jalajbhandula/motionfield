import { describe, expect, it } from "vitest";
import { MOTION_TEMPLATES, motionTemplateSpec } from "@/lib/render/templates";
import { parseSceneSpec } from "@/lib/render/spec";
import { motionRenderParamsSchema } from "@/lib/generation/recipes/motion-render";
import fixture from "../fixtures/ws5-launch.json";

describe("motion templates", () => {
  it("ships exactly 7, all valid SceneSpec v1", () => {
    expect(MOTION_TEMPLATES).toHaveLength(7);
    expect(new Set(MOTION_TEMPLATES.map((t) => t.id)).size).toBe(7);
  });

  for (const t of MOTION_TEMPLATES) {
    it(`${t.id}: parses, ≥2 params, binds resolve`, () => {
      const spec = motionTemplateSpec(t.id)!;
      expect(spec.version).toBe(1);
      expect(spec.width).toBeGreaterThan(0);
      expect(spec.params?.length ?? 0).toBeGreaterThanOrEqual(2);
      // every bind targets a real layer - parseSceneSpec already enforces this
      const ids = new Set<string>();
      const walk = (ls: typeof spec.layers) => ls.forEach((l) => {
        ids.add(l.id);
        if (l.type === "group") walk(l.props.children);
      });
      walk(spec.layers);
      for (const p of spec.params ?? []) expect(ids.has(p.bind.split(".")[0])).toBe(true);
    });
  }

  it("ids stay stable - templates ship generic names only", () => {
    for (const t of MOTION_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.label.length).toBeGreaterThan(1);
    }
  });
});

describe("motion-render recipe params", () => {
  it("accepts {spec_id:uuid} and {spec}", () => {
    const goodId = crypto.randomUUID();
    expect(motionRenderParamsSchema.safeParse({ spec_id: goodId }).success).toBe(true);
    expect(motionRenderParamsSchema.safeParse({ spec: fixture }).success).toBe(true);
    expect(motionRenderParamsSchema.safeParse({ spec: fixture, values: { titleScale: 1.2 } }).success).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(motionRenderParamsSchema.safeParse({}).success).toBe(false);
    expect(motionRenderParamsSchema.safeParse({ spec_id: "not-a-uuid" }).success).toBe(false);
    expect(motionRenderParamsSchema.safeParse({ spec_id: crypto.randomUUID(), values: { x: NaN } }).success).toBe(false);
    expect(motionRenderParamsSchema.safeParse({ spec: fixture, values: "oops" }).success).toBe(false);
    expect(motionRenderParamsSchema.safeParse({ spec_id: crypto.randomUUID(), extra: 1 }).success).toBe(false);
  });
});
