import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * motionfield-mcp-http - the Streamable HTTP lane (s9). The installed bin is
 * spawned on a free loopback port with MOTIONFIELD_URL pointed at this app's
 * dev server; the suite only ever kills the process it spawned.
 *
 *  - tools/list over HTTP is exactly the stdio list for the same key/toolsets
 *  - generate (mock) → job_wait → job_download returns a fetchable url
 *  - no header → 401, wrong key → 401, bad Host → 403, local-path upload refused
 */

test.describe.configure({ mode: "serial" });

const IMAGE_EP = "motionfield/z-image-turbo/text-to-image";

interface Job { id: string; status: string }

function callTool(client: Client, apiKey: string) {
  return async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const sc = (r as { structuredContent?: unknown }).structuredContent;
    const first = (r.content as { type: string; text?: string }[] | undefined)?.[0];
    const text = sc !== undefined ? JSON.stringify(sc) : (first?.type === "text" ? first.text! : "");
    // the caller's key must never surface inside a tool result
    expect(text).not.toContain(apiKey);
    return { isError: r.isError === true, parsed: JSON.parse(text) };
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function httpStatus(port: number, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/mcp", method: opts.method ?? "POST", headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const JSONRPC_INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
});
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("[OF-09xx] mcp-http: tools/list == stdio, generate→wait→download url, 401/403 guards", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const email = `mcphttp-${Date.now()}@e2e.test`;

  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("MCP HTTP E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });

  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("mcp-http-e2e");
  await page.getByTestId("create-key").click();
  const keyEl = page.getByTestId("key-value");
  await expect(keyEl).toBeVisible({ timeout: 15_000 });
  const apiKey = (await keyEl.textContent())!.trim();
  expect(apiKey).toMatch(/^of_/);

  const prefix = mkdtempSync(join(tmpdir(), "of-mcphttp-e2e-prefix-"));
  try {
    execFileSync("scripts/install-cli.sh", [], {
      env: { ...process.env, PREFIX: prefix }, stdio: "pipe",
    });
  const mcpHttpBin = join(prefix, "bin", "motionfield-mcp-http");
  const mcpStdioBin = join(prefix, "bin", "motionfield-mcp");
  expect(existsSync(mcpHttpBin)).toBe(true);

  // spawn the listener - no MOTIONFIELD_API_KEY: the server holds no key of its own
  const { MOTIONFIELD_API_KEY: _drop, ...serverEnv } = process.env;
  const port = await freePort();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  let proc: ChildProcess | undefined;
  let stderr = "";
  try {
    proc = spawn(mcpHttpBin, [], {
      env: {
        ...serverEnv,
        MOTIONFIELD_URL: baseURL!,
        MOTIONFIELD_MCP_HTTP_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stderr!.on("data", (d) => { stderr += String(d); });

    // readiness - any answered request means the listener is up
    await expect(async () => {
      const r = await httpStatus(port, { headers: MCP_HEADERS, body: JSONRPC_INIT });
      expect(r.status).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [300, 600, 1200] });

    // ---- the pre-MCP gates ----
    const noAuth = await httpStatus(port, { headers: MCP_HEADERS, body: JSONRPC_INIT });
    expect(noAuth.status).toBe(401);
    const badAuth = await httpStatus(port, {
      headers: { ...MCP_HEADERS, authorization: "Bearer of_dead_wrongsecret" }, body: JSONRPC_INIT,
    });
    expect(badAuth.status).toBe(401);
    const badHost = await httpStatus(port, {
      headers: { ...MCP_HEADERS, authorization: `Bearer ${apiKey}`, host: "evil.example" },
      body: JSONRPC_INIT,
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await httpStatus(port, {
      headers: { ...MCP_HEADERS, authorization: `Bearer ${apiKey}`, origin: "http://evil.example" },
      body: JSONRPC_INIT,
    });
    expect(badOrigin.status).toBe(403);
    const offPath = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/v1/jobs", method: "POST",
          headers: { ...MCP_HEADERS, authorization: `Bearer ${apiKey}` } },
        (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); });
      req.on("error", reject);
      req.end(JSONRPC_INIT);
    });
    expect(offPath.status).toBe(404);

    // ---- stdio baseline: tools/list for the same key + toolsets ----
    const stdioTransport = new StdioClientTransport({
      command: mcpStdioBin,
      env: { ...process.env, MOTIONFIELD_URL: baseURL!, MOTIONFIELD_API_KEY: apiKey },
    });
    const stdioClient = new Client({ name: "ws1-stdio-ref", version: "0" });
    await stdioClient.connect(stdioTransport);
    const stdioTools = (await stdioClient.listTools()).tools
      .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const httpTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    const httpClient = new Client({ name: "ws1-http-e2e", version: "0" });
    await httpClient.connect(httpTransport);
    const httpTools = (await httpClient.listTools()).tools
      .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(httpTools).toEqual(stdioTools);
    expect(httpTools.map((t) => t.name)).toContain("generate");

    const call = callTool(httpClient, apiKey);

    // upload{path} - a local path is a guard error on http
    const up = await call("upload", { path: "/etc/hosts" });
    expect(up.isError).toBe(true);
    expect(up.parsed.code).toBe("guard");
    expect(up.parsed.message).toContain("stdio");

    // generate (mock) → job_wait → job_download returns a fetchable url
    const g = await call("generate", { endpoint: IMAGE_EP, params: { prompt: "e2e http lighthouse", seed: 1 }, wait_s: 50 });
    expect(g.isError).toBe(false);
    const job = g.parsed as Job;
    expect(job.status).toBe("completed");

    const dl = await call("job_download", { id: job.id, index: 0 });
    expect(dl.isError).toBe(false);
    const out = dl.parsed as { url: string; mime: string };
    expect(out.url).toMatch(new RegExp(`^${baseURL!.replace(/[/.]/g, "\\$&")}/api/v1/jobs/${job.id}/result`));
    const media = await fetch(out.url, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(media.status).toBe(200);
    expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(0);

    await httpClient.close();
    await stdioClient.close();
  } finally {
    // only ever the process this suite spawned
    proc?.kill("SIGTERM");
  }
  expect(stderr).not.toContain(apiKey);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
