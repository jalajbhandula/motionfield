import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Live ASR smoke - real whisper-cli + real ffmpeg + the real burn pipeline.
 * Gated on ASR_LIVE=1 so `npm test` stays deterministic; run it through the
 * shared GPU wrapper:
 *
 *   ~/.motionfield/gpu-run ws5-asr -- env ASR_LIVE=1 npx vitest run tests/smoke/ws5-asr.test.ts
 *
 * It copies the whisper-cpp sample into a temp dir (transcribeWords only
 * reads media under tmpdir/public/files), asserts the word-level timing
 * contract - ≥15 words, monotonic starts, no punctuation-only words - then
 * runs burnCaptions on a clip made from the wav and writes the artifact
 * evidence to /tmp/of-evidence/OF-0357.json.
 */

const LIVE = process.env.ASR_LIVE === "1";
const WHISPER_BIN = process.env.WHISPER_CLI || "whisper-cli";
const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";
const MODEL = process.env.WHISPER_MODEL || `${process.env.HOME}/.motionfield/models/whisper/ggml-base.en.bin`;
/** whisper.cpp's public model source for ggml-base.en */
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const JFK = "/opt/homebrew/share/whisper-cpp/jfk.wav";
const EVIDENCE = "/tmp/of-evidence";

const haveTools = LIVE
  && existsSync(MODEL)
  && existsSync(JFK)
  && [WHISPER_BIN, FFMPEG, FFPROBE].every((b) => {
    try {
      execFileSync("/usr/bin/which", [b], { stdio: "ignore" });
      return true;
    } catch {
      return existsSync(b);
    }
  });

describe.skipIf(!haveTools)("ws5 ASR live smoke (whisper-cli + ffmpeg + burnCaptions)", () => {
  it("transcribeWords → ordered, punctuated whole words; burnCaptions → evidence JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "of-asr-smoke-"));
    try {
    // jfk.wav lives outside the allowed roots - copy it in like a real upload
    const wav = path.join(dir, "jfk.wav");
    copyFileSync(JFK, wav);

    const { transcribeWords } = await import("@/lib/captions");
    const { words, estimated } = await transcribeWords(wav, {
      deps: { model: MODEL },
      signal: AbortSignal.timeout(300_000),
    });

    expect(estimated).toBe(false);
    // "…ask not what your country can do for you…" - base.en lands ≥15 words
    expect(words.length).toBeGreaterThanOrEqual(15);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
    }
    for (const w of words) {
      expect(w.end).toBeGreaterThan(w.start);
      // no punctuation-only or control-marker words - each segment's whole
      // text is the word (this is the splitting fix under test)
      expect(w.text).not.toMatch(/^[\s\p{P}\p{S}]+$/u);
      expect(w.text).not.toMatch(/^\[_.*_\]$/);
    }

    // a real clip made from the wav → burnCaptions burns the words in
    const clip = path.join(dir, "clip.mp4");
    execFileSync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24",
      "-i", wav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
    const out = path.join(dir, "burned.mp4");
    const { burnCaptions } = await import("@/lib/captions/burn");
    const res = await burnCaptions({
      video: clip, words, out,
      base: process.env.OF_BASE || undefined, // absent → exporter spawns its own dev server
      signal: AbortSignal.timeout(600_000),
    });
    expect(existsSync(res.mp4)).toBe(true);
    expect(existsSync(res.ass)).toBe(true);
    expect(existsSync(res.srt)).toBe(true);
    expect(existsSync(res.vtt)).toBe(true);

    const probe = JSON.parse(
      execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", res.mp4], { encoding: "utf8" }),
    );
    const sha256 = createHash("sha256").update(readFileSync(res.mp4)).digest("hex");
    const modelStat = statSync(MODEL);
    const modelSha = createHash("sha256").update(readFileSync(MODEL)).digest("hex");

    mkdirSync(EVIDENCE, { recursive: true });
    // the mp4 survives alongside the JSON - artifact_path points at the
    // evidence copy (the working dir is removed in finally)
    const evidenceMp4 = path.join(EVIDENCE, "OF-0357.mp4");
    copyFileSync(res.mp4, evidenceMp4);
    writeFileSync(
      path.join(EVIDENCE, "OF-0357.json"),
      JSON.stringify({
        id: "OF-0357",
        cmd: "~/.motionfield/gpu-run ws5-asr -- env ASR_LIVE=1 npx vitest run tests/smoke/ws5-asr.test.ts",
        artifact_path: evidenceMp4,
        sha256,
        ffprobe: probe,
        model: { url: MODEL_URL, path: MODEL, size: modelStat.size, sha256: modelSha },
        date: new Date().toISOString(),
      }, null, 2),
    );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 660_000);
});
