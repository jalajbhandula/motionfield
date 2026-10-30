#!/usr/bin/env tsx
/**
 * brain-bench — scores the planner over ~20 briefs against a live dev server.
 *
 *   # dry — the built-in (stub) planner end to end, zero LLM calls: real
 *   # uploads, real POST /api/agent/runs, real 422s — plus coverage checks:
 *   npx tsx scripts/brain-bench.ts --dry
 *
 *   # live — real planner calls (LLM_LIVE=1 required). --planner takes a
 *   # comma list of candidates; --repeat runs the whole set N times each;
 *   # --limit caps the brief list; --stub adds a candidate driven through
 *   # llmPlan by a loopback OpenAI-wire stub (the deterministic table
 *   # answers the request — proves the wire/parse/validate path end to end):
 *   LLM_LIVE=1 npx tsx scripts/brain-bench.ts --planner ollama:qwen3.5:9b
 *   LLM_LIVE=1 npx tsx scripts/brain-bench.ts --planner ollama:qwen3.5:9b,builtin --repeat 2
 *   npx tsx scripts/brain-bench.ts --stub --limit 12
 *
 *   # MOTIONFIELD_PLANNER_THINK=1 flips the Ollama `think` wire flag on the
 *   # planner route — the bench records it per candidate so SMOKE rows say
 *   # exactly what was measured.
 *
 * Briefs that need media get a tiny uploaded fixture attached — the planner
 * sees a real /files/ url, so a "can plan" brief genuinely can. Briefs with
 * expect:"ask" must NOT plan: a parked run there means the planner
 * fabricated media, which scores 0 — the bench grades honesty, not just
 * endpoint coverage.
 *
 * Writes /tmp/of-brain-bench.json. Exits 1 when a scored brief gets 0.
 */
export {}; // module — top-level identifiers must not collide with other scripts

