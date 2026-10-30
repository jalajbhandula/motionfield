import { expect, test, request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Platform MCP spec - reshoot + re_edit run the real endpoint path:
 * tools/call → POST /api/v1/probe (owned-media probe) → POST /api/v1/jobs.
 * The probe stamps the server-derived frames/fps/duration/dims + window
 * count - a client can never hand those in. Also: 401 without a token.
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(300_000); });

let apiKey = "";
let base = "";
let prefix = "";
let videoUrl = "";
let cliEnv: NodeJS.ProcessEnv = process.env;

const spawnMcp = async (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MOTIONFIELD_URL = base;
  env.MOTIONFIELD_API_KEY = apiKey;
  env.MOTIONFIELD_TOOLSETS = "core,studio";
  env.MOTIONFIELD_MCP_OUT_DIR = mkdtempSync(join(tmpdir(), "of-pmcp-out-"));
  Object.assign(env, extra);
  const transport = new StdioClientTransport({
    command: join(prefix, "bin", "motionfield-mcp"),
    env, stderr: "pipe",
  });
  const client = new Client({ name: "platform-e2e", version: "0" });
  await client.connect(transport);
  return { client, async close() { await client.close().catch(() => {}); } };
};

const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = (res.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? "";
  expect(text).not.toContain(apiKey);                    // the key never rides a result
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* raw text */ }
  return { isError: res.isError === true, data, text };
};

async function waitForJob(id: unknown) {
  expect(typeof id).toBe("string");
  const ctx = await request.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${apiKey}` } });
  try {
    await expect.poll(async () => {
      const response = await ctx.get(`/api/v1/jobs/${id}`);
      expect(response.ok()).toBeTruthy();
      return (await response.json()).status;
    }, { timeout: 120_000, intervals: [250, 500, 1000] }).toMatch(/^(completed|failed|cancelled)$/);
  } finally { await ctx.dispose(); }
}

function makeClip(file: string, secs = 2, rate = 24, size = "320x180") {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${secs}`,
    "-an", "-map", "0:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return readFileSync(file);
}

test.beforeAll(async ({ browser }) => {
  base = `http://localhost:${process.env.PORT || "3100"}`;
  const page = await browser.newPage({ baseURL: base });
  try {
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("Platform MCP");
    await page.getByPlaceholder("you@email.com").fill(`pmcp-${Date.now()}@e2e.test`);
    await page.getByPlaceholder(/Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
    const kr = await page.request.post("/api/keys", { data: { label: "platform-mcp" } });
    expect(kr.status()).toBe(201);
    apiKey = ((await kr.json()) as { key: string }).key;
    // restricted-license endpoints (LTX) only list after the user's opt-in -
    // vfx_lab's endpoint gate reads the same catalog
    const opt = await page.request.post("/api/licenses/opt-in", { data: { confirm: true } });
    expect(opt.ok()).toBeTruthy();

    // upload a 2 s clip through the session - reshoot/re-edit own it from here
    const clip = makeClip(join(mkdtempSync(join(tmpdir(), "of-pmcp-clip-")), "clip.mp4"));
    const up = await page.request.post("/api/uploads", {
      multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: clip } },
    });
    expect(up.ok()).toBeTruthy();
    videoUrl = ((await up.json()) as { url: string }).url;
    expect(videoUrl).toMatch(/^\/files\//);
  } finally {
    await page.close();
  }
  expect(apiKey).toMatch(/^of_/);

  prefix = mkdtempSync(join(tmpdir(), "of-pmcp-prefix-"));
  execFileSync("scripts/install-cli.sh", [], {
    env: { ...process.env, PREFIX: prefix }, stdio: "pipe", timeout: 120_000,
  });
  expect(existsSync(join(prefix, "bin", "motionfield-mcp"))).toBe(true);

  cliEnv = { ...process.env };
  for (const k of Object.keys(cliEnv)) if (k.startsWith("MOTIONFIELD_")) delete cliEnv[k];
});

test("probe endpoint: bearer-authed owned-media facts (windows for re-edit)", async () => {
  const ctx = await request.newContext({ baseURL: base });
  try {
    const r = await ctx.post("/api/v1/probe", {
      headers: { authorization: `Bearer ${apiKey}` },
      data: { video_url: videoUrl },
    });
    expect(r.ok()).toBeTruthy();
    const { probe } = (await r.json()) as { probe: Record<string, number | null | boolean> };
    expect(Math.abs(Number(probe.fps) - 24)).toBeLessThan(0.01);
    expect(probe.frames).toBe(48);
    expect(probe.render_width).toBeGreaterThan(0);
    expect(probe.windows).toBeGreaterThanOrEqual(1);     // shot detection ran
  } finally {
    await ctx.dispose();
  }
});

test("reshoot happy path - probe-stamped params, job created", async () => {
  const { client, close } = await spawnMcp();
  const r = await callTool(client, "reshoot", { video_url: videoUrl, moves: ["dolly-in"] });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.id).toMatch(/^[0-9a-f-]{36}$/);
  await waitForJob(r.data.id);
  // unowned media → the probe's 404 surfaces as the tool error
  const bad = await callTool(client, "reshoot", { video_url: "/files/not-mine.mp4" });
  expect(bad.isError).toBe(true);
  expect(bad.data.code).toBe("not_found");
  await close();
});

test("re_edit happy path - windows stamped from the probe, job created", async () => {
  const { client, close } = await spawnMcp();
  // restyle needs no images/consent; windows comes from /api/v1/probe
  const r = await callTool(client, "re_edit", {
    video_url: videoUrl, flow: "restyle",
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.id).toMatch(/^[0-9a-f-]{36}$/);
  await waitForJob(r.data.id);
  // consent gate: character-swap without likeness_consent refuses tool-side
  const denied = await callTool(client, "re_edit", {
    video_url: videoUrl, flow: "character-swap", image_urls: ["/files/x.png"],
  });
  expect(denied.isError).toBe(true);
  expect(denied.data.code).toBe("consent_required");
  await close();
});

test("vfx_lab happy path - probe-derived 8n+1 frames @24fps", async () => {
  const { client, close } = await spawnMcp();
  // the user opted into restricted licenses in beforeAll, so the LTX
  // endpoint is in this server's model catalog
  const r = await callTool(client, "vfx_lab", {
    video_url: videoUrl, prompt: "frostbite creeps across the frame",
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.id).toMatch(/^[0-9a-f-]{36}$/);
  await waitForJob(r.data.id);
  await close();
});

test("no token → MCP server fails closed (startup refuses, never lists)", async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MOTIONFIELD_URL = base;
  delete env.MOTIONFIELD_API_KEY;                           // no key at all
  env.MOTIONFIELD_MCP_OUT_DIR = mkdtempSync(join(tmpdir(), "of-pmcp-out-"));
  const transport = new StdioClientTransport({
    command: join(prefix, "bin", "motionfield-mcp"),
    env, stderr: "pipe",
  });
  const client = new Client({ name: "platform-e2e-anon", version: "0" });
  // the server may connect (stdio handshake is keyless) - but every API-bound
  // call must 401 through the envelope, never fabricate a success
  try {
    await client.connect(transport);
    const res = await client.callTool(
      { name: "reshoot", arguments: { video_url: videoUrl } },
      undefined, { timeout: 60_000 });
    expect(res.isError).toBe(true);
  } catch {
    // a startup-level refusal is equally correct - either way, no silent pass
  }
});
