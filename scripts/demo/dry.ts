/**
 * dry.ts — `npm run demo:dry`. The repeatable demo pipeline end to end:
 *
 *   profile-guard → provision a demo user (signup, pro, key, license opt-in)
 *   → fixtures → capture (browser shots → webm clips) → mcp-check (real
 *   tool sequence over the installed MCP bin) → CLI line (motionfield
 *   generate … --wait --json) → music bed (mock ACE-Step) → cards (real
 *   SceneSpec renders) → assemble (xfade + overlays + music) →
 *   timeline.json + captions.srt + demo.mp4.
 *
 * Everything lands under `--out` (default /tmp/of-demo-dry — always inside
 * the temp dir, always of-demo*, nuked at start). The API key lives in env
 * vars and memory only; every artifact write passes through the redactor.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assemble, closeOverlayRenderer } from "./assemble";
import { buildCardSpecs, renderCards } from "./cards";
import { captureShots, provisionUser } from "./capture";
import { runMcpCheck } from "./mcp-check";
import { loadProfile } from "./profile-guard";
import { badgesFor, nodePackBadge, shots as allShots, type Badge } from "./shots";
import { parseArgs, redactSecrets, redactedStringify, resolveDemoOutDir } from "./util";

/* ------------------------- mock music bed ------------------------------ */

/** The dry-run bed is a real job through the real endpoint — under the mock
 *  provider ACE-Step returns a real WAV without GPU. On Oct 28 the same
 *  call goes to the GPU graph instead (scripts/gpu-run covers that leg). */
async function musicBed(base: string, apiKey: string, out: string): Promise<{ file: string | null; credit: string }> {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  let jobId: string;
  try {
    const r = await fetch(`${base}/api/v1/jobs`, {
      method: "POST", headers,
      body: JSON.stringify({ endpoint: "motionfield/acestep/music", params: { prompt: "warm ambient bed, light tape hiss, slow pulses", duration: 12 } }),
    });
    if (!r.ok) return { file: null, credit: `music: ACE-Step 1.5 · MIT (submit ${r.status} in dry run)` };
    jobId = ((await r.json()) as { id: string }).id; // /api/v1/jobs returns the job at top level
  } catch {
    return { file: null, credit: "music: ACE-Step 1.5 · MIT (submit unreachable in dry run)" };
  }
  const end = Date.now() + 120_000;
  for (;;) {
    const j = await fetch(`${base}/api/v1/jobs/${jobId}`, { headers });
    const d = (await j.json()) as { status: string; outputs?: { url?: string; type?: string }[] };
    if (["completed", "failed", "canceled"].includes(d.status)) {
      const url = d.outputs?.[0]?.url;
      if (d.status === "completed" && url?.startsWith("/files/")) {
        const rel = url.slice("/files/".length);
        const fp = path.join(process.cwd(), "public", "files", rel);
        if (fs.existsSync(fp)) {
          const dst = path.join(out, "music.wav");
          fs.copyFileSync(fp, dst);
          return { file: dst, credit: "music: ACE-Step 1.5 · MIT (mock provider — dry run)" };
        }
      }
      return { file: null, credit: `music: ACE-Step 1.5 · MIT (mock run ended ${d.status})` };
    }
    if (Date.now() > end) return { file: null, credit: "music: ACE-Step 1.5 · MIT (mock run timed out)" };
    await new Promise((r2) => setTimeout(r2, 1500));
  }
}

/* ------------------------------ the line ------------------------------- */

/** `motionfield generate … --wait --json` through the installed bin — the
 *  exact line docs/DEMO.md shows viewers; stdout lands redacted in
 *  cli-run.json. */
function cliLine(opts: { prefixDir: string; base: string; apiKey: string; out: string }): { ok: boolean; line: string } {
  const bin = path.join(opts.prefixDir, "bin", "motionfield");
  const line = `motionfield generate motionfield/z-image-turbo/text-to-image -p prompt="a red kite over golden dunes" --wait --json`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.MOTIONFIELD_URL = opts.base;
  env.MOTIONFIELD_API_KEY = opts.apiKey;
  env.MOTIONFIELD_CONFIG_DIR = path.join(opts.out, "cli-cfg");
  const stdout = execFileSync(bin, [
    "generate", "motionfield/z-image-turbo/text-to-image",
    "-p", "prompt=a red kite over golden dunes", "--wait", "--json",
  ], { env, encoding: "utf8", timeout: 240_000 });
  fs.writeFileSync(path.join(opts.out, "cli-run.json"), redactSecrets(stdout));
  return { ok: true, line };
}

