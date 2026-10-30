/**
 * WS5 motion API smoke - hits the live dev server:
 *
 *   npx tsx tests/smoke/ws5-motion.smoke.ts [--base http://localhost:3150]
 *
 * Signs up/in a throwaway user (same cookie-jar pattern as
 * scripts/assistant-smoke.ts), then checks:
 *   - POST /api/render/motion with a template → 201 + valid spec (no LLM needed)
 *   - POST /api/render/motion without a template → 201 if LLM_* set, else 503 NEEDS_LLM
 *   - POST /api/render/specs >256KB → 413
 *   - GET  /api/render/specs lists the row
 *   - POST /api/render/motion/:id/render → 503 while the catalog entry is unregistered
 *   - POST /api/render/motion/:id/refine → 503 NEEDS_LLM w/o LLM
 */

const BASE = arg("base") || `http://localhost:${process.env.PORT || "3150"}`;
const EMAIL = `ws5-motion-${Date.now()}@test.local`;
const PASSWORD = "smoke-pass-1234";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let COOKIE = "";
async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      ...(COOKIE ? { cookie: COOKIE } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [k] = pair.split("=");
    const jar = new Map(COOKIE ? COOKIE.split("; ").map((p) => p.split("=") as [string, string]) : []);
    jar.set(k, pair.split("=").slice(1).join("="));
    COOKIE = [...jar.entries()].map(([k2, v]) => `${k2}=${v}`).join("; ");
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const up = await api("/api/auth/sign-up/email", { body: { email: EMAIL, password: PASSWORD, name: "WS5 Motion Smoke" } });
  if (!COOKIE) {
    const si = await api("/api/auth/sign-in/email", { body: { email: EMAIL, password: PASSWORD } });
    if (!COOKIE) throw new Error(`auth failed up=${up.status} si=${si.status}`);
  }
  console.log("authed");

  // 1. template path - deterministic, no LLM
  const gen = await api("/api/render/motion", {
    body: { prompt: "smoke test card", template_id: "presentation", aspect: "16:9", resolution: "720p", fps: 24, duration: 3 },
  });
  check("POST /api/render/motion (template) → 201", gen.status === 201, JSON.stringify(gen.data).slice(0, 160));
  const id = gen.data.id as string | undefined;
  const spec = gen.data.spec as { width?: number } | undefined;
  check("…returns stored id + spec", Boolean(id) && spec?.width === 1280);

  // 2. raw generate - NEEDS_LLM unless LLM_* configured on the server
  const raw = await api("/api/render/motion", { body: { prompt: "minimal bouncing title" } });
  const llmUp = raw.status === 201;
  const needsLlm = raw.status === 503 && raw.data.code === "NEEDS_LLM";
  check("POST /api/render/motion (no template) → 201 or NEEDS_LLM", llmUp || needsLlm, `status=${raw.status}`);

  // 3. oversize spec post
  const big = await api("/api/render/specs", { body: { spec: { version: 1, width: 10, pad: "x".repeat(300_000) } } });
  check("POST /api/render/specs >256KB → 413", big.status === 413, `status=${big.status}`);

  // 4. list
  const list = await api("/api/render/specs");
  const rows = list.data.specs as { id: string }[] | undefined;
  check("GET /api/render/specs lists the new row", Array.isArray(rows) && !!id && rows.some((r) => r.id === id));

  // 5. non-uuid id → 404 not a DB error
  const bad = await api("/api/render/specs/not-a-uuid");
  check("GET /api/render/specs/not-a-uuid → 404", bad.status === 404, `status=${bad.status}`);

  // 6. render gate - 503 until the catalog entry is wired
  if (id) {
    const ren = await api(`/api/render/motion/${id}/render`, { body: {} });
    check("POST …/render → 503 (catalog not wired)", ren.status === 503, `status=${ren.status} ${JSON.stringify(ren.data).slice(0, 120)}`);

    const ref = await api(`/api/render/motion/${id}/refine`, { body: { instruction: "make it bigger" } });
    check(
      "POST …/refine → 503 NEEDS_LLM or 201",
      ref.status === 201 || (ref.status === 503 && ref.data.code === "NEEDS_LLM"),
      `status=${ref.status}`,
    );
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nall green");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

export {};
