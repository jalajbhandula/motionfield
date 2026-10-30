/** MotionField Skills - agent pipelines exposed in Assistant (and later MCP/CLI).
 *  Each skill is a data definition in our own format: intake questions,
 *  ordered steps over job endpoints, and an output contract.
 *
 *  Honesty rules enforced here (and by tests):
 *  - every step endpoint exists in the catalog and runs on a bundled workflow
 *    or recipe - a skill never names a model that can't run;
 *  - step params only carry fields the endpoint declares, and select values
 *    are snapped to the endpoint's enum;
 *  - step `cost` matches the endpoint's own cost function at these params;
 *  - default steps stay on open-license endpoints (LTX-family is opt-in, never
 *    a silent default);
 *  - intake answers reach params via `steps(brief, answers)` - a question that
 *    can't change the plan doesn't get asked.
 */
import { EP } from "../agent-defaults";

export type SkillStep = {
  /** human label shown in plan review */
  label: string;
  /** endpoint_id from the model catalog - every step is a real generation job */
  endpoint: string;
  /** params template - only fields the endpoint declares */
  params: Record<string, unknown>;
  /** credit estimate shown pre-run - matches the endpoint's cost function */
  cost: number;
  /** spoken step - its prompt becomes a writer-LLM narration script when one
   *  is configured (it reads the user's text verbatim otherwise) */
  readsScript?: boolean;
};

export type SkillDef = {
  id: string;
  name: string;
  category: "marketing" | "explainer" | "apps" | "design" | "utility" | "motion";
  /** what the skill actually produces - no promised stages the steps don't run */
  blurb: string;
  /** labeled intake questions asked before planning (max 4, per interview pattern) */
  intake: { key: string; ask: string; options?: string[] }[];
  /** ordered pipeline - sequential, outputs may feed later steps */
  steps: (brief: string, answers?: Record<string, string>) => SkillStep[];
  /** extra reference slots (e.g. product photo, character refs) */
  refSlots?: { label: string; accept: string; max: number }[];
};

/* ---- intake answer helpers ---- */

/** Extract the "(id)" suffix from a labeled option, else the raw value. */
const pick = (v: string | undefined): string | undefined =>
  v == null ? undefined : (/\(([\w.-]+)\)\s*$/.exec(v)?.[1] ?? v);

/** Snap an intake value onto an endpoint's declared enum (nearest numeric). */
const snap = <T extends string | number>(v: string | undefined, allowed: readonly T[], d: T): T => {
  if (v == null || v === "") return d;
  if ((allowed as readonly unknown[]).includes(v)) return v as T;
  const n = Number(v);
  if (!Number.isNaN(n))
    return allowed.reduce((a, b) => (Math.abs(Number(b) - n) < Math.abs(Number(a) - n) ? b : a), d);
  return allowed.includes(v as T) ? (v as T) : d;
};

/** Trimmed free-text answer fragment ("" when absent). */
const frag = (v: string | undefined) => (v ?? "").trim();

const VOICES = ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"] as const;
const VOICE_OPTS = ["Warm female (af_heart)", "Bright female (af_sky)", "Calm male (am_adam)", "British male (bm_george)"];
const voice = (v: string | undefined, d: (typeof VOICES)[number]) => snap(pick(v), VOICES, d);

