import { expect, test, request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advertisedSet } from "./helpers/advertised-tools";

/**
 * WS1 s6b studio toolset e2e - the installed motionfield-mcp over stdio against
 * the live v1 API (mock provider, MOTIONFIELD_TOOLSETS=core,studio). The studio
 * surface is 17 tools: refs/person_swap/director_shot/voices/motion_graphics
 * are live on this catalog (director runs Wan VACE locally - no opt-in
 * needed; ltx stays restricted); reshoot/vfx_lab/re_edit are live
 * endpoint-backed wrappers over POST /api/v1/probe + /api/v1/jobs; dub is a
 * live endpoint wrapper over the dub recipe; the
 * remaining pending wrappers never list and answer not_available naming
 * the capability and its owner step. The key never appears in any tool result.
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(300_000); });

/** The 17 studio tools, in declaration order */
const STUDIO_ALL = [
  "refs", "characters", "person_swap", "director_shot", "reshoot", "vfx_lab",
  "re_edit", "audio", "voices", "dub", "motion_graphics", "ad_lab",
  "video_analyze", "clipper", "shorts", "podcast_edit", "virality_score",
].sort();

/** The advertised set for a toolset list - computed live from
 *  /api/v1/capabilities + /api/v1/models (never hard-coded): the same rule
 *  registry.toolAvailable() applies - pending tools never list; enabled
 *  toolset AND (no gate declared OR its capability is reported OR one of
 *  its endpoints is in the catalog). */
const liveSet = async (key: string, toolsets: string[]): Promise<string[]> => {
  const ctx = await request.newContext({ baseURL: base });
  try {
    const auth = { authorization: `Bearer ${key}` };
    const caps = new Set(
      ((await (await ctx.get("/api/v1/capabilities", { headers: auth })).json()) as { capabilities: string[] }).capabilities);
    const eps = new Set(
      ((await (await ctx.get("/api/v1/models", { headers: auth })).json()) as { models: { id: string }[] }).models.map((m) => m.id));
    return advertisedSet(toolsets, [...caps], [...eps]);
  } finally {
    await ctx.dispose();
  }
};
const liveStudioSet = (key: string) => liveSet(key, ["studio"]);

/** The gated tools and the capability each is missing (owner in parens) */
const GATED: Record<string, [string, string | null]> = {
  characters: ["characters", "WS4 s8"],
  ad_lab: ["ads", "WS4 s11"],
  video_analyze: ["video_analyze", "WS2 s17"],
  clipper: ["clipper", null],
  shorts: ["shorts", "WS4 s13b"],
  podcast_edit: ["podcast", "WS2 s16"],
  virality_score: ["virality", "WS2 s14"],
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let apiKey = "";
let otherKey = "";
let base = "";
let prefix = "";
let tmp = "";
let imgUrl = "";
let vidUrl = "";
let wavUrl = "";
let specId = "";

const spawnMcp = async (extra: Record<string, string> = {}) => {
  const outDir = mkdtempSync(join(tmpdir(), "of-studio-e2e-out-"));
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
  const client = new Client({ name: "studio-e2e", version: "0" });
  await client.connect(transport);
  return {
    client,
    outDir,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    async close() { await client.close().catch(() => {}); },
  };
};

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}, timeout = 120_000): Promise<ToolResult> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const content = res.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* text payloads stay raw */ }
  expect(text).not.toContain(apiKey);
  return { isError: res.isError === true, data, text };
};