/* ------------------------------- main ---------------------------------- */

export async function dryRun(opts: { base: string; out: string; keep?: boolean }): Promise<number> {
  const out = resolveDemoOutDir(opts.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const log = (m: string) => console.log(`demo:dry ${m}`);

  const profile = loadProfile();
  log(`profile ok — brain ${profile.brain.model} via ${profile.brain.provider}`);

  const sess = await provisionUser(opts.base);
  log(`demo user up (${sess.email.replace(/@.*/, "@…")} · pro plan · restricted opt-in on)`);

  // 1 — the shots
  const cap = await captureShots({ base: opts.base, out, storageState: sess.storageState, profile });
  const failedShots = cap.metas.filter((m) => !m.ok);
  log(`capture: ${cap.metas.filter((m) => m.ok).length}/${cap.metas.length} shots ok`);

  // 2 — MCP tool sequence for real
  const mcp = await runMcpCheck({
    base: opts.base, apiKey: sess.apiKey, out, profile, storageState: sess.storageState,
    prefixDir: path.join(out, "prefix"),
  });
  log(`mcp-check: ${mcp.ok ? "ok" : `FAILED — ${mcp.error}`}`);

  // 3 — the CLI line
  let cli: { ok: boolean; line: string } = { ok: false, line: "" };
  try {
    cli = cliLine({ prefixDir: path.join(out, "prefix"), base: opts.base, apiKey: sess.apiKey, out });
    log(`cli: ${cli.line.split(" --")[0]} … → done`);
  } catch (e) {
    cli = { ok: false, line: `motionfield generate … failed: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : e}` };
    log(`cli: FAILED — ${cli.line}`);
  }

  // 4 — music bed (mock provider → real wav, no GPU)
  const music = await musicBed(opts.base, sess.apiKey, out);
  log(`music: ${music.file ? "bed captured" : "no bed — credits still carry the card line"}`);

  // 5 — cards, rendered through the app's own exporter
  const allBadges: Badge[] = cap.metas.flatMap((m) => m.badges);
  const specs = buildCardSpecs({ badges: [...allBadges, nodePackBadge()], musicCredit: music.credit });
  const cards = renderCards({ out, base: opts.base, specs });
  log(`cards: ${cards.map((c) => c.id).join(", ")} rendered`);

  // 6 — assemble
  const res = await assemble({ out, cards, musicFile: music.file, musicCredit: music.credit });
  await closeOverlayRenderer();
  if (!res.ok) {
    log(`assemble: missing required shots: ${res.missing.join(", ")}`);
  } else {
    log(`assemble: ${res.total_s}s → ${res.outFile}`);
    log(`timeline → ${res.timelinePath}`);
    log(`captions → ${res.captionsPath}`);
  }

  const report = {
    ok: res.ok && mcp.ok && cli.ok && failedShots.length === 0,
    capture: cap.metas.map((m) => ({ id: m.id, ok: m.ok, clip: m.clip, error: m.error })),
    mcp: { ok: mcp.ok, run_id: mcp.run_id, s1_reused: mcp.s1_reused, s2_reran: mcp.s2_reran, s2_revision: mcp.s2_revision, error: mcp.error },
    cli: cli.ok,
    music: !!music.file,
    assemble: { ok: res.ok, total_s: res.total_s, missing: res.missing },
  };
  fs.writeFileSync(path.join(out, "dry-report.json"), redactedStringify(report));
  log(`report → ${path.join(out, "dry-report.json")}`);
  return report.ok ? 0 : 1;
}

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/dry.ts");
if (isMain) {
  const { opts } = parseArgs(process.argv.slice(2));
  dryRun({
    base: String(opts.base ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3110"),
    out: String(opts.out ?? "/tmp/of-demo-dry"),
  }).then(
    (code) => process.exit(code),
    (e) => { console.error(`demo:dry ${e instanceof Error ? e.message : e}`); process.exit(1); },
  );
}
