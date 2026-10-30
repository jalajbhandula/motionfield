/**
 * Shared, honest defaults for the agent's deterministic fallback planner and
 * the Assistant/Canvas surfaces.
 *
 * Rules this module enforces by construction:
 * - every endpoint id must exist in the catalog (tested) and run on a bundled
 *   workflow or recipe;
 * - default picks stay on open licenses - restricted models (LTX family) are
 *   opt-ins, never silent defaults;
 * - param templates only carry fields the endpoint actually declares.
 */

/** Canonical endpoint ids - the single place defaults are chosen. */
export const EP = {
  textToImage: "motionfield/z-image-turbo/text-to-image",
  imageEdit: "motionfield/qwen-image-edit/edit",
  productPlacement: "motionfield/product-placement",
  upscaleImage: "motionfield/upscale/image",
  removeBackground: "motionfield/birefnet/remove-background",
  character: "motionfield/character/generate",
  textToVideo: "motionfield/wan-2.1/text-to-video",
  imageToVideo: "motionfield/wan-vace/image-to-video",
  motionTransfer: "motionfield/wan-vace/motion-transfer",
  characterSwap: "motionfield/wan-vace/character-swap",
  restyle: "motionfield/wan-vace/restyle",
  reframe: "motionfield/reframe/v1.0",
  tts: "motionfield/kokoro/text-to-speech",
  voiceClone: "motionfield/chatterbox/voice-clone",
  lipSync: "motionfield/musetalk/lip-sync-video",
  talkingPortrait: "motionfield/musetalk/talking-portrait",
  portraitSays: "motionfield/musetalk/portrait-says",
  explainer: "motionfield/explainer/video",
} as const;

export type AgentIntent = {
  re: RegExp;
  endpoint: string;
  label: string;
  /** baseline params merged into the submitted job - declared fields only */
  params: Record<string, unknown>;
};

/** Deterministic intent table - earliest regex match wins. Params here must
 *  be declared on the endpoint (they land on the job row verbatim). */
export const INTENTS: AgentIntent[] = [
  { re: /lip.?sync.{0,30}(photo|image|picture|portrait|still|avatar)|dub (this |the |my |a )?(photo|image|picture|portrait|avatar)/i,
    endpoint: EP.talkingPortrait, label: "Talking portrait", params: {} },
  { re: /lip.?sync|dub\b|sync.{0,15}(lips|mouth|audio|voice)/i,
    endpoint: EP.lipSync, label: "Lip-sync", params: {} },
  { re: /make (this|the|my|that|these) (portrait|photo|image|picture|headshot|avatar|character|person|persona) (say|speak|talk|sing)|talking (head|portrait|avatar|photo|character|person)/i,
    endpoint: EP.portraitSays, label: "Portrait says", params: {} },
  { re: /character.?swap|swap (the |a |that |this )?(character|person|actor|lead)|replace (the |a )?(person|actor|character|lead)/i,
    endpoint: EP.characterSwap, label: "Character swap", params: { resolution: "480p" } },
  { re: /explainer|video explaining|explain.{0,50}(video|clip|film)|turn .{0,80}into (a|an) (narrated |animated )?(video|explainer)/i,
    endpoint: EP.explainer, label: "Explainer video", params: {} },
  { re: /persona|same character|consistent character|more (photos|shots|images) of|influencer/i,
    endpoint: EP.character, label: "Character shots", params: { resolution: "480p", batch_size: 2 } },
  { re: /voice.?clon|clon.{0,15}voice|in (my|your) voice|my own voice|sounds? like me/i,
    endpoint: EP.voiceClone, label: "Clone voice", params: {} },
  { re: /narrat|voice.?over|text.?to.?speech|\btts\b|aloud|speak|speech|say it|audio(book| version)|read it to/i,
    endpoint: EP.tts, label: "Read your text aloud", params: {} },
  { re: /background|cut.?out|isolate|transparen/i,
    endpoint: EP.removeBackground, label: "Remove background", params: {} },
  { re: /upscal|up.?res|sharpen|enhance|make .{0,20}(bigger|higher.?res|4k|hd|crisper)/i,
    endpoint: EP.upscaleImage, label: "Upscale", params: {} },
  { re: /restyle|recolou?r|grade|vfx|effect/i,
    endpoint: EP.restyle, label: "Restyle video", params: { resolution: "480p" } },
  // "animate it/this/my photo" is image-to-video, not a fresh text-to-video -
  // it only makes sense with a source, which the planner fills from an
  // attachment, the session's lastOutputs, or a chained $step ref (never
  // invented). Kept ahead of the generic video intent so the pronoun wins.
  { re: /animat\w*\s+(it|this|that|the|my|your|these|those)\b|bring\s+\w+\s+(back )?to life/i,
    endpoint: EP.imageToVideo, label: "Animate image", params: { resolution: "480p", duration: 3 } },
  { re: /(?:video|clip|shot|film|animate|movie|reel)/i,
    endpoint: EP.textToVideo, label: "Generate video", params: { resolution: "480p", duration: 3 } },
  { re: /(?:image|picture|photo|poster|thumbnail|logo)/i,
    endpoint: EP.textToImage, label: "Generate image", params: { resolution: "720p", steps: 8 } },
];

/** Canvas palette → endpoint map. Kept here (not in the page) so the defaults
 *  audit test sees the same source of truth the canvas submits against. */
export const CANVAS_NODES: Record<string, string> = {
  image: EP.textToImage,
  video: EP.imageToVideo,
  audio: EP.tts,
  swap: EP.characterSwap,
  character: EP.character,
  lipsync: EP.lipSync,
};

/** Endpoints whose bundled graphs still carry banned-known components -
 *  empty since the V4 lane: the patched MuseTalk pack blends through
 *  OF_MouthMask (DWPose landmarks) - the upstream BiSeNet face segmenter
 *  and its weights are gone. Keep the set so the defaults audit has a
 *  single place to look. */
export const PENDING_V4: ReadonlySet<string> = new Set();

export type PlanStepDef = {
  step: string;
  endpoint: string;
  params: Record<string, unknown>;
  cost: number;
};

/** The no-skill Assistant plan: one image, and - when the brief clearly
 *  wants motion - an image-to-video step fed by it at runtime. Open-license
 *  defaults only (z-image-turbo + Wan VACE); restricted models stay opt-in. */
export function fallbackPlanSteps(brief: string): PlanStepDef[] {
  const out: PlanStepDef[] = [{
    step: "Generate image (Z-Image-Turbo)",
    endpoint: EP.textToImage,
    params: { prompt: brief, aspect_ratio: "16:9" },
    cost: 0.08,
  }];
  if (/video|clip|film|ad|commercial|shot|scene|movie|reel|short/i.test(brief)) {
    out.push({
      step: "Animate (Wan VACE i2v)",
      endpoint: EP.imageToVideo,
      params: { prompt: brief, duration: 2, resolution: "480p" },
      cost: 2,
    });
  }
  return out;
}
