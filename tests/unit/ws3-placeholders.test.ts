/**
 * Placeholder substitution in comfy.ts:
 *  - generic pass: every scalar param lands under its UPPER_SNAKE placeholder
 *  - existing mapped keys are untouched by the generic pass
 *  - unresolved non-optional placeholders fail with "missing placeholders: X, Y"
 *  - _meta.optional placeholders still drop their loader node (+ link rewire)
 */
import { describe, expect, it } from "vitest";
import { placeholders, paramToPlaceholder, substitute, validateMediaParams, prune } from "@/lib/generation/comfy";
import type { SubmitInput } from "@/lib/generation/types";

const input = (params: Record<string, unknown>): SubmitInput => ({
  jobId: "00000000-0000-0000-0000-000000000001",
  model: {} as never,
  workflow: { endpointId: "test/wf", providers: { comfy: { workflow: "x.json" } } } as never,
  params,
  appBaseUrl: "http://localhost:3000",
});

describe("placeholders() generic mapping", () => {
  it("exposes scalar params as UPPER_SNAKE placeholders", () => {
    const map = placeholders(input({ prompt: "hi", skip_frames: 3, camera_movement: "dolly-in", generate_audio: false, custom_flag: "x" }));
    expect(map.SKIP_FRAMES).toBe("3");
    expect(map.CAMERA_MOVEMENT).toBe("dolly-in");
    expect(map.GENERATE_AUDIO).toBe("false");
    expect(map.CUSTOM_FLAG).toBe("x");
  });

  it("does not override explicitly mapped keys", () => {
    const map = placeholders(input({ prompt: "p", steps: 8, seed: 7, voice: "am_adam", negative_prompt: "bad", batch_size: 4 }));
    expect(map.PROMPT).toBe("p");
    expect(map.STEPS).toBe("8");       // explicit map wins over generic STEPS (same value anyway)
    expect(map.SEED).toBe("7");
    expect(map.VOICE).toBe("am_adam");
    expect(map.NEGATIVE).toBe("bad");
    expect(map.BATCH).toBe("4");
  });

  it("keeps the special media remap and skips non-scalars", () => {
    const map = placeholders(input({ image_url: "/files/a.png", image_urls: ["/files/a.png", "/files/b.png"] }));
    expect(map.INPUT_IMAGE).toBe("/files/a.png");
    expect(map.IMAGE_URL).toBe("/files/a.png"); // generic scalar also lands
    expect(map.REF_IMAGE).toBe("/files/a.png");
    expect(map.REF_IMAGE_2).toBe("/files/b.png");
    expect(map.IMAGE_URLS).toBeUndefined();
  });

  it("reserved placeholders are never filled by stray params", () => {
    const map = placeholders(input({
      input_video: "/any/local/path.mp4", ref_image: "someone-elses-upload.png",
      mask_image: "/files/m.png", end_frame: "7", pose_image: "/files/p.png",
      source_face_image: "/files/face.png", prefix: "pwned_", model: "evil.safetensors",
    }));
    expect(map.INPUT_VIDEO).toBeUndefined();
    expect(map.REF_IMAGE).toBeUndefined();
    expect(map.MASK_IMAGE).toBeUndefined();
    expect(map.END_FRAME).toBeUndefined();
    expect(map.POSE_IMAGE).toBeUndefined();
    expect(map.SOURCE_FACE_IMAGE).toBeUndefined();
    expect(map.PREFIX).toBe("of_00000000"); // jobId-derived, not the param
    expect(map.MODEL).toBe("RealESRGAN_x4plus.pth");
  });

  it("media-typed params skip the generic pass - they reach their placeholders via the explicit mapping only", () => {
    const inp = input({ image_url: "/files/a.png", pose_image_url: "/files/p.png", scene_note: "x" });
    inp.workflow = {
      ...(inp.workflow as object),
      params: [
        { name: "image_url", label: "Image", type: "image" },
        { name: "pose_image_url", label: "Pose", type: "image" },
        { name: "scene_note", label: "Note", type: "text" },
      ],
    } as SubmitInput["workflow"];
    const map = placeholders(inp);
    expect(map.INPUT_IMAGE).toBe("/files/a.png");
    expect(map.POSE_IMAGE).toBe("/files/p.png");
    expect(map.IMAGE_URL).toBeUndefined();      // media param doesn't generic-map
    expect(map.POSE_IMAGE_URL).toBeUndefined();
    expect(map.SCENE_NOTE).toBe("x");            // plain text params still map
  });

  it("paramToPlaceholder keeps the historical media names", () => {
    expect(paramToPlaceholder("image_url")).toBe("INPUT_IMAGE");
    expect(paramToPlaceholder("video_url")).toBe("INPUT_VIDEO");
    expect(paramToPlaceholder("audio_url")).toBe("INPUT_AUDIO");
    expect(paramToPlaceholder("mask_url")).toBe("MASK_IMAGE");
    expect(paramToPlaceholder("end_image_url")).toBe("END_IMAGE");
    expect(paramToPlaceholder("whatever_else")).toBe("WHATEVER_ELSE");
  });
});

