import { expect, test, request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { advertisedSet } from "./helpers/advertised-tools";

/**
 * WS1 s14 - the `3d` toolset + the audio tool over MCP/CLI:
 *
 *  - toolsets=3d advertises exactly the computed 3d set ({stage} while the
 *    server reports the 'stage' capability - /api/stage is a capability,
 *    not a catalog endpoint)
 *  - stage{create{empty:true} → get → inspect → apply(+idempotency_key) →
 *    revisions → restore} drives the real /api/stage routes through the
 *    SDK: stale base_revision is a stale_revision tool error carrying
 *    head_rev; a foreign id is not_found
 *  - anim_clips stays un-advertised and answers not_available naming its
 *    capability + owner step (clip search is WS5b S1, not in this build)
 *  - audio{kind:sfx} submits a real job through motionfield/moss/sfx - the
 *    mock provider completes it with an audio output; video_sfx without
 *    video_url is invalid_params; music duration:150 is the endpoint's own
 *    invalid_params range error, not an MCP-side clamp
 *  - the CLI `motionfield stage` surface does the same roundtrip
 *  - the key never appears in a tool result, stdout, or stderr
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(300_000); });

let apiKey = "";
let base = "";
let prefix = "";
let cliEnv: NodeJS.ProcessEnv = process.env;

/* every temp dir this suite makes is tracked and deleted in afterAll */
const tmpDirs: string[] = [];
const mktmp = (pfx: string) => {
  const d = mkdtempSync(join(tmpdir(), pfx));
  tmpDirs.push(d);
  return d;
};
test.afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

/* ---------------- installed-bin MCP client ---------------- */

const spawnMcp = async (extra: Record<string, string> = {}) => {
  const outDir = mktmp("of-3d-e2e-out-");
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
  const client = new Client({ name: "ws1-3d-e2e", version: "0" });
  await client.connect(transport);
  return {
    client,
    outDir,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    async close() { await client.close().catch(() => {}); },
  };
};

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

/** tools/call → the parsed JSON payload. The key must never ride a tool
 *  result back. */
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
    const email = `mcp3d-${Date.now()}@e2e.test`;
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("MCP 3D E2E");
    await page.getByPlaceholder("you@email.com").fill(email);
    await page.getByPlaceholder(/Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
    const kr = await page.request.post("/api/keys", { data: { label: "mcp-3d-e2e" } });
    expect(kr.status()).toBe(201);
    apiKey = ((await kr.json()) as { key: string }).key;
  } finally {
    await page.close();
  }
  expect(apiKey).toMatch(/^of_/);

  // the installed bins, like a user runs them - never the sources
  prefix = mktmp("of-3d-e2e-prefix-");
  execFileSync("scripts/install-cli.sh", [], {
    env: { ...process.env, PREFIX: prefix }, stdio: "pipe", timeout: 120_000,
  });
  expect(existsSync(join(prefix, "bin", "motionfield-mcp"))).toBe(true);
  expect(existsSync(join(prefix, "bin", "motionfield"))).toBe(true);

  cliEnv = { ...process.env };
  for (const k of Object.keys(cliEnv)) if (k.startsWith("MOTIONFIELD_")) delete cliEnv[k];
  cliEnv.MOTIONFIELD_CONFIG_DIR = mktmp("of-3d-e2e-cfg-");
});

/* ---------------- toolset surface ---------------- */

