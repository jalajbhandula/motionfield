/**
 * Phase B graph fixes, checked through the same substitute + prune path
 * createJob submits. No GPU.
 *
 *  - Wan2.2-Animate replace: a still mask seeds a per-frame track. Move mode
 *    (no mask) drops that chain and leaves the grey plate unmasked.
 *  - Draw-to-video: the stroke is a mask, never a VACE reference image.
 *  - Object swap and restyle mux audio through OF_PlateAudio.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { placeholders, prune, substitute } from "@/lib/generation/comfy";
import type { SubmitInput } from "@/lib/generation/types";
import { DRAW_TO_VIDEO } from "@/lib/catalog/video/camera";
import { WAN_ANIMATE, WAN_VACE } from "@/lib/catalog/video/swap";

const WF_DIR = resolve(__dirname, "../../workflows");

type Node = { class_type: string; inputs: Record<string, unknown> };
type Built = Record<string, Node>;

function workflow(model: { workflows: SubmitInput["workflow"][] }, id: string): SubmitInput["workflow"] {
  const found = model.workflows.find((w) => w.id === id);
  if (!found) throw new Error(`missing workflow ${id}`);
  return found;
}

function build(file: string, wf: SubmitInput["workflow"], params: Record<string, unknown>): Built {
  const raw = JSON.parse(readFileSync(join(WF_DIR, file), "utf8")) as {
    _meta?: { optional?: string[] };
  };
  const optional = new Set(raw._meta?.optional ?? []);
  const map = placeholders({
    jobId: "00000000-0000-0000-0000-0000000000ab",
    model: {} as never,
    workflow: wf,
    params,
    appBaseUrl: "http://localhost:3000",
  });
  return prune(substitute(raw as never, map, optional)) as Built;
}

function byClass(graph: Built, classType: string): [string, Node][] {
  return Object.entries(graph).filter((entry): entry is [string, Node] => entry[1]?.class_type === classType);
}

function linked(graph: Built, value: unknown): Node | undefined {
  if (!Array.isArray(value) || typeof value[0] !== "string") return undefined;
  return graph[value[0]];
}

const clip = {
  video_url: "/files/clip.mp4",
  image_url: "/files/stroke.png",
  mask_url: "/files/mask.png",
  image_urls: ["/files/ref.png"],
  prompt: "keep the room, change the marked region",
};

describe("wan-animate replace vs move", () => {
  const wf = workflow(WAN_ANIMATE, "character-swap");

  it("replace mode tracks the still mask per frame", () => {
    const graph = build("wan-animate-character-swap.json", wf, clip);
    const animate = byClass(graph, "WanAnimateToVideo");
    expect(animate).toHaveLength(1);
    const trackId = String((animate[0][1].inputs.character_mask as [string, number])[0]);
    expect(graph[trackId].class_type).toBe("OF_MaskTrack");
    expect(linked(graph, graph[trackId].inputs.pick)?.class_type).toBe("LoadImageMask");
    expect(linked(graph, graph[trackId].inputs.matte)?.class_type).toBe("GrowMask");
    expect(byClass(graph, "LoadBackgroundRemovalModel")).toHaveLength(1);

    const plate = byClass(graph, "ImageCompositeMasked");
    expect(plate).toHaveLength(1);
    expect(plate[0][1].inputs.mask).toEqual([trackId, 0]);
  });

  it("move mode disconnects background_video and character_mask (stock Move mode)", () => {
    const { mask_url: _mask, ...move } = clip;
    const graph = build("wan-animate-character-swap.json", wf, move);
    expect(byClass(graph, "OF_MaskTrack")).toHaveLength(0);
    expect(byClass(graph, "LoadImageMask")).toHaveLength(0);
    expect(byClass(graph, "LoadBackgroundRemovalModel")).toHaveLength(0);
    expect(byClass(graph, "GrowMask")).toHaveLength(0);

    const animate = byClass(graph, "WanAnimateToVideo")[0][1];
    expect(animate.inputs.character_mask).toBeUndefined();
    // an unmasked plate would be an all-grey background_video
    expect(animate.inputs.background_video).toBeUndefined();
    expect(byClass(graph, "ImageCompositeMasked")).toHaveLength(0);
    expect(byClass(graph, "EmptyImage")).toHaveLength(0);
    expect(linked(graph, animate.inputs.reference_image)?.class_type).toBe("LoadImage");
    expect(linked(graph, animate.inputs.pose_video)?.class_type).toBe("OF_DWPose");
  });
});

describe("draw-to-video uses a stroke mask", () => {
  const wf = workflow(DRAW_TO_VIDEO, "draw");

  it("does not pass the edited frame in as a reference image", () => {
    const graph = build("vace-draw.json", wf, { ...clip, timestamp: 1 });
    const vace = byClass(graph, "WanVaceToVideo");
    expect(vace).toHaveLength(1);
    expect(vace[0][1].inputs.reference_image).toBeUndefined();
    expect(linked(graph, vace[0][1].inputs.control_masks)?.class_type).toBe("OF_DrawMask");
    // the drawn region is greyed out in the control clip - VACE regenerates
    // only what it can't see, so the original pixels there must not survive
    const ctrl = linked(graph, vace[0][1].inputs.control_video);
    expect(ctrl?.class_type).toBe("ImageCompositeMasked");
    expect(linked(graph, ctrl?.inputs.destination)?.class_type).toBe("VHS_LoadVideo");
    expect(linked(graph, ctrl?.inputs.mask)?.class_type).toBe("OF_DrawMask");

    const output = byClass(graph, "VHS_VideoCombine")[0][1];
    const composite = linked(graph, output.inputs.images);
    expect(composite?.class_type).toBe("ImageCompositeMasked");
    expect(linked(graph, composite?.inputs.destination)?.class_type).toBe("VHS_LoadVideo");
    expect(linked(graph, composite?.inputs.source)?.class_type).toBe("VAEDecode");
    expect(linked(graph, composite?.inputs.mask)?.class_type).toBe("OF_DrawMask");

    const draw = byClass(graph, "OF_DrawMask")[0][1];
    expect(linked(graph, draw.inputs.edited)?.class_type).toBe("LoadImage");
    const base = linked(graph, draw.inputs.base);
    expect(base?.class_type).toBe("VHS_LoadVideo");
    expect(base?.inputs.skip_first_frames).toBe(16);
    expect(base?.inputs.frame_load_cap).toBe(1);
    expect(linked(graph, ctrl?.inputs.destination)?.inputs.skip_first_frames).toBe(0);

    const trim = byClass(graph, "TrimVideoLatent")[0][1];
    expect(trim.inputs.trim_amount).toEqual([vace[0][0], 3]);
    expect(linked(graph, byClass(graph, "VHS_VideoCombine")[0][1].inputs.audio)?.class_type).toBe("OF_PlateAudio");
  });

  it("keeps motion transfer on the reference-image graph", () => {
    const motion = workflow(WAN_VACE, "motion-transfer");
    const graph = build("vace-motion-transfer.json", motion, clip);
    const vace = byClass(graph, "WanVaceToVideo")[0][1];
    expect(linked(graph, vace.inputs.reference_image)?.class_type).toBe("LoadImage");
    expect(byClass(graph, "OF_DrawMask")).toHaveLength(0);
  });
});

describe("silent clips do not read VHS audio output 2", () => {
  const cases: [string, SubmitInput["workflow"]][] = [
    ["vace-object-swap.json", workflow(WAN_VACE, "object-swap")],
    ["vace-object-swap-sam3.json", workflow(WAN_VACE, "object-swap")],
    ["vace-restyle.json", workflow(WAN_VACE, "restyle")],
  ];

  for (const [file, wf] of cases) {
    it(file, () => {
      const graph = build(file, wf, clip);
      const combines = byClass(graph, "VHS_VideoCombine");
      expect(combines.length).toBeGreaterThan(0);
      for (const [, node] of combines) {
        expect(linked(graph, node.inputs.audio)?.class_type).toBe("OF_PlateAudio");
      }
      for (const [, node] of Object.entries(graph)) {
        for (const value of Object.values(node.inputs)) {
          if (Array.isArray(value) && value[1] === 2) {
            expect(graph[String(value[0])]?.class_type).not.toBe("VHS_LoadVideo");
          }
        }
      }
    });
  }
});

describe("explicit output geometry", () => {
  const wf = WAN_ANIMATE.workflows[0] as unknown as SubmitInput["workflow"];
  const base = { video_url: "src.mp4", image_urls: ["ref.png"], likeness_consent: true, resolution: "480p" };
  it("defaults stay 16:9 5s@25fps when the caller sends nothing", () => {
    const g = build("wan-animate-character-swap.json", wf, base);
    const [, n] = byClass(g, "WanAnimateToVideo")[0];
    expect([n.inputs.width, n.inputs.height, n.inputs.length]).toEqual([864, 480, 129]);
  });
  it("width/height/frames from a portrait source win (4n+1 frames)", () => {
    const g = build("wan-animate-character-swap.json", wf, { ...base, width: 480, height: 832, frames: 81 });
    const [, n] = byClass(g, "WanAnimateToVideo")[0];
    expect([n.inputs.width, n.inputs.height, n.inputs.length]).toEqual([480, 832, 81]);
  });
});


describe("character reference framing", () => {
  it("contain-pads complete references before VACE's center crop", () => {
    const graph = JSON.parse(readFileSync(join(WF_DIR, "character-vace-image.json"), "utf8")) as Built;
    const vace = byClass(graph, "WanVaceToVideo")[0][1];
    const fit = linked(graph, vace.inputs.reference_image);
    expect(fit?.class_type).toBe("OF_BoxPlace");
    expect(fit?.inputs).toMatchObject({ bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, grow: 0, feather: 0 });
    const canvas = linked(graph, fit?.inputs.image);
    expect(canvas?.class_type).toBe("EmptyImage");
    expect(canvas?.inputs).toMatchObject({ width: "{{WIDTH}}", height: "{{HEIGHT}}" });
  });
});