describe("validateMediaParams()", () => {
  const wf = {
    params: [
      { name: "video_url", label: "Video", type: "media" },
      { name: "mask_url", label: "Mask", type: "image" },
      { name: "image_urls", label: "Refs", type: "images" },
    ],
  } as never;

  it("rejects wrong-typed media params instead of dropping them silently", () => {
    expect(() => validateMediaParams(wf, { video_url: 123 })).toThrow(/video_url/);
    expect(() => validateMediaParams(wf, { mask_url: { url: "x" } })).toThrow(/mask_url/);
    expect(() => validateMediaParams(wf, { image_urls: ["/files/a.png", 7] })).toThrow(/image_urls/);
    expect(() => validateMediaParams(wf, { video_url: ["https://x/a.mp4", "https://x/b.mp4"] })).not.toThrow(); // string[] is a valid media value
    expect(() => validateMediaParams(wf, { image_urls: "https://x/y.png" })).not.toThrow();
    expect(() => validateMediaParams(wf, { image_urls: ["/files/a.png", "/files/b.png"] })).not.toThrow();
    expect(() => validateMediaParams(wf, {})).not.toThrow();
  });

  it("rejects bare filenames/paths - only /files/ or http(s) refs reach ComfyUI", () => {
    // a bare name would let LoadImage read any file in ComfyUI's input folder
    expect(() => validateMediaParams(wf, { mask_url: "etc/x.png" })).toThrow("invalid media param mask_url");
    expect(() => validateMediaParams(wf, { image_urls: ["/files/a.png", "b.png"] })).toThrow("invalid media param image_urls");
    expect(() => validateMediaParams(wf, { video_url: "/abs/path/v.mp4" })).toThrow("invalid media param video_url");
    expect(() => validateMediaParams(wf, { video_url: "/files/v.mp4" })).not.toThrow();
    expect(() => validateMediaParams(wf, { mask_url: "https://cdn.example/m.png" })).not.toThrow();
  });
});

