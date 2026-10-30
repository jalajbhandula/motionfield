/** Real pod generations shipped as "Try this example" - one per endpoint.
 *  Media lives under public/examples/feature/<slug>.<ext>; inputs the
 *  example used live under public/examples/inputs/ and are re-uploaded as the
 *  user's own /files/ media when they hit "Try this example" (jobs only
 *  accept owned media). Every entry here was generated on our own GPU pod
 *  and graded by eye - nothing is a stock or third-party asset. */
export type FeatureExample = {
  /** workflow endpoint id, e.g. "motionfield/flux2-klein/edit" */
  endpoint: string;
  /** /examples/feature/... output shown as the card */
  media: string;
  kind: "image" | "video" | "audio" | "model";
  /** scalar params the example ran with (prompt, steps, …) */
  params: Record<string, string | number | boolean>;
  /** input shown left of the before/after slider (edit/transform features);
   *  omitted for pure generation (t2i, t2v, audio) */
  before?: string;
  /** media params → /examples/inputs/... files the example used */
  inputs?: Record<string, string | string[]>;
  /** model + license credit shown under the card */
  credit: string;
  /** studio route that hosts the endpoint's workflow */
  studio: "image" | "video" | "audio";
  /** tool page that loads this example itself (endpoint not in a studio list) */
  tryHref?: string;
};