test("toolsets=3d advertises exactly the computed 3d set; anim_clips answers not_available", async () => {
  const { client, close, stderr } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "3d" });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  const ctx = await request.newContext({ baseURL: base });
  try {
    const auth = { authorization: `Bearer ${apiKey}` };
    const caps = ((await (await ctx.get("/api/v1/capabilities", { headers: auth })).json()) as { capabilities: string[] }).capabilities;
    const eps = ((await (await ctx.get("/api/v1/models", { headers: auth })).json()) as { models: { id: string }[] }).models.map((m) => m.id);
    expect(caps).toContain("stage");
    expect(names).toEqual(advertisedSet(["3d"], caps, eps));
  } finally {
    await ctx.dispose();
  }
  expect(names).toContain("stage");
  expect(names).not.toContain("anim_clips");

  /* a pending tool answers calls with a clean not_available naming the
   * capability and its owner step - never a protocol crash */
  const r = await callTool(client, "anim_clips", { query: "walk cycle" });
  expect(r.isError).toBe(true);
  expect(r.data.code).toBe("not_available");
  expect(String(r.data.message)).toContain("anim_clips");
  expect(String(r.data.message)).toContain("WS5b");
  expect(stderr()).not.toContain(apiKey);
  await close();
});

/* ---------------- stage over MCP ---------------- */

test("stage - create(empty) → get → inspect → apply(+idempotency) → revisions → restore; stale + 404 contracts", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "3d" });

  const created = await callTool(client, "stage", { action: "create", empty: true });
  expect(created.isError, created.text).toBe(false);
  const sceneId = created.data.id as string;
  expect(created.data.revision).toBe(1);

  const got = await callTool(client, "stage", { action: "get", id: sceneId });
  expect(got.isError, got.text).toBe(false);
  expect(got.data.revision).toBe(1);
  const nodes = (got.data.scene as { nodes: { id: string }[] }).nodes;
  expect(nodes.length).toBeGreaterThan(0);

  const tree = await callTool(client, "stage", { action: "inspect", id: sceneId, view: "tree" });
  expect(tree.isError, tree.text).toBe(false);

  /* apply - one typed op under an idempotency key; a byte-identical retry
   * replays instead of writing a second head */
  const addPylon = [{ op: "add", node: { kind: "primitive", name: "Pylon", props: { shape: "box", size: [1, 1, 1], color: "#3366aa" } } }];
  const applied = await callTool(client, "stage", {
    action: "apply", id: sceneId, base_revision: 1, ops: addPylon, idempotency_key: "e2e-idem-pylon",
  });
  expect(applied.isError, applied.text).toBe(false);
  expect(applied.data.revision).toBe(2);

  const replay = await callTool(client, "stage", {
    action: "apply", id: sceneId, base_revision: 1, ops: addPylon, idempotency_key: "e2e-idem-pylon",
  });
  expect(replay.isError, replay.text).toBe(false);
  expect(replay.data.revision).toBe(2);

  /* the same key with a different body is idempotency_mismatch - never a
   * silent second apply */
  const mismatch = await callTool(client, "stage", {
    action: "apply", id: sceneId, base_revision: 2, idempotency_key: "e2e-idem-pylon",
    ops: [{ op: "add", node: { kind: "primitive", name: "Other", props: { shape: "sphere", size: [1, 1, 1], color: "#aa3366" } } }],
  });
  expect(mismatch.isError).toBe(true);
  expect(mismatch.data.code).toBe("idempotency_mismatch");

  /* revisions - newest-first; the ops row is there */
  const revisions = await callTool(client, "stage", { action: "revisions", id: sceneId });
  expect(revisions.isError, revisions.text).toBe(false);
  const revs = revisions.data.revisions as { revision: number; source: string }[];
  expect(revs.map((r) => r.revision)).toContain(2);
  expect(revs.find((r) => r.revision === 2)?.source).toBe("ops");

  /* restore rev 1 onto a new head - history is append-only */
  const restored = await callTool(client, "stage", { action: "restore", id: sceneId, rev: 1, base_revision: 2 });
  expect(restored.isError, restored.text).toBe(false);
  expect(restored.data.revision).toBe(3);
  const after = await callTool(client, "stage", { action: "get", id: sceneId });
  expect((after.data.scene as { nodes: { name?: string }[] }).nodes.some((n) => n.name === "Pylon")).toBe(false);

  /* a stale base_revision is a tool error carrying the live head */
  const stale = await callTool(client, "stage", {
    action: "apply", id: sceneId, base_revision: 1, ops: addPylon,
  });
  expect(stale.isError).toBe(true);
  expect(stale.data.code).toBe("stale_revision");
  expect(stale.data.head_rev).toBe(3);

  /* a scene the key doesn't own is not_found - the API's own 404 mapping */
  const missing = await callTool(client, "stage", { action: "get", id: crypto.randomUUID() });
  expect(missing.isError).toBe(true);
  expect(missing.data.code).toBe("not_found");

  /* missing id/base are invalid_params before any request */
  const noId = await callTool(client, "stage", { action: "apply", ops: addPylon, base_revision: 1 });
  expect(noId.isError).toBe(true);
  expect(noId.data.code).toBe("invalid_params");

  await close();
});

