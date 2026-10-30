import type { ModelDef } from "../types";

/**
 * Music + sound-effect models - surfaced in the audio studio next to Voice.
 *
 *  - ACE-Step 1.5 (MIT upstream; the Comfy-Org repackage is Apache-2.0)
 *    prompt→music through ComfyUI's native ace nodes. Turbo DiT + Qwen3
 *    encoder/LM + 1.5 VAE; weights bind through {{ACESTEP_*}} placeholders
 *    so the shipped graph stays weight-free (per-file license rows land
 *    with the WS3 manifest request).
 *  - MOSS-SoundEffect v2.0 (Apache-2.0) prompt→sfx through OF_MossSFX -
 *    our own MIT node driving the Apple-Silicon MLX 4-bit port.
 *  - Video→SFX + post-mix run the audio-mix recipe (cue planning on the
 *    caller's vision route, cue synthesis on the sfx graph, ffmpeg mix).
 */

/** The exact ACE-Step 1.5 files the graph binds - the Comfy-Org repackage
 *  (Apache-2.0) of the same weights ACE-Step/Ace-Step1.5 ships as MIT
 *  upstream. NOT XL. */
export const ACESTEP_FILES = {
  unet: "acestep_v1.5_turbo.safetensors",
  clipEncoder: "qwen_0.6b_ace15.safetensors",
  clipLm: "qwen_1.7b_ace15.safetensors",
  vae: "ace_1.5_vae.safetensors",
} as const;

export const ACESTEP_MUSIC: ModelDef = {
  id: "acestep", label: "ACE-Step 1.5", vendor: "ACE Studio · StepFun", kind: "audio",
  description:
    "Prompt-to-music on ACE-Step 1.5 (MIT upstream; the Comfy-Org repackage is " +
    "Apache-2.0) - a Qwen LM plans the song, the turbo DiT renders it. Style tags + " +
    "optional lyrics; instrumental mode ignores lyrics. Output is a " +
    "loudness-normalized WAV (−14 LUFS integrated, −1 dBTP).",
  tags: ["music", "song", "instrumental", "lyrics"],
  workflows: [
    {
      id: "music", label: "Text to music", endpointId: "motionfield/acestep/music", kind: "audio",
      params: [
        { name: "prompt", label: "Style", type: "textarea", required: true,
          placeholder: "epic orchestral score, taiko drums, heroic brass, cinematic…",
          description: "Style tags describing the track - genre, instruments, mood, tempo feel (max 500 chars)." },
        { name: "lyrics", label: "Lyrics", type: "textarea",
          placeholder: "[verse]\n…\n[chorus]\n…",
          description: "Optional lyrics - section markers like [verse]/[chorus] are understood (max 3000 chars)." },
        { name: "instrumental", label: "Instrumental", type: "boolean", default: false,
          description: "Ignore lyrics - music bed only." },
        { name: "duration", label: "Duration (s)", type: "slider", default: 30, min: 10, max: 120, step: 1 },
        { name: "seed", label: "Seed", type: "integer", default: 0, min: 0, max: 2147483647, step: 1,
          description: "0 = random." },
      ],
      cost: (p) => 2 + Math.ceil(Math.min(120, Math.max(10, Number(p.duration) || 30)) / 30),
      validate: (p) => {
        const prompt = String(p.prompt ?? "").trim();
        if (!prompt) return "a style prompt is required";
        if (prompt.length > 500) return "style prompt must be ≤ 500 characters";
        if (String(p.lyrics ?? "").length > 3000) return "lyrics must be ≤ 3000 characters";
        const d = Number(p.duration ?? 30);
        if (!Number.isFinite(d) || d < 10 || d > 120) return "duration must be 10-120 seconds";
        return null;
      },
      providers: {
        comfy: {
          workflow: "music-acestep.json",
          map: (p) => ({
            ACESTEP_UNET: ACESTEP_FILES.unet,
            ACESTEP_CLIP1: ACESTEP_FILES.clipEncoder,
            ACESTEP_CLIP2: ACESTEP_FILES.clipLm,
            ACESTEP_VAE: ACESTEP_FILES.vae,
            // a submit without duration still binds the placeholder
            DURATION: p.duration ?? 30,
            // instrumental ignores lyrics; ACE-Step 1.5's code LM stops early on
            // empty lyrics (half the clip came back silent), so tag it explicitly
            LYRICS: p.instrumental === true || p.instrumental === "true" ? "[Instrumental]" : String(p.lyrics ?? ""),
          }),
        },
      },
      heavy: "ACE-Step 1.5 turbo - ~10 GB of weights, installed locally; verified on Apple Silicon 2026-10-24, ~116 s per 30 s clip; peak ≈16 GB RAM",
    },
  ],
};

