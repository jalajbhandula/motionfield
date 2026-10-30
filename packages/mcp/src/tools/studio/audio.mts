import { z } from "zod";
import { toolError, type ToolDef } from "../../registry.mts";
import { checkAgainstSchema, submitJob, waitField } from "./_job.mts";

const ENDPOINTS = {
  music: "motionfield/acestep/music",
  sfx: "motionfield/moss/sfx",
  video_sfx: "motionfield/moss/video-sfx",
} as const;

const Input = z.object({
  kind: z.enum(["music", "sfx", "video_sfx"])
    .describe("music = text→song (ACE-Step); sfx = text→effect (MOSS); video_sfx = your clip + foley cues"),
  prompt: z.string().optional()
    .describe("music/sfx: the style or sound description (required); video_sfx: optional cue guidance"),
  duration: z.number().positive().optional()
    .describe("seconds - music 10-120 (default 30), sfx 1-20 (default 5); video_sfx declares no duration"),
  video_url: z.string().optional()
    .describe("video_sfx only - a /files/ clip url you own (≤60 s)"),
  wait_s: waitField,
});

export default {
  name: "audio",
  toolset: "studio",
  endpoints: [ENDPOINTS.music, ENDPOINTS.sfx, ENDPOINTS.video_sfx],
  description:
    "Audio - text→music (motionfield/acestep/music), text→sound effect (motionfield/moss/sfx), " +
    "or video→foley track (motionfield/moss/video-sfx, needs your video_url). wait_s ≤ 50 like " +
    "generate; the endpoint validates range/params - a field the endpoint doesn't declare is " +
    "invalid_params.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    const endpoint = ENDPOINTS[a.kind];

    /* every mapped field is schema-checked before submit - a field the
     * endpoint doesn't declare (duration on video_sfx, video_url on music)
     * answers invalid_params naming it */
    const mapped: Record<string, unknown> = {};
    if (a.kind === "video_sfx") {
      if (a.video_url === undefined)
        return toolError("invalid_params",
          "video_sfx needs video_url - a /files/ clip url you own (upload one first)");
      mapped.video_url = a.video_url;
      if (a.prompt !== undefined) mapped.prompt = a.prompt;
      if (a.duration !== undefined) mapped.duration = a.duration;
    } else {
      if (a.prompt === undefined)
        return toolError("invalid_params", `${a.kind} needs prompt - the style or sound description`);
      mapped.prompt = a.prompt;
      if (a.duration !== undefined) mapped.duration = a.duration;
      if (a.video_url !== undefined) mapped.video_url = a.video_url;
    }
    const denied = checkAgainstSchema(ctx, endpoint, mapped);
    if (denied) return denied;
    return submitJob(ctx, endpoint, mapped, a.wait_s);
  },
} satisfies ToolDef;
