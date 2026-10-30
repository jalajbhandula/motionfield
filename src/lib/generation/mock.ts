import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import type { GenerationProvider, ProviderStatus, SubmitInput, SubmitResult } from "./types";
import { JOB_KIND_OUTPUT } from "./types";
import { filePathFor } from "../storage";
import { probeVideo } from "../re-edit-ffmpeg";

const run = promisify(execFile);
const OUT_DIR = path.join(process.cwd(), "public", "files", "generated");

interface MockMeta { submittedAt: number; prompt: string; kind: string; seed?: number; ar: string; finishSource?: string }

const QUEUE_MS = 1200;
const RUN_MS = 3800;

const AR_DIMS: Record<string, [number, number]> = {
  "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [960, 960],
  "4:3": [960, 720], "3:4": [720, 960], "21:9": [1280, 548],
  "3:2": [1080, 720], "2:3": [720, 1080], "4:5": [768, 960], "5:4": [900, 720],
};

function esc(s: string) {
  return s.replace(/[:\\'"]/g, " ").slice(0, 90);
}

/** Render a real artifact. Tries ffmpeg; falls back to a hand-written SVG/WAV
    so zero-dependency setups still produce genuine media files. */
async function render(kind: string, jobId: string, prompt: string, seed: number, ar: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const [w, h] = AR_DIMS[ar] ?? AR_DIMS["16:9"];
  const hue = (seed * 37) % 360;
  const caption = esc(prompt || "motionfield mock render");
  const common = ["-y", "-hide_banner", "-loglevel", "error"];

  if (kind === "image") {
    const file = path.join(OUT_DIR, `${jobId}.png`);
    try {
      await run("ffmpeg", [...common,
        "-f", "lavfi", "-i", `gradients=size=${w}x${h}:seed=${seed}:duration=1:speed=0`,
        "-vf", `hue=h=${hue}`,
        "-frames:v", "1", file]);
      return { url: `/files/generated/${jobId}.png`, width: w, height: h };
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 120) % 360},70%,25%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="52%" font-family="system-ui" font-size="28" fill="white" text-anchor="middle">${caption}</text></svg>`;
      const svgFile = path.join(OUT_DIR, `${jobId}.svg`);
      await fs.writeFile(svgFile, svg);
      return { url: `/files/generated/${jobId}.svg`, width: w, height: h };
    }
  }
  if (kind === "audio") {
    const file = path.join(OUT_DIR, `${jobId}.wav`);
    const freq = 220 + (seed % 440);
    try {
      await run("ffmpeg", [...common, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=4`, file]);
    } catch {
      // 4s mono sine WAV written by hand (44-byte header + PCM16)
      const rate = 22050, n = rate * 4, buf = Buffer.alloc(44 + n * 2);
      buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
      buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
      await fs.writeFile(file, buf);
    }
    return { url: `/files/generated/${jobId}.wav`, duration: 4 };
  }
  // video
  const file = path.join(OUT_DIR, `${jobId}.mp4`);
  await run("ffmpeg", [...common,
    "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=24:duration=3`,
    "-f", "lavfi", "-i", `sine=frequency=${200 + (seed % 300)}:duration=3`,
    "-vf", `hue=h=${hue}:s=0.6`,
    "-pix_fmt", "yuv420p", "-shortest", file]);
  return { url: `/files/generated/${jobId}.mp4`, width: w, height: h, duration: 3 };
}

export const mockProvider: GenerationProvider = {
  name: "mock",

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const meta: MockMeta = {
      submittedAt: Date.now(),
      prompt: String(input.params.prompt ?? input.params.text ?? input.workflow.label),
      kind: JOB_KIND_OUTPUT[input.workflow.kind],
      seed: Number(input.params.seed) || Math.floor(Math.random() * 1e6),
      ar: String(input.params.aspect_ratio ?? "16:9"),
      ...(input.workflow.endpointId === "motionfield/finish/video"
        ? { finishSource: String(input.params.video_url ?? "") } : {}),
    };
    return { providerJobId: `mock-${input.jobId}`, meta: meta as unknown as Record<string, unknown> };
  },

  async poll(providerJobId: string, meta: Record<string, unknown>): Promise<ProviderStatus> {
    const m = meta as unknown as MockMeta;
    const elapsed = Date.now() - m.submittedAt;
    if (elapsed < QUEUE_MS) return { state: "queued", position: 1 };
    if (elapsed < QUEUE_MS + RUN_MS) return { state: "in_progress", progress: Math.min(95, Math.round(((elapsed - QUEUE_MS) / RUN_MS) * 100)) };

    const jobId = providerJobId.replace(/^mock-/, "");
    try {
      // Mock finishing is a pass-through, not a new three-second test pattern.
      // Preserve the source timeline/audio so recipe contract tests stay useful.
      if (m.finishSource !== undefined) {
        const source = m.finishSource.startsWith("/files/") ? filePathFor(m.finishSource) : null;
        if (!source) throw new Error("mock finish requires a local output");
        const probe = await probeVideo(source);
        await fs.mkdir(OUT_DIR, { recursive: true });
        await fs.copyFile(source, path.join(OUT_DIR, `${jobId}.mp4`));
        return { state: "completed", output: { items: [{ type: "video",
          url: `/files/generated/${jobId}.mp4`, width: probe.width,
          height: probe.height, duration: probe.durationSec }], meta: { mock: true } } };
      }
      const item = await render(m.kind, jobId, m.prompt, m.seed ?? 1, m.ar);
      return { state: "completed", output: { items: [{ type: m.kind as "image" | "video" | "audio", ...item }], meta: { mock: true } } };
    } catch (err) {
      return { state: "failed", error: `mock render failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },

  async cancel() { /* instant - nothing running */ },
};
