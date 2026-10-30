/**
 * Director move resolution + aux output prefixes (PART 0B):
 *  - a mixed catalog stack executes its runnable ids and prompt-guides the
 *    rest - a runnable id never goes prompt-guided just because its stack-mate
 *    can't run on the rig
 *  - a pure >3 stack is refused (the "1-3 stack" contract)
 *  - the director's placeholder map mints job-unique REFGRID_PREFIX /
 *    KEYFRAME_PREFIX so aux SaveImage outputs can't collide with (or be
 *    mistaken for) the primary PREFIX video output - and both bundled graphs
 *    wire their aux loaders to the aux placeholders
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { resolveMoves } from "@/lib/camera/moves";
import { DIRECTOR } from "@/lib/catalog/video/generate";

const map = (p: Record<string, unknown>) => DIRECTOR.workflows[0].providers.comfy!.map!(p);

describe("resolveMoves - mixed stacks split runnable from prompt-guided", () => {
  it("a runnable id executes even when its stack-mate can't", () => {
    const r = resolveMoves("dolly-in+eye-push");
    expect(r?.executed).toEqual(["dolly-in"]);
    expect(r?.moves).toBe("dolly-in");
    expect(r?.guided).toBe("Eye Push");
    expect(r?.stack).toBe(true);
  });

  it("a fully unrunnable catalog stack is all prompt-guided", () => {
    const r = resolveMoves("eye-push+body-mount");
    expect(r?.executed).toEqual([]);
    expect(r?.moves).toBe("locked-off");
    expect(r?.guided).toBe("Eye Push + Body Mount");
    expect(r?.stack).toBe(true);
  });

  it("mixed free text keeps the runnable id and guides the rest", () => {
    const r = resolveMoves("dolly in then swoop low");
    expect(r?.executed).toEqual(["dolly-in"]);
    expect(r?.guided).toBe("swoop low");
    expect(r?.stack).toBe(false);
  });

  it("pure catalog stacks over 3 refuse", () => {
    expect(resolveMoves("dolly-in+pan-left+tilt-up+arc-left")).toBeNull();
  });
});

describe("director aux prefixes - refgrid/keyframe can't collide with the video", () => {
  it("the map mints job-unique REFGRID_PREFIX and KEYFRAME_PREFIX", () => {
    const m = map({ duration: 1 });
    expect(m.REFGRID_PREFIX).toMatch(/^of_dir_[0-9a-f]{8}-refgrid$/);
    expect(m.KEYFRAME_PREFIX).toMatch(/^of_dir_[0-9a-f]{8}-keyframe$/);
    const m2 = map({ duration: 1 });
    expect(m2.REFGRID_PREFIX).not.toBe(m.REFGRID_PREFIX);
    expect(m2.KEYFRAME_PREFIX).not.toBe(m.KEYFRAME_PREFIX);
  });

  it("both director graphs wire aux SaveImage inputs to the aux placeholders", async () => {
    for (const file of ["director-wan.json", "director-wan-txt.json"]) {
      const g = JSON.parse(await fs.readFile(path.join("workflows", file), "utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const declared = Object.keys((g._meta as { placeholders?: Record<string, string> }).placeholders ?? {});
      // every aux SaveImage filename must be an aux placeholder - never {{PREFIX}}
      const aux = Object.values(g).filter((n) => n.class_type === "SaveImage");
      expect(aux.length, `${file} carries refgrid/keyframe SaveImage`).toBeGreaterThan(0);
      for (const n of aux) {
        const v = String(n.inputs.filename_prefix);
        expect(v, `${file} SaveImage prefix must not be the primary PREFIX`).not.toContain("{{PREFIX}}");
        const key = /^\{\{([A-Z_0-9]+)\}\}$/.exec(v)?.[1];
        expect(key && declared.includes(key), `${file} SaveImage uses a declared placeholder`).toBeTruthy();
      }
      // the video output still rides PREFIX
      const vhs = Object.values(g).find((n) => n.class_type === "VHS_VideoCombine");
      expect(vhs?.inputs.filename_prefix).toBe("{{PREFIX}}");
    }
    // the txt graph declares both; the i2v graph only refgrid (no keyframe render)
    const txt = JSON.parse(await fs.readFile("workflows/director-wan-txt.json", "utf8")) as { _meta: { placeholders: Record<string, string> } };
    expect(Object.keys(txt._meta.placeholders)).toContain("REFGRID_PREFIX");
    expect(Object.keys(txt._meta.placeholders)).toContain("KEYFRAME_PREFIX");
  });
});