test.beforeAll(async ({ browser }) => {
  base = `http://localhost:${process.env.PORT || "3100"}`;
  tmp = mkdtempSync(join(tmpdir(), "of-studio-e2e-"));
  const page = await browser.newPage({ baseURL: base });
  try {
    const email = `studio-${Date.now()}@e2e.test`;
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("Studio E2E");
    await page.getByPlaceholder("you@email.com").fill(email);
    await page.getByPlaceholder(/Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
    const sub = await page.request.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
    expect(sub.ok()).toBeTruthy();
    /* no license opt-in - director_shot runs Wan VACE (open); ltx stays a
     * restricted pick this test never takes */
    /* a motion spec for motion_graphics - the deterministic template path
     * needs no LLM; renders are session-owned so the spec id is mine */
    const ms = await page.request.post("/api/render/motion", {
      data: { template_id: "presentation", prompt: "A concise product presentation", duration: 2, aspect: "16:9" } });
    expect(ms.ok(), `motion spec: ${await ms.text()}`).toBeTruthy();
    specId = ((await ms.json()) as { id: string }).id;
    const kr = await page.request.post("/api/keys", { data: { label: "studio-e2e" } });
    expect(kr.status()).toBe(201);
    apiKey = ((await kr.json()) as { key: string }).key;
  } finally {
    await page.close();
  }
  expect(apiKey).toMatch(/^of_/);

  /* a second user - their key is only ever used over HTTP to prove owner
   * scoping (a foreign ref answers 404) */
  const ctx = await request.newContext({ baseURL: base });
  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email: `studio-other-${Date.now()}@e2e.test`, password: "e2e-password-123", name: "Other" },
  });
  expect(su.ok(), `other signup: ${await su.text()}`).toBeTruthy();
  const ok2 = await ctx.post("/api/keys", { data: { label: "other" } });
  otherKey = ((await ok2.json()) as { key: string }).key;
  await ctx.dispose();

  /* install the CLI + MCP into a throwaway prefix - the same path a user runs */
  prefix = mkdtempSync(join(tmpdir(), "of-studio-e2e-prefix-"));
  execFileSync("scripts/install-cli.sh", [], {
    env: { ...process.env, PREFIX: prefix }, stdio: "pipe", timeout: 120_000,
  });
  expect(existsSync(join(prefix, "bin", "motionfield-mcp"))).toBe(true);

  /* real media files → owned /files urls through the upload API */
  const png = join(tmp, "shot.png"); writeFileSync(png, PNG);
  const mp4 = join(tmp, "clip.mp4");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=5:r=24",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
  const wav = join(tmp, "line.wav");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);

  const auth = { Authorization: `Bearer ${apiKey}` };
  const ctx2 = await request.newContext({ baseURL: base });
  const up = async (p: string, mime: string) => {
    const r = await ctx2.post("/api/v1/uploads", {
      headers: auth,
      multipart: { file: { name: p.split("/").pop()!, mimeType: mime, buffer: readFileSync(p) } },
    });
    expect(r.status(), `upload ${p}: ${await r.text()}`).toBe(201);
    return ((await r.json()) as { url: string }).url;
  };
  imgUrl = await up(png, "image/png");
  vidUrl = await up(mp4, "video/mp4");
  wavUrl = await up(wav, "audio/wav");
  await ctx2.dispose();
});

test.afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/* ---------------- listing + gating ---------------- */

test("[#70] core,studio lists the 20 core tools + the live studio set; gated tools answer not_available with the owner reason", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  /* the live studio set is COMPUTED - capabilities + the model catalog this
   * server reports for this key (refs via capability; person_swap,
   * director_shot, voices, motion_graphics via endpoints) */
  const liveStudio = await liveStudioSet(apiKey);
  expect(names).toEqual([...[
    "assets_list", "estimate", "generate", "generate_batch", "job_cancel",
    "job_download", "job_status", "job_wait", "jobs_list", "model_schema",
    "models_list", "presets", "run_approve", "run_control", "run_create",
    "run_edit_step", "run_get", "skills", "system_status", "upload",
  ], ...liveStudio].sort());

  /* every gated studio tool is absent from the list and answers calls with
   * not_available naming the missing capability and its owner step */
  for (const [tool, [cap, owner]] of Object.entries(GATED)) {
    expect(names).not.toContain(tool);
    const r = await callTool(client, tool, {});
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("not_available");
    expect(String(r.data.message)).toContain(`'${cap}'`);
    if (owner) expect(String(r.data.message)).toContain(owner);
  }
  await close();
});

test("[#70] default toolsets hide the studio surface entirely - calls still answer not_available", async () => {
  const { client, close } = await spawnMcp(); // MOTIONFIELD_TOOLSETS unset → core,3d
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  /* core + the live 3d set - computed from this server's reported
   * capabilities + catalog, never a hard-coded count */
  expect(names).toEqual(await liveSet(apiKey, ["core", "3d"]));
  for (const s of STUDIO_ALL) expect(names).not.toContain(s);
  const r = await callTool(client, "refs", { action: "list" });
  expect(r.isError).toBe(true);
  expect(r.data.code).toBe("not_available");
  expect(String(r.data.message)).toContain("studio");
  await close();
});

/* ---------------- refs + @ref planning ---------------- */