export const FEATURE_EXAMPLES: FeatureExample[] = [
  { endpoint: "motionfield/wan-2.2/a14b-t2v", media: "/examples/feature/wan22-a14b-t2v.mp4", kind: "video",
    params: { prompt: "a red vintage convertible drives along a winding coastal cliff road at sunset, the camera follows from behind, ocean waves below, photoreal, cinematic", duration: 3, resolution: "720p", steps: 20, finish: false },
    credit: "Wan 2.2 T2V A14B · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/moss/sfx", media: "/examples/feature/moss-sfx.wav", kind: "audio",
    params: { prompt: "Rain falling on a tin roof with distant thunder", duration: 2, seed: 42 },
    credit: "MOSS-SoundEffect v2.0 · Apache-2.0", studio: "audio" },
  { endpoint: "motionfield/moss/video-sfx", media: "/examples/feature/moss-video-sfx.mp4", kind: "video", before: "/examples/inputs/coastal-car.mp4",
    params: { prompt: "One single continuous cue of a vintage car engine driving. No music or speech.", seed: 42 },
    inputs: { video_url: "/examples/inputs/coastal-car.mp4" }, credit: "MOSS-SoundEffect v2.0 · Apache-2.0 · sound added after generation", studio: "audio" },
  { endpoint: "motionfield/dub/v1", media: "/examples/feature/dub-es.mp4", kind: "video", before: "/examples/inputs/dub-speaker.mp4",
    params: { language: "es", voice: "female", lipsync: true, original_volume: 0, finish: false },
    inputs: { video_url: "/examples/inputs/dub-speaker.mp4" }, credit: "Spanish dub · Kokoro + Chatterbox + MuseTalk · Apache-2.0 / MIT", studio: "audio" },
  { endpoint: "motionfield/birefnet/remove-background", media: "/examples/feature/birefnet-remove-background.webp", kind: "image", before: "/examples/inputs/person.jpg",
    params: {}, inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "BiRefNet · MIT", studio: "image" },
  { endpoint: "motionfield/product-placement", media: "/examples/feature/product-placement.jpg", kind: "image", before: "/examples/inputs/product.jpg",
    params: { prompt: "the sneaker on a marble pedestal in a sunlit studio, packshot", aspect_ratio: "1:1", steps: 4 },
    inputs: { product_image_url: "/examples/inputs/product.jpg" }, credit: "FLUX.2 klein 4B · Apache-2.0 + BiRefNet · MIT", studio: "image" },
  { endpoint: "motionfield/wan-2.2/a14b-i2v", media: "/examples/feature/wan22-a14b-i2v.mp4", kind: "video", before: "/examples/inputs/reel-s1.jpg",
    params: { prompt: "a man in a mustard jacket walks along a city sidewalk on an overcast afternoon, natural stride, the camera tracks backward with him, photoreal", duration: 3, resolution: "720p", steps: 20 },
    inputs: { image_url: "/examples/inputs/reel-s1.jpg" }, credit: "Wan 2.2 I2V A14B · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/lens/standard/image-to-video", media: "/examples/feature/lens-image-to-video.mp4", kind: "video", before: "/examples/inputs/perfume.jpg",
    params: { prompt: "a glass perfume bottle on a pedestal, soft studio light, gentle light shimmer on the glass, product shot", camera_movement: "dolly-in", duration: 3, aspect_ratio: "1:1", resolution: "480p" },
    inputs: { image_url: "/examples/inputs/perfume.jpg" }, credit: "LTX-2.5 · LTX-2.x Community License (Lightricks)", studio: "video" },
  { endpoint: "motionfield/lens/standard/text-to-video", media: "/examples/feature/lens-text-to-video.mp4", kind: "video",
    params: { prompt: "a lighthouse keeper in a yellow oilskin coat stands on a rocky shore at golden hour, waves breaking behind him, photoreal, cinematic", camera_movement: "dolly-in", duration: 3, aspect_ratio: "16:9", resolution: "480p" },
    inputs: {}, credit: "LTX-2.5 · LTX-2.x Community License (Lightricks) + Z-Image-Turbo · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/wan-animate/character-swap", media: "/examples/feature/wan-animate-character-swap.mp4", kind: "video", before: "/examples/inputs/src5.mp4",
    params: { prompt: "a man in his 30s with short dark hair and light stubble, navy bomber jacket, white t-shirt, blue jeans, white sneakers, photorealistic", resolution: "480p", steps: 6, finish: false },
    inputs: { video_url: "/examples/inputs/src5.mp4", image_urls: ["/examples/inputs/man-ref.jpg"] },
    credit: "Wan 2.2 Animate 14B · Apache-2.0 + lightx2v LoRA · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/qwen-image-edit/edit", media: "/examples/feature/qwen-image-edit-edit.jpg", kind: "image", before: "/examples/inputs/person.jpg",
    params: { prompt: "turn the scene into a watercolor illustration, keep the pose", edit_mode: "edit", steps: 8 },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "Qwen-Image-Edit-2511 · Apache-2.0", studio: "image" },
  { endpoint: "motionfield/musetalk/talking-portrait", media: "/examples/feature/musetalk-talking-portrait.mp4", kind: "video", before: "/examples/inputs/portrait.jpg",
    params: { likeness_consent: true },
    inputs: { image_url: "/examples/inputs/portrait.jpg", audio_url: "/examples/inputs/voice.wav" }, credit: "Wan 2.1 VACE 1.3B · Apache-2.0 + MuseTalk · MIT", studio: "audio" },
  { endpoint: "motionfield/musetalk/lip-sync-video", media: "/examples/feature/musetalk-lip-sync-video.mp4", kind: "video", before: "/examples/inputs/portrait-clip.mp4",
    params: { likeness_consent: true },
    inputs: { video_url: "/examples/inputs/portrait-clip.mp4", audio_url: "/examples/inputs/voice.wav" }, credit: "MuseTalk · MIT", studio: "audio" },
  { endpoint: "motionfield/musetalk/portrait-says", media: "/examples/feature/musetalk-portrait-says.mp4", kind: "video", before: "/examples/inputs/portrait.jpg",
    params: { likeness_consent: true, prompt: "Hi, this is MotionField speaking.", voice: "af_heart", duration: 2, steps: 8 },
    inputs: { image_url: "/examples/inputs/portrait.jpg" }, credit: "Wan 2.1 VACE 1.3B · Apache-2.0 + Kokoro · Apache-2.0 + MuseTalk · MIT", studio: "audio" },
  { endpoint: "motionfield/musetalk/portrait-says-ltx", media: "/examples/feature/musetalk-portrait-says-ltx.mp4", kind: "video", before: "/examples/inputs/portrait.jpg",
    params: { likeness_consent: true, prompt: "Welcome to MotionField. This clip was generated live.", voice: "af_heart" },
    inputs: { image_url: "/examples/inputs/portrait.jpg" }, credit: "LTX-2.5 · LTX-2.x Community License (Lightricks) + Kokoro · Apache-2.0 + MuseTalk · MIT", studio: "audio" },
  { endpoint: "motionfield/trellis2/image-to-3d", media: "/examples/feature/trellis2-image-to-3d.jpg", kind: "image", before: "/examples/inputs/perfume.jpg",
    params: { upres: 1024, faces: 100000 },
    inputs: { image_url: "/examples/inputs/perfume.jpg" }, credit: "TRELLIS.2 · MIT + DINOv3 License (Meta) · textured GLB, 60k vertices", studio: "image" },
  { endpoint: "motionfield/wan-vace/object-swap", media: "/examples/feature/wan-vace-object-swap.mp4", kind: "video", before: "/examples/inputs/src5.mp4",
    params: { prompt: "a bright yellow hooded raincoat", mask_tracker: "birefnet", resolution: "480p" },
    inputs: { video_url: "/examples/inputs/src5.mp4", mask_url: "/examples/inputs/torso-box.png", image_urls: ["/examples/inputs/raincoat.jpg"] },
    credit: "Wan 2.1 VACE 1.3B · Apache-2.0 + BiRefNet · MIT", studio: "video" },
  { endpoint: "motionfield/qwen-image-edit/character", media: "/examples/feature/qwen-image-edit-character.jpg", kind: "image", before: "/examples/inputs/man-ref.jpg",
    params: { prompt: "the same man from the reference photo sitting at a sunlit cafe table with a cup of coffee, three-quarter view, natural light, photorealistic", aspect_ratio: "3:4", resolution: "720p" },
    inputs: { image_urls: ["/examples/inputs/man-ref.jpg"] }, credit: "Qwen-Image-Edit-2511 · Apache-2.0", studio: "image" },
  { endpoint: "motionfield/flux2-klein/edit", media: "/examples/feature/flux2-klein-edit.jpg", kind: "image", before: "/examples/inputs/person.jpg",
    params: { prompt: "make it night-time on a neon city street, keep the woman exactly the same", steps: 4 },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "FLUX.2 klein 4B · Apache-2.0", studio: "image" },
  { endpoint: "motionfield/ltx-video/image-to-video", media: "/examples/feature/ltx-video-image-to-video.mp4", kind: "video",
    params: { prompt: "the woman waves at the camera, static camera, full body in frame", duration: 4, resolution: "480p", finish: false },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "LTX-2.5 22B distilled · LTX-2.x Community License (Lightricks) · with generated audio", studio: "video" },
  { endpoint: "motionfield/wan-2.2/image-to-video", media: "/examples/feature/wan-2.2-image-to-video.mp4", kind: "video",
    params: { prompt: "the woman turns her head and smiles, static camera, full body in frame", duration: 5, resolution: "480p", steps: 12, finish: false },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "Wan 2.2 TI2V 5B · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/ltx-video/vfx-keyframe", media: "/examples/feature/ltx-video-vfx-keyframe.mp4", kind: "video", before: "/examples/inputs/person.jpg",
    params: { prompt: "frost crystals bloom across the woman's clothes, ice creeping outward", duration: 4, resolution: "480p", finish: false },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "LTX-2.5 22B distilled · LTX-2.x Community License (Lightricks) · with generated audio", studio: "video" },
  { endpoint: "motionfield/ltx-video/vfx-lab-image", media: "/examples/feature/ltx-video-vfx-lab-image.mp4", kind: "video", before: "/examples/inputs/person.jpg",
    params: { prompt: "the woman erupts in green vines and leaves, overgrowth swallowing her", engine: "ltx095", duration: 4, resolution: "480p", steps: 8, finish: false },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "LTX-2.5 · LTX-2.x Community License (Lightricks)", studio: "video" },
  { endpoint: "motionfield/ltx-video/vfx-lab-plate", media: "/examples/feature/ltx-video-vfx-lab-plate.mp4", kind: "video", before: "/examples/inputs/src5.mp4",
    params: { prompt: "ember sparks and molten cracks crawl across the figure, ash drifting", engine: "ltx095", plate_lock: "medium", hold: 9, target_strength: 0.8, resolution: "480p", steps: 8, finish: false },
    inputs: { video_url: "/examples/inputs/src5.mp4" }, credit: "LTX-2.5 · LTX-2.x Community License (Lightricks)", studio: "video" },
  { endpoint: "motionfield/acestep/music", media: "/examples/feature/acestep-music.mp3", kind: "audio",
    params: { prompt: "upbeat synthwave instrumental, 120 bpm, driving bass", instrumental: true, duration: 15 },
    credit: "ACE-Step 1.5 turbo · Apache-2.0", studio: "audio" },
  { endpoint: "motionfield/flux2-klein/text-to-image", media: "/examples/feature/flux2-klein-text-to-image.jpg", kind: "image",
    params: { prompt: "photo of a grey-haired woman in her 60s riding a vintage bicycle down a cobblestone street in Lisbon, morning light, yellow tram in the background, 35mm film look, photorealistic", aspect_ratio: "3:4", resolution: "720p", steps: 4, seed: 2026 },
    credit: "FLUX.2 klein 4B · Apache-2.0", studio: "image" },
  { endpoint: "motionfield/z-image-turbo/text-to-image", media: "/examples/feature/z-image-turbo-text-to-image.jpg", kind: "image",
    params: { prompt: "photo of a man in his 30s, short dark hair, light stubble, navy bomber jacket, white t-shirt, blue jeans, white sneakers, standing straight facing the camera, arms relaxed at his sides, full body visible head to feet with headroom, plain light grey studio background, soft natural light, photorealistic", aspect_ratio: "9:16", steps: 8, seed: 4242 },
    credit: "Z-Image-Turbo · Apache-2.0", studio: "image" },
  { endpoint: "motionfield/wan-vace/image-to-video", media: "/examples/feature/wan-vace-image-to-video.mp4", kind: "video",
    params: { prompt: "he walks toward the camera, steady tracking shot", duration: 2, aspect_ratio: "9:16", resolution: "480p", steps: 12, finish: false },
    inputs: { image_url: "/examples/inputs/reel-s1.jpg" }, credit: "Wan 2.1 VACE 1.3B · Apache-2.0", studio: "video" },
  { endpoint: "motionfield/palette/grade-image", media: "/examples/feature/palette-grade-image.jpg", kind: "image", before: "/examples/inputs/person.jpg",
    params: { look: "cinema-amber", intensity: 0.8 },
    inputs: { image_url: "/examples/inputs/person.jpg" }, credit: "MotionField palette grade (3D LUT, no model)", studio: "image", tryHref: "/color-grade?example=1" },
  { endpoint: "motionfield/kokoro/text-to-speech", media: "/examples/feature/kokoro-text-to-speech.mp3", kind: "audio",
    params: { prompt: "Hi, I'm testing MotionField. Every clip you see here was generated on open models.", voice: "af_heart" },
    credit: "Kokoro-82M · Apache-2.0", studio: "audio" },
  { endpoint: "motionfield/ltx-video/text-to-video", media: "/examples/feature/ltx-video-text-to-video.mp4", kind: "video",
    params: { prompt: "a man in his 30s with short dark hair in a navy jacket walks toward the camera along a sunlit city sidewalk at golden hour, full body in frame, handheld cinematic shot, natural street ambience", duration: 4, aspect_ratio: "16:9", resolution: "480p", finish: false },
    credit: "LTX-2.5 22B distilled · LTX-2.x Community License (Lightricks) · with generated audio", studio: "video" },
];