test("a second user's scene is not_found under the first user's key", async () => {
  /* user 2 signs up and mints a scene over the plain API; user 1's MCP
   * stage{get} on that id must answer the API's own not_found - scenes are
   * owned, never shared by id knowledge */
  const ctx = await request.newContext({ baseURL: base });
  try {
    const su = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `mcp3d-other-${Date.now()}@e2e.test`, password: "e2e-password-123", name: "Other" },
    });
    expect(su.ok(), `other signup: ${await su.text()}`).toBeTruthy();
    const kr = await ctx.post("/api/keys", { data: { label: "other-3d" } });
    expect(kr.status()).toBe(201);
    const key2 = ((await kr.json()) as { key: string }).key;
    const sc = await ctx.post("/api/stage", {
      headers: { authorization: `Bearer ${key2}` },
      data: { empty: true },
    });
    expect(sc.status(), `other stage create: ${await sc.text()}`).toBe(201);
    const sceneId = ((await sc.json()) as { id: string }).id;

    const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "3d" });
    const foreign = await callTool(client, "stage", { action: "get", id: sceneId });
    expect(foreign.isError).toBe(true);
    expect(foreign.data.code).toBe("not_found");
    await close();
  } finally {
    await ctx.dispose();
  }
});

/* ---------------- audio over MCP ---------------- */