test("[#70][OF-0756] upload → refs{create,list,get}; run_create 'a clip of @name' puts the ref image in step 1's media param", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const made = await callTool(client, "refs", {
    action: "create", name: "Steel Cube", category: "prop", kind: "prop",
    description: "the matte cube still", images: [imgUrl] });
  expect(made.isError, made.text).toBe(false);
  expect(made.data.name).toBe("steel-cube");
  expect(made.data.images).toEqual([imgUrl]);

  const listed = await callTool(client, "refs", { action: "list" });
  expect(((listed.data.refs as { name: string }[])).map((r) => r.name)).toContain("steel-cube");

  const got = await callTool(client, "refs", { action: "get", name: "steel-cube" });
  expect(got.isError).toBe(false);
  expect(got.data.name).toBe("steel-cube");

  // the built-in planner resolves the @ref → approving the run lands the
  // ref's image in step 1's media param (the step job exposes its params)
  const run = await callTool(client, "run_create", {
    brief: "a clip of @steel-cube", planner: "builtin", ask_first: true });
  expect(run.isError, run.text).toBe(false);
  const steps = run.data.steps as { endpoint?: string; job_id?: string | null }[];
  expect(steps[0]?.endpoint).toBe("motionfield/wan-vace/image-to-video");
  await callTool(client, "run_approve", { id: run.data.id });
  let jobId: string | null = null;
  for (let i = 0; i < 30 && !jobId; i++) {
    const v = await callTool(client, "run_get", { id: run.data.id });
    jobId = (v.data.steps as { job_id?: string | null }[])[0]?.job_id ?? null;
    if (!jobId) await new Promise((s) => setTimeout(s, 2000));
  }
  expect(jobId).toBeTruthy();
  const job = await callTool(client, "job_status", { id: jobId! });
  expect((job.data.params as Record<string, unknown>)?.image_url).toBe(imgUrl);

  // duplicates → the API's 409 envelope; person without consent → refused
  const dup = await callTool(client, "refs", {
    action: "create", name: "steel-cube", category: "prop", kind: "prop", images: [imgUrl] });
  expect(dup.isError).toBe(true);
  expect(dup.data.code).toBe("conflict");
  const noConsent = await callTool(client, "refs", {
    action: "create", name: "a person", kind: "person", images: [imgUrl] });
  expect(noConsent.isError).toBe(true);

  // a foreign ref - created by the other user with their own upload - is 404
  const ctx = await request.newContext({ baseURL: base });
  const u2 = await ctx.post("/api/v1/uploads", {
    headers: { Authorization: `Bearer ${otherKey}` },
    multipart: { file: { name: "secret.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(u2.status()).toBe(201);
  const secretUrl = ((await u2.json()) as { url: string }).url;
  const theirs = await ctx.post("/api/v1/refs", {
    headers: { Authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
    data: { name: "secret-ref", kind: "prop", category: "prop", images: [secretUrl] },
  });
  expect(theirs.status(), `foreign ref: ${await theirs.text()}`).toBe(201);
  const foreign = await callTool(client, "refs", { action: "get", name: "secret-ref" });
  expect(foreign.isError).toBe(true);
  expect(foreign.data.code).toBe("not_found");
  const relist = await callTool(client, "refs", { action: "list" });
  expect(((relist.data.refs as { name: string }[])).map((r) => r.name))
    .not.toContain("secret-ref");
  await ctx.dispose();
  await close();
});

/* ---------------- live job rows ---------------- */

test("[OF-0733][OF-0734][OF-0735] voices - list is gated; create without consent is consent_required; with consent it is a job", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const listed = await callTool(client, "voices", { action: "list" });
  expect(listed.isError).toBe(true);
  expect(listed.data.code).toBe("not_available");
  expect(String(listed.data.message)).toContain("'voices'");

  const bare = await callTool(client, "voices", { action: "create" });
  expect(bare.isError).toBe(true);
  expect(String(bare.data.message)).toContain("/audio");

  const noConsent = await callTool(client, "voices", {
    action: "create", audio_url: wavUrl, prompt: "the render is ready" });
  expect(noConsent.isError).toBe(true);
  expect(noConsent.data.code).toBe("consent_required");

  const job = await callTool(client, "voices", {
    action: "create", audio_url: wavUrl, prompt: "the render is ready",
    consent: true, wait_s: 50 }, 180_000);
  expect(job.isError, job.text).toBe(false);
  expect(job.data.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(["completed", "in_progress", "queued"]).toContain(job.data.status);
  await close();
});

test("dub - consent_required without consent; an unknown language is refused by the tool schema", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("dub");
  const noConsent = await callTool(client, "dub", { video_url: vidUrl, language: "es" });
  expect(noConsent.isError).toBe(true);
  expect(noConsent.data.code).toBe("consent_required");
  const badLang = await callTool(client, "dub", { video_url: vidUrl, language: "de", likeness_consent: true });
  expect(badLang.isError).toBe(true);
  await close();
});

test("[OF-0743] person_swap - consent_required without likeness consent; with it, a job → wait → download", async () => {
  const { client, outDir, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const noConsent = await callTool(client, "person_swap", {
    video_url: vidUrl, image_url: imgUrl });
  expect(noConsent.isError).toBe(true);
  expect(noConsent.data.code).toBe("consent_required");

  const job = await callTool(client, "person_swap", {
    video_url: vidUrl, image_url: imgUrl, likeness_consent: true, wait_s: 50 }, 180_000);
  expect(job.isError, job.text).toBe(false);
  const jobId = job.data.id as string;
  expect(job.data.endpoint).toBe("motionfield/wan-vace/character-swap");

  const done = await callTool(client, "job_wait", { ids: [jobId], timeout_s: 50 }, 180_000);
  const j = ((done.data.jobs ?? []) as { status: string }[])[0];
  expect(j.status).toBe("completed");

  const dl = await callTool(client, "job_download", { id: jobId });
  expect(dl.isError).toBe(false);
  expect(dl.data.bytes).toBeGreaterThan(0);
  expect(statSync(dl.data.path as string).size).toBeGreaterThan(0);
  expect(String(dl.data.path)).toContain("of-studio-e2e-out-");
  await close();
});

test("director_shot - takes submit one job each → wait → download; undeclared fields are tool errors", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  // undeclared fields, over-range lists and unmapped picks are tool errors
  // before any job is submitted
  for (const args of [
    { prompt: "x", bogus_field: 1 },
    { prompt: "x", moves: ["dolly-in", "pan-left", "tilt-up", "crane-up"] },
    { prompt: "x", lights: ["az0:el10:warm:soft", "az90:el20:cool:hard", "az180:el30:#a0c4ff:medium"] },
    { prompt: "x", audio: true },
    { prompt: "x", emotion: { name: "joy", character: "the lead" } },
  ]) {
    const r = await client.callTool({ name: "director_shot", arguments: args }, undefined, { timeout: 60_000 })
      .then((res) => ({ errored: false, isError: res.isError === true }), () => ({ errored: true, isError: true }));
    expect(r.isError || r.errored, JSON.stringify(args)).toBe(true);
  }
  // audio:true names the missing field
  const audioErr = await callTool(client, "director_shot", { prompt: "x", audio: true });
  expect(audioErr.isError).toBe(true);
  expect(audioErr.data.code).toBe("invalid_params");
  expect(String(audioErr.data.message)).toContain("audio");

  const shot = await callTool(client, "director_shot", {
    prompt: "slow crane over the marina at dusk",
    image_url: imgUrl,
    moves: ["dolly-in", "pan-left"],
    lens: "standard-35", aperture: "f2.8",
    lights: ["az45:el30:warm:soft"],
    emotion: { name: "joy", intensity: "moderate" },
    takes: 2,
  }, 120_000);
  expect(shot.isError, shot.text).toBe(false);
  expect(shot.data.takes).toBe(2);
  const jobs = shot.data.jobs as { id: string }[];
  expect(jobs.length).toBe(2);
  for (const j of jobs) {
    expect(j.id).toMatch(/^[0-9a-f-]{36}$/);
    const done = await callTool(client, "job_wait", { ids: [j.id], timeout_s: 50 }, 180_000);
    const w = ((done.data.jobs ?? []) as { status: string; params?: Record<string, unknown> }[])[0];
    expect(w.status).toBe("completed");
    // the job's stored params echo the mapped endpoint fields
    expect(w.params?.image_url).toBe(imgUrl);
    expect(w.params?.moves).toBe("dolly-in+pan-left");
    expect(w.params?.lights).toBe("az45:el30:warm:soft");
    expect(w.params?.camera_lens).toBe("standard-35");
    expect(w.params?.camera_aperture).toBe("f2.8");
    expect(w.params?.emotion).toBe("joy");
    expect(w.params?.emotion_intensity).toBe("moderate");

    const dl = await callTool(client, "job_download", { id: j.id });
    expect(dl.isError).toBe(false);
    expect(dl.data.bytes).toBeGreaterThan(0);
    expect(statSync(dl.data.path as string).size).toBeGreaterThan(0);
  }
  await close();
});

test("motion_graphics → job id → wait → downloaded bytes > 0", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "core,studio" });
  const job = await callTool(client, "motion_graphics", {
    spec_id: specId, wait_s: 50 }, 180_000);
  expect(job.isError, job.text).toBe(false);
  const jobId = job.data.id as string;
  expect(job.data.endpoint).toBe("motionfield/motion-render/mp4");

  const done = await callTool(client, "job_wait", { ids: [jobId], timeout_s: 50 }, 180_000);
  const j = ((done.data.jobs ?? []) as { status: string }[])[0];
  expect(j.status).toBe("completed");

  const dl = await callTool(client, "job_download", { id: jobId });
  expect(dl.isError).toBe(false);
  expect(dl.data.bytes).toBeGreaterThan(0);
  expect(statSync(dl.data.path as string).size).toBeGreaterThan(0);
  await close();
});
