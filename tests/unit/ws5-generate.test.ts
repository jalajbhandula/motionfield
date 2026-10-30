import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildMotionSpec,
  generateMotionSpec,
  motionDraftSchema,
  NeedsLlm,
  refineMotionSpec,
  type MotionDeps,
  type MotionDraft,
} from "@/lib/render/generate";
import fixture from "../fixtures/ws5-launch.json";
import { parseSceneSpec } from "@/lib/render/spec";

const draftFrom = (v: unknown) => {
  const s = v as Record<string, unknown>;
  return motionDraftSchema.parse({
    background: s.background, camera: s.camera, layers: s.layers, params: s.params,
  });
};

const fmt = { aspect: "9:16" as const, resolution: "1080p" as const, fps: 30 as const, duration: 6 };
const deps = (chatJson: MotionDeps["chatJson"], on = true): MotionDeps => ({ chatJson, llmReady: async () => on });

describe("motionDraftSchema", () => {
  it("emits JSON Schema (recursive layers included)", () => {
    const js = z.toJSONSchema(motionDraftSchema);
    expect(js.type).toBe("object");
    expect((js.required as string[]).sort()).toEqual(["background", "camera", "layers", "params"]);
  });

  it("accepts the fixture's draft half", () => {
    const s = fixture as unknown as Record<string, unknown>;
    const r = motionDraftSchema.safeParse({
      background: s.background, camera: s.camera, layers: s.layers, params: s.params,
    });
    expect(r.success).toBe(true);
  });

  it("runs cross-reference checks - a bad bind fails safeParse (so the LLM repair round sees it)", () => {
    const s = fixture as unknown as Record<string, unknown>;
    const draft = {
      background: s.background, camera: s.camera, layers: s.layers,
      params: [{ id: "x", label: "x", min: 0, max: 1, step: 0.1, default: 0.5, bind: "ghost.scale" }],
    };
    const r = motionDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join("; ")).toContain("ghost");
  });

  it("catches duplicate layer ids and invalid keyframe paths at draft time", () => {
    const s = fixture as unknown as Record<string, unknown>;
    const dupLayers = [...(s.layers as unknown[]), (s.layers as unknown[])[1]];
    expect(motionDraftSchema.safeParse({
      background: s.background, camera: s.camera, layers: dupLayers, params: s.params,
    }).success).toBe(false);

    const badKf = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    (badKf.layers as { keyframes?: unknown[] }[])[0].keyframes = [{ t: 0, path: "props.nothere", value: 1 }];
    expect(motionDraftSchema.safeParse({
      background: badKf.background, camera: badKf.camera, layers: badKf.layers, params: badKf.params,
    }).success).toBe(false);
  });

  it("enforces the layer/particle budgets on drafts", () => {
    const s = fixture as unknown as Record<string, unknown>;
    const dust = (s.layers as { id: string; type: string; props: Record<string, unknown> }[])
      .find((l) => l.type === "particles")!;
    const heavy = Array.from({ length: 3 }, (_, i) => ({
      ...dust, id: `p${i}`, props: { ...dust.props, count: 20000 },
    }));
    const r = motionDraftSchema.safeParse({
      background: s.background, camera: s.camera,
      layers: [...heavy, (s.layers as unknown[])[0]],
      params: s.params,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join("; ")).toMatch(/particles/);
  });
});