describe("substitute()", () => {
  const node = (cls: string, inputs: Record<string, unknown>) => ({ class_type: cls, inputs });

  it("fills known placeholders and coerces numeric strings", () => {
    const g = substitute(
      { "1": node("KSampler", { seed: "{{SEED}}", steps: "{{STEPS}}", text: "{{PROMPT}}" }) },
      { SEED: "42", STEPS: "8", PROMPT: "a cube" },
      new Set(),
    );
    expect(g["1"].inputs).toEqual({ seed: 42, steps: 8, text: "a cube" });
  });

  it("generic params substitute like built-ins", () => {
    const g = substitute(
      { "1": node("VHS_LoadVideo", { skip_frames: "{{SKIP_FRAMES}}", rate: "{{FPS}}" }) },
      placeholders(input({ skip_frames: 2, fps: 16 })),
      new Set(),
    );
    expect(g["1"].inputs.skip_frames).toBe(2);
    expect(g["1"].inputs.rate).toBe(16);
  });

  it("'true'/'false' placeholder values land as real booleans (ComfyUI bool() would read \"false\" as true)", () => {
    const g = substitute(
      { "1": node("Sampler", { generate_audio: "{{GENERATE_AUDIO}}", flag: "{{FLAG}}", name: "{{PROMPT}}" }) },
      placeholders(input({ prompt: "a cube", generate_audio: false, flag: "true" })),
      new Set(),
    );
    expect(g["1"].inputs.generate_audio).toBe(false);
    expect(g["1"].inputs.flag).toBe(true);
    expect(g["1"].inputs.name).toBe("a cube");
  });

  it("prompt placeholders never coerce 'true'/'false' - a prompt reading 'false' stays a string", () => {
    const g = substitute(
      { "1": node("CLIPTextEncode", { text: "{{PROMPT}}", neg: "{{NEGATIVE}}", mot: "{{MOTION_PROMPT}}", flag: "{{FLAG}}" }) },
      { PROMPT: "false", NEGATIVE: "true", MOTION_PROMPT: "false", FLAG: "false" },
      new Set(),
    );
    expect(g["1"].inputs.text).toBe("false");
    expect(g["1"].inputs.neg).toBe("true");
    expect(g["1"].inputs.mot).toBe("false");
    expect(g["1"].inputs.flag).toBe(false); // non-prompt keys still coerce
  });

  it("fails with 'missing placeholders: X, Y' when non-optional placeholders remain", () => {
    expect(() =>
      substitute(
        { "1": node("N", { a: "{{ZED}}", b: "{{ALPHA}}" }), "2": node("M", { c: "{{ZED}}" }) },
        {},
        new Set(),
      ),
    ).toThrowError("missing placeholders: ALPHA, ZED");
  });

  it("does not count placeholders on nodes dropped by the optional rule", () => {
    // node 1 carries BOTH an optional placeholder (dropped) and an unresolved
    // one - the whole node goes away, so UNKNOWN is never reported.
    const g = substitute(
      {
        "1": node("LoadImage", { image: "{{OPT_IMG}}", other: "{{UNKNOWN}}" }),
        "2": node("SaveImage", { images: ["1", 0], filename_prefix: "x" }),
      },
      {},
      new Set(["OPT_IMG"]),
    );
    expect(g["1"]).toBeUndefined();
  });

  it("optional loaders still drop and links rewire via passthrough", () => {
    const g = substitute(
      {
        _meta: { passthrough: { "9": ["model", "clip", "vae"] } } as never,
        "8": node("UNETLoader", { unet_name: "w.safetensors" }),
        "9": node("Guide", { model: ["8", 0], clip: ["8", 1], vae: ["8", 2], image: "{{OPT_IMG}}" }),
        "10": node("Sampler", { model: ["9", 0], clip: ["9", 1], vae: ["9", 2], seed: "{{SEED}}" }),
      },
      { SEED: "1" },
      new Set(["OPT_IMG"]),
    );
    expect(g["9"]).toBeUndefined();
    // consumers of the dropped guide rewire to its passthrough inputs
    expect(g["10"].inputs.model).toEqual(["8", 0]);
    expect(g["10"].inputs.clip).toEqual(["8", 1]);
    expect(g["10"].inputs.seed).toBe(1);
  });

  it("drops plain consumers' links to dropped nodes", () => {
    const g = substitute(
      {
        "1": node("LoadImage", { image: "{{OPT_IMG}}" }),
        "2": node("Node", { a: ["1", 0], b: "keep" }),
      },
      {},
      new Set(["OPT_IMG"]),
    );
    expect(g["2"].inputs.a).toBeUndefined();
    expect(g["2"].inputs.b).toBe("keep");
  });
});

describe("prune()", () => {
  const node = (cls: string, inputs: Record<string, unknown>) => ({ class_type: cls, inputs });
  it("keeps an OF_ProvTag terminal and its chain - a custom save is an output too", () => {
    const g = prune({
      "1": node("LoadImage", { image: "in.png" }),
      "2": node("Sampler", { image: ["1", 0] }),
      "3": node("OF_ProvTag", { images: ["2", 0], feature: "photo-face-swap" }),
      "4": node("SaveImage", { images: ["1", 0] }),
      "9": node("LoadImage", { image: "dangling.png" }), // nothing consumes it - dropped
    });
    expect(Object.keys(g).sort()).toEqual(["1", "2", "3", "4"]);
  });
});
