/* Environment check: verifies everything the app needs before it starts,
   so a broken setup reports what is wrong instead of failing later.

   Run: pnpm health

   PASS means the check is fine. WARN means the app runs but something is
   degraded. FAIL means fix it before reporting the app as ready.
   Explicit environment variables win over .env; .env.local wins over .env. */
import { execSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Level = "PASS" | "WARN" | "FAIL";
const results: { level: Level; name: string; detail: string }[] = [];
const report = (level: Level, name: string, detail: string) => {
  results.push({ level, name, detail });
  const pad = level === "PASS" ? level : ` ${level}`;
  console.log(`${pad}  ${name.padEnd(30)} ${detail}`);
};

// --- env files: parse KEY=VALUE, never eval. Shell env wins. ------------
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

const onPath = (bin: string) => {
  try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true; } catch { return false; }
};

async function main() {
  // --- runtime ------------------------------------------------------------
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18))
    report("PASS", "node", `v${process.versions.node} (need >= 22.18)`);
  else report("FAIL", "node", `v${process.versions.node} — install Node 22.18 or newer`);

  report(onPath("pnpm") ? "PASS" : "FAIL", "pnpm", onPath("pnpm") ? "on PATH" : "not on PATH — install pnpm 12.15.0");

  // --- auth ---------------------------------------------------------------
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret.length >= 32 && !secret.startsWith("change-me"))
    report("PASS", "auth secret", "set");
  else report("FAIL", "auth secret", "missing or placeholder — set BETTER_AUTH_SECRET in .env (openssl rand -base64 32)");

  if (process.env.BETTER_AUTH_URL) report("PASS", "auth url", process.env.BETTER_AUTH_URL);
  else report("WARN", "auth url", "BETTER_AUTH_URL unset — sign-in may fail off the default origin");

  // --- provider -----------------------------------------------------------
  const provider = (process.env.GENERATION_PROVIDER || "comfy").trim();
  if (provider === "mock" || provider === "comfy")
    report("PASS", "provider", provider === "mock" ? "mock — synthetic outputs, no GPU" : "comfy — real renders through ComfyUI");
  else report("FAIL", "provider", `GENERATION_PROVIDER="${provider}" — must be mock or comfy`);

  // --- database -----------------------------------------------------------
  const dbUrl = process.env.DATABASE_URL?.trim();
  let dbOk = false;
  if (dbUrl) {
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 4000 });
      await pool.query("SELECT 1");
      await pool.end();
      dbOk = true;
      report("PASS", "database", "Postgres reachable");
    } catch (e) {
      report("FAIL", "database", `DATABASE_URL unreachable — ${e instanceof Error ? e.message : e}`);
    }
  } else {
    const local = "postgres://motionfield:motionfield@127.0.0.1:5432/motionfield";
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: local, connectionTimeoutMillis: 4000 });
      await pool.query("SELECT 1");
      await pool.end();
      dbOk = true;
      report("PASS", "database", "Postgres on 127.0.0.1:5432 — set DATABASE_URL to this in .env so the app uses it");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report("FAIL", "database", `Docker Postgres is not reachable (${msg}). Run: docker compose up -d db`);
    }
  }
  void dbOk;

  // --- workflows ------------------------------------------------------------
  try {
    const files = readdirSync("workflows").filter((f) => f.endsWith(".json"));
    let bad = 0;
    for (const f of files) {
      try { JSON.parse(readFileSync(join("workflows", f), "utf8")); } catch { bad++; }
    }
    if (bad) report("FAIL", "workflows", `${bad} of ${files.length} graphs do not parse`);
    else report("PASS", "workflows", `${files.length} graphs, all valid JSON`);
  } catch {
    report("FAIL", "workflows", "workflows/ directory missing");
  }

  // --- comfy --------------------------------------------------------------
  if (provider === "comfy") {
    const base = (process.env.COMFY_BASE_URL || "http://127.0.0.1:8189").replace(/\/+$/, "");
    try {
      const key = process.env.COMFY_API_KEY;
      const res = await fetch(`${base}/api/v2/health`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) report("PASS", "comfy proxy", `${base} answers`);
      else report("FAIL", "comfy proxy", `${base} returned ${res.status}`);
    } catch {
      report("FAIL", "comfy proxy", `${base} unreachable — is ComfyUI + comfy-api-proxy running?`);
    }
    if (process.env.PUBLIC_BASE_URL) report("PASS", "public url", process.env.PUBLIC_BASE_URL);
    else report("WARN", "public url", "PUBLIC_BASE_URL unset — remote ComfyUI cannot fetch your media");
  } else {
    report("PASS", "comfy proxy", `skipped — provider is ${provider}`);
  }

  // --- media tools ----------------------------------------------------------
  const ff = onPath(process.env.MOTIONFIELD_FFMPEG || "ffmpeg");
  const fp = onPath(process.env.MOTIONFIELD_FFPROBE || "ffprobe");
  if (ff && fp) report("PASS", "ffmpeg", "ffmpeg and ffprobe on PATH");
  else report("WARN", "ffmpeg", `${ff ? "ffprobe" : "ffmpeg"} missing — captions and video finishing need both`);

  // --- llm ------------------------------------------------------------------
  if (process.env.LLM_PROVIDER || process.env.LLM_BASE_URL)
    report("PASS", "llm", `${process.env.LLM_PROVIDER || "custom endpoint"} configured`);
  else report("WARN", "llm", "unset — assistant uses the fixed planner, games use templates");

  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\n${results.length - fails - warns} passed, ${warns} warnings, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("doctor crashed:", e);
  process.exit(1);
});