describe("buildMotionSpec - dims table", () => {
  it.each([
    ["16:9", "720p", 1280, 720], ["16:9", "1080p", 1920, 1080], ["16:9", "4k", 3840, 2160],
    ["9:16", "720p", 720, 1280], ["9:16", "4k", 2160, 3840],
    ["1:1", "4k", 2160, 2160], ["4:5", "1080p", 864, 1080],
  ] as const)("%s %s → %dx%d", (aspect, resolution, w, h) => {
    const draft = draftFrom(fixture);
    const spec = buildMotionSpec({ aspect, resolution, fps: 24, duration: 4 }, draft, 42);
    expect(spec.width).toBe(w);
    expect(spec.height).toBe(h);
    expect(spec.width % 2 + spec.height % 2).toBe(0); // h264 needs even
    expect(Math.max(spec.width, spec.height)).toBeLessThanOrEqual(3840);
    expect(spec.width * spec.height).toBeLessThanOrEqual(3840 * 2160);
    expect(spec.fps).toBe(24);
    expect(spec.seed).toBe(42);
    expect(spec.version).toBe(1);
  });

  it("rejects a draft that fails full-spec validation (bad bind)", () => {
    const draft = draftFrom(fixture);
    draft.params = [{ id: "x", label: "x", min: 0, max: 1, step: 0.1, default: 0.5, bind: "nope.scale" }];
    expect(() => buildMotionSpec({ aspect: "16:9", resolution: "720p", fps: 24, duration: 4 }, draft)).toThrow();
  });
});

describe("generateMotionSpec / refineMotionSpec", () => {
  it("throws NEEDS_LLM when no LLM is configured", async () => {
    await expect(
      generateMotionSpec({ prompt: "title card", format: fmt }, deps(async () => { throw new Error("never called"); }, false)),
    ).rejects.toThrow("NEEDS_LLM");
  });

  it("calls chatJson once with a draft and assembles the full spec", async () => {
    let calls = 0;
    const fake: MotionDeps["chatJson"] = async (schema, msgs) => {
      calls++;
      expect(msgs[0].role).toBe("system");
      expect(String(msgs[1].content)).toContain("title card");
      expect(String(msgs[1].content)).toContain("1080×1920");
      return draftFrom(fixture) as never;
    };
    const spec = await generateMotionSpec({ prompt: "title card", format: fmt }, deps(fake));
    expect(calls).toBe(1);
    expect(spec.width).toBe(1080);
    expect(spec.height).toBe(1920);
    expect(spec.fps).toBe(30);
    expect(spec.duration).toBe(6);
    expect(spec.layers.length).toBe(fixture.layers.length);
  });

  it("propagates LLM failure", async () => {
    const fake: MotionDeps["chatJson"] = async () => { throw new Error("provider down"); };
    await expect(generateMotionSpec({ prompt: "x", format: fmt }, deps(fake))).rejects.toThrow("provider down");
  });

  it("embeds <brand_context> only when a url/brand was supplied", async () => {
    const seen: string[] = [];
    const fake: MotionDeps["chatJson"] = async (_s, msgs) => {
      seen.push(String(msgs[1].content));
      return draftFrom(fixture) as never;
    };
    const d = deps(fake);
    await generateMotionSpec({ prompt: "a card", format: fmt }, d);
    expect(seen[0]).not.toContain("brand_context");

    await generateMotionSpec(
      { prompt: "a card", format: fmt, brand: { url: "https://x.example", title: "X", colors: ["#112233"] } },
      d,
    );
    expect(seen[1]).toContain("brand_context");
    expect(seen[1]).toContain("https://x.example");
  });

  it("refine keeps the original frame + seed and applies the new draft", async () => {
    const spec = parseSceneSpec(fixture);
    const changed = draftFrom(fixture);
    changed.layers = (changed.layers as unknown[]).filter((l) => (l as { id: string }).id !== "dust") as MotionDraft["layers"];
    changed.params = changed.params.slice(0, 1).concat([{ id: "p2", label: "y", min: 0, max: 1, step: 0.1, default: 0.5, bind: "title.scale" }]);
    const fake: MotionDeps["chatJson"] = async (_s, msgs) => {
      expect(String(msgs[1].content)).toContain("remove the dust");
      return changed as never;
    };
    const out = await refineMotionSpec(spec, "remove the dust", {}, deps(fake));
    expect(out.width).toBe(spec.width);
    expect(out.height).toBe(spec.height);
    expect(out.fps).toBe(spec.fps);
    expect(out.duration).toBe(spec.duration);
    expect(out.seed).toBe(spec.seed);
    expect(out.layers.find((l) => l.id === "dust")).toBeUndefined();
  });
});