export const SKILLS: SkillDef[] = [
  {
    id: "narrated-explainer", name: "Narrated Explainer", category: "explainer",
    blurb: "Topic or short script → one narrated video: scenes written, illustrated, voiced & stitched",
    intake: [
      { key: "scenes", ask: "How many scenes?", options: ["3", "4", "5"] },
      { key: "voice", ask: "Narrator voice?", options: VOICE_OPTS },
      { key: "style", ask: "Visual style?", options: ["Flat illustration", "Whiteboard", "Watercolor", "Low-poly 3D", "Collage"] },
      { key: "aspect", ask: "Aspect?", options: ["16:9", "9:16", "1:1"] },
    ],
    steps: (b, a = {}) => {
      const scenes = snap(a.scenes, [3, 4, 5] as const, 3);
      return [{
        label: "Explainer video (script → scenes → narration → stitch)", endpoint: EP.explainer,
        params: {
          prompt: b, scenes,
          voice: voice(a.voice, "af_heart"),
          style: frag(a.style) || undefined,
          aspect_ratio: snap(a.aspect, ["16:9", "9:16", "1:1"] as const, "16:9"),
        },
        cost: 3 + 5 * scenes, // explainer cost fn
      }];
    },
  },
  {
    id: "ugc-ad", name: "UGC Ad (silent)", category: "marketing",
    blurb: "Product + creator photos → product hero shot + a creator-style clip, no voice",
    refSlots: [{ label: "Product", accept: "image/*", max: 3 }, { label: "Creator", accept: "image/*", max: 2 }],
    intake: [{ key: "hook", ask: "Hook angle?", options: ["Problem/solution", "Unboxing", "Tutorial", "Testimonial"] }],
    steps: (b, a = {}) => [
      { label: "Product hero shot", endpoint: EP.productPlacement,
        params: { prompt: `UGC product shot${a.hook ? ` (${a.hook} angle)` : ""}: ${b}`, aspect_ratio: "9:16",
          // when a creator photo is attached the plan filler lands it in
          // image_url → the boxed-compose arm needs the four box fields;
          // lower-centre third is the honest default placement
          bbox_x: 0.2, bbox_y: 0.55, bbox_w: 0.6, bbox_h: 0.4 },
        cost: 0.2 },
      { label: "Creator clip", endpoint: EP.imageToVideo,
        params: { prompt: `Casual creator-style UGC clip: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "lead-swap", name: "Lead Swap", category: "motion",
    blurb: "Existing clip → your character takes over the performance",
    refSlots: [{ label: "Source clip", accept: "video/*", max: 1 }, { label: "New character", accept: "image/*", max: 3 }],
    intake: [{ key: "scene", ask: "Describe the scene/character look?" }],
    steps: (b, a = {}) => [
      { label: "Character swap", endpoint: EP.characterSwap,
        params: { prompt: `${b}${a.scene ? ` - ${a.scene}` : ""}`, resolution: "480p" }, cost: 25 },
    ],
  },
  {
    id: "ad-variants", name: "Ad Variants", category: "marketing",
    blurb: "One ad → three campaign variations (styling & setting refreshed)",
    refSlots: [{ label: "Source ad", accept: "image/*,video/*", max: 1 }, { label: "Product", accept: "image/*", max: 2 }],
    intake: [],
    steps: (b) => [1, 2, 3].map((n) => ({
      label: `Variation ${n}`, endpoint: EP.textToImage,
      params: { prompt: `Campaign ad variation ${n}, distinct setting & styling, product identity preserved: ${b}`, aspect_ratio: "4:5" }, cost: 0.08,
    })),
  },
  {
    id: "product-shots", name: "Product Shots", category: "marketing",
    blurb: "Product photo brief → a batch of scene-set product images",
    refSlots: [{ label: "Product photo", accept: "image/*", max: 4 }],
    intake: [
      { key: "mode", ask: "Scene?", options: ["Studio backdrop", "Kitchen counter", "Cafe table", "Desk flat-lay", "Street scene", "Living room", "Outdoor garden", "Bathroom shelf", "Gym bench", "Bedside table"] },
      { key: "count", ask: "How many?", options: ["1", "4"] },
      { key: "mood", ask: "Style/mood?" },
      { key: "channel", ask: "Where will it run?", options: ["Shopify", "Instagram", "Pinterest", "Paid ads", "Website"] },
    ],
    steps: (b, a = {}) => {
      const batch = snap(a.count, [1, 4] as const, 4);
      return [{
        label: `Generate pack (${batch})`, endpoint: EP.textToImage,
        params: {
          prompt: `${frag(a.mode) || "Studio backdrop"} product imagery${a.mood ? `, ${a.mood}` : ""}${a.channel ? ` for ${a.channel}` : ""}: ${b}`,
          aspect_ratio: "4:5", batch_size: batch,
        },
        cost: 0.08 * batch,
      }];
    },
  },
  {
    id: "brand-starter-pack", name: "Brand Starter Pack", category: "design",
    blurb: "Brief → logo marks, type pairing board and mockups (raster drafts)",
    intake: [
      { key: "name", ask: "Brand name?" },
      { key: "vibe", ask: "Direction?", options: ["Minimal", "Bold", "Luxury", "Playful", "Technical"] },
    ],
    steps: (b, a = {}) => [
      { label: "Logo marks (4)", endpoint: EP.textToImage,
        params: { prompt: `Minimal vector-style logo mark sheet${a.vibe ? `, ${a.vibe} direction` : ""}, brand: ${frag(a.name) || b}`, aspect_ratio: "1:1", batch_size: 4 }, cost: 0.32 },
      { label: "Type pairing board", endpoint: EP.textToImage,
        params: { prompt: `Typography specimen board for brand ${frag(a.name) || b}` }, cost: 0.08 },
      { label: "Mockup set", endpoint: EP.textToImage,
        params: { prompt: `Brand mockups - cards, signage, packaging for ${frag(a.name) || b}`, batch_size: 4 }, cost: 0.32 },
    ],
  },
  {
    id: "thumbnail-pack", name: "Thumbnail Pack", category: "utility",
    blurb: "Video topic → two thumbnail variants",
    intake: [{ key: "energy", ask: "Style?", options: ["High energy", "Clean", "Cinematic", "Meme"] }],
    steps: (b, a = {}) => [1, 2].map((n) => ({
      label: `Thumbnail ${n}`, endpoint: EP.textToImage,
      params: { prompt: `YouTube thumbnail${a.energy ? `, ${a.energy} style` : ""}, bold readable focal point, variant ${n}: ${b}`, aspect_ratio: "16:9" }, cost: 0.08,
    })),
  },
  {
    id: "listing-images", name: "Listing Images", category: "utility",
    blurb: "Listing-ready product card set with clean badge zones",
    refSlots: [{ label: "Product", accept: "image/*", max: 2 }],
    intake: [{ key: "market", ask: "Marketplace?", options: ["Amazon", "Etsy", "Shopify", "eBay"] }],
    steps: (b, a = {}) => [
      { label: "Card set (4)", endpoint: EP.textToImage,
        params: { prompt: `${a.market ? `${a.market} ` : ""}e-commerce listing card, clean badge zones: ${b}`, aspect_ratio: "1:1", batch_size: 4 }, cost: 0.32 },
    ],
  },
  {
    id: "footage-re-edit", name: "Footage Re-edit", category: "motion",
    blurb: "Reference clip + subject refs → rebuilt video with motion transfer",
    refSlots: [{ label: "Reference clip", accept: "video/*", max: 1 }, { label: "Subjects", accept: "image/*", max: 5 }],
    intake: [{ key: "keep", ask: "What must stay identical?" }],
    steps: (b, a = {}) => [
      { label: "Motion transfer", endpoint: EP.motionTransfer,
        params: { prompt: `${b}${a.keep ? ` - keep identical: ${a.keep}` : ""}`, resolution: "480p" }, cost: 25 },
    ],
  },
  {
    id: "character-photoshoot", name: "Character Photoshoot", category: "utility",
    blurb: "1-3 reference photos → a batch of consistent character shots, new scenes & outfits",
    refSlots: [{ label: "Character refs", accept: "image/*", max: 3 }],
    intake: [
      { key: "scenes", ask: "Scenes/outfits?", options: ["Studio portraits", "Street style", "Travel vlog look", "Editorial", "Surprise me"] },
      { key: "count", ask: "How many?", options: ["1", "2", "4"] },
    ],
    steps: (b, a = {}) => {
      const batch = snap(a.count, [1, 2, 4] as const, 2);
      return [{
        label: `Character shots (${batch})`, endpoint: EP.character,
        params: { prompt: `Character photoshoot${a.scenes && a.scenes !== "Surprise me" ? `, ${a.scenes}` : ""}: ${b}`, aspect_ratio: "3:4", batch_size: batch },
        cost: 0.4 * batch, // character cost fn
      }];
    },
  },
  {
    id: "talking-portrait", name: "Talking Portrait", category: "utility",
    blurb: "A photo that delivers a line - speech + lip-sync in one job",
    refSlots: [{ label: "Portrait", accept: "image/*", max: 1 }],
    intake: [
      { key: "voice", ask: "Voice?", options: VOICE_OPTS },
      { key: "line", ask: "What should they say?" },
    ],
    steps: (b, a = {}) => [
      { label: "Portrait speaks", endpoint: EP.portraitSays,
        params: { prompt: frag(a.line) || b, voice: voice(a.voice, "af_heart") }, cost: 16 },
    ],
  },
  {
    id: "lip-sync-dub", name: "Lip-sync Dub & Translate", category: "utility",
    blurb: "Clip + track → synchronized lip-synced video",
    refSlots: [{ label: "Face video", accept: "video/*", max: 1 }, { label: "Audio track", accept: "audio/*", max: 1 }],
    // the face video is a likeness upload - the skill asks for the right
    // and only sends the flag when the user answers yes (fps follows the
    // source clip - the graph reads it off video_info)
    intake: [{ key: "consent", ask: "Do you have the right to use the likeness of the person in this video?", options: ["yes"] }],
    steps: (b, a = {}) => [
      { label: "Lip-sync", endpoint: EP.lipSync,
        params: a.consent === "yes" ? { likeness_consent: true } : {}, cost: 10 },
    ],
  },
  {
    id: "landing-visuals", name: "Landing Visuals", category: "apps",
    blurb: "Brief → hero clip + section imagery for a landing page",
    intake: [
      { key: "type", ask: "Type?", options: ["Landing", "Portfolio", "SaaS page", "Store"] },
      { key: "aspect", ask: "Hero aspect?", options: ["16:9", "9:16", "1:1"] },
    ],
    steps: (b, a = {}) => [
      { label: "Hero clip", endpoint: EP.textToVideo,
        params: { prompt: `Cinematic brand hero shot for a ${frag(a.type) || "landing"} page: ${b}`, duration: 5, resolution: "480p", aspect_ratio: snap(a.aspect, ["16:9", "9:16", "1:1"] as const, "16:9") }, cost: 5 },
      { label: "Section imagery (4)", endpoint: EP.textToImage,
        params: { prompt: `Website section art, consistent brand look: ${b}`, batch_size: 4 }, cost: 0.32 },
    ],
  },
  {
    id: "short-maker", name: "Short Maker", category: "explainer",
    blurb: "Topic → vertical keyframe + short animated clip",
    intake: [{ key: "platform", ask: "Platform?", options: ["Reels", "TikTok", "Shorts"] }],
    steps: (b, a = {}) => [
      { label: "Vertical keyframe", endpoint: EP.textToImage,
        params: { prompt: `Vertical ${frag(a.platform) || "social"} short keyframe: ${b}`, aspect_ratio: "9:16" }, cost: 0.08 },
      { label: "Animate", endpoint: EP.imageToVideo,
        params: { prompt: `${b}, subtle motion`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "ad-localizer", name: "Ad Localizer", category: "marketing",
    blurb: "Ad image → instruction-edited variant for a new language/market",
    refSlots: [{ label: "Source ad", accept: "image/*", max: 1 }],
    intake: [{ key: "langs", ask: "Target markets/languages?" }],
    steps: (b, a = {}) => [
      { label: "Adapted creative", endpoint: EP.imageEdit,
        params: { prompt: `Localized ad adaptation for ${frag(a.langs) || "the target market"}: ${b}` }, cost: 1.5 },
    ],
  },
  // ---- Recipe-class skills (landing-page equivalents, data-driven) ----
  {
    id: "debris-shatter", name: "Debris & Shatter", category: "motion",
    blurb: "Subject still → dramatic crumble/explode/shatter clip",
    refSlots: [{ label: "Subject", accept: "image/*", max: 1 }],
    intake: [{ key: "fx", ask: "Effect type?", options: ["Crumble", "Explode", "Shatter", "Disintegrate", "Melt"] }],
    steps: (b, a = {}) => [
      { label: "Break-apart clip", endpoint: EP.imageToVideo,
        params: { prompt: `${b}, ${frag(a.fx) || "dramatic"} break-apart VFX, physics debris, cinematic slow-mo`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "component-reveal", name: "Component Reveal", category: "motion",
    blurb: "Product still → technical component-separation clip",
    refSlots: [{ label: "Product", accept: "image/*", max: 2 }],
    intake: [],
    steps: (b) => [
      { label: "Separation clip", endpoint: EP.imageToVideo,
        params: { prompt: `Technical component separation animation, parts drift apart and reassemble: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "set-dressing", name: "Set Dressing", category: "motion",
    blurb: "Elements + environment still → a short animated clip",
    refSlots: [{ label: "Elements", accept: "image/*", max: 4 }, { label: "Environment", accept: "image/*", max: 1 }],
    intake: [{ key: "env", ask: "Environment/mood?" }],
    steps: (b, a = {}) => [
      { label: "Animate scene", endpoint: EP.imageToVideo,
        params: { prompt: `${b}${a.env ? ` - ${a.env}` : ""}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "toon-look", name: "Toon Look", category: "motion",
    blurb: "Footage → cartoon/toon-shaded restyle",
    refSlots: [{ label: "Source video", accept: "video/*", max: 1 }],
    intake: [{ key: "style", ask: "Toon style?", options: ["Anime", "Cel-shade", "Comic ink", "CG toon"] }],
    steps: (b, a = {}) => [
      { label: "Restyle", endpoint: EP.restyle,
        params: { prompt: `${frag(a.style) || "Cartoon"}-shaded restyle: ${b}`, resolution: "480p" }, cost: 20 },
    ],
  },
  {
    id: "video-reframe", name: "Video Reframe", category: "motion",
    blurb: "Finished clip → recomposed for a new aspect ratio",
    refSlots: [{ label: "Clip", accept: "video/*", max: 1 }],
    intake: [{ key: "ratio", ask: "Target ratio?", options: ["16:9", "9:16", "1:1", "4:5"] }],
    steps: (b, a = {}) => [
      { label: "Reframe", endpoint: EP.reframe,
        params: { aspect_ratio: snap(a.ratio, ["16:9", "9:16", "1:1", "4:5"] as const, "9:16"), mode: "smart" }, cost: 18 },
    ],
  },
  {
    id: "plate-cleanup", name: "Plate Cleanup", category: "utility",
    blurb: "Image → remove objects/artifacts by instruction",
    refSlots: [{ label: "Image", accept: "image/*", max: 1 }],
    intake: [{ key: "remove", ask: "What to remove?" }],
    steps: (b, a = {}) => [
      { label: "Instruct-edit cleanup", endpoint: EP.imageEdit,
        params: { prompt: `Remove ${frag(a.remove) || "unwanted elements"}, seamless fill: ${b}` }, cost: 1.5 },
    ],
  },
  {
    id: "vector-look", name: "Vector Look", category: "utility",
    blurb: "Raster art → clean vector-style render (raster output, not SVG)",
    refSlots: [{ label: "Artwork", accept: "image/*", max: 1 }],
    intake: [],
    steps: (b) => [
      { label: "Vector-style render", endpoint: EP.imageEdit,
        params: { prompt: `Clean vector-style illustration version: ${b}` }, cost: 1.5 },
    ],
  },
  {
    id: "image-upscaler", name: "Image Upscaler", category: "utility",
    blurb: "Low-res or soft image → a clean upscale",
    refSlots: [{ label: "Image", accept: "image/*", max: 1 }],
    intake: [{ key: "scale", ask: "Scale?", options: ["2×", "4×"] }],
    steps: (b, a = {}) => {
      const scale = snap(a.scale?.replace("×", ""), [2, 4] as const, 4);
      return [{
        label: `Upscale ${scale}×`, endpoint: EP.upscaleImage,
        params: { scale }, cost: scale === 4 ? 2 : 1,
      }];
    },
  },
  {
    id: "background-cutout", name: "Background Remover", category: "utility",
    blurb: "Image → transparent-background PNG + matte",
    refSlots: [{ label: "Image", accept: "image/*", max: 1 }],
    intake: [],
    steps: () => [
      { label: "Remove background", endpoint: EP.removeBackground, params: {}, cost: 0.5 },
    ],
  },
  {
    id: "color-grade", name: "Color Grade", category: "motion",
    blurb: "Footage → filmic grade by prompt",
    refSlots: [{ label: "Footage", accept: "video/*", max: 1 }],
    intake: [{ key: "look", ask: "Look?", options: ["Teal-orange", "Noir", "Vintage film", "Clean commercial", "Horror cold"] }],
    steps: (b, a = {}) => [
      { label: "Grade", endpoint: EP.restyle,
        params: { prompt: `Filmic color grade, ${frag(a.look) || "clean commercial"}: ${b}`, resolution: "480p" }, cost: 20 },
    ],
  },
  {
    id: "headline-variants", name: "Headline Variants", category: "marketing",
    blurb: "One headline visual → typographic variants",
    refSlots: [{ label: "Ad/visual", accept: "image/*", max: 1 }],
    intake: [{ key: "n", ask: "How many variants?", options: ["3", "5", "8"] }],
    steps: (b, a = {}) => {
      const n = Math.max(1, Math.min(8, Math.trunc(Number(a.n) || 3)));
      return Array.from({ length: n }, (_, i) => ({
        label: `Headline variant ${i + 1}`, endpoint: EP.textToImage,
        params: { prompt: `Ad visual variant ${i + 1}, different headline treatment: ${b}`, aspect_ratio: "1:1" }, cost: 0.08,
      }));
    },
  },
  {
    id: "opening-variants", name: "Opening Variants", category: "marketing",
    blurb: "Brief → a keyframe plus alternate 2s opening clips",
    intake: [{ key: "n", ask: "How many openings?", options: ["2", "3", "5"] }],
    steps: (b, a = {}) => {
      const n = Math.max(1, Math.min(5, Math.trunc(Number(a.n) || 3)));
      return [
        { label: "Opening keyframe", endpoint: EP.textToImage,
          params: { prompt: `Opening frame for: ${b}`, aspect_ratio: "9:16" }, cost: 0.08 },
        ...Array.from({ length: n }, (_, i) => ({
          label: `Opening variant ${i + 1}`, endpoint: EP.imageToVideo,
          params: { prompt: `Alternate opening shot ${i + 1} for: ${b}`, duration: 2, resolution: "480p" }, cost: 2,
        })),
      ];
    },
  },
  {
    id: "illustration-animator", name: "Illustration Animator", category: "motion",
    blurb: "Static illustration → living animated loop",
    refSlots: [{ label: "Illustration", accept: "image/*", max: 1 }],
    intake: [{ key: "motion", ask: "Motion feel?", options: ["Subtle loop", "Wind/ambient", "Character moves", "Parallax"] }],
    steps: (b, a = {}) => [
      { label: "Animate", endpoint: EP.imageToVideo,
        params: { prompt: `Animate illustration, ${frag(a.motion) || "subtle ambient motion"}, preserve style: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "paper-collage", name: "Paper Collage", category: "motion",
    blurb: "Subject still → hand-crafted paper-collage style clip",
    refSlots: [{ label: "Subject", accept: "image/*", max: 2 }],
    intake: [],
    steps: (b) => [
      { label: "Collage clip", endpoint: EP.imageToVideo,
        params: { prompt: `Paper collage stop-motion feel: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "slide-animator", name: "Slide Animator", category: "explainer",
    blurb: "Topic → slide-style visuals animated into a short clip",
    intake: [{ key: "slides", ask: "Key points (comma-separated)?" }],
    steps: (b, a = {}) => [
      { label: "Slide visuals (4)", endpoint: EP.textToImage,
        params: { prompt: `Presentation slide art${a.slides ? ` - ${a.slides}` : ""}: ${b}`, batch_size: 4 }, cost: 0.32 },
      { label: "Animate slides", endpoint: EP.imageToVideo,
        params: { prompt: `Presentation slides animating: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "saas-showcase", name: "SaaS Showcase", category: "marketing",
    blurb: "Product UI shots → a short showcase clip",
    refSlots: [{ label: "UI screenshots", accept: "image/*", max: 4 }],
    intake: [{ key: "feature", ask: "Feature to highlight?" }],
    steps: (b, a = {}) => [
      { label: "Showcase clip", endpoint: EP.imageToVideo,
        params: { prompt: `Sleek SaaS product showcase, floating UI panels${a.feature ? `, feature: ${a.feature}` : ""}: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "whiteboard-explainer", name: "Whiteboard Explainer", category: "explainer",
    blurb: "Topic → whiteboard-style frames, an animated clip, and a spoken track",
    intake: [{ key: "voice", ask: "Narrator?", options: VOICE_OPTS }],
    steps: (b, a = {}) => [
      { label: "Whiteboard frames (4)", endpoint: EP.textToImage,
        params: { prompt: `Whiteboard sketch illustration: ${b}`, batch_size: 4 }, cost: 0.32 },
      { label: "Animate", endpoint: EP.imageToVideo,
        params: { prompt: `Hand-drawn whiteboard animation: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
      { label: "Narration - reads your text", endpoint: EP.tts, readsScript: true,
        params: { prompt: b, voice: voice(a.voice, "am_adam") }, cost: 0.5 },
    ],
  },
  {
    id: "narrated-channel-video", name: "Narrated Channel Video", category: "explainer",
    blurb: "Niche topic → hook image, scene shots, a short clip and a voice-over track",
    intake: [
      { key: "niche", ask: "Niche?", options: ["History", "Facts", "Motivation", "Finance", "True crime"] },
      { key: "style", ask: "Visual style?", options: ["Watercolor", "Cinematic", "Retro", "Dark academia"] },
    ],
    steps: (b, a = {}) => [
      { label: "Hook visual", endpoint: EP.textToImage,
        params: { prompt: `Strong hook visual${a.niche ? ` for a ${a.niche} channel` : ""}: ${b}`, aspect_ratio: "9:16" }, cost: 0.08 },
      { label: "Scene visuals (4)", endpoint: EP.textToImage,
        params: { prompt: `Stylized scene${a.style ? `, ${a.style}` : ""}: ${b}`, batch_size: 4, aspect_ratio: "9:16" }, cost: 0.32 },
      { label: "Animate", endpoint: EP.imageToVideo,
        params: { prompt: `${b}, cinematic motion`, duration: 2, resolution: "480p" }, cost: 2 },
      { label: "Voice-over - reads your text", endpoint: EP.tts, readsScript: true,
        params: { prompt: b, voice: "af_sky" }, cost: 0.5 },
    ],
  },
  {
    id: "product-review-clip", name: "Product Review Clip (silent)", category: "marketing",
    blurb: "Product + creator refs → review-style clip + product b-roll, no voice",
    refSlots: [{ label: "Product", accept: "image/*", max: 3 }, { label: "Creator", accept: "image/*", max: 1 }],
    intake: [{ key: "angle", ask: "Review angle?", options: ["Honest pros/cons", "Unboxing", "vs competitor", "Day-one test"] }],
    steps: (b, a = {}) => [
      { label: "Product still", endpoint: EP.textToImage,
        params: { prompt: `Clean product still: ${b}`, aspect_ratio: "9:16" }, cost: 0.08 },
      { label: "Creator clip", endpoint: EP.imageToVideo,
        params: { prompt: `Casual product review clip${a.angle ? `, ${a.angle}` : ""}: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
      { label: "Product b-roll", endpoint: EP.imageToVideo,
        params: { prompt: `Macro product b-roll: ${b}`, duration: 2, resolution: "480p" }, cost: 2 },
    ],
  },
  {
    id: "game-art-pack", name: "Game Art Pack", category: "apps",
    blurb: "Concept → styled game-art renders (raster)",
    intake: [{ key: "kind", ask: "Asset type?", options: ["Spritesheet", "Tileable texture", "Character turnaround", "3D concept"] }],
    steps: (b, a = {}) => [
      { label: "Asset render", endpoint: EP.textToImage,
        params: { prompt: `Game asset${a.kind ? ` (${a.kind})` : ""}, consistent style: ${b}` }, cost: 0.08 },
    ],
  },
];

export const SKILL_CATEGORIES = ["all", "marketing", "explainer", "design", "apps", "motion", "utility"] as const;

/** Ids are slugs of our own names. The old ids (kept as aliases below) still
 *  resolve - nothing stored or linked under an old id breaks. */
export const SKILL_ALIASES: Record<string, string> = {
  explain: "narrated-explainer",
  photoshoot: "product-shots",
  "brand-system": "brand-starter-pack",
  thumbs: "thumbnail-pack",
  cards: "listing-images",
  reedit: "footage-re-edit",
  "character-pack": "character-photoshoot",
  "lip-sync": "lip-sync-dub",
  site: "landing-visuals",
  short: "short-maker",
  localize: "ad-localizer",
  destruction: "debris-shatter",
  "exploded-view": "component-reveal",
  "scene-builder": "set-dressing",
  "cartoon-shader": "toon-look",
  "shot-composer": "video-reframe",
  "shot-cleanup": "plate-cleanup",
  vectorize: "vector-look",
  "image-fixer": "image-upscaler",
  cutout: "background-cutout",
  "headline-x": "headline-variants",
  "hook-x": "opening-variants",
  "illustrate-anim": "illustration-animator",
  "deck-anim": "slide-animator",
  "saas-anim": "saas-showcase",
  whiteboard: "whiteboard-explainer",
  faceless: "narrated-channel-video",
  "product-review": "product-review-clip",
  "game-assets": "game-art-pack",
};

export const skillById = (id: string) =>
  SKILLS.find((s) => s.id === id) ?? SKILLS.find((s) => s.id === SKILL_ALIASES[id]);