const BASE = arg("base") ?? process.env.BASE_URL ?? "http://localhost:3120";
const PLANNERS = (arg("planner") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const REPEAT = Math.max(1, Number(arg("repeat") ?? 1) || 1);
const LIMIT = Math.max(0, Number(arg("limit") ?? 0) || 0);
const DRY = process.argv.includes("--dry");
const STUB = process.argv.includes("--stub");
const LIVE = process.env.LLM_LIVE === "1";
/** recorded per candidate — the planner route's Ollama `think` flag state */
const THINK = process.env.MOTIONFIELD_PLANNER_THINK === "1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type MediaKind = "image" | "video" | "audio";
type Attachment = { url: string; mime: string; name: string };
type Tool = { endpoint_id: string; offered_to_planner: boolean; available: boolean };
type Brief = {
  /** the check text posted as the user's message */
  text: string;
  /** endpoint_id regexes the plan should produce (all must hit) */
  want: RegExp[];
  /** fixture kinds to upload once and attach to this brief */
  attach?: MediaKind[];
  /** "ask" → an honest question/refusal is required; a created plan = a
   *  fabricated-input failure */
  expect?: "plan" | "ask";
  /** skip the brief entirely when this tool isn't offered to the planner
   *  (web_search hides until the user configures a SearXNG base URL) */
  requiresTool?: string;
  /** the built-in table legitimately asks here — in --dry a 422 passes */
  dryRefuse?: boolean;
  /** this brief only measures the builtin tool table — non-builtin
   *  candidates score -1 (skipped, excluded from the average) */
  builtinOnly?: boolean;
};

/** ~20 briefs spanning the tool surface — media tools, builtins, ambiguity. */
const BRIEFS: Brief[] = [
  { text: "make a short video of a lighthouse at dusk", want: [/text-to-video/] },
  { text: "generate an image of a red fox in snow", want: [/text-to-image|img2img/] },
  { text: "a neon cyberpunk city image", want: [/text-to-image/] },
  { text: "animate this photo into a 4s clip", want: [/image-to-video/], attach: ["image"] },
  { text: "restyle this clip as an oil painting", want: [/restyle/], attach: ["video"] },
  { text: "a 30s product ad for sneakers", want: [/text-to-video|text-to-image|explainer/], dryRefuse: true },
  { text: "turn my podcast clip into a vertical reel", want: [/video|restyle/], attach: ["video"] },
  { text: "make an explainer about how rainbows form", want: [/explainer/] },
  { text: "read this aloud with a warm voice", want: [/text-to-speech|voice/] },
  { text: "swap the character in this clip for my mascot", want: [/character-swap|swap/], attach: ["video", "image"] },
  { text: "a character photo of a knight in silver armor", want: [/character|image/], attach: ["image"] },
  { text: "upscale this image", want: [/upscale/], attach: ["image"] },
  { text: "lip-sync this portrait to my voiceover", want: [/lip-sync|musetalk|portrait/], attach: ["image", "audio"] },
  { text: "fetch https://example.com and summarize it", want: [/web_fetch/] },
  { text: "search the web for comfyui release notes", want: [/web_search/], requiresTool: "agent/web_search" },
  { text: "jot down the idea: a noir trailer for my game", want: [/notes/] },
  { text: "list my saved refs", want: [/refs_list/], builtinOnly: true },
  { text: "search the catalog for image tools", want: [/catalog_search/], builtinOnly: true },
  { text: "make a 3-shot reel: wide, close-up, drone pull-back", want: [/video|image/] },
  { text: "make a video of a dragon, then restyle it neon", want: [/text-to-video/, /restyle|image-to-video/] },
  // honest-ask briefs — no media anywhere; a parked plan here is fabricated
  // media. ("animate this photo" is NOT one: the built-in C6 fallback reads
  // it as a text-to-video brief, which is a visible, honest answer.)
  { text: "upscale this image", want: [], expect: "ask" },
  { text: "lip-sync this portrait to my voiceover", want: [], expect: "ask" },
  { text: "swap the character in this clip for my mascot", want: [], expect: "ask" },
  { text: "something cool", want: [], expect: "ask" },
];

type Result = {
  text: string;
  status: number | null;
  planned: boolean;
  asked: boolean;
  endpoints: string[];
  outside: string[];
  hits: number;
  misses: string[];
  via: string | null;
  fallback: string | null;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  ms: number;
  error: string | null;
  score: number; // 0..1, -1 excluded
};

/* ------------------------- tiny real fixtures ---------------------------- */

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const MP4_FTYP = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
const WAV_HDR = (() => {
  const b = Buffer.alloc(96);
  b.write("RIFF", 0); b.writeUInt32LE(88, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(52, 40);
  return b;
})();
const FIXTURES: Record<MediaKind, { name: string; mime: string; buf: Buffer }> = {
  image: { name: "bench.png", mime: "image/png", buf: PNG_1PX },
  video: { name: "bench.mp4", mime: "video/mp4", buf: MP4_FTYP },
  audio: { name: "bench.wav", mime: "audio/wav", buf: WAV_HDR },
};

/* ------------------------------- http ---------------------------------- */

let COOKIE = "";
async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      ...(COOKIE ? { cookie: COOKIE } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [k] = pair.split("=");
    const jar = new Map(COOKIE ? COOKIE.split("; ").map((p) => p.split("=") as [string, string]) : []);
    jar.set(k, pair.split("=").slice(1).join("="));
    COOKIE = [...jar.entries()].map(([k2, v]) => `${k2}=${v}`).join("; ");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

async function signIn() {
  const email = `bench-${Date.now()}@test.local`;
  const up = await api("/api/auth/sign-up/email", { email, password: "bench-pass-1234", name: "Brain Bench" });
  if (!COOKIE) throw new Error(`sign-up failed: ${up.status} ${JSON.stringify(up.data).slice(0, 200)}`);
}

/** Upload one real file per media kind — a /files/ url the planner can use. */
async function uploadFixtures(): Promise<Record<MediaKind, Attachment>> {
  const out = {} as Record<MediaKind, Attachment>;
  for (const [kind, f] of Object.entries(FIXTURES) as [MediaKind, (typeof FIXTURES)[MediaKind]][]) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(f.buf)], { type: f.mime }), f.name);
    const res = await fetch(`${BASE}/api/uploads`, {
      method: "POST", headers: { cookie: COOKIE }, body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    const d = await res.json().catch(() => ({})) as { url?: string };
    if (res.status !== 201 || !d.url) throw new Error(`upload ${kind}: ${res.status} ${JSON.stringify(d).slice(0, 200)}`);
    out[kind] = { url: d.url, mime: f.mime, name: f.name };
  }
  return out;
}

/* ------------------------------ scoring -------------------------------- */

async function runBrief(
  b: Brief, planner: string, media: Record<MediaKind, Attachment>,
  /** the builtin intent table produced this answer (DRY, builtin pick, or
   *  the wire stub); a resolved `via:"built-in planner"` counts the same */
  builtinTable: boolean,
): Promise<Result> {
  const t0 = Date.now();
  const r: Result = {
    text: b.text, status: null, planned: false, asked: false, endpoints: [], outside: [],
    hits: 0, misses: b.want.map(String), via: null, fallback: null,
    usage: null, ms: 0, error: null, score: 0,
  };
  const attachments = (b.attach ?? []).map((k) => media[k]);
  const res = await api("/api/agent/runs", {
    text: b.text, ask_first: true,
    ...(attachments.length ? { attachments } : {}),
    ...(planner ? { planner } : {}),
  });
  r.ms = Date.now() - t0;
  r.status = res.status;
  const run = res.data.run as { steps?: { endpoint_id: string }[] } | undefined;
  const planner_ = res.data.planner as { via?: string | null; fallback_reason?: string; usage?: Result["usage"] } | undefined;
  r.via = planner_?.via ?? null;
  r.fallback = planner_?.fallback_reason ?? null;
  r.usage = planner_?.usage ?? null;

  if (b.expect === "ask") {
    // the honest answer is a question/422 — a parked run here means the
    // planner invented the media it needed
    r.asked = res.status === 422;
    r.error = r.asked ? String(res.data.error ?? "").slice(0, 120) : null;
    r.score = r.asked ? 1 : 0;
    if (res.status === 201) {
      r.endpoints = (run?.steps ?? []).map((s) => s.endpoint_id);
      r.outside = r.endpoints; // fabricated-step list, for the report
    }
    return r;
  }

  if (res.status === 201 && run) {
    r.planned = true;
    r.endpoints = (run.steps ?? []).map((s) => s.endpoint_id);
    r.hits = b.want.filter((re) => r.endpoints.some((e) => re.test(e))).length;
    r.misses = b.want.filter((re) => !r.endpoints.some((e) => re.test(e))).map(String);
  } else {
    r.asked = res.status === 422;
    r.error = String(res.data.error ?? res.status).slice(0, 120);
  }
  // endpoints must all sit inside the live allowlist AND every want must hit
  // dryRefuse briefs pass on a 422 only when the builtin intent table made
  // the call — a real planner that can't plan the brief fails honestly
  const builtinDriven = builtinTable || r.via === "built-in planner";
  const wantScore = r.planned ? (b.want.length ? r.hits / b.want.length : 1) : (builtinDriven && b.dryRefuse && r.asked ? 1 : 0);
  const leakPenalty = r.outside.length ? 0.5 : 0;
  r.score = Math.max(0, wantScore - leakPenalty);
  return r;
}

const pct = (xs: number[], p: number) =>
  xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : 0;

/* ---------------------------- wire stub (--stub) ------------------------- */

const STUB_ROUTE = "lmstudio:bench-stub"; // provider:model the candidate picks

/** A loopback OpenAI-wire stub: every POST /chat/completions answers with
 *  the deterministic table's plan (or ask) serialized as JSON — it exists to
 *  drive the real llmPlan request/parse/validate path end to end without a
 *  model. The brief and its attachments arrive inside llmPlan's own user
 *  message (the "Available media" block) — the stub plans on exactly what a
 *  model would see, never on data the turn didn't carry. */
async function startStub(tools: Tool[]): Promise<{ base: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ALL_MODELS } = await import("../src/lib/catalog/video-models");
  const { deterministicPlan } = await import("../src/lib/runs/planner");
  const offered = new Set(tools.filter((t) => t.offered_to_planner).map((t) => t.endpoint_id));
  const eps = ALL_MODELS.flatMap((m) =>
    m.workflows
      .filter((w) => offered.has(w.endpointId)
        && (!!w.providers.recipe?.name
          || (w.providers.comfy?.workflow != null && existsSync(join("workflows", w.providers.comfy.workflow)))))
      .map((w) => ({ model: m, workflow: w })));

  const srv = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").includes("chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let brief = "";
      let atts: { url: string }[] = [];
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: { role?: string; content?: unknown }[];
        };
        // the FIRST user message is the turn's brief + media block — later
        // "user" messages are catalog_search/correction follow-ups
        const user = (body.messages ?? []).find((m) => m.role === "user");
        const content = typeof user?.content === "string" ? user.content : "";
        const [text, mediaBlock] = content.split("\n\nAvailable media:\n");
        brief = text;
        atts = (mediaBlock ?? "").split("\n")
          .map((l) => /^- (?:attached|previous result) (?:image|video|audio): (\S+)/.exec(l)?.[1])
          .filter((u): u is string => !!u)
          .map((url) => ({ url }));
      } catch { /* a malformed body just plans an empty brief */ }
      const turn = deterministicPlan(brief, atts, {}, eps, "auto", []);
      const payload = turn.kind === "plan" ? turn.plan
        : {
            ask_user: {
              question: turn.kind === "ask" ? turn.question : "what should I make?",
              options: ((turn.kind === "ask" || turn.kind === "none" ? turn.options : undefined) ?? ["describe the subject"]).slice(0, 4),
            },
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
      }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

