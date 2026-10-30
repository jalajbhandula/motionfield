import type { ModelDef } from "../types";
import { DUB } from "./dub";
import { prompt, dur, resV, fps, steps, finish } from "../video/params";
import { LIKENESS_CONSENT_FIELD as likenessConsent, likenessConsentCheck } from "../../likeness";

/** lipsync-video's mask stream (the VHS_LoadVideo feeding OF_MouthMask) must
 *  scale the SHORT side to 512. Which side that is depends on the uploaded
 *  video's orientation, so it is computed here - server-side via ffprobe at
 *  submit time - never trusted from the caller: portrait → custom_width 512,
 *  landscape/square → custom_height 512 (current VHS), plus the matching
 *  force_size for older packs. Unreadable or remote sources keep the
 *  landscape default - the mask just runs at higher cost, same result.
 *  Lazy builtins keep this catalog module importable from client bundles. */
function lipsyncMaskPlaceholders(p: Record<string, unknown>): Record<string, unknown> {
  const landscape = { MASK_FORCE: "Custom Height", MASK_W: "0", MASK_H: "512" };
  const url = typeof p.video_url === "string" ? p.video_url : "";
  const get = globalThis.process?.getBuiltinModule?.bind(globalThis.process);
  if (!get || !url.startsWith("/files/") || /[\\%]|\.\.|\0/.test(url)) return landscape;
  try {
    const path = get("node:path") as typeof import("node:path");
    const fs = get("node:fs") as typeof import("node:fs");
    const cp = get("node:child_process") as typeof import("node:child_process");
    const root = path.resolve(process.cwd(), "public", "files");
    const file = path.resolve(root, url.slice("/files/".length));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return landscape;
    const out = cp.execFileSync(process.env.FFPROBE_BIN || "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-protocol_whitelist", "file", "-i", file],
      { encoding: "utf8", timeout: 15_000 });
    const v = (JSON.parse(out).streams ?? [])
      .find((s: { codec_type?: string }) => s.codec_type === "video");
    let w = Number(v?.width), h = Number(v?.height);
    const rot = Math.abs(Number(
      v?.side_data_list?.find((s: { rotation?: number }) => typeof s.rotation === "number")?.rotation
      ?? v?.tags?.rotate ?? 0)) % 360;
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return landscape;
    // masks must match MuseTalkRun's frames - it re-reads video_path at the
    // native size, so the loader has to emit native dims too (detection
    // still runs at OF_MouthMask's internal 512, so nothing is lost).
    return h > w
      ? { MASK_FORCE: "Custom Width", MASK_W: String(w), MASK_H: "0" }
      : { MASK_FORCE: "Custom Height", MASK_W: "0", MASK_H: String(h) };
  } catch {
    return landscape;
  }
}

/** Audio / avatar models - surfaced in the audio studio. */
export const VOICE_STUDIO: ModelDef = {
  id: "voice-studio", label: "Voice Studio", vendor: "hexgrad Kokoro · ResembleAI", kind: "audio",
  description: "Speech generation on open weights - Kokoro-82M text-to-speech (Apache-2.0, ONNX/CPU) and Chatterbox voice cloning (MIT, MPS). Both run fast locally on Apple Silicon.",
  tags: ["speech", "narration", "voice-clone", "fast"],
  workflows: [
    {
      id: "text-to-speech", label: "Text to speech", endpointId: "motionfield/kokoro/text-to-speech", kind: "audio",
      params: [
        { name: "prompt", label: "Text", type: "textarea", required: true, placeholder: "The text to speak aloud…" },
        { name: "voice", label: "Voice", type: "select", default: "af_heart",
          enum: ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
          description: "af/am = American female/male, bf/bm = British" },
        { name: "speed", label: "Speed", type: "slider", default: 1, min: 0.5, max: 2, step: 0.05 },
      ],
      cost: () => 0.5,
      providers: { comfy: { workflow: "kokoro-tts.json" } },
    },
    {
      id: "voice-clone", label: "Voice clone", endpointId: "motionfield/chatterbox/voice-clone", kind: "audio",
      params: [
        { name: "audio_url", label: "Reference voice", type: "audio", required: true, accepts: "audio/*",
          description: "A clean 5-20 s clip of the voice to clone. Only clone a voice you have the right to use - output is watermarked when resemble-perth is installed (scripts/setup-voice.sh)." },
        { name: "prompt", label: "Text", type: "textarea", required: true, placeholder: "What the cloned voice should say…" },
        { name: "exaggeration", label: "Expressiveness", type: "slider", default: 0.5, min: 0.25, max: 2, step: 0.05 },
      ],
      cost: () => 2,
      providers: { comfy: { workflow: "chatterbox-voice-clone.json" } },
    },
  ],
};