export function exampleFor(endpoint: string | undefined): FeatureExample | undefined {
  if (!endpoint) return undefined;
  return FEATURE_EXAMPLES.find((e) => e.endpoint === endpoint);
}

/** Studio deep link that loads an example (model/flow resolve from the endpoint). */
export function exampleHref(e: FeatureExample) {
  if (e.tryHref) return e.tryHref;
  return `${e.studio === "audio" ? "/audio" : `/ai/${e.studio}`}?example=${encodeURIComponent(e.endpoint)}`;
}

/** Standalone tool pages → the endpoints whose examples they show. Studio
 *  routes (/ai/image, /ai/video, /audio) render the example of the selected
 *  workflow inline instead. */
export const PAGE_EXAMPLES: Record<string, string[]> = {
  "/dub-translate": ["motionfield/dub/v1"],
  "/product-ads": ["motionfield/product-placement"],
  "/person-swap": ["motionfield/wan-animate/character-swap"],
  "/object-swap": ["motionfield/wan-vace/object-swap"],
  "/image-editor": ["motionfield/qwen-image-edit/edit"],
  "/color-grade": ["motionfield/palette/grade-image"],
};

export function examplesForPath(pathname: string): FeatureExample[] {
  return (PAGE_EXAMPLES[pathname] ?? []).map(exampleFor).filter((e): e is FeatureExample => !!e);
}

/** AI Assistant skill cards - each shows a real pod output of the skill's own
 *  first step run on `brief`; "Try this example" runs the skill on the same
 *  brief. Skills without an entry here are not shown on the gallery. */
export type SkillExample = { id: string; media: string; kind: "image" | "video"; brief: string };
export const SKILL_EXAMPLES: SkillExample[] = [
  { id: "product-shots", media: "/examples/skills/product-shots.jpg", kind: "image", brief: "a matte black ceramic coffee mug" },
  { id: "ad-variants", media: "/examples/skills/ad-variants.jpg", kind: "image", brief: "a pair of white running sneakers for city runners" },
  { id: "game-art-pack", media: "/examples/skills/game-art-pack.jpg", kind: "image", brief: "a cozy forest village farming game" },
];
export const skillExample = (id: string) => SKILL_EXAMPLES.find((s) => s.id === id);
