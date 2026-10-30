/**
 * Recipe smoke — run a recipe-backed endpoint straight through the provider
 * path (no Next server / auth / DB needed):
 *
 *   npx tsx scripts/recipe-smoke.ts "make an explainer about how rainbows form" \
 *     [--params '{"scenes":3,"voice":"af_heart","aspect_ratio":"16:9"}'] [--timeout 2400]
 *
 * Needs ComfyUI + comfy-api-proxy running, and a configured LLM
 * (LLM_BASE_URL + LLM_MODEL) for the script step — without one, a pasted
 * multi-sentence script still works (chunked deterministically) but a bare
 * topic fails fast. The only output is the final stitched mp4 — sub-job
 * artifacts are tracked and deleted after the stitch.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import { recipeProvider } from "../src/lib/generation/recipe";

const execFileP = promisify(execFile);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

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
  } catch { /* ffprobe missing — size check only */ }
  return `${(size / 1024).toFixed(0)} KB${probe}${size === 0 ? "  ⚠ EMPTY" : ""}`;
}

async function main() {
  const prompt = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : "make an explainer about how rainbows form";
  const params: Record<string, unknown> = {
    prompt, scenes: 3, voice: "af_heart", aspect_ratio: "16:9",
    ...(arg("params") ? JSON.parse(arg("params")!) : {}),
  };

  const t0 = Date.now();
  const timeoutMs = (Number(arg("timeout")) || 2400) * 1000;
  const sub = await recipeProvider.submit({
    jobId: `smoke-${crypto.randomUUID()}`,
    model: {} as never,
    workflow: { endpointId: "motionfield/explainer/video", providers: { recipe: { name: "explainer" } } } as never,
    params,
    appBaseUrl: "http://localhost:3000",
  });
  console.log(`submitted explainer recipe -> ${sub.providerJobId}`);

  let lastPct = -1;
  for (;;) {
    const st = await recipeProvider.poll(sub.providerJobId, sub.meta ?? {});
    const secs = Math.round((Date.now() - t0) / 1000);
    if (st.state === "in_progress" || st.state === "queued") {
      const pct = st.state === "in_progress" ? (st.progress ?? 0) : 0;
      if (pct !== lastPct || secs % 30 === 0) {
        process.stdout.write(`\r${st.state} ${pct}% (${secs}s)   `);
        lastPct = pct;
      }
      if (Date.now() - t0 > timeoutMs) {
        console.log(`\ntimeout after ${secs}s — cancelling`);
        await recipeProvider.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
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