export const LIPSYNC: ModelDef = {
  id: "lipsync", label: "Lip Sync", vendor: "Tencent TME · Alibaba Wan-AI", kind: "avatar",
  description: "Open lip-sync on commercially usable weights - MuseTalk runs locally on Apple Silicon (video + audio, or a still portrait driven into a talking clip); Wan2.2-S2V is the native 14B studio path (cloud-recommended). Audio can be an upload or a Voice Studio clip - or type a line and we synthesize the speech in the same job.",
  tags: ["lip-sync", "talking-head", "dubbing", "avatar"],
  workflows: [
    {
      id: "lip-sync-video", label: "Lip-sync video", endpointId: "motionfield/musetalk/lip-sync-video", kind: "avatar",
      params: [
        likenessConsent,
        { name: "video_url", label: "Face video", type: "video", required: true,
          description: "A clip with a clearly visible face of a person you have the right to use. It loops if the audio runs longer." },
        { name: "audio_url", label: "Audio", type: "audio", required: true, accepts: "audio/*",
          description: "Upload a track - or feed a Voice Studio (Kokoro/Chatterbox) output." },
        { name: "bbox_shift", label: "Mouth-open bias", type: "slider", default: 0, min: -10, max: 10, step: 1,
          description: "MuseTalk tuning - positive values open the mouth more." },
        finish,
      ],
      cost: () => 10,
      validate: likenessConsentCheck("motionfield/musetalk/lip-sync-video"),
      providers: { comfy: { workflow: "lipsync-video.json", map: lipsyncMaskPlaceholders } },
    },
    {
      id: "talking-portrait", label: "Talking portrait", endpointId: "motionfield/musetalk/talking-portrait", kind: "avatar",
      params: [
        likenessConsent,
        { name: "image_url", label: "Portrait", type: "image", required: true, accepts: "image/*",
          description: "Front-facing portrait - animated into a short motion clip first (Wan 2.1 VACE 1.3B, Apache-2.0), then lip-synced." },
        { name: "audio_url", label: "Audio", type: "audio", required: true, accepts: "audio/*" },
        { name: "motion_prompt", label: "Motion prompt", type: "text",
          default: "a person facing camera and talking, subtle natural head motion, steady framing" },
        { name: "bbox_shift", label: "Mouth-open bias", type: "slider", default: 0, min: -10, max: 10, step: 1 },
        dur([1, 2, 3, 5], 2), fps, steps(8), finish,
      ],
      cost: () => 15,
      validate: likenessConsentCheck("motionfield/musetalk/talking-portrait"),
      providers: { comfy: { workflow: "lipsync-talking-portrait.json" } },
    },
    {
      id: "talking-portrait-ltx", label: "Talking portrait · LTX (opt-in)", endpointId: "motionfield/musetalk/talking-portrait-ltx", kind: "avatar",
      params: [
        likenessConsent,
        { name: "image_url", label: "Portrait", type: "image", required: true, accepts: "image/*",
          description: "Front-facing portrait - motion stage uses LTX-2.5 (LTX-2.x Community License, use-restricted). Explicit opt-in." },
        { name: "audio_url", label: "Audio", type: "audio", required: true, accepts: "audio/*" },
        { name: "motion_prompt", label: "Motion prompt", type: "text",
          default: "a person facing camera and talking, subtle natural head motion, steady framing" },
        { name: "bbox_shift", label: "Mouth-open bias", type: "slider", default: 0, min: -10, max: 10, step: 1 },
        dur([3, 5], 3), fps, steps(8), finish,
      ],
      cost: () => 15,
      validate: likenessConsentCheck("motionfield/musetalk/talking-portrait-ltx"),
      providers: { comfy: { workflow: "lipsync-talking-portrait-ltx.json" } },
    },
    {
      id: "portrait-says", label: "Portrait says", endpointId: "motionfield/musetalk/portrait-says", kind: "avatar",
      params: [
        likenessConsent,
        { name: "image_url", label: "Portrait", type: "image", required: true, accepts: "image/*",
          description: "Front-facing portrait - motion by Wan 2.1 VACE 1.3B (Apache-2.0), speech by Kokoro, lip-sync by MuseTalk." },
        { name: "prompt", label: "Line to speak", type: "textarea", required: true,
          placeholder: "What the portrait should say…" },
        { name: "voice", label: "Voice", type: "select", default: "af_heart",
          enum: ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
          description: "Kokoro voice - af/am = American female/male, bf/bm = British" },
        { name: "speed", label: "Speech speed", type: "slider", default: 1, min: 0.5, max: 2, step: 0.05 },
        { name: "motion_prompt", label: "Motion prompt", type: "text",
          default: "a person facing camera and talking, subtle natural head motion, steady framing" },
        // same motion knobs as Talking portrait - without them the graph fell
        // back to 30 VACE steps (~56 s/step on an H100, ~30 min per clip)
        dur([1, 2, 3, 5], 2), fps, steps(8), finish,
      ],
      cost: () => 16,
      validate: likenessConsentCheck("motionfield/musetalk/portrait-says"),
      providers: { comfy: { workflow: "lipsync-talk.json" } },
    },
    {
      id: "portrait-says-ltx", label: "Portrait says · LTX (opt-in)", endpointId: "motionfield/musetalk/portrait-says-ltx", kind: "avatar",
      params: [
        likenessConsent,
        { name: "image_url", label: "Portrait", type: "image", required: true, accepts: "image/*",
          description: "Front-facing portrait - motion stage uses LTX-2.5 (LTX-2.x Community License, use-restricted). Explicit opt-in." },
        { name: "prompt", label: "Line to speak", type: "textarea", required: true,
          placeholder: "What the portrait should say…" },
        { name: "voice", label: "Voice", type: "select", default: "af_heart",
          enum: ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
          description: "Kokoro voice - af/am = American female/male, bf/bm = British" },
        { name: "speed", label: "Speech speed", type: "slider", default: 1, min: 0.5, max: 2, step: 0.05 },
        { name: "motion_prompt", label: "Motion prompt", type: "text",
          default: "a person facing camera and talking, subtle natural head motion, steady framing" },
        finish,
      ],
      cost: () => 16,
      validate: likenessConsentCheck("motionfield/musetalk/portrait-says-ltx"),
      providers: { comfy: { workflow: "lipsync-talk-ltx.json" } },
    },
    {
      id: "studio-portrait", label: "Studio portrait · S2V", endpointId: "motionfield/wan-s2v/talking-portrait", kind: "avatar",
      params: [
        likenessConsent,
        { name: "image_url", label: "Portrait", type: "image", required: true, accepts: "image/*" },
        { name: "audio_url", label: "Audio", type: "audio", required: true, accepts: "audio/*" },
        prompt(false), dur([3, 5], 5), resV(["480p", "720p"], "480p"), steps(20), finish,
      ],
      cost: () => 40,
      validate: likenessConsentCheck("motionfield/wan-s2v/talking-portrait"),
      providers: { comfy: { workflow: "lipsync-s2v.json" } },
      heavy: "Wan2.2-S2V-14B fp8 (~16 GB) + wav2vec2 - not downloaded locally; Comfy Cloud or a CUDA GPU recommended. The MuseTalk modes above run on this machine.",
    },
  ],
};

export const AUDIO_VOICE_MODELS: ModelDef[] = [VOICE_STUDIO, LIPSYNC, DUB];
