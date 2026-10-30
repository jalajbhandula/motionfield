/**
 * Captions library - word timestamps → cues → ASS/SRT/VTT sidecars →
 * burned-in captions. Server-only: ASR and burn spawn host binaries
 * (whisper-cli/ffmpeg) - never import this module from client code
 * (the renderer carries its own cue grouping/drawing in render/runtime).
 *
 * API for WS2 (explainer) and WS4 (edits):
 *
 *   transcribeWords(mediaPath, { signal, language? })
 *     → { words: Word[]; estimated: false }
 *     ASR via whisper-cli + ggml model (WHISPER_MODEL env, default
 *     ~/.motionfield/models/whisper/ggml-base.en.bin). mediaPath must resolve
 *     inside the storage root or os.tmpdir(). AsrError codes: NEEDS_ASR
 *     (binary/model missing), ASR_LANGUAGE (".en" model + non-English),
 *     ASR_PATH (bad path), ASR_FAILED (spawn/parse failure).
 *
 *   wordsFromScript(text, duration)
 *     → { words: Word[]; estimated: true }
 *     Script-fallback timing (no ASR): length-weighted word spread with
 *     punctuation pauses, ≥0.12 s per word. Always flagged estimated.
 *
 *   toCues(words, { maxChars?=32, lines?=2, maxCue?=3.5, breakGap?=0.35 })
 *     → Cue[]  (cue = { start, end, words })
 *
 *   toAss(cues, style, frame?) / toSrt(cues, style) / toVtt(cues, style)
 *     → sidecar text (ASS carries karaoke {\k} timing + the style block;
 *       frame {width,height} sets PlayRes - size/margin defaults scale with
 *       the frame height).
 *
 *   burnCaptions({ video, words, style?, mode?=karaoke|pop|punch, punch?,
 *                  out, base?, signal? })
 *     → { mp4, ass, srt, vtt }
 *     Renders the captions through the canvas renderer over `video` via the
 *     exporter's overlay mode; writes the three sidecars next to `out.mp4`.
 *
 * The SceneSpec `captions` layer (karaoke/pop/punch) does the actual burn-in
 * drawing - ffmpeg here has no libass/drawtext by design.
 */

export { AsrError, DEFAULT_CAPTION_STYLE } from "./types";
export type { AsrErrorCode, CaptionMode, CaptionStyle, Cue, GroupOptions, Word } from "./types";
export { toCues } from "./group";
export { wordsFromScript } from "./timing";
export { assEscape, assTime, cueText, karaokeText, srtTime, toAss, toSrt, toVtt } from "./ass";
export { transcribeWords, type AsrDeps } from "./asr";
export { burnCaptions, probeVideo, type BurnResult } from "./burn";
