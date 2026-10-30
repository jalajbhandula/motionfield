/**
 * Catalog aggregation - each domain file owns an ordered <DOMAIN>_MODELS array
 * and the compatibility barrels concatenate them. These tests pin the order
 * and coverage so a model can't land in the catalog without touching its
 * domain array.
 */
import { describe, expect, it } from "vitest";
import {
  VIDEO_MODELS, AUDIO_MODELS, CODE_MODELS, ALL_MODELS, MOTION_RENDER, MOTION_RENDER_ENDPOINT, findEndpoint,
} from "@/lib/catalog/video-models";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { VIDEO_GENERATE_MODELS } from "@/lib/catalog/video/generate";
import { VIDEO_VFX_MODELS } from "@/lib/catalog/video/vfx";
import { VIDEO_SWAP_MODELS } from "@/lib/catalog/video/swap";
import { VIDEO_CAMERA_MODELS } from "@/lib/catalog/video/camera";
import { VIDEO_POST_MODELS } from "@/lib/catalog/video/post";
import { EXPLAINER } from "@/lib/catalog/video/recipes";
import { AUDIO_VOICE_MODELS } from "@/lib/catalog/audio/voice";
import { AUDIO_MUSIC_MODELS } from "@/lib/catalog/audio/music";
import { CODE_MOTION_MODELS } from "@/lib/catalog/code/motion";
import { CODE_STAGE_MODELS } from "@/lib/catalog/code/stage";
import { CODE_GAMES_MODELS } from "@/lib/catalog/code/games";
import { IMAGE_GENERATE_MODELS } from "@/lib/catalog/image/generate";
import { IMAGE_EDIT_MODELS } from "@/lib/catalog/image/edit";
import { IMAGE_RELIGHT_MODELS } from "@/lib/catalog/image/relight";
import { IMAGE_ANGLES_MODELS } from "@/lib/catalog/image/angles";
import { THREED_MODELS } from "@/lib/catalog/image/threed";
import { ALL_PRESETS, findPreset } from "@/lib/catalog/presets";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("ws3 catalog aggregation", () => {
  it("VIDEO_MODELS is the domain arrays concatenated in domain order (recipes last)", () => {
    expect(ids(VIDEO_MODELS)).toEqual(ids([
      ...VIDEO_GENERATE_MODELS, ...VIDEO_VFX_MODELS, ...VIDEO_SWAP_MODELS,
      ...VIDEO_CAMERA_MODELS, ...VIDEO_POST_MODELS, EXPLAINER,
    ]));
  });

  it("IMAGE_MODELS, AUDIO_MODELS and CODE_MODELS follow the same rule", () => {
    expect(ids(IMAGE_MODELS)).toEqual(ids([
      ...IMAGE_GENERATE_MODELS, ...IMAGE_EDIT_MODELS, ...IMAGE_RELIGHT_MODELS, ...IMAGE_ANGLES_MODELS,
      ...THREED_MODELS,
    ]));
    // music/SFX first - the audio page opens on a generative tab, not TTS
    expect(ids(AUDIO_MODELS)).toEqual(ids([...AUDIO_MUSIC_MODELS, ...AUDIO_VOICE_MODELS]));
    expect(ids(CODE_MODELS)).toEqual(ids([...CODE_MOTION_MODELS, ...CODE_STAGE_MODELS, ...CODE_GAMES_MODELS]));
  });

  it("ALL_MODELS is the four barrels in order with no duplicate ids", () => {
    expect(ids(ALL_MODELS)).toEqual(ids([...IMAGE_MODELS, ...VIDEO_MODELS, ...AUDIO_MODELS, ...CODE_MODELS]));
    expect(new Set(ids(ALL_MODELS)).size).toBe(ALL_MODELS.length);
  });

  it("every domain array is present (empty is fine while the domain ships nothing)", () => {
    for (const arr of [
      VIDEO_GENERATE_MODELS, VIDEO_VFX_MODELS, VIDEO_SWAP_MODELS, VIDEO_CAMERA_MODELS, VIDEO_POST_MODELS,
      AUDIO_VOICE_MODELS, AUDIO_MUSIC_MODELS, CODE_MOTION_MODELS, CODE_STAGE_MODELS, CODE_GAMES_MODELS,
      IMAGE_GENERATE_MODELS, IMAGE_EDIT_MODELS, IMAGE_RELIGHT_MODELS, IMAGE_ANGLES_MODELS,
    ]) expect(Array.isArray(arr)).toBe(true);
    for (const arr of [IMAGE_ANGLES_MODELS, CODE_GAMES_MODELS])
      expect(arr.length).toBe(0); // empty placeholders - nothing is silently dropped
    expect(IMAGE_RELIGHT_MODELS.map((m) => m.id)).toEqual(["relight"]);
    expect(VIDEO_POST_MODELS.map((m) => m.id)).toEqual(["palette", "beat-cut"]);
  });

  it("MOTION_RENDER is the registered code-domain renderer", () => {
    expect(CODE_MOTION_MODELS[0]?.id).toBe("motion-render");
    expect(MOTION_RENDER.workflows[0]?.endpointId).toBe(MOTION_RENDER_ENDPOINT);
    expect(MOTION_RENDER.workflows[0]?.providers.recipe?.name).toBe("motion-render");
    expect(findEndpoint(MOTION_RENDER_ENDPOINT)?.model.id).toBe("motion-render");
  });

  it("preset barrel exposes the aggregated views", () => {
    expect(ALL_PRESETS.length).toBeGreaterThan(0);
    const p = ALL_PRESETS[0];
    expect(findPreset(p.kind, p.id)?.id).toBe(p.id);
    expect(new Set(ALL_PRESETS.map((x) => x.id)).size).toBe(ALL_PRESETS.length);
  });
});
