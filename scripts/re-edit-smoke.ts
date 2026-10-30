/**
 * ReCut smoke — run the whole pipeline for real against ComfyUI
 * (GENERATION_PROVIDER=comfy), one job, no Next server needed:
 *
 *   npx tsx scripts/re-edit-smoke.ts /path/to/reference.mp4 \
 *     [--flow restyle] [--resolution 480p] [--steps 6] [--timeout 2400] [--regen 0]
 *   npx tsx scripts/re-edit-smoke.ts --chain <id> --regen <shot-index>
 *
 * The --chain form re-drives a regenerate on an existing chain in the same
 * PGlite dir — the retry path after a transient provider outage.
 *
 * Uses its own PGlite (PGLITE_DIR, default /tmp/of-re-edit-smoke) so it never
 * fights a running dev server, seeds a smoke user, inserts the clip as an
 * upload, then drives startChain → re-edit-assemble → tickJob until terminal.
 * Prints the ffprobe of source vs output and per-shot status at the end.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

process.env.PGLITE_DIR ??= "/tmp/of-re-edit-smoke";
process.env.GENERATION_PROVIDER ??= "comfy";

import { sql } from "../src/db";
import { startChain, loadChain, chainJobs, regenerateShot } from "../src/lib/re-edit";
import { cancelJob, tickJob } from "../src/lib/jobs";

const USER = "of-re-edit-smoke";

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

const FLAG_ARGS = new Set(["flow", "resolution", "steps", "timeout", "regen", "instructions", "chain"]);
/** Positional args = argv entries that aren't --flags or a --flag's value. */
const positional = () => process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith("--") && !(arr[i - 1]?.startsWith("--") && FLAG_ARGS.has(arr[i - 1].slice(2))));

async function main() {
  const src = positional()[0];
  const chainArg = arg("chain");
  if (!chainArg && !src) {
    console.error("usage: npx tsx scripts/re-edit-smoke.ts <reference.mp4> [--flow restyle] [--resolution 480p] [--steps 6] [--timeout 2400]\n" +
      "       npx tsx scripts/re-edit-smoke.ts --chain <id> --regen <shot-index>");
    process.exit(2);
  }
  if (src && !existsSync(src)) { console.error(`not found: ${src}`); process.exit(2); }
  const flow = (arg("flow") ?? "restyle") as "restyle" | "character-swap" | "motion-transfer";
  const resolution = arg("resolution") ?? "480p";
  const steps = arg("steps");
  const timeoutMs = (Number(arg("timeout")) || 2400) * 1000;

  await migrate();
  await seed();

  const t0 = Date.now();
  let lastStage = "";
  const drain = async (jobId: string, chainId: string) => {
    for (;;) {
      await tickJob(jobId);
      const [{ status, progress }] = await sql<{ status: string; progress: number }>(
        `SELECT status, progress FROM jobs WHERE id = $1`, [jobId]);
      const c = await loadChain(chainId);
      const stage = `${status} ${progress}% · chain=${c?.status}`;
      if (stage !== lastStage) { console.log(`${Math.round((Date.now() - t0) / 1000)}s  ${stage}`); lastStage = stage; }
      if (!["queued", "in_progress"].includes(status)) return;
      if (Date.now() - t0 > timeoutMs) {
        console.log(`timeout — canceling job`);
        await cancelJob(USER, jobId).catch(() => {});
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const driveRegen = async (chainId: string, shotIdx: number) => {
    const { job: rjob } = await regenerateShot(USER, chainId, shotIdx);
    console.log(`\nregen shot ${shotIdx} — job ${rjob.id}`);
    lastStage = "";
    await drain(rjob.id, chainId);
    const ref2 = await loadChain(chainId);
    if (ref2?.status !== "completed" || !ref2.resultUrl) {
      console.error(`REGEN FAILED: chain=${ref2?.status} err=${ref2?.error ?? "(none)"}`);
      const jobs = await chainJobs(chainId, USER);
      jobs.forEach((j) => console.error(`  job ${j.id} ${j.status} ${j.error ?? ""}`));
      process.exit(1);
    }
    const regenFile = path.join(process.cwd(), "public", ref2.resultUrl.replace("/files/", "files/"));
    console.log(`\nregen output: ${describe(await ffprobe(regenFile))}`);
    console.log(`artifact: ${ref2.resultUrl}`);
  };

  // --chain <id> --regen <shot>: retry a shot on an existing chain —
  // no upload, no new chain, just the regenerate + probe
  if (chainArg) {
    const chain = await loadChain(chainArg);
    if (!chain) { console.error(`chain ${chainArg} not found in PGLITE_DIR=${process.env.PGLITE_DIR}`); process.exit(2); }
    console.log(`chain ${chain.id} status=${chain.status}`);
    await driveRegen(chain.id, Math.trunc(Number(arg("regen") ?? "0")));
    return;
  }

  const upName = `re-edit-smoke-${randomUUID()}${path.extname(src!) || ".mp4"}`;
  const upDir = path.join(process.cwd(), "public", "files", "uploads");
  mkdirSync(upDir, { recursive: true });
  copyFileSync(src, path.join(upDir, upName));
  const videoUrl = `/files/uploads/${upName}`;
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', $3, $4)
             ON CONFLICT DO NOTHING`,
    [USER, videoUrl, statSync(path.join(upDir, upName)).size, upName]);

  const srcProbe = await ffprobe(src!);
  console.log(`source: ${describe(srcProbe)}`);

  const { chain, job } = await startChain(USER, {
    videoUrl, flow, imageUrls: [], instructions: arg("instructions") ?? "",
    resolution,
    ...(steps !== undefined ? { steps: Number(steps) } : {}),
  });
  const shots = chain.shots as { index: number; start: number; end: number; windows: unknown[] }[];
  console.log(`chain ${chain.id} — ${shots.length} shot(s), ${shots.reduce((a, s) => a + s.windows.length, 0)} window(s), job ${job.id}`);

  await drain(job.id, chain.id);

  const fresh = await loadChain(chain.id);
  if (fresh?.status !== "completed" || !fresh.resultUrl) {
    console.error(`FAILED: chain=${fresh?.status} err=${fresh?.error ?? "(none)"}`);
    const jobs = await chainJobs(chain.id, USER);
    jobs.forEach((j) => console.error(`  job ${j.id} ${j.status} ${j.error ?? ""}`));
    process.exit(1);
  }
  const outFile = path.join(process.cwd(), "public", fresh.resultUrl.replace("/files/", "files/"));
  const outProbe = await ffprobe(outFile);
  console.log(`\noutput: ${describe(outProbe)}`);
  console.log(`result_url: ${fresh.resultUrl}`);
  console.log(`file: ${outFile}`);
  console.log(`artifact: ${fresh.resultUrl}`);

  const regenShot = arg("regen");
  if (regenShot !== undefined) {
    await driveRegen(chain.id, Math.trunc(Number(regenShot)));
  }
}

void main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
