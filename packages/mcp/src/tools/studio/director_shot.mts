import { z } from "zod";
import { MotionFieldError } from "../../../../sdk-ts/src/index.ts";
import { notAvailable, ok, toolError, type ToolDef } from "../../registry.mts";
import { checkAgainstSchema, schemaProps, WAIT_CAP_S } from "./_job.mts";

const ENDPOINT = "motionfield/director/generate";

const Emotion = z.object({
  name: z.string().min(1).describe("the catalog emotion - e.g. joy, calm, resolve"),
  intensity: z.enum(["subtle", "moderate", "intense"]).optional()
    .describe("emotion_intensity (default: subtle when unset)"),
  character: z.string().optional()
    .describe("who carries the emotion - refused while the endpoint declares no field for it"),
});

const Input = z.strictObject({
  prompt: z.string().min(1).describe("the shot"),
  image_url: z.string().optional()
    .describe("start frame - a /files/ url you own"),
  moves: z.array(z.string().min(1)).optional()
    .describe("camera moves - catalog ids (≤3), '+'-joined for the endpoint"),
  lens: z.string().optional().describe("camera_lens - e.g. standard-35, portrait-85"),
  sensor: z.string().optional().describe("camera_sensor - e.g. full_frame, super35"),
  aperture: z.string().optional().describe("camera_aperture - e.g. f2.8, f8"),
  body: z.string().optional().describe("camera_body - e.g. modern, 35mm-film"),
  lights: z.array(z.string().min(1)).optional()
    .describe("dome lights (≤2) - each az<0-359>:el<0-90>:<warm|neutral|cool|#hex>:<soft|medium|hard>, '+'-joined"),
  emotion: Emotion.optional(),
  backend: z.string().optional()
    .describe("generation backend - wan-vace is the server's default and runs locally; ltx is a restricted opt-in (never defaulted to)"),
  takes: z.number().int().min(1).max(4).optional()
    .describe("number of takes - one job each, 1-4"),
  duration: z.number().optional().describe("seconds (1-5)"),
  aspect_ratio: z.string().optional(),
  resolution: z.string().optional(),
  audio: z.boolean().optional()
    .describe("the endpoint declares no audio field today - passing it is invalid_params"),
  wait_s: z.number().positive().max(WAIT_CAP_S).optional()
    .describe(`poll each take this many seconds (max ${WAIT_CAP_S})`),
});

/* Every tool field maps onto a field the endpoint's live input schema
 * declares - the map is checked name-by-name before submit so nothing is
 * silently dropped or folded into the prompt. Enum values are checked the
 * same way (a typo'd pick is invalid_params, not a dead clause). A field
 * this tool doesn't declare is a ZodError (tool error). */

export default {
  name: "director_shot",
  toolset: "studio",
  endpoints: [ENDPOINT],
  description:
    "A directed shot on the Director endpoint - Wan VACE runs locally; LTX is a " +
    "restricted opt-in. prompt + optional start image_url, camera moves (≤3), " +
    "lens/sensor/aperture/body, dome lights (≤2), emotion, takes (one job each).",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    if ((a.moves?.length ?? 0) > 3)
      return toolError("invalid_params", "moves takes at most 3 - the endpoint runs a ≤3-move stack");
    if ((a.lights?.length ?? 0) > 2)
      return toolError("invalid_params", "lights takes at most 2 dome lights");

    const properties = schemaProps(ctx, ENDPOINT);
    if (!properties)
      return notAvailable(`endpoint ${ENDPOINT} is not in the startup model catalog`);

    const mapped: Record<string, unknown> = { prompt: a.prompt };
    if (a.image_url !== undefined) mapped.image_url = a.image_url;
    if (a.moves?.length) mapped.moves = a.moves.join("+");
    if (a.lens !== undefined) mapped.camera_lens = a.lens;
    if (a.sensor !== undefined) mapped.camera_sensor = a.sensor;
    if (a.aperture !== undefined) mapped.camera_aperture = a.aperture;
    if (a.body !== undefined) mapped.camera_body = a.body;
    if (a.lights?.length) mapped.lights = a.lights.join("+");
    if (a.emotion) {
      mapped.emotion = a.emotion.name;
      if (a.emotion.intensity !== undefined) mapped.emotion_intensity = a.emotion.intensity;
    }
    if (a.backend !== undefined) mapped.backend = a.backend;
    if (a.duration !== undefined) mapped.duration = a.duration;
    if (a.aspect_ratio !== undefined) mapped.aspect_ratio = a.aspect_ratio;
    if (a.resolution !== undefined) mapped.resolution = a.resolution;
    // picks with no declared field on this endpoint - refused, never folded
    if (a.audio !== undefined) {
      const target = ["generate_audio", "audio"].find((n) => n in properties);
      if (!target)
        return toolError("invalid_params", "audio: this endpoint declares no audio field");
      mapped[target] = a.audio;
    }
    if (a.emotion?.character !== undefined) {
      const target = ["emotion_character", "character"].find((n) => n in properties);
      if (!target)
        return toolError("invalid_params", "emotion.character: this endpoint declares no field for it");
      mapped[target] = a.emotion.character;
    }

    const denied = checkAgainstSchema(ctx, ENDPOINT, mapped);
    if (denied) return denied;

    const takes = a.takes ?? 1;
    const jobs = [];
    for (let i = 0; i < takes; i++) {
      try {
        const created = await ctx.client.submit(ENDPOINT, mapped);
        if (!a.wait_s) { jobs.push(created); continue; }
        try {
          jobs.push(await ctx.client.wait(created.id, {
            timeoutMs: Math.min(a.wait_s, WAIT_CAP_S) * 1000 }));
        } catch (e) {
          if (e instanceof MotionFieldError && e.code === "wait_timeout") {
            jobs.push(await ctx.client.get(created.id));
          } else {
            /* the submit minted a real, billed job - a failed wait still
             * reports it in jobs so the caller can poll or cancel it rather
             * than lose the take */
            jobs.push(created);
            throw e;
          }
        }
      } catch (e) {
        // a later take that fails still reports the jobs already minted -
        // real, billed work the caller needs to see, not a black hole
        if (!jobs.length) throw e;
        return toolError(e instanceof MotionFieldError ? e.code : "internal_error",
          e instanceof Error ? e.message : String(e),
          { submitted: jobs.length, jobs });
      }
    }
    return ok({ takes: jobs.length, jobs });
  },
} satisfies ToolDef;
