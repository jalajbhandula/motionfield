/**
 * WS1 s14 GPU smoke — drives MCP `audio{kind:"music"}` end-to-end on a real
 * ComfyUI-backed app instance: signup → API key → install-cli → stdio MCP →
 * audio{kind:music,duration:10} → job_status poll → job_download → RIFF check.
 *
 *   # app instance first (separate shell):
 *   PORT=3120 PGLITE_DIR=/tmp/of-ws1-gpu/pglite GENERATION_PROVIDER=comfy \
 *     COMFY_BASE_URL=http://127.0.0.1:8188 npm run dev
 *
 *   # then, always under the GPU serializer:
 *   GPU_MAX_SECS=1800 ~/.motionfield/gpu-run ws1-s14 -- \
 *     npx tsx scripts/ws1-mcp-audio-smoke.mts --base http://localhost:3120
 *
 * duration:10 — the endpoint's own floor is 10 s (music validates 10–120);
 * asking for 5 would exercise its input validator, not the GPU. Exits
 * non-zero on any failure so the gpu-run log records the real outcome.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => argv[argv.indexOf(`--${n}`) + 1] ?? d;
const base = arg("base", "http://localhost:3120");
const pollMs = Number(arg("poll-ms", "25")) * 60_000; // job budget, minutes

const email = `ws1-gpu-smoke-${Date.now()}@smoke.test`;
const sign = await fetch(`${base}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email, password: "gpu-smoke-pass-1234", name: "GPU Smoke" }),
});
if (!sign.ok) throw new Error(`signup ${sign.status}: ${await sign.text()}`);
const cookie = (sign.headers.get("set-cookie") ?? "").split(";")[0];

const keyRes = await fetch(`${base}/api/keys`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie },
  body: JSON.stringify({ label: "ws1-gpu-smoke" }),
});
if (!keyRes.ok) throw new Error(`key ${keyRes.status}: ${await keyRes.text()}`);
const { key } = (await keyRes.json()) as { key: string };
if (!key?.startsWith("of_")) throw new Error("no of_ key in /api/keys response");

const prefix = mkdtempSync(join(tmpdir(), "of-gpu-smoke-"));
execFileSync("scripts/install-cli.sh", [], {
  env: { ...process.env, PREFIX: prefix }, stdio: "inherit", timeout: 120_000,
});
const outDir = mkdtempSync(join(tmpdir(), "of-gpu-smoke-out-"));

const transport = new StdioClientTransport({
  command: join(prefix, "bin", "motionfield-mcp"),
  env: {
    ...process.env,
    MOTIONFIELD_URL: base,
    MOTIONFIELD_API_KEY: key,
    MOTIONFIELD_TOOLSETS: "core,studio", // audio lives in studio, job_* in core
    MOTIONFIELD_MCP_OUT_DIR: outDir,
  } as Record<string, string>,
});
const client = new Client({ name: "ws1-gpu-smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
if (!names.includes("audio")) {
  console.error(`audio not listed — endpoints: ${names.join(",")}`);
  process.exit(2);
}
console.log(`audio listed (${names.length} tools across core,studio)`);

const call = async (name: string, args: Record<string, unknown>, timeout = 60_000) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = (res.content as { text?: string }[])[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* raw */ }
  return { isError: res.isError === true, data, text };
};

const sub = await call("audio", {
  kind: "music", prompt: "calm ambient pad, soft piano, slow cinematic swell",
  duration: 10, wait_s: 50,
}, 70_000);
if (sub.isError) { console.error(`audio submit failed: ${sub.text}`); process.exit(3); }
let job = sub.data;
console.log(`submitted ${job.id} — status ${job.status}`);

/* the MCP wait caps at 50 s — ACE-Step takes longer; poll job_status to a
 * terminal state inside the gpu-run budget */
const deadline = Date.now() + pollMs;
while (!["completed", "failed", "canceled", "nsfw"].includes(String(job.status))) {
  if (Date.now() > deadline) { console.error(`job ${job.id} still ${job.status} after ${pollMs}ms`); process.exit(4); }
  await new Promise((r) => setTimeout(r, 5000));
  const st = await call("job_status", { id: job.id });
  if (!st.isError) job = st.data;
  console.log(`  ${job.status} (${new Date().toISOString().slice(11, 19)})`);
}
if (job.status !== "completed") { console.error(`job ended ${job.status}: ${JSON.stringify(job).slice(0, 400)}`); process.exit(5); }

const outs = job.outputs as { type: string; url?: string }[] | undefined;
console.log(`completed — outputs: ${JSON.stringify(outs?.map((o) => o.type))}`);
if (!outs?.length || !String(outs[0].type).startsWith("audio/")) { console.error("no audio output"); process.exit(6); }

const dl = await call("job_download", { id: job.id, index: 0 });
if (dl.isError) { console.error(`job_download failed: ${dl.text}`); process.exit(7); }
const file = String(dl.data.path ?? "");
if (!file || !existsSync(file)) { console.error(`no downloaded file: ${dl.text}`); process.exit(8); }
const head = readFileSync(file).subarray(0, 4).toString("latin1");
if (head !== "RIFF") { console.error(`downloaded bytes aren't RIFF (${head})`); process.exit(9); }
console.log(`downloaded ${file} — ${readFileSync(file).length} bytes, RIFF ok`);
console.log("GPU SMOKE PASS — audio{kind:music,duration:10} → ACE-Step → real WAV through the MCP surface");
await client.close();
process.exit(0);
