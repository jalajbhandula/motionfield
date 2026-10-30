/**
 * PersonSwap smoke — run the whole pipeline for real against ComfyUI
 * (GENERATION_PROVIDER=comfy), one job, no Next server needed:
 *
 *   npx tsx scripts/person-swap-smoke.ts /path/to/clip.mp4 --ref /path/to/person.png \
 *     [--ref2..ref8 pN.png] [--mode person|environment|both] [--no-lip] \
 *     [--resolution 480p] [--steps 6] [--timeout 2400] \
 *     [--env-prompt txt] [--aspect source|9:16|16:9] [--quick] [--gallery <id>]
 *
 * `-` as the clip + --gallery <id> runs a ready gallery clip without staging.
 *
 * Uses its own PGlite (PGLITE_DIR, default /tmp/of-person-swap-smoke) so it never
 * fights a running dev server, seeds a smoke user, inserts the clip + refs
 * as uploads, then drives createJob → the person-swap recipe → tickJob until
 * terminal. Prints the ffprobe of source vs output; the run's matte/coverage
 * evidence stays under public/files/generated/.person_swap/<job>/.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

const FLAG_ARGS = new Set([
  "ref", "ref2", "ref3", "ref4", "ref5", "ref6", "ref7", "ref8",
  "mode", "resolution", "steps", "timeout", "prompt", "env-prompt", "aspect", "gallery",
]);
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const positional = () => process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith("--") && !(arr[i - 1]?.startsWith("--") && FLAG_ARGS.has(arr[i - 1].slice(2))));

process.env.PGLITE_DIR ??= "/tmp/of-person-swap-smoke";
process.env.GENERATION_PROVIDER ??= "comfy";

import { sql } from "../src/db";
import { createJob, cancelJob, tickJob } from "../src/lib/jobs";
import { probeVideo } from "../src/lib/re-edit-ffmpeg";
import { PERSON_SWAP_ENDPOINT, personSwapWindows } from "../src/lib/generation/recipes/person-swap";

const USER = "of-person-swap-smoke";

async function migrate() {
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "inherit",
  });
}
async function seed() {
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'smoke', 'smoke@local.dev', true)
             ON CONFLICT (id) DO NOTHING`, [USER]);
  await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 100000)
             ON CONFLICT (user_id) DO UPDATE SET credits = 100000`, [USER]);
}

const ffprobe = async (file: string) => {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  return JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; avg_frame_rate?: string; width?: number; height?: number }[] };
};
const describe = (m: Awaited<ReturnType<typeof ffprobe>>) => {
  const v = (m.streams ?? []).find((s) => s.codec_type === "video");
  const [rn, rd] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return `${v?.width}x${v?.height} @ ${rd ? (rn / rd).toFixed(3) : "?"} fps · ${Number(m.format?.duration ?? 0).toFixed(2)}s · ${(m.streams ?? []).map((s) => s.codec_type).join("+")}`;
};

async function stageUpload(file: string, mime: string) {
  const name = `person-swap-smoke-${randomUUID()}${path.extname(file)}`;
  const dir = path.join(process.cwd(), "public", "files", "uploads");
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, name));
  const url = `/files/uploads/${name}`;
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`, [USER, url, mime, statSync(path.join(dir, name)).size, name]);
  return url;
}

async function main() {
  const src = positional()[0];
  if (!src || (src !== "-" && !existsSync(src))) {
    console.error("usage: npx tsx scripts/person-swap-smoke.ts <clip.mp4|-> [--mode person] [--ref person.png …] [--prompt txt] [--env-prompt txt] [--aspect source|9:16|16:9] [--quick] [--draft] [--draft-of <job>] [--gallery <id>] [--no-lip] [--resolution 480p] [--steps 6] [--timeout 2400]");
    process.exit(2);
  }
  const mode = arg("mode") ?? "person";
  const resolution = arg("resolution") ?? "480p";
  const lipSync = !process.argv.includes("--no-lip");
  const quick = process.argv.includes("--quick");
  const draft = process.argv.includes("--draft");
  const draftOf = arg("draft-of");
  const steps = arg("steps");
  const timeoutMs = (Number(arg("timeout")) || 2400) * 1000;
  const galleryId = arg("gallery");
  const refs = ["ref", "ref2", "ref3", "ref4", "ref5", "ref6", "ref7", "ref8"]
    .map(arg).filter((x): x is string => Boolean(x && existsSync(x)));

  await migrate();
  await seed();

  const videoUrl = src === "-" ? "" : await stageUpload(src, "video/mp4");
  const imageUrls: string[] = [];
  for (const r of refs) imageUrls.push(await stageUpload(r, "image/png"));

  if (videoUrl) console.log(`source: ${describe(await ffprobe(src))}`);
  // same derivation the route does — windows are the chargeable unit and the
  // recipe re-checks the count, never the caller's number
  const probeSrc = videoUrl ? path.resolve(src) : "/dev/null";
  const windows = videoUrl
    ? personSwapWindows((await probeVideo(probeSrc)).durationSec).length
    : 1; // gallery clips ≤5 s → always 1 window; the route re-derives anyway
  const t0 = Date.now();
  const job = await createJob(USER, {
    endpointId: PERSON_SWAP_ENDPOINT,
    params: {
      ...(videoUrl ? { video_url: videoUrl } : {}),
      ...(galleryId ? { gallery_id: galleryId } : {}),
      mode, image_urls: imageUrls,
      prompt: arg("prompt") ?? "", likeness_consent: true,
      lip_sync: lipSync, resolution, windows,
      ...(arg("env-prompt") !== undefined ? { env_prompt: arg("env-prompt") } : {}),
      ...(arg("aspect") && arg("aspect") !== "source" ? { aspect: arg("aspect") } : {}),
      ...(quick ? { quick: true } : {}),
      ...(draft ? { draft: true } : {}),
      ...(draftOf ? { draft_of: draftOf } : {}),
      ...(steps !== undefined ? { steps: Number(steps) } : {}),
    },
    title: `person-swap smoke ${mode}${quick ? " quick" : ""}`,
  });
  console.log(`job ${job.id} — mode=${mode}${quick ? " quick" : ""} refs=${imageUrls.length} lip=${lipSync}${galleryId ? ` gallery=${galleryId}` : ""}`);

  let lastStage = "";
  for (;;) {
    await tickJob(job.id);
    const [{ status, progress, error }] = await sql<{ status: string; progress: number; error: string | null }>(
      `SELECT status, progress, error FROM jobs WHERE id = $1`, [job.id]);
    const stage = `${status} ${progress}%`;
    if (stage !== lastStage) { console.log(`${Math.round((Date.now() - t0) / 1000)}s  ${stage}`); lastStage = stage; }
    if (!["queued", "in_progress"].includes(status)) {
      if (status !== "completed") { console.error(`FAILED: ${error}`); process.exit(1); }
      break;
    }
    if (Date.now() - t0 > timeoutMs) {
      console.log("timeout — canceling job");
      await cancelJob(USER, job.id).catch(() => {});
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const [{ outputs, provider_meta }] = await sql<{
    outputs: { url: string; type: string }[];
    provider_meta: { person_swap?: Record<string, unknown> } | null;
  }>(`SELECT outputs, provider_meta FROM jobs WHERE id = $1`, [job.id]);
  const outUrl = outputs?.[0]?.url;
  if (!outUrl) { console.error("no output url"); process.exit(1); }
  const outFile = path.join(process.cwd(), "public", outUrl.replace("/files/", "files/"));
  console.log(`\noutput: ${describe(await ffprobe(outFile))}`);
  console.log(`artifact: ${outUrl}`);
  console.log(`meta: ${JSON.stringify(provider_meta?.person_swap ?? null)}`);
  const evDir = path.join(process.cwd(), "public", "files", "generated", ".person_swap", job.id);
  try { console.log(`evidence: ${evDir} — ${readdirSync(evDir).join(", ") || "(empty)"}`); } catch { /* none */ }
  console.log(`total ${Math.round((Date.now() - t0) / 1000)}s`);
}

main()
  .then(() => process.exit(0))  // the db pool + comfy event stream keep the loop alive — exit explicitly
  .catch((e) => { console.error(e); process.exit(1); });