export const MOSS_SFX: ModelDef = {
  id: "moss-sfx", label: "MOSS SoundEffect", vendor: "OpenMOSS", kind: "audio",
  description:
    "Text-to-sound-effects on MOSS-SoundEffect v2.0 (Apache-2.0, 1.3B DiT + DAC VAE) " +
    "- ambience, impacts, creatures, actions at 48 kHz. Apple Silicon uses MLX; " +
    "configured CUDA hosts use the upstream torch pipeline. Missing weights or " +
    "dependencies produce an explicit error.",
  tags: ["sfx", "foley", "sound-effects", "ambience"],
  workflows: [
    {
      id: "sfx", label: "Text to sound effect", endpointId: "motionfield/moss/sfx", kind: "audio",
      params: [
        { name: "prompt", label: "Sound", type: "textarea", required: true,
          placeholder: "rain on a tin roof with distant thunder…",
          description: "What it should sound like (max 300 chars)." },
        { name: "duration", label: "Duration (s)", type: "slider", default: 5, min: 1, max: 20, step: 1 },
        { name: "seed", label: "Seed", type: "integer", default: 0, min: 0, max: 2147483647, step: 1 },
      ],
      cost: () => 1,
      validate: (p) => {
        const prompt = String(p.prompt ?? "").trim();
        if (!prompt) return "a sound prompt is required";
        if (prompt.length > 300) return "sound prompt must be ≤ 300 characters";
        const d = Number(p.duration ?? 5);
        if (!Number.isFinite(d) || d < 1 || d > 20) return "duration must be 1-20 seconds";
        return null;
      },
      providers: {
        comfy: {
          workflow: "sfx-moss.json",
          // a submit without duration still binds the placeholder
          map: (p) => ({ DURATION: p.duration ?? 5 }),
        },
      },
      heavy: "MOSS-SoundEffect v2.0 - MLX on Apple Silicon or a separately provisioned CUDA environment (scripts/runpod/moss-cuda.sh).",
    },
    {
      id: "video-sfx", label: "Video → sound effects", endpointId: "motionfield/moss/video-sfx", kind: "v2v",
      params: [
        { name: "video_url", label: "Video", type: "video", required: true,
          description: "An owned clip up to 60 s - up to 16 frames (1 per second on clips ≤16 s, sparser beyond) go to your configured vision model to plan foley cues." },
        { name: "prompt", label: "Cue guidance", type: "textarea",
          description: "Optional direction for the cue planner (e.g. 'subtle indoor ambience')." },
        { name: "seed", label: "Seed", type: "integer", default: 0, min: 0, max: 2147483647, step: 1 },
      ],
      cost: () => 6,
      providers: { recipe: { name: "audio-mix" } },
      heavy: "cues planned by your vision model from up to 16 frames (1 per second on clips ≤16 s, sparser beyond), then made from text - timing ≈1 s on short clips, coarser on long ones; not frame-synced; sound added after generation",
    },
  ],
};

export const AUDIO_MIX: ModelDef = {
  id: "sound-mix", label: "Sound · post-mix", vendor: "MotionField ffmpeg", kind: "v2v",
  description:
    "Post-mix a finished video - lay an owned music/sfx bed under it, or rebuild its " +
    "soundtrack cue-by-cue. Sound added after generation - the output is tagged post-mix " +
    "(metadata.audio) and never pretends to be original audio.",
  tags: ["post-mix", "audio-mix", "sound"],
  workflows: [
    {
      id: "post-mix", label: "Post-mix audio", endpointId: "motionfield/audio-mix/post-mix", kind: "v2v",
      params: [
        { name: "video_url", label: "Video", type: "video", required: true,
          description: "An owned clip to re-sound." },
        { name: "audio_url", label: "Music / SFX bed", type: "audio", required: true,
          accepts: "audio/*",
          description: "An owned/generated track - mixed in at −20 LUFS under kept dialogue, −14 when it carries the mix." },
        { name: "mode", label: "Original audio", type: "select", default: "keep",
          enum: ["keep", "replace"],
          description: "keep = original audio at −16 LUFS with the bed −20 under it; replace = drop it - bed alone at −14." },
      ],
      cost: () => 1,
      providers: { recipe: { name: "audio-mix" } },
    },
  ],
};

export const AUDIO_MUSIC_MODELS: ModelDef[] = [ACESTEP_MUSIC, MOSS_SFX, AUDIO_MIX];
