import { expect, test, request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, statSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../../src/lib/catalog/skills";
import { advertisedSet } from "./helpers/advertised-tools";

/** The prompt metadata, loaded through the same node type-stripping the
 *  server runs - tests must not import .mts sources (root tsconfig). */
const promptDefs = (): { name: string; tools: string[]; requires: string[] }[] =>
  JSON.parse(execFileSync("node", ["--experimental-strip-types", "-e",
    `import("./packages/mcp/src/prompts.mts").then(m => console.log(JSON.stringify(m.PROMPTS.map(p => ({ name: p.name, tools: p.tools, requires: p.requires })))))`],
    { encoding: "utf8", timeout: 30_000 })) as { name: string; tools: string[]; requires: string[] }[];

/**
 * motionfield-mcp end-to-end: a real API key → install-cli.sh into a temp
 * PREFIX → the installed `motionfield-mcp` bin over stdio (MCP SDK client) →
 * tools/list, tools/call and prompts/list against the live v1 API → jobs
 * generated and downloaded through the mock provider. The CLI half uses the
 * installed `motionfield` bin. stdout carries JSON-RPC only; the key never
 * appears in a tool result, on stdout or on stderr.
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(300_000); });

/** The tools this server advertises under the default toolsets (core,3d) -
 *  computed in beforeAll from the live capabilities + model catalog, so the
 *  count moves with the surface instead of hard-coding it. */
let LISTED_TOOLS: string[] = [];

/** The 13 prompts whose `requires` a `runs`/`threed`-less server satisfies -
 *  `make-3d-character` joins exactly when the API reports `threed`; skill-run
 *  needs skills.read + runs. */
const PROMPT_NAMES = [
  "ad-pack", "direct-shot", "explainer", "launch-motion", "make-game",
  "podcast-cut", "re-edit-edit", "reshoot-angle", "skill-run", "stage-scene",
  "swap-performer", "ugc-ad", "vfx-plate",
].sort();

const IMAGE_EP = "motionfield/z-image-turbo/text-to-image";

let apiKey = "";
let base = "";
let prefix = "";
let cliEnv: NodeJS.ProcessEnv = process.env;

/* ---------------- installed-bin MCP client ---------------- */

const spawnMcp = async (extra: Record<string, string> = {}) => {
  const outDir = mkdtempSync(join(tmpdir(), "of-mcp-e2e-out-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MOTIONFIELD_URL = base;
  env.MOTIONFIELD_API_KEY = apiKey;
  env.MOTIONFIELD_MCP_OUT_DIR = outDir;
  Object.assign(env, extra);
  const transport = new StdioClientTransport({
    command: join(prefix, "bin", "motionfield-mcp"),
    env,
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
  const client = new Client({ name: "ws1-e2e", version: "0" });
  await client.connect(transport);
  return {
    client,
    outDir,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    async close() { await client.close().catch(() => {}); },
  };
};

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

/** tools/call → the parsed JSON payload. Asserts the key is absent from
 *  every result - no `of_` material may ride a tool response back. */
const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}, timeout = 120_000): Promise<ToolResult> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const content = res.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* text payloads stay raw */ }
  expect(text).not.toContain(apiKey);
  return { isError: res.isError === true, data, text };
};

const cli = (args: string[]) =>
  execFileSync(join(prefix, "bin", "motionfield"), args, { env: cliEnv, encoding: "utf8", timeout: 240_000 });

/* ---------------- one-time API key + install ---------------- */

test.beforeAll(async ({ browser }) => {
  base = `http://localhost:${process.env.PORT || "3100"}`;
  const page = await browser.newPage({ baseURL: base });
  try {
    const email = `mcp-${Date.now()}@e2e.test`;
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("MCP E2E");
    await page.getByPlaceholder("you@email.com").fill(email);
    await page.getByPlaceholder(/Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
    // pro plan → 4 parallel image slots; the free tier's single live job
    // would make the generate_batch assertions timing-racy
    const sub = await page.request.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
    expect(sub.ok()).toBeTruthy();
    // the key comes from POST /api/keys - never rendered into the DOM
    const kr = await page.request.post("/api/keys", { data: { label: "mcp-e2e" } });
    expect(kr.status()).toBe(201);
    apiKey = ((await kr.json()) as { key: string }).key;
    (globalThis as Record<string, unknown>).__mcpEmail = email;
  } finally {
    await page.close();
  }
  expect(apiKey).toMatch(/^of_/);

  /* the advertised set is computed from the registry × this server's reported
   * capabilities × the model catalog - never a hard-coded count */
  {
    const ctx = await request.newContext({ baseURL: base });
    try {
      const auth = { authorization: `Bearer ${apiKey}` };
      const caps = ((await (await ctx.get("/api/v1/capabilities", { headers: auth })).json()) as { capabilities: string[] }).capabilities;
      const eps = ((await (await ctx.get("/api/v1/models", { headers: auth })).json()) as { models: { id: string }[] }).models.map((m) => m.id);
      LISTED_TOOLS = advertisedSet(["core", "3d"], caps, eps);
    } finally {
      await ctx.dispose();
    }
  }

  // install the CLI + MCP server into a throwaway prefix - the same path a
  // user runs; the tests spawn the installed bins, never the sources
  prefix = mkdtempSync(join(tmpdir(), "of-mcp-e2e-prefix-"));
  execFileSync("scripts/install-cli.sh", [], {
    env: { ...process.env, PREFIX: prefix }, stdio: "pipe", timeout: 120_000,
  });
  expect(existsSync(join(prefix, "bin", "motionfield-mcp"))).toBe(true);
  expect(existsSync(join(prefix, "bin", "motionfield"))).toBe(true);

  // the CLI gets a scrubbed env: no MOTIONFIELD_* from the test runner itself
  cliEnv = { ...process.env };
  for (const k of Object.keys(cliEnv)) if (k.startsWith("MOTIONFIELD_")) delete cliEnv[k];
  cliEnv.MOTIONFIELD_CONFIG_DIR = mkdtempSync(join(tmpdir(), "of-mcp-e2e-cfg-"));
});

/* ---------------- tool surface ---------------- */

test("tools/list advertises exactly the computed set - run_* + stage list while their gates report", async () => {
  const { client, close } = await spawnMcp();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(LISTED_TOOLS);
  for (const t of tools) expect((t.inputSchema as { type?: string }).type).toBe("object");

  // a non-UUID id dies in the guard - 'guard', never a crash or an API call
  const runGet = await callTool(client, "run_get", { id: "r_1" });
  expect(runGet.isError).toBe(true);
  expect(runGet.data.code).toBe("guard");
  // a real but unknown run id passes the guard and answers the API's own 404
  const missing = await callTool(client, "run_get", { id: crypto.randomUUID() });
  expect(missing.isError).toBe(true);
  expect(missing.data.code).toBe("not_found");
  await close();
});

test("[OF-0723] models_list: no restricted-license endpoint; goal re-ranks deterministically", async () => {
  const { client, close } = await spawnMcp();
  const models = (await callTool(client, "models_list")).data.models as {
    id: string; kind: string; license: { class: string };
  }[];
  expect(models.length).toBeGreaterThan(0);
  for (const m of models) expect(m.license.class).not.toBe("restricted");

  // goal ranking is word overlap, not an LLM - same goal, same order
  const a = (await callTool(client, "models_list", { goal: "image to video" })).data.models as { id: string }[];
  const b = (await callTool(client, "models_list", { goal: "image to video" })).data.models as { id: string }[];
  expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  expect(a[0].id).toContain("image-to-video");

  // model_schema - one endpoint's full record; a bad id is not_found
  const schema = (await callTool(client, "model_schema", { endpoint: IMAGE_EP })).data as {
    id: string; kind: string; inputs: { type: string };
  };
  expect(schema.id).toBe(IMAGE_EP);
  expect(schema.inputs.type).toBe("object");
  const bad = await callTool(client, "model_schema", { endpoint: "motionfield/nope/v1" });
  expect(bad.isError).toBe(true);
  expect(bad.data.code).toBe("not_found");
  await close();
});

test("[OF-0724] presets{list,get,resolve} through the live API", async () => {
  const { client, close } = await spawnMcp();
  const presets = (await callTool(client, "presets", { action: "list" })).data.presets as { id: string; kind: string }[];
  expect(presets.length).toBeGreaterThan(0);

  const one = (await callTool(client, "presets", { action: "get", id: presets[0].id })).data;
  expect(one.id).toBe(presets[0].id);

  const filtered = (await callTool(client, "presets", { action: "list", kind: "style" })).data.presets as { kind: string }[];
  for (const p of filtered) expect(p.kind).toBe("style");

  const resolved = (await callTool(client, "presets", {
    action: "resolve", endpoint: IMAGE_EP, params: { prompt: "dunes" },
  })).data as { endpoint: string; params: Record<string, unknown> };
  expect(resolved.endpoint).toBe(IMAGE_EP);
  expect(resolved.params.prompt).toBe("dunes");
  await close();
});

test("[OF-0773][OF-0774] skills{list,get} - get returns SKILL.md with slug front matter", async () => {
  const { client, close } = await spawnMcp();
  const skills = (await callTool(client, "skills", { action: "list" })).data.skills as { slug: string }[];
  expect(skills.length).toBeGreaterThan(0);

  const detail = (await callTool(client, "skills", { action: "get", slug: skills[0].slug })).data as { skill_md: string };
  expect(detail.skill_md.startsWith(`---\nname: "${skills[0].slug}"`)).toBe(true);

  // run needs a brief now that 'runs' is reported; import stays gated on
  // 'skills.import' - not_available while the API doesn't report it
  const run = await callTool(client, "skills", { action: "run", slug: skills[0].slug });
  expect(run.isError).toBe(true);
  expect(run.data.code).toBe("invalid_params");
  const imp = await callTool(client, "skills", { action: "import", path: "/tmp/nope" });
  expect(imp.isError).toBe(true);
  expect(imp.data.code).toBe("not_available");
  await close();
});

test("[#122] run_* tools drive a real run: create(ask_first) → edit → approve → done → control idempotent", async () => {
  const { client, close } = await spawnMcp();
  try {
    // planner:"builtin" - a bare brief must never let an e2e reach Ollama:
    // in a gate env with LLM_PROVIDER set the default pick would hit the
    // local model outside the GPU lock
    const made = await callTool(client, "run_create", {
      brief: "a photo of a lighthouse", planner: "builtin", ask_first: true,
    });
    expect(made.isError, made.text).toBe(false);
    const id = made.data.id as string;
    expect(made.data.status).toBe("awaiting_approval");
    const steps = made.data.steps as { id: string; status: string; rev: number }[];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status === "pending")).toBe(true);

    // edit s1's params while parked - the tool sends step_id + the rev
    // run_get showed; a stale rev is refused with head_rev, never retried
    const edited = await callTool(client, "run_edit_step", {
      id, step_id: "s1", rev: steps[0].rev, params: { prompt: "a lighthouse over calm seas" },
    });
    expect(edited.isError, edited.text).toBe(false);
    const newRev = ((edited.data.steps as { rev: number }[])[0]).rev;
    expect(newRev).toBeGreaterThan(steps[0].rev);
    const stale = await callTool(client, "run_edit_step", {
      id, step_id: "s1", rev: steps[0].rev, params: { prompt: "x" },
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.code).toBe("stale_revision");
    expect(stale.data.head_rev).toBe(newRev);
    const noStep = await callTool(client, "run_edit_step", {
      id, step_id: "s9", rev: 0, params: { prompt: "x" },
    });
    expect(noStep.isError).toBe(true);
    expect(noStep.data.code).toBe("not_found");

    const approved = await callTool(client, "run_approve", { id });
    expect(approved.isError, approved.text).toBe(false);
    expect(approved.data.status).toBe("running");

    // run_get ticks the run each poll - mock generation walks it to done
    await expect.poll(async () => {
      const v = (await callTool(client, "run_get", { id })).data as { status: string };
      return v.status;
    }, { timeout: 240_000, intervals: [1000, 2000, 3000] }).toMatch(/^(done|failed|stopped)$/);
    const final = (await callTool(client, "run_get", { id })).data as {
      status: string; steps: { status: string; job_id: string | null }[];
    };
    expect(final.status).toBe("done");
    expect(final.steps.every((s) => s.status === "done" && s.job_id)).toBe(true);

    // control is idempotent on a terminal run - cancel(stop) on done is a no-op
    const ctl = await callTool(client, "run_control", { id, action: "cancel" });
    expect(ctl.isError, ctl.text).toBe(false);
    expect((ctl.data as { status: string }).status).toBe("done");
  } finally {
    await close();
  }
});

test("[#122][OF-0759] run_create plan + skills{action:run} with inputs; run_control stop is the real verb", async () => {
  const { client, close } = await spawnMcp();
  try {
    /* literal plan form - {plan} alone, no brief */
    const made = await callTool(client, "run_create", {
      plan: { steps: [
        { id: "s1", title: "frame", endpoint_id: IMAGE_EP, params: { prompt: "mcp plan-run" } },
      ] },
      ask_first: true,
    });
    expect(made.isError, made.text).toBe(false);
    expect(made.data.status).toBe("awaiting_approval");
    expect((made.data.steps as { id: string }[])[0].id).toBe("s1");

    // plan + inputs is refused - inputs only apply to text and skill runs,
    // the same 400 the API answers
    const withInputs = await callTool(client, "run_create", {
      plan: { steps: [{ id: "s1", title: "f", endpoint_id: IMAGE_EP, params: { prompt: "x" } }] },
      inputs: [{ url: "/files/uploads/nope.png" }],
    });
    expect(withInputs.isError).toBe(true);
    expect(withInputs.data.code).toBe("invalid_params");

    // stop is a first-class verb - the parked run ends stopped, idempotently
    const stop = await callTool(client, "run_control", { id: made.data.id, action: "stop" });
    expect(stop.isError, stop.text).toBe(false);
    expect(stop.data.status).toBe("stopped");
    const stop2 = await callTool(client, "run_control", { id: made.data.id, action: "stop" });
    expect(stop2.isError).toBe(false);
    expect(stop2.data.status).toBe("stopped");

    /* a video skill run fed by an upload via inputs */
    const dir = mkdtempSync(join(tmpdir(), "of-mcp-e2e-skill-"));
    const clip = join(dir, "clip.mp4");
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
    const up = await callTool(client, "upload", { path: clip });
    expect(up.isError, up.text).toBe(false);
    const url = String(up.data.url);
    expect(url).toMatch(/^\/files\/uploads\//);

    const run = await callTool(client, "skills", {
      action: "run", slug: "video-reframe", brief: "the launch clip",
      params: { ratio: "9:16" }, inputs: [{ url, mime: "video/mp4" }],
    });
    expect(run.isError, run.text).toBe(false);
    const steps = run.data.steps as { title: string; endpoint: string; status: string }[];
    expect(steps.length).toBe(1);
    expect(steps[0].title).toBe("Reframe");
    expect(steps[0].endpoint).toBe("motionfield/reframe/v1.0");
    expect(String(run.data.planner ? (run.data.planner as { via: string }).via : "")).toBe("skill·video-reframe");

    // video_url reached the step - approve, wait for the job, then read the
    // submitted params back off the v1 job view (the run view hides params
    // on purpose; the job view shows what was actually sent)
    const approved = await callTool(client, "run_approve", { id: run.data.id });
    expect(approved.isError, approved.text).toBe(false);
    let jobId: string | null = null;
    await expect.poll(async () => {
      const v = (await callTool(client, "run_get", { id: run.data.id })).data as {
        steps: { job_id: string | null }[];
      };
      jobId = v.steps[0].job_id;
      return jobId;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).not.toBeNull();
    const apiCtx = await request.newContext({ baseURL: base });
    try {
      const jobRes = await apiCtx.get(`/api/v1/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(jobRes.status()).toBe(200);
      const job = (await jobRes.json()) as { params: { video_url?: string } };
      expect(job.params.video_url).toBe(url);
    } finally {
      await apiCtx.dispose();
    }

    /* [OF-0759] short-maker through skills{run} - the run IS the skill's
     * pipeline: titles and endpoints exactly as skill.steps(brief, answers)
     * lays them out, and `answers` (the API/SDK spelling) works as the
     * intake alias */
    const want = SKILLS.find((s) => s.id === "short-maker")!
      .steps("a lighthouse on a cliff", { platform: "Reels" });
    const sm = await callTool(client, "skills", {
      action: "run", slug: "short-maker", brief: "a lighthouse on a cliff",
      answers: { platform: "Reels" },
    });
    expect(sm.isError, sm.text).toBe(false);
    const smSteps = sm.data.steps as { title: string; endpoint: string }[];
    expect(smSteps.map((s) => s.title)).toEqual(want.map((s) => s.label));
    expect(smSteps.map((s) => s.endpoint)).toEqual(want.map((s) => s.endpoint));
    expect(String(sm.data.planner ? (sm.data.planner as { via: string }).via : ""))
      .toBe("skill·short-maker");

    // run_create's skill form takes the same `answers` alias
    const sm2 = await callTool(client, "run_create", {
      skill: "short-maker", brief: "a lighthouse on a cliff",
      answers: { platform: "Reels" },
    });
    expect(sm2.isError, sm2.text).toBe(false);
    const sm2Steps = sm2.data.steps as { title: string; endpoint: string }[];
    expect(sm2Steps.map((s) => s.title)).toEqual(want.map((s) => s.label));
    expect(sm2Steps.map((s) => s.endpoint)).toEqual(want.map((s) => s.endpoint));
  } finally {
    await close();
  }
});

test("[#122][OF-0757] skills{action:run} ugc-ad - inputs land in step 1's media params (agent view)", async () => {
  /* the step params only show on the app-side run view, which wants a
   * session cookie - sign a second user up through ctx (the cookie lands in
   * ctx's jar) and mint its key there, then point THIS MCP client at that
   * key so the run's owner is exactly the user ctx can read */
  const ctx = await request.newContext({ baseURL: base });
  try {
    const su = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `mcp-ugc-${Date.now()}@e2e.test`, password: "e2e-password-123", name: "MCP UGC" },
    });
    expect(su.ok(), `signup: ${await su.text()}`).toBeTruthy();
    const kr = await ctx.post("/api/keys", { data: { label: "mcp-ugc-e2e" } });
    expect(kr.status()).toBe(201);
    const key2 = ((await kr.json()) as { key: string }).key;
    expect(key2).toMatch(/^of_/);

    const { client, close } = await spawnMcp({ MOTIONFIELD_API_KEY: key2 });
    try {
      /* product + creator uploads through the real upload tool - they ride
       * `inputs` into step 1's media params in declared order */
      const dir = mkdtempSync(join(tmpdir(), "of-mcp-ugc-"));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64");
      const productPath = join(dir, "product.png");
      const creatorPath = join(dir, "creator.png");
      writeFileSync(productPath, png);
      writeFileSync(creatorPath, png);
      const upProduct = await callTool(client, "upload", { path: productPath });
      expect(upProduct.isError, upProduct.text).toBe(false);
      const productUrl = String(upProduct.data.url);
      const upCreator = await callTool(client, "upload", { path: creatorPath });
      expect(upCreator.isError, upCreator.text).toBe(false);
      const creatorUrl = String(upCreator.data.url);

      const brief = "an insulated water bottle";
      const answers = { hook: "Unboxing" };
      const run = await callTool(client, "skills", {
        action: "run", slug: "ugc-ad", brief, answers,
        inputs: [{ url: productUrl, mime: "image/png" }, { url: creatorUrl, mime: "image/png" }],
      });
      expect(run.isError, run.text).toBe(false);

      // the run IS the skill's own pipeline - titles + endpoints exactly as
      // skill.steps(brief, answers) lays them out
      const want = SKILLS.find((s) => s.id === "ugc-ad")!.steps(brief, answers);
      const steps = run.data.steps as { title: string; endpoint: string }[];
      expect(steps.map((s) => s.title)).toEqual(want.map((s) => s.label));
      expect(steps.map((s) => s.endpoint)).toEqual(want.map((s) => s.endpoint));

      const full = await ctx.get(`/api/agent/runs/${run.data.id}`);
      expect(full.status()).toBe(200);
      const fullRun = ((await full.json()) as {
        run: { steps: { params: Record<string, unknown> }[] };
      }).run;
      // product → step 1's product slot, creator → its scene slot; step 2's
      // frame chains off step 1's hero shot - the app's own fill order
      expect(fullRun.steps[0].params.product_image_url).toBe(productUrl);
      expect(fullRun.steps[0].params.image_url).toBe(creatorUrl);
      expect(fullRun.steps[1].params.image_url).toBe("$step:s1.outputs[0]");
    } finally {
      await close();
    }
  } finally {
    await ctx.dispose();
  }
});

test("[OF-0798] system_status - system view + account plan/credits, never the key", async () => {
  const { client, close } = await spawnMcp();
  const data = (await callTool(client, "system_status")).data as {
    system: { tier: string; gpu: { busy: boolean }; queue: { queued: number } };
    account: { plan: string | null; credits: number };
  };
  expect(data.system.tier).toBe("local");
  expect(typeof data.system.gpu.busy).toBe("boolean");
  expect(typeof data.system.queue.queued).toBe("number");
  expect(typeof data.account.credits).toBe("number");
  expect(Object.keys(data.account).sort()).toEqual(["credits", "plan"]);
  await close();
});

/* ---------------- jobs through the live API ---------------- */

test("[OF-0726][OF-0744] generate → job_status → job_wait → job_download lands a real file tagged mcp", async () => {
  const { client, outDir, close } = await spawnMcp();
  const gen = await callTool(client, "generate", {
    endpoint: IMAGE_EP, params: { prompt: "mcp e2e lighthouse" }, wait_s: 50,
  });
  expect(gen.isError, JSON.stringify(gen.data)).toBe(false);
  expect(gen.data.status).toBe("completed");
  expect(gen.data.source).toBe("mcp");
  expect((gen.data.outputs as unknown[]).length).toBeGreaterThan(0);

  const status = (await callTool(client, "job_status", { id: gen.data.id as string })).data as {
    id: string; status: string; source: string; outputs: unknown[];
  };
  expect(status.id).toBe(gen.data.id);
  expect(status.status).toBe("completed");
  expect(status.source).toBe("mcp");

  const dl = (await callTool(client, "job_download", { id: gen.data.id as string, index: 0 })).data as { path: string; bytes: number };
  expect(dl.path.startsWith(realpathSync(outDir))).toBe(true);
  expect(dl.path).toContain(`${gen.data.id}-0.`);
  expect(existsSync(dl.path)).toBe(true);
  expect(statSync(dl.path).size).toBeGreaterThan(0);
  await close();
});

test("[OF-0714][OF-0754] assets_list{source:mcp} contains the generated output", async () => {
  const { client, close } = await spawnMcp();
  const gen = await callTool(client, "generate", {
    endpoint: IMAGE_EP, params: { prompt: "mcp e2e assets" }, wait_s: 50,
  });
  const assets = (await callTool(client, "assets_list", { source: "mcp", limit: 10 })).data.assets as {
    id: string; job_id: string; source: string;
  }[];
  const mine = assets.filter((a) => a.job_id === gen.data.id);
  expect(mine.length).toBeGreaterThan(0);
  expect(mine[0].source).toBe("mcp");
  await close();
});

test("[OF-0727][OF-0729][OF-0732][OF-0745] generate_batch image+video+audio ids + in-place error; job_wait returns 3 statuses", async () => {
  const { client, close } = await spawnMcp();
  // params come straight from each endpoint's model_schema: every property
  // its `required` list names gets a value of the type the schema declares
  const schemaParams = async (endpoint: string, text: string) => {
    const s = (await callTool(client, "model_schema", { endpoint })).data as {
      inputs?: { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> };
    };
    const params: Record<string, unknown> = {};
    for (const name of s.inputs?.required ?? []) {
      const prop = s.inputs?.properties?.[name] ?? {};
      params[name] = prop.enum?.length ? prop.enum[0] : prop.type === "string" ? text : undefined;
      expect(params[name], `${endpoint} required param ${name}`).toBeDefined();
    }
    return params;
  };
  const legs: { endpoint: string; kind: string }[] = [
    { endpoint: IMAGE_EP, kind: "image" },
    { endpoint: "motionfield/wan-2.1/text-to-video", kind: "video" },
    { endpoint: "motionfield/kokoro/text-to-speech", kind: "audio" },
  ];
  const requests = await Promise.all(legs.map(async (l) => ({
    endpoint: l.endpoint, params: await schemaParams(l.endpoint, `mcp e2e batch ${l.kind}`),
  })));
  requests.splice(1, 0, { endpoint: "motionfield/no-such-endpoint", params: {} });

  const batch = (await callTool(client, "generate_batch", { requests })).data.results as {
    endpoint: string; id?: string; status?: string; error?: { code: string };
  }[];
  expect(batch.length).toBe(4);
  // the bad endpoint's error lands in place - the other three still got ids
  expect(batch[1].error?.code).toBe("not_found");
  const ids = batch.filter((r) => r.id).map((r) => r.id as string);
  expect(ids.length).toBe(3);

  // each id's kind matches the endpoint it was submitted on
  for (const [i, leg] of legs.entries()) {
    const mine = await callTool(client, "jobs_list", { ids: [ids[i]], kind: leg.kind });
    expect((mine.data.jobs as { id: string }[]).map((j) => j.id), `${leg.endpoint} kind`).toEqual([ids[i]]);
  }

  // all three legs complete, and each first output's type matches its kind
  // (mock renders a real .png/.mp4/.wav - the view types it image/…, video/…, audio/…)
  const waited = (await callTool(client, "job_wait", { ids, timeout_s: 50 })).data.jobs as {
    id: string; status: string; outputs?: { type?: string }[];
  }[];
  expect(waited.length).toBe(3);
  for (const [i, leg] of legs.entries()) {
    const j = waited[i];
    expect(j.id).toBe(ids[i]);
    expect(j.status, `${leg.endpoint} must complete`).toBe("completed");
    expect(j.outputs?.[0]?.type ?? "", `${leg.endpoint} first output type`).toMatch(new RegExp(`^${leg.kind}/`));
  }
  await close();
});

test("[OF-0747][OF-0748][OF-0799] jobs_list{ids} fetches exactly those jobs in request order", async () => {
  const { client, close } = await spawnMcp();
  const mk = async (prompt: string) => {
    const gen = await callTool(client, "generate", { endpoint: IMAGE_EP, params: { prompt }, wait_s: 50 });
    expect(gen.isError, gen.text).toBe(false);
    return gen.data.id as string;
  };
  const [first, second] = [await mk("order a"), await mk("order b")];

  const listRes = await callTool(client, "jobs_list", { ids: [second, first] });
  expect(listRes.isError, listRes.text).toBe(false);
  const jobs = listRes.data.jobs as { id: string; source: string }[];
  expect(jobs.map((j) => j.id)).toEqual([second, first]);
  expect(jobs[0].source).toBe("mcp");

  // unfiltered: the account's newest-first page contains both jobs
  const all = await callTool(client, "jobs_list");
  expect(all.isError, all.text).toBe(false);
  const allIds = (all.data.jobs as { id: string }[]).map((j) => j.id);
  expect(allIds).toContain(first);
  expect(allIds).toContain(second);
  await close();
});

test("[OF-0751] upload{path} stages a real PNG; generate on img2img consumes it as image_url", async () => {
  const { client, close } = await spawnMcp();
  const dir = mkdtempSync(join(tmpdir(), "of-mcp-e2e-up-"));
  try {
    const png = join(dir, "in.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));

    const up = await callTool(client, "upload", { path: png });
    expect(up.isError, up.text).toBe(false);
    expect(up.data.mime).toBe("image/png");
    expect(String(up.data.url)).toContain("/files/uploads/");
    expect(up.data.bytes).toBe(12);

    const gen = await callTool(client, "generate", {
      endpoint: "motionfield/z-image-turbo/img2img",
      params: { prompt: "mcp e2e img2img from upload", image_url: up.data.url },
      wait_s: 50,
    });
    expect(gen.isError, JSON.stringify(gen.data)).toBe(false);
    expect(gen.data.status).toBe("completed");
    expect((gen.data.outputs as unknown[]).length).toBeGreaterThan(0);
    await close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- prompts ---------------- */

test("[OF-0717] prompts/list - every listed prompt's tools are listed and its requires are reported", async () => {
  const { client, close } = await spawnMcp();
  const [{ tools }, { prompts }] = await Promise.all([client.listTools(), client.listPrompts()]);
  const toolNames = new Set(tools.map((t) => t.name));
  const apiCtx = await request.newContext({ baseURL: base });
  const capsRes = await apiCtx.get("/api/v1/capabilities", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const caps = new Set(((await capsRes.json()) as { capabilities: string[] }).capabilities);
  await apiCtx.dispose();

  const listed = prompts.map((p) => p.name).sort();
  // `make-3d-character` is listed exactly when the API reports `threed`
  const threed = caps.has("threed");
  expect(listed).toEqual([...PROMPT_NAMES, ...(threed ? ["make-3d-character"] : [])].sort());
  expect(listed.includes("make-3d-character")).toBe(threed);
  const defs = promptDefs();
  for (const name of listed) {
    const def = defs.find((p) => p.name === name)!;
    for (const t of def.tools) expect(toolNames, `${name} tool ${t}`).toContain(t);
    for (const c of def.requires) expect(caps, `${name} requires ${c}`).toContain(c);
  }

  // every `models_list kind <k>` a recipe names must return ≥1 endpoint -
  // otherwise step 2 of the recipe dead-ends the agent (kind-drift guard)
  for (const name of listed) {
    const got = await client.getPrompt({ name, arguments: {} });
    const text = got.messages[0].content.type === "text" ? got.messages[0].content.text : "";
    for (const k of new Set([...text.matchAll(/models_list kind ([a-z0-9_-]+)/g)].map((m) => m[1]))) {
      const res = await callTool(client, "models_list", { kind: k });
      expect(
        (res.data.models as unknown[]).length,
        `${name} names models_list kind ${k} but it returns no endpoints`,
      ).toBeGreaterThan(0);
    }
  }

  // a get returns the template text naming its tools
  const got = await client.getPrompt({ name: "re-edit-edit", arguments: { clip: "/tmp/x.mp4" } });
  const text = got.messages[0].content.type === "text" ? got.messages[0].content.text : "";
  expect(text).toContain("upload");
  expect(text).toContain("/tmp/x.mp4");
  await close();
});

/* ---------------- gating + hygiene ---------------- */

test("a disabled toolset un-lists its tools; calls answer not_available", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "studio" });
  const { tools } = await client.listTools();
  /* studio-only lists exactly the studio tools this deployment serves -
   * COMPUTED from /api/v1/capabilities + /api/v1/models: a tool lists when
   * it isn't pending AND (capability reported OR an endpoint listed). The
   * eight pending wrappers never list, whatever the server reports. */
  const apiCtx = await request.newContext({ baseURL: base });
  const auth = { authorization: `Bearer ${apiKey}` };
  const caps = new Set(
    ((await (await apiCtx.get("/api/v1/capabilities", { headers: auth })).json()) as { capabilities: string[] }).capabilities);
  const eps = new Set(
    ((await (await apiCtx.get("/api/v1/models", { headers: auth })).json()) as { models: { id: string }[] }).models.map((m) => m.id));
  await apiCtx.dispose();
  const want = advertisedSet(["studio"], [...caps], [...eps]);
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(want);
  const call = await callTool(client, "models_list");
  expect(call.isError).toBe(true);
  expect(call.data.code).toBe("not_available");
  // a pending wrapper stays not_available even if its capability lands -
  // characters names the capability and that the wrapper isn't built yet
  const gated = await callTool(client, "characters", {});
  expect(gated.isError).toBe(true);
  expect(gated.data.code).toBe("not_available");
  expect(String(gated.data.message)).toContain("characters");
  expect(String(gated.data.message)).toContain("isn't built yet");
  await close();
});

test("the key appears in no tool result and no captured stderr", async () => {
  const { client, stderr, close } = await spawnMcp();
  await client.listTools();
  await callTool(client, "system_status");
  await callTool(client, "models_list", { kind: "image" });
  await callTool(client, "skills", { action: "list" });
  expect(stderr()).not.toContain(apiKey);
  await close();
});

/* ---------------- raw stdio discipline ---------------- */

// A minimal raw JSON-RPC driver for the stdout-purity + exit-code checks the
// SDK client can't observe - every line on stdout must parse as JSON-RPC 2.0.
interface JsonRpc { jsonrpc: string; id?: number; result?: unknown; error?: unknown }

class RawMcp {
  readonly proc: ChildProcess;
  stdoutLines: string[] = [];
  stderrText = "";
  private buf = "";
  private nextId = 0;
  private pending = new Map<number, (v: JsonRpc) => void>();

  constructor(bin: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        this.stdoutLines.push(line);
        try {
          const msg = JSON.parse(line) as JsonRpc;
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* non-JSON stdout is asserted against below */ }
      }
    });
    this.proc.stderr!.on("data", (d: Buffer) => { this.stderrText += d.toString("utf8"); });
  }

  request(method: string, params?: unknown): Promise<JsonRpc> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }

  notify(method: string): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async handshake(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" },
    });
    this.notify("notifications/initialized");
  }

  kill() { this.proc.kill(); }
}

test("stdout is JSON-RPC only; missing MOTIONFIELD_API_KEY exits 2 with nothing on stdout", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.MOTIONFIELD_URL = base;
  env.MOTIONFIELD_API_KEY = apiKey;
  env.MOTIONFIELD_MCP_OUT_DIR = mkdtempSync(join(tmpdir(), "of-mcp-e2e-out-"));

  const m = new RawMcp(join(prefix, "bin", "motionfield-mcp"), env);
  try {
    await m.handshake();
    await m.request("tools/list");
    await m.request("tools/call", { name: "system_status", arguments: {} });
    for (const line of m.stdoutLines) {
      const msg = JSON.parse(line) as JsonRpc; // throws on any non-JSON stdout
      expect(msg.jsonrpc).toBe("2.0");
    }
    expect(m.stdoutLines.join("\n")).not.toContain(apiKey);
    expect(m.stderrText).not.toContain(apiKey);
  } finally {
    m.kill();
  }

  // no key → stderr message + exit 2, nothing on stdout
  const noKeyEnv = { ...env };
  delete noKeyEnv.MOTIONFIELD_API_KEY;
  const noKey = new RawMcp(join(prefix, "bin", "motionfield-mcp"), noKeyEnv);
  const code = await new Promise<number | null>((resolve) => {
    noKey.proc.on("exit", (c) => resolve(c));
    setTimeout(() => { noKey.kill(); resolve(null); }, 10_000);
  });
  expect(code).toBe(2);
  expect(noKey.stdoutLines.join("")).toBe("");
  expect(noKey.stderrText).toContain("MOTIONFIELD_API_KEY");
});

/* ---------------- the CLI through the same install ---------------- */

test("cli: generate --json lands a cli-sourced job; s8 gaps (logout/whoami, skills get, status disk, upload/-f)", async () => {
  const bin = join(prefix, "bin", "motionfield");
  // login → generate --json → list --source cli contains the job
  const login = cli(["login", "--url", base, "--key", apiKey]);
  expect(login).toContain("logged in");
  expect(login).not.toContain(apiKey);

  const genOut = cli(["generate", IMAGE_EP, "-p", "prompt=cli-mcp-e2e", "--json"]);
  const job = JSON.parse(genOut) as { id: string };
  expect(job.id).toBeTruthy();
  expect(genOut).not.toContain(apiKey);

  const list = JSON.parse(cli(["list", "--source", "cli", "--json"])) as { jobs: { id: string; source: string }[] };
  const mine = list.jobs.find((j) => j.id === job.id);
  expect(mine).toBeTruthy();
  expect(mine!.source).toBe("cli");

  // status --json carries the disk block
  const sys = JSON.parse(cli(["status", "--json"])) as { disk?: { free_gb: number | null } };
  expect(sys).toHaveProperty("disk");

  // skills get prints the generated SKILL.md - slug front matter first
  const skills = JSON.parse(cli(["skills", "list", "--json"])) as { skills: { slug: string }[] };
  const md = cli(["skills", "get", skills.skills[0].slug]);
  expect(md.startsWith(`---\nname: "${skills.skills[0].slug}"`)).toBe(true);

  // upload + generate -f - a real file rides the upload path into params
  const upFile = join(mkdtempSync(join(tmpdir(), "of-mcp-e2e-up-")), "in.png");
  writeFileSync(upFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  const up = JSON.parse(cli(["upload", upFile, "--json"])) as { url: string };
  expect(up.url).toContain("/files/");
  const fJob = JSON.parse(
    cli(["generate", "motionfield/z-image-turbo/img2img", "-p", "prompt=cli -f test", "-f", `image_url=${upFile}`, "--json"]),
  ) as { id: string };
  expect(fJob.id).toBeTruthy();

  // logout removes the stored config; whoami then exits 2 - not logged in
  cli(["logout"]);
  const who = spawnSync(bin, ["whoami"], { env: cliEnv, encoding: "utf8", timeout: 30_000 });
  expect(who.status).toBe(2);
});
