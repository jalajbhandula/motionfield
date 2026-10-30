/**
 * Smoke-test one bundled workflow through the Comfy SDK provider, end to end:
 *   npx tsx scripts/comfy-smoke.ts ltx-txt2video.json "a paper boat drifting on a pond"
 *   npx tsx scripts/comfy-smoke.ts ltx-img2video.json --image public/files/smoke/frame.png
 *   npx tsx scripts/comfy-smoke.ts vace-restyle.json --video public/files/smoke/clip.mp4 --steps 6
 *   npx tsx scripts/comfy-smoke.ts klein-inpaint.json --image x.png --mask y.png --params '{"mode":"remove"}'
 *   npx tsx scripts/comfy-smoke.ts ltx-vfx-keyframe.json --image start.png --end-image end.png
 *   npx tsx scripts/comfy-smoke.ts vace-character-swap.json --video clip.mp4 --ref person.png [--ref2 p2.png --ref3 p3.png]
 *   npx tsx scripts/comfy-smoke.ts character-vace-image.json --ref p1.png --ref2 p2.png [--pose pose.png]
 *
 * Media flags accept a local path (copied under public/files/smoke/ first) or an
 * existing /files/... path; the provider then uploads it to ComfyUI through the
 * SDK asset pipeline — the same path user uploads take.
 * Needs ComfyUI + comfy-api-proxy running (see README). Exits non-zero on failure.
 * .env is honoured (COMFY_BASE_URL/COMFY_API_KEY) — an unset env would silently
 * target the provider default (127.0.0.1:8189), which can be a stale local stack.
 */
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { comfyProvider } from "../src/lib/generation/comfy";
import { ALL_MODELS } from "../src/lib/catalog/video-models";

// load .env before the provider reads COMFY_BASE_URL — the static import above
// is hoisted, but the provider resolves config lazily at submit time, so
// loading here is still early enough
try { process.loadEnvFile?.(); } catch { /* no .env — provider defaults apply */ }

const execFileP = promisify(execFile);

/** Probe a saved output file: byte size + ffprobe duration/streams (best-effort). */
async function verifyOutput(relUrl: string) {
  const p = path.join(process.cwd(), "public", relUrl);
  const st = await fs.stat(p).catch(() => null);
  const size = st?.size ?? 0;
  let probe = "";
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", p,
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    const dur = lines.find((l) => l.startsWith("format"))?.split(",")[1];
    const streams = lines.filter((l) => l.startsWith("stream")).map((l) => l.split(",").slice(1).join(":"));
    probe = `${dur ? ` · ${Number(dur).toFixed(2)}s` : ""}${streams.length ? ` · ${streams.join("+")}` : ""}`;
  } catch { /* ffprobe not installed — size check only */ }
  return `${(size / 1024).toFixed(0)} KB${probe}${size === 0 ? "  ⚠ EMPTY" : ""}`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// first positional = workflow file, second = prompt
const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "ltx-txt2video.json";
const prompt = process.argv[3] && !process.argv[3].startsWith("--")
  ? process.argv[3]
  : "a paper boat drifting on a calm pond at sunrise";

/** Copy a local media file into public/files/smoke/ and return its /files/ path. */
async function toFilesPath(p: string): Promise<string> {
  if (p.startsWith("/files/")) return p;
  const data = await fs.readFile(p);
  const dest = path.join(process.cwd(), "public", "files", "smoke", path.basename(p));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);
  return `/files/smoke/${path.basename(p)}`;
}

async function main() {
  const params: Record<string, unknown> = {
    prompt,
    aspect_ratio: "16:9",
    resolution: "480p",
    duration: 1,
    fps: 16,
    steps: 6,
    seed: 42,
    // media
    image_url: arg("image") ? await toFilesPath(arg("image")!) : undefined,
    end_image_url: arg("end-image") ? await toFilesPath(arg("end-image")!) : undefined,
    video_url: arg("video") ? await toFilesPath(arg("video")!) : undefined,
    mask_url: arg("mask") ? await toFilesPath(arg("mask")!) : undefined,
    mask_video_url: arg("mask-video") ? await toFilesPath(arg("mask-video")!) : undefined,
    audio_url: arg("audio") ? await toFilesPath(arg("audio")!) : undefined,
    pose_image_url: arg("pose") ? await toFilesPath(arg("pose")!) : undefined,
    image_urls: arg("ref")
      ? [arg("ref"), arg("ref2"), arg("ref3")].filter(Boolean).map((x) => x!)
      : undefined,
  };
  if (params.image_urls) {
    const urls: string[] = [];
    for (const p of params.image_urls as string[]) urls.push(await toFilesPath(p));
    params.image_urls = urls;
  }
  const override = arg("params");
  if (override) Object.assign(params, JSON.parse(override));
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

  const t0 = Date.now();
  const timeoutMs = (Number(arg("timeout")) || 900) * 1000;
  // adopt the catalog's providers.comfy block (map hooks, licensing) when the
  // graph file is a catalog workflow — smoke then exercises the real def
  const catWf = ALL_MODELS.flatMap((m) => m.workflows)
    .find((w) => w.providers.comfy?.workflow === file);
  const sub = await comfyProvider.submit({
    jobId: `smoke-${crypto.randomUUID()}`,
    model: {} as never,
    workflow: catWf
      ? { endpointId: catWf.endpointId, providers: catWf.providers, params: catWf.params } as never
      : { endpointId: `smoke/${file}`, providers: { comfy: { workflow: file } } } as never,
    params,
    appBaseUrl: "http://localhost:3000",
  });
  console.log(`submitted ${file} -> job ${sub.providerJobId}`);

  let lastPct = -1;
  for (;;) {
    const st = await comfyProvider.poll(sub.providerJobId, sub.meta ?? {});
    const secs = Math.round((Date.now() - t0) / 1000);
    if (st.state === "queued" || st.state === "in_progress") {
      const pct = st.state === "in_progress" && st.progress != null ? st.progress : 0;
      if (pct !== lastPct || secs % 30 === 0) {
        process.stdout.write(`\r${st.state} ${pct}% (${secs}s)   `);
        lastPct = pct;
      }
      if (Date.now() - t0 > timeoutMs) {
        console.log(`\ntimeout after ${secs}s — cancelling`);
        await comfyProvider.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    console.log(`\n${st.state} after ${secs}s`);
    if (st.state === "completed") {
      for (const it of st.output.items) console.log(`  ${it.type}: public${it.url} (${await verifyOutput(it.url)})`);
    } else console.log(st);
    process.exit(st.state === "completed" ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
