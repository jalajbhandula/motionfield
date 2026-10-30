import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { z } from "zod";
import type { SceneSpec } from "@/lib/render/spec";
import { SPEC_LIMITS } from "../render/limits";
import { toAss, toSrt, toVtt } from "./ass";
import { toCues } from "./group";
import { wordsWithinDuration } from "./timing";
import {
  CAPTION_MARGIN_RATIO,
  CAPTION_SIZE_RATIO,
  DEFAULT_CAPTION_STYLE,
  type CaptionMode,
  type CaptionStyle,
  type Word,
} from "./types";

/**
 * Burn word-timed captions into an existing video:
 *   ffprobe the source → build a transparent SceneSpec holding one captions
 *   layer → run the exporter's overlay mode (canvas-rendered captions over
 *   the source, audio kept) → write .ass/.srt/.vtt sidecars next to the mp4.
 *
 * Needs a running app base URL (the render page does the drawing) - the same
 * contract as scripts/render/export.ts.
 */

const FFMPEG = process.env.MOTIONFIELD_FFMPEG || "ffmpeg";
const FFPROBE = process.env.MOTIONFIELD_FFPROBE || "ffprobe";

export interface BurnResult {
  mp4: string;
  ass: string;
  srt: string;
  vtt: string;
}

/** ffprobe -print_format json - the fields we read, validated, never cast */
const ffprobeJson = z.object({
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
  })).optional(),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export async function probeVideo(file: string): Promise<{ width: number; height: number; fps: number; duration: number; hasAudio: boolean }> {
  const raw = await new Promise<string>((res, rej) => {
    const proc = spawn(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", rej);
    proc.on("close", (c) => (c === 0 ? res(out) : rej(new Error(`ffprobe exited ${c}: ${err.slice(-300)}`))));
  });
  const j = ffprobeJson.parse(JSON.parse(raw));
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("ffprobe: no video stream");
  const rate = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate;
  const [rn, rd] = (rate ?? "24/1").split("/").map(Number);
  const fps = rd ? rn / rd : rn || 24;
  const duration = Number(j.format?.duration);
  return {
    width: v.width,
    height: v.height,
    fps: Math.max(1, Math.round(fps * 1000) / 1000),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 1,
    hasAudio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
  };
}

export async function burnCaptions(args: {
  video: string;
  words: Word[];
  style?: Partial<CaptionStyle>;
  mode?: CaptionMode;
  punch?: number[];
  out: string;
  /** app base URL for the render page; omit to let the exporter spawn its own dev server */
  base?: string;
  signal?: AbortSignal;
}): Promise<BurnResult> {
  const { video, words, out, base, signal } = args;
  const mode: CaptionMode = args.mode ?? "karaoke";
  if (!words.length) throw new Error("burnCaptions: words[] is empty");
  const info = await probeVideo(video);
  const boundedWords = wordsWithinDuration(words, info.duration);
  if (!boundedWords.length) throw new Error("burnCaptions: no words fall within the video duration");
  // the same budgets the spec enforces - fail before any spawn, not inside it
  if (info.width * info.height > SPEC_LIMITS.maxPixels) {
    throw new Error(`burnCaptions: ${info.width}×${info.height} exceeds the ${SPEC_LIMITS.maxPixels}-pixel budget`);
  }
  if (Math.round(info.duration * info.fps) > SPEC_LIMITS.maxFrames) {
    throw new Error(`burnCaptions: ${Math.round(info.duration * info.fps)} frames exceeds the ${SPEC_LIMITS.maxFrames}-frame budget`);
  }
  // size/margin default off the real frame height - the same ratios the
  // canvas renderer applies (a fixed px value would shrink on tall formats)
  const style: CaptionStyle = {
    ...DEFAULT_CAPTION_STYLE,
    size: args.style?.size ?? Math.round(info.height * CAPTION_SIZE_RATIO),
    marginBottom: args.style?.marginBottom ?? Math.round(info.height * CAPTION_MARGIN_RATIO),
    ...args.style,
  };

  const spec: SceneSpec = {
    version: 1,
    width: info.width,
    height: info.height,
    fps: info.fps,
    duration: info.duration,
    seed: 1,
    background: { transparent: true },
    camera: { keyframes: [{ t: 0, position: [0, 0, 1], target: [0, 0, 0] }] },
    layers: [{
      id: "captions",
      type: "captions",
      props: {
        words: boundedWords,
        style: mode,
        size: style.size,
        color: style.color,
        highlightColor: style.highlightColor,
        outline: style.outline,
        marginBottom: style.marginBottom,
        uppercase: style.uppercase,
        maxChars: style.maxChars,
        lines: style.lines,
        ...(args.punch?.length ? { punch: args.punch } : {}),
      },
    }],
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "of-burn-"));
  try {
    const specFile = path.join(dir, "spec.json");
    await fs.writeFile(specFile, JSON.stringify(spec));
    const argv = [
      "--experimental-strip-types", "scripts/render/export.ts",
      "--spec", specFile, "--out", out, "--video", video,
      ...(base ? ["--base", base] : []),
    ];
    await new Promise<void>((res, rej) => {
      const proc = spawn(process.execPath, argv, { cwd: process.cwd(), signal });
      let tail = "";
      proc.stderr?.on("data", (d) => { tail = (tail + String(d)).slice(-4000); });
      proc.on("error", rej);
      proc.on("close", (code) => {
        if (code === 0) res();
        else if (signal?.aborted) rej(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        else rej(new Error(`export failed (${code}): ${tail.slice(-400)}`));
      });
    });

    const cues = toCues(boundedWords, { maxChars: style.maxChars, lines: style.lines });
    const ass = `${out}.ass`;
    const srt = `${out}.srt`;
    const vtt = `${out}.vtt`;
    await fs.writeFile(ass, toAss(cues, style, { width: info.width, height: info.height }));
    await fs.writeFile(srt, toSrt(cues, style));
    await fs.writeFile(vtt, toVtt(cues, style));
    return { mp4: out, ass, srt, vtt };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