/* -------------------------------- main ---------------------------------- */

async function main() {
  const health = await fetch(`${BASE}/api/catalog`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!health?.ok) throw new Error(`server at ${BASE} unreachable — start npm run dev first`);

  const toolsRes = await api("/api/agent/tools");
  if (toolsRes.status === 401) { await signIn(); }
  const tools = ((await api("/api/agent/tools")).data.tools ?? []) as Tool[];
  const allowed = new Set(tools.map((t) => t.endpoint_id));
  const plannable = new Set(tools.filter((t) => t.offered_to_planner).map((t) => t.endpoint_id));

  // real fixtures — media briefs attach these so the planner can honestly plan
  const media = await uploadFixtures();

  const briefs = LIMIT ? BRIEFS.slice(0, LIMIT) : BRIEFS;

  // coverage — a want regex naming no offered tool is a bench bug, not a
  // model failure; report it and score the brief 0 in every mode
  const missingWants = briefs.filter((b) => !(b.requiresTool && !allowed.has(b.requiresTool)))
    .flatMap((b) => b.want
      .filter((re) => !tools.some((t) => t.offered_to_planner && re.test(t.endpoint_id)))
      .map((re) => `${b.text.slice(0, 40)}… wants ${re}`));

  const candidates: { planner: string; repeat: number; builtin?: boolean; stub?: boolean }[] = DRY
    ? [{ planner: "builtin", repeat: 1, builtin: true }]
    : [
        ...(PLANNERS.length ? PLANNERS : [""]).flatMap((p) =>
          Array.from({ length: REPEAT }, (_, i) => ({ planner: p, repeat: i + 1, builtin: p === "builtin" }))),
        ...(STUB ? [{ planner: STUB_ROUTE, repeat: 1, stub: true }] : []),
      ];

  console.log(`brain-bench — ${DRY ? "DRY (built-in stub)" : LIVE ? "LIVE" : "stub-check"} — ${briefs.length} briefs × ${candidates.length} candidate-runs vs ${plannable.size} planner tools @ ${BASE}${THINK ? " · think=on" : ""}`);
  if (missingWants.length) console.log(`coverage gaps:\n  ${missingWants.join("\n  ")}`);

  const candidateReports = [];
  for (const c of candidates) {
    let stopStub: (() => Promise<void>) | null = null;
    let pick = c.planner;
    if (c.stub) {
      // loopback OpenAI-wire stub → the bench user's planner route points at
      // it for this candidate only; the planner pick resolves the saved route
      const stub = await startStub(tools);
      const prov = await api("/api/llm/providers/lmstudio", { baseUrl: `${stub.base}/v1` }, "PUT");
      const route = await api("/api/llm/routes/planner", { providerId: "lmstudio", model: "bench-stub" }, "PUT");
      if (prov.status >= 400 || route.status >= 400) {
        await stub.close();
        throw new Error(`stub route setup failed: provider ${prov.status} / route ${route.status}`);
      }
      stopStub = stub.close;
    }
    const results: Result[] = [];
    let sawModelVia = false;
    for (const b of briefs) {
      const r: Result = {
        text: b.text, status: null, planned: false, asked: false, endpoints: [], outside: [],
        hits: 0, misses: b.want.map(String), via: null, fallback: null,
        usage: null, ms: 0, error: null, score: 0,
      };
      if (b.requiresTool && !allowed.has(b.requiresTool)) {
        r.error = `${b.requiresTool} not offered (unconfigured)`;
        r.score = -1;
        results.push(r);
        continue;
      }
      if (b.builtinOnly && !c.builtin) {
        r.error = "builtin-table brief — skipped for this candidate";
        r.score = -1;
        results.push(r);
        continue;
      }
      // an unpinned pick resolves server-side — builtin when the user has no
      // planner configured, a model otherwise. 422s carry no `via`, so the
      // dryRefuse rule leans on what this candidate has already reported
      const res = await runBrief(b, pick, media,
        c.builtin === true || c.stub === true || (c.planner === "" && !sawModelVia));
      if (res.via && res.via !== "built-in planner") sawModelVia = true;
      results.push(res);
      // outside-allowlist endpoints are a planner leak regardless of the mode
      const last = results[results.length - 1];
      last.outside = [...last.outside, ...last.endpoints.filter((e) => !allowed.has(e))];
      if (last.outside.length) last.score = Math.max(0, last.score - 0.5);
    }
    if (stopStub) await stopStub();
    const scored = results.filter((r) => r.score >= 0);
    const ms = scored.map((r) => r.ms);
    const viaKinds = new Map<string, number>();
    let fallbacks = 0, inTok = 0, outTok = 0;
    for (const r of results) {
      if (r.via) viaKinds.set(r.via, (viaKinds.get(r.via) ?? 0) + 1);
      if (r.fallback) fallbacks += 1;
      inTok += r.usage?.inputTokens ?? 0;
      outTok += r.usage?.outputTokens ?? 0;
    }
    candidateReports.push({
      planner: c.stub ? `stub(${c.planner})` : c.planner || "default",
      repeat: c.repeat,
      think: THINK,
      briefs: results.length,
      planned: results.filter((r) => r.planned).length,
      asked: results.filter((r) => r.asked).length,
      avg_score: Number((scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0).toFixed(3)),
      latency_ms: { mean: Math.round(ms.reduce((a, x) => a + x, 0) / Math.max(1, ms.length)), p50: pct(ms, 50), p95: pct(ms, 95) },
      fallbacks,
      outside_endpoints: results.flatMap((r) => r.outside),
      via: Object.fromEntries(viaKinds),
      usage: { inputTokens: inTok, outputTokens: outTok },
      results,
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: DRY ? "dry" : "live",
    base: BASE,
    tools: tools.length, plannable: plannable.size,
    missing_wants: missingWants,
    candidates: candidateReports,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/of-brain-bench.json", JSON.stringify(report, null, 2));

  for (const c of candidateReports) {
    console.log(`\n— candidate ${c.planner}${REPEAT > 1 ? ` #${c.repeat}` : ""} —`);
    for (const r of c.results) {
      console.log(
        `${r.score < 0 ? "-" : r.score >= 1 ? "✓" : r.score > 0 ? "~" : "✗"} ${r.text.slice(0, 44).padEnd(44)} | ${r.status ?? "-"} | ${r.via ?? "-"} | ${r.ms}ms | ${r.endpoints.join(",") || (r.error ?? "-")} | ${r.score < 0 ? "skip" : r.score.toFixed(2)}${r.fallback ? `  [fallback: ${r.fallback.slice(0, 60)}]` : ""}`,
      );
    }
    console.log(`planned ${c.planned}/${c.briefs} · asked ${c.asked} · avg ${c.avg_score} · p50 ${c.latency_ms.p50}ms p95 ${c.latency_ms.p95}ms · fallbacks ${c.fallbacks} · tokens ${c.usage.inputTokens}+${c.usage.outputTokens} · think=${c.think ? "on" : "off"} · via ${Object.entries(c.via).map(([k, v]) => `${k}×${v}`).join(", ") || "-"}`);
  }
  console.log("wrote /tmp/of-brain-bench.json");
  const failed = candidateReports.some((c) => c.results.some((r) => r.score === 0)) || missingWants.length > 0;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
