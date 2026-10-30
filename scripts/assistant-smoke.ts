/**
 * Assistant end-to-end smoke — drives the REAL HTTP protocol the browser
 * uses (auth → POST session → POST messages → durable agent_run → poll
 * GET messages?after= + run views) against a dev server running with the
 * local LLM + local ComfyUI:
 *
 *   LLM_PROVIDER=ollama LLM_MODEL=qwen3.5:9b npm run dev
 *   npx tsx scripts/assistant-smoke.ts [--base http://localhost:3000] [--only a|b|c|d] [--timeout 900]
 *
 * Each brief goes through the session planner turn (llmPlan when a route is
 * configured, deterministic otherwise) → one durable run. Awaiting runs are
 * approved explicitly; the poll watches the run + step statuses until every
 * run is terminal, prints the task tree, and asserts every produced output
 * URL is /files/ or /api/assets/ — nothing else is a real output.
 *
 * Exits non-zero if any brief fails.
 */

const BASE = arg("base") ?? process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = "smoke-assistant@motionfield.local";
const PASSWORD = "assistant-smoke-123";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let COOKIE = "";
async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      ...(COOKIE ? { cookie: COOKIE } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // the planner turn runs inside POST /messages — can take minutes on a local model
    signal: AbortSignal.timeout(600_000),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const [k] = pair.split("=");
    const jar = new Map(COOKIE ? COOKIE.split("; ").map((p) => p.split("=") as [string, string]) : []);
    jar.set(k, pair.split("=").slice(1).join("="));
    COOKIE = [...jar.entries()].map(([k2, v]) => `${k2}=${v}`).join("; ");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function signIn() {
  const up = await api("/api/auth/sign-up/email", { body: { email: EMAIL, password: PASSWORD, name: "Assistant Smoke" } });
  if (up.status < 400 && COOKIE) { console.log("signed up fresh smoke user"); return; }
  const sign = await api("/api/auth/sign-in/email", { body: { email: EMAIL, password: PASSWORD } });
  if (!COOKIE) throw new Error(`auth failed: signup=${up.status} ${JSON.stringify(up.data).slice(0, 160)} signin=${sign.status} ${JSON.stringify(sign.data).slice(0, 160)}`);
  console.log("signed in existing smoke user");
}

type MsgRow = { seq: number; role: string; kind: string; content: Record<string, unknown> };
type StepRow = {
  step_id: string; title: string; endpoint_id: string; status: string;
  depends_on?: string[]; job_id?: string | null; error?: string | null;
  outputs?: { url?: string; type?: string }[];
  cost?: number | null; eta_seconds?: number | null; model_label?: string | null;
  /** custom-mode provenance: the user's pick (null = planner's) + effort */
  model_choice?: string | null; effort?: string | null;
};
type RunRow = {
  id: string; status: string; title?: string | null; mode?: string;
  via?: string | null; planner_note?: string | null;
  estimate_credits?: number; eta_seconds?: number | null; steps?: StepRow[];
};

/** terminal run statuses — kept in step with the engine's TERMINAL_RUN set
 *  ("stopped" replaced the old "canceled" run status in step 5) */
const TERMINAL = new Set(["done", "failed", "stopped"]);
/** only these prefixes are real step outputs — anything else is a violation */
const OUTPUT_URL_OK = /^\/(files|api\/assets)\//;

type Turn = {
  text: string;
  attachments?: { url: string; mime?: string; name?: string }[];
  /** auto | offline | custom — defaults to auto; custom turns still park at
   *  awaiting_approval (the mode's own gate), the settle loop approves */
  mode?: "auto" | "offline" | "custom";
};
type Brief = {
  name: string;
  /** sequential user messages; each turn waits for its runs to settle */
  turns: Turn[];
  /** endpoint_id regexes that must appear among the run's planned steps */
  expect: RegExp[];
  timeoutMs: number;
};
const BRIEFS: Brief[] = [
  {
    name: "A · text-to-video (single request)",
    turns: [{ text: "make a short cinematic video of a lighthouse at dusk" }],
    expect: [/text-to-video/],
    timeoutMs: 900_000,
  },
  {
    name: "B · video → restyle (single-request chain)",
    turns: [{ text: "make a short video of a lighthouse at dusk, then restyle it with a cartoon shader" }],
    expect: [/text-to-video/, /restyle/],
    timeoutMs: 1500_000,
  },
  {
    name: "C · image → animate (attached image)",
    turns: [{
      text: "animate this image into a short cinematic video",
      attachments: [{ url: "/files/generated/5cf20964-2a1c-4c94-8970-227a0c9c1231.png", mime: "image/png", name: "lighthouse.png" }],
    }],
    expect: [/image-to-video|vfx-keyframe/],
    timeoutMs: 900_000,
  },
  {
    name: "D · explainer recipe (multi-stage pipeline)",
    turns: [{ text: "make an explainer about how rainbows form" }],
    expect: [/explainer\/video/],
    timeoutMs: 2400_000,
  },
];

const STEP_ICON: Record<string, string> = {
  done: "✓", running: "…", failed: "✕", canceled: "–", skipped: "–",
  paused: "⏸", queued: "◌", pending: "○",
};

function printTree(run: RunRow, indent = "  ") {
  const meta = `${run.mode ?? "auto"}${run.via ? ` · via ${run.via}` : ""}${run.planner_note ? ` · ${run.planner_note}` : ""}`;
  console.log(`${indent}[run ${run.id.slice(0, 8)}] ${run.status} — ${run.title ?? ""} [${meta}] (${(run.estimate_credits ?? 0).toFixed(2)} cr${run.eta_seconds != null ? `, ~${run.eta_seconds}s` : ", ETA unknown"})`);
  for (const s of run.steps ?? []) {
    const deps = (s.depends_on ?? []).length ? `  ⟵ ${(s.depends_on ?? []).join(",")}` : "";
    const out = (s.outputs ?? []).find((o) => o?.url)?.url;
    const pick = s.model_choice ? ` [model ${s.model_choice}${s.effort ? ` · ${s.effort}` : ""}]` : (s.effort ? ` [${s.effort}]` : "");
    console.log(`${indent}  ${STEP_ICON[s.status] ?? "?"} ${s.step_id} ${s.title}${deps}${pick}${s.error ? ` — ${s.error}` : ""}${out ? ` → ${out}` : ""}`);
  }
}

async function runBrief(b: Brief) {
  const t0 = Date.now();
  const created = await api("/api/agent/sessions", { body: { mode: "auto" } });
  const sessionId = (created.data.session as { id: string } | undefined)?.id;
  if (!sessionId) throw new Error(`session create failed: ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  console.log(`\n=== ${b.name} ===`);
  console.log(`session ${sessionId.slice(0, 8)}`);

  let lastSeq = 0;
  let llmError: string | null = null;
  const runsSeen = new Map<string, RunRow>();
  const approved = new Set<string>();
  const lastTree = new Map<string, string>();

  const drain = (msgs: MsgRow[]) => {
    for (const m of msgs) {
      lastSeq = Math.max(lastSeq, m.seq);
      const c = m.content;
      if (m.role === "user") continue;
      if (m.kind === "status" && String(c.text ?? "").includes("llm_error")) {
        llmError = String(c.text);
        console.log(`  [status] ${c.text}`);
      } else if (m.kind !== "plan") {
        console.log(`  [${m.kind}] ${c.text ?? c.question ?? c.error ?? ""}`);
      }
    }
  };

  /** poll until this turn settles: every run terminal, or timeout */
  const settle = async (deadline: number) => {
    let idle = 0;
    for (;;) {
      const r = await api(`/api/agent/sessions/${sessionId}/messages?after=${lastSeq}`);
      if (r.status !== 200) { console.log(`  poll failed: ${r.status}`); return false; }
      const d = r.data as { session?: { status?: string }; messages?: MsgRow[]; runs?: RunRow[] };
      drain(d.messages ?? []);
      for (const run of d.runs ?? []) {
        runsSeen.set(run.id, run);
        if (run.status === "awaiting_approval" && !approved.has(run.id)) {
          approved.add(run.id);
          const a = await api(`/api/agent/runs/${run.id}/approve`, { method: "POST" });
          console.log(`  [approve] ${run.id.slice(0, 8)} → ${a.status}`);
        }
        const tree = `${run.status}|${(run.steps ?? []).map((s) => `${s.step_id}:${s.status}`).join(",")}`;
        if (lastTree.get(run.id) !== tree) {
          lastTree.set(run.id, tree);
          printTree(run);
        }
      }
      const live = [...runsSeen.values()].filter((x) => !TERMINAL.has(x.status));
      const busy = live.length > 0
        || (d.runs ?? []).some((x) => x.steps?.some((s) => s.status === "running"));
      if (busy) {
        idle = 0;
        process.stdout.write(`\r  ⏳ ${live.map((x) => `${x.id.slice(0, 8)} ${x.status}`).join(" · ")}      `);
      } else {
        idle++;
        if (idle >= 2) { process.stdout.write("\r"); return true; }
      }
      if (Date.now() > deadline) { console.log("\n  ✗ TIMEOUT"); return false; }
      await new Promise((r2) => setTimeout(r2, 2500));
    }
  };

  for (const [i, turn] of b.turns.entries()) {
    console.log(`\n  turn ${i + 1}: "${turn.text}"`);
    const tPlan = Date.now();
    const posted = await api(`/api/agent/sessions/${sessionId}/messages`, {
      body: { text: turn.text, mode: turn.mode ?? "auto", ask_first: true, attachments: turn.attachments },
    });
    console.log(`  planner turn: ${((Date.now() - tPlan) / 1000).toFixed(0)}s (POST ${posted.status})`);
    if (posted.status !== 201) {
      console.log(`  ✗ post failed: ${JSON.stringify(posted.data).slice(0, 200)}`);
      return { ok: false, wall: Date.now() - t0, runs: [], llmError };
    }
    if (!(await settle(t0 + b.timeoutMs))) return { ok: false, wall: Date.now() - t0, runs: [...runsSeen.values()], llmError };
  }

  const runs = [...runsSeen.values()];
  const allSteps = runs.flatMap((r) => r.steps ?? []);
  const missed = b.expect.filter((re) => !allSteps.some((s) => re.test(s.endpoint_id)));
  const badUrls = allSteps.flatMap((s) => (s.outputs ?? [])
    .filter((o) => o?.url && !OUTPUT_URL_OK.test(o.url)).map((o) => o.url));
  const produced = allSteps.filter((s) => s.status === "done" && (s.outputs ?? []).some((o) => o?.url));
  const failedRuns = runs.filter((r) => r.status === "failed" || r.status === "stopped");
  const ok = runs.length > 0 && !missed.length && produced.length > 0
    && badUrls.length === 0 && failedRuns.length === 0;
  for (const r of runs) printTree(r);
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} — ${((Date.now() - t0) / 1000).toFixed(0)}s wall, ${runs.length} run(s), endpoints: ${allSteps.map((s) => s.endpoint_id).join(", ") || "none"}`);
  if (missed.length) console.log(`    expected endpoints not planned: ${missed.map(String).join(", ")}`);
  if (badUrls.length) console.log(`    bad output URLs (must be /files/ or /api/assets/): ${badUrls.join(", ")}`);
  return { ok, wall: Date.now() - t0, runs, llmError };
}

async function main() {
  const only = arg("only")?.toLowerCase();
  const timeoutSecs = Number(arg("timeout") ?? 0);
  const briefs = BRIEFS.filter((b) => !only || b.name.toLowerCase().startsWith(only));
  if (timeoutSecs) for (const b of briefs) b.timeoutMs = timeoutSecs * 1000;

  const health = await fetch(`${BASE}/api/catalog`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!health?.ok) throw new Error(`server at ${BASE} not reachable — start npm run dev with LLM_* env first`);
  await signIn();

  const results = [];
  for (const b of briefs) results.push({ name: b.name, ...(await runBrief(b)) });

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    const eps = (r.runs ?? []).flatMap((x: RunRow) => (x.steps ?? []).map((s) => s.endpoint_id));
    console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${(r.wall / 1000).toFixed(0)}s — ${eps.join(", ")}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