test("audio{kind:sfx} completes under the mock provider with an audio output; input contracts", async () => {
  const { client, close } = await spawnMcp({ MOTIONFIELD_TOOLSETS: "studio,core" }); // job_download lives in core

  /* a real job through motionfield/moss/sfx - mock completes with a WAV */
  const sfx = await callTool(client, "audio", { kind: "sfx", prompt: "rain on a tin roof", duration: 5, wait_s: 50 }, 180_000);
  expect(sfx.isError, sfx.text).toBe(false);
  expect(sfx.data.status).toBe("completed");
  const outs = sfx.data.outputs as { type: string }[];
  expect(outs[0]?.type).toMatch(/^audio\//);

  /* music is the same loop through motionfield/acestep/music - wait →
   * completed → job_download lands real bytes */
  const music = await callTool(client, "audio", { kind: "music", prompt: "lo-fi rain loop", duration: 10, wait_s: 50 }, 180_000);
  expect(music.isError, music.text).toBe(false);
  expect(music.data.status).toBe("completed");
  expect((music.data.outputs as { type: string }[])[0]?.type).toMatch(/^audio\//);
  const dl = await callTool(client, "job_download", { id: music.data.id as string });
  expect(dl.isError, dl.text).toBe(false);
  expect(dl.data.bytes).toBeGreaterThan(0);

  /* video_url on the music endpoint - the endpoint declares no such field,
   * so the live-schema check answers invalid_params naming it */
  const musicVideo = await callTool(client, "audio", { kind: "music", prompt: "x", video_url: "/files/x.mp4" });
  expect(musicVideo.isError).toBe(true);
  expect(musicVideo.data.code).toBe("invalid_params");
  expect(String(musicVideo.data.message)).toContain("video_url");

  /* an enum value the tool doesn't declare is refused - the input schema's
   * zod parse fails inside the handler and comes back as an isError result
   * naming the allowed kinds */
  const bogus = await callTool(client, "audio", { kind: "bogus" });
  expect(bogus.isError).toBe(true);
  expect(bogus.text).toMatch(/music|sfx|video_sfx/);

  /* video_sfx needs a video_url you own - missing one is invalid_params
   * before any request */
  const noVideo = await callTool(client, "audio", { kind: "video_sfx" });
  expect(noVideo.isError).toBe(true);
  expect(noVideo.data.code).toBe("invalid_params");
  expect(String(noVideo.data.message)).toContain("video_url");

  /* motionfield/moss/video-sfx is a restricted-license recipe endpoint -
   * hidden from this lane's catalog, so the honest answer is not_available
   * (on an opted-in lane the undeclared-field check answers invalid_params
   * for duration instead) */
  const undeclared = await callTool(client, "audio", { kind: "video_sfx", video_url: "/files/x.mp4", duration: 5 });
  expect(undeclared.isError).toBe(true);
  expect(["not_available", "invalid_params"]).toContain(undeclared.data.code);

  /* an out-of-range duration reaches the endpoint and answers its own
   * error - the v1 validate() failure is a bad_request carrying the
   * endpoint's range message, not an MCP-side clamp re-stating it */
  const range = await callTool(client, "audio", { kind: "music", prompt: "epic taiko", duration: 150 });
  expect(range.isError).toBe(true);
  expect(range.data.code).toBe("bad_request");
  expect(String(range.data.message)).toContain("10-120");

  await close();
});

/* ---------------- CLI surface ---------------- */

test("cli stage - create --empty → apply --ops → restore; stale base is the API's 409 contract", async () => {
  cli(["login", "--url", base, "--key", apiKey]);

  const created = JSON.parse(cli(["stage", "create", "--empty", "--json"])) as { id: string; revision: number };
  expect(created.revision).toBe(1);

  /* stage get --json returns the live head - revision included */
  const got = JSON.parse(cli(["stage", "get", created.id, "--json"])) as { id: string; revision: number };
  expect(got.id).toBe(created.id);
  expect(got.revision).toBe(1);

  const list = JSON.parse(cli(["stage", "list", "--json"])) as { scenes: { id: string }[] };
  expect(list.scenes.map((s) => s.id)).toContain(created.id);

  const inspected = JSON.parse(cli(["stage", "inspect", created.id, "--t", "tree", "--json"])) as Record<string, unknown>;
  expect(inspected).toBeTruthy();

  const opsFile = join(mktmp("of-3d-e2e-ops-"), "ops.json");
  writeFileSync(opsFile, JSON.stringify([{ op: "add", node: { kind: "primitive", name: "Pylon", props: { shape: "box", size: [1, 1, 1], color: "#3366aa" } } }]));
  const applied = JSON.parse(cli(["stage", "apply", created.id, "--base-revision", "1", "--ops", opsFile, "--idempotency-key", "cli-e2e-1", "--json"])) as { revision: number };
  expect(applied.revision).toBe(2);

  const revisions = JSON.parse(cli(["stage", "revisions", created.id, "--json"])) as { revisions: { revision: number }[] };
  expect(revisions.revisions.map((r) => r.revision)).toEqual([2, 1]);

  const restored = JSON.parse(cli(["stage", "restore", created.id, "1", "--base-revision", "2", "--json"])) as { revision: number };
  expect(restored.revision).toBe(3);

  /* stale base → exit 1, {error:{code:"stale_revision", head_rev:3}} on --json */
  let staleOut = "";
  try {
    cli(["stage", "apply", created.id, "--base-revision", "1", "--ops", opsFile, "--json"]);
  } catch (e) {
    staleOut = String((e as { stdout?: string }).stdout ?? "");
  }
  const staleErr = JSON.parse(staleOut) as { error: { code: string; head_rev: number } };
  expect(staleErr.error.code).toBe("stale_revision");
  expect(staleErr.error.head_rev).toBe(3);

  cli(["logout"]);
});
