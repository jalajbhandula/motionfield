/**
 * Red-flag patterns (licenses.ts) - weight names and node classes that must
 * never run. A match inside a graph yields a "banned" component even on a
 * known/allowlisted class (a param swap can't launder a banned weight).
 */
import { describe, expect, it } from "vitest";
import { graphLicense, KNOWN_NODES, RED_FLAG_WEIGHTS } from "@/lib/catalog/licenses";

const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });

const flag = (v: string) => RED_FLAG_WEIGHTS.some((re) => re.test(v));

describe("RED_FLAG_WEIGHTS", () => {
  it("catches the ws3 additions", () => {
    expect(flag("gimmvfi_r_arb_lpips_fp32.safetensors")).toBe(true);  // GIMM-VFI - word-boundary gimm alone misses "gimmvfi"
    expect(flag("GIMM_R_Arb_LPIPS_fp32.safetensors")).toBe(true);
    expect(flag("kandinsky5_t2v.safetensors")).toBe(true);
    // DINOv3 was reclassified banned→restricted in s2b - the weight ban must
    // NOT catch it; RESTRICTED_WEIGHT_PATTERNS owns it (separator-agnostic)
    expect(flag("dinov3_vitl16.safetensors")).toBe(false);
    expect(flag("dino_v3_vit_l.safetensors")).toBe(false);
    expect(flag("body_pose_model.onnx")).toBe(true);                 // OpenPose-carryover pose weights - non-commercial
    expect(flag("hand_pose_model.onnx")).toBe(true);
    // s8fix bans: rembg's default model, SkinTokens, Make-It-Animatable, Mixamo
    expect(flag("u2net_human_seg.onnx")).toBe(true);
    expect(flag("skintokens_v1.safetensors")).toBe(true);
    expect(flag("make-it-animatable-dit.safetensors")).toBe(true);
    expect(flag("mixamo_rig.bin")).toBe(true);
    // non-matches stay clear
    expect(flag("wan2.1_vace_1.3B_fp16.safetensors")).toBe(false);
    expect(flag("yolox_l.onnx")).toBe(false);                        // DWPose person detector is Apache-2.0
    expect(flag("dw-ll_ucoco_384.onnx")).toBe(false);
  });
});

describe("graphLicense red-flag handling", () => {
  const known = KNOWN_NODES; // LoadImage is a core class

  it("a red-flag weight on a known class bans the graph", () => {
    const lic = graphLicense({ "1": node("LoadImage", { image: "gimmvfi_r_arb_lpips_fp32.safetensors" }) });
    expect(lic.class).toBe("banned");
    expect(lic.components.some((c) => c.class === "banned" && c.name.includes("gimmvfi"))).toBe(true);
  });

  it("a red-flag weight via a *_name input bans the graph", () => {
    const lic = graphLicense({ "1": node("UNETLoader", { unet_name: "kandinsky5_t2v.safetensors" }) });
    expect(lic.class).toBe("banned");
  });

  it("a red-flag class bans the graph", () => {
    const lic = graphLicense({ "1": node("KandinskyLoader", {}) });
    expect(lic.class).toBe("banned");
    expect(lic.components.some((c) => c.name.includes("Kandinsky"))).toBe(true);
    // s8fix class bans - SkinTokens / Make-It-Animatable / Mixamo entry points
    for (const cls of ["SkinTokensLoader", "MakeItAnimatableSampler", "MixamoRetarget"]) {
      expect(graphLicense({ "1": node(cls, {}) }).class, cls).toBe("banned");
    }
  });

  it("unlisted weights stay restricted (fail closed), not banned", () => {
    const lic = graphLicense({ "1": node("UNETLoader", { unet_name: "totally_unknown_model.safetensors" }) });
    expect(lic.class).toBe("restricted");
  });
});
