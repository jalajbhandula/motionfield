import { test, expect, request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advertisedSet } from "./helpers/advertised-tools";

/**
 * WS1 s7 honest-pages e2e - /plugins, /connectors, /mcp, /docs and /docs/cli
 * describe only artifacts that exist in this repository:
 *
 *  - every same-origin href on the five pages answers <400
 *  - no Install/Connect control exists for an item with no real artifact
 *    (the "not included" sections carry zero links and zero buttons)
 *  - the Blender row says beta + GPL-2.0-or-later + headless-smoke honesty
 *  - Telegram reads "planned" while /api/v1/capabilities lacks "telegram"
 *  - the /mcp flow is executable end to end: mint a key in the UI →
 *    install-cli.sh into a temp prefix → parse the page's generic JSON
 *    snippet → spawn motionfield-mcp exactly as it says → 20 core tools
 *  - the four client snippets parse (JSON.parse / TOML shape) and appear
 *    verbatim in docs/MCP.md - page, doc and spec read one source of truth
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(180_000); });

const base = `http://localhost:${process.env.PORT || 3100}`;
const PAGES = ["/plugins", "/connectors", "/mcp", "/docs", "/docs/cli"] as const;
const SNIPPET_IDS = ["claude", "codex", "cursor", "opencode", "generic"] as const;
const HTTP_SNIPPET_IDS = ["http-claude-code", "http-cursor", "http-codex", "http-opencode", "http-generic"] as const;

let apiKey = "";
let email = "";
let tmp = "";
let prefix = "";

const uuid = () => crypto.randomUUID();

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000); // hook timeout - first hit compiles these routes cold
  const context = await browser.newContext();
  const page = await context.newPage();
  email = `s7honest-${uuid().slice(0, 8)}@e2e.test`;
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("Honest E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });

  /* mint a key through the real Settings → API keys UI */
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("s7 honest e2e");
  await page.getByTestId("create-key").click();
  const raw = await page.getByTestId("key-value").textContent({ timeout: 15_000 });
  apiKey = (raw ?? "").trim();
  expect(apiKey).toMatch(/^of_/);

  /* install the real CLIs into a throwaway prefix */
  tmp = mkdtempSync(join(tmpdir(), "of-s7-honest-"));
  prefix = join(tmp, "prefix");
  execFileSync("bash", ["scripts/install-cli.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, PREFIX: prefix },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await context.close();
});

test.afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/* ---------------- no 404 links ---------------- */

for (const p of PAGES) {
  test(`${p} - every same-origin href answers <400`, async ({ page }) => {
    await page.goto(p);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")!));
    const internal = [...new Set(hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//")))];
    expect(internal.length, `${p} exposes no internal links`).toBeGreaterThan(0);
    const ctx = await request.newContext({ baseURL: base });
    try {
      for (const href of internal) {
        const res = await ctx.get(href);
        expect(res.status(), `${p} links ${href} → ${res.status()}`).toBeLessThan(400);
      }
    } finally {
      await ctx.dispose();
    }
  });
}

/* ---------------- honest status ---------------- */

test("plugins/connectors - no Install or Connect control on items with no artifact", async ({ page }) => {
  for (const p of ["/plugins", "/connectors"] as const) {
    await page.goto(p);
    /* "not included" is the only place unsupported items are named -
     * it must carry zero links and zero buttons */
    const zone = page.getByTestId("not-included");
    await expect(zone).toBeVisible();
    expect(await zone.locator("a").count(), `${p} not-included has links`).toBe(0);
    expect(await zone.locator("button").count(), `${p} not-included has buttons`).toBe(0);
    /* nothing anywhere on the page is a clickable Install/Connect control */
    const controls = await page.$$("a, button");
    for (const c of controls) {
      const label = (await c.textContent()) ?? "";
      expect(label, `${p} has an install/connect control: ${label.trim()}`)
        .not.toMatch(/\b(install|connect)\b/i);
    }
  }
});

test("/plugins - the Blender row is honest: beta + GPL-2.0-or-later + hand-test caveat", async ({ page }) => {
  await page.goto("/plugins");
  const row = page.getByTestId("plugin-blender");
  await expect(row).toBeVisible();
  const text = await row.innerText();
  expect(text).toContain("GPL-2.0-or-later");
  expect(text).toContain("beta");
  expect(text).toMatch(/headless smoke/i);
  expect(text).toMatch(/5\.2\.3/);
  expect(text).toMatch(/not been\s+hand-tested|not yet run on a real|not hand-tested/i);
  /* the Chrome row is the real Send-to-MotionField extension */
  const chrome = await page.getByTestId("plugin-chrome").innerText();
  expect(chrome).toContain("Send to MotionField");
});

test("/connectors - Telegram reads planned while the capability is absent", async ({ page }) => {
  /* the server must actually lack the capability - the badge is the truth,
   * not a static label */
  const ctx = await request.newContext({ baseURL: base });
  const caps = await ctx.get("/api/v1/capabilities", {
    headers: { authorization: `Bearer ${apiKey}` } });
  const { capabilities } = await caps.json() as { capabilities: string[] };
  await ctx.dispose();
  expect(capabilities).not.toContain("telegram");

  await page.goto("/connectors");
  await expect(page.getByTestId("telegram-status")).toHaveText("planned");
  /* the three real connectors are the only working rows */
  for (const id of ["connector-webhooks", "connector-mcp", "connector-apikeys"])
    await expect(page.getByTestId(id)).toBeVisible();
  /* webhooks are per-job only - runs have no options.webhook_url */
  expect(await page.content()).not.toContain("options.webhook_url");
});

/* ---------------- the /mcp flow actually executes ---------------- */

test("/mcp - generic snippet spawns motionfield-mcp; the four client snippets parse", async ({ page }) => {
  await page.goto("/mcp");

  /* every rendered snippet appears verbatim in docs/MCP.md - the doc and the
   * page read one source of truth */
  const mcpDoc = readFileSync("docs/MCP.md", "utf8");
  const snippets: Record<string, string> = {};
  for (const id of SNIPPET_IDS)
    snippets[id] = (await page.getByTestId(`mcp-snippet-${id}`).innerText()).trim();

  /* JSON snippets parse; every snippet is verbatim in the doc */
  const claude = JSON.parse(snippets.claude) as { mcpServers: { motionfield: { command: string; env: Record<string, string> } } };
  expect(claude.mcpServers.motionfield.command).toBe("motionfield-mcp");
  const cursor = JSON.parse(snippets.cursor) as { mcpServers: { motionfield: { command: string } } };
  expect(cursor.mcpServers.motionfield.command).toBe("motionfield-mcp");
  const opencode = JSON.parse(snippets.opencode) as { mcp: { motionfield: { type: string; command: string[]; environment: Record<string, string> } } };
  expect(opencode.mcp.motionfield.type).toBe("local");
  expect(opencode.mcp.motionfield.command).toEqual(["motionfield-mcp"]);

  /* the TOML snippet carries the motionfield server block with command + env */
  expect(snippets.codex).toContain("[mcp_servers.motionfield]");
  expect(snippets.codex).toContain('command = "motionfield-mcp"');
  expect(snippets.codex).toContain("env =");

  for (const id of SNIPPET_IDS)
    expect(mcpDoc, `docs/MCP.md is missing the ${id} snippet`).toContain(snippets[id]);

  /* the remote (Streamable HTTP) snippets render under their own testids and
   * are verbatim in the doc - one source of truth, no literal key anywhere */
  const httpSnippets: Record<string, string> = {};
  for (const id of HTTP_SNIPPET_IDS) {
    httpSnippets[id] = (await page.getByTestId(`mcp-http-snippet-${id}`).innerText()).trim();
    expect(mcpDoc, `docs/MCP.md is missing the ${id} snippet`).toContain(httpSnippets[id]);
  }
  const httpClaude = JSON.parse(httpSnippets["http-claude-code"]) as
    { mcpServers: { motionfield: { type: string; url: string; headers: Record<string, string> } } };
  expect(httpClaude.mcpServers.motionfield.type).toBe("http");
  expect(httpClaude.mcpServers.motionfield.url).toBe("http://127.0.0.1:8790/mcp");
  expect(httpClaude.mcpServers.motionfield.headers.Authorization).toContain("${MOTIONFIELD_API_KEY}");
  const httpCursor = JSON.parse(httpSnippets["http-cursor"]) as
    { mcpServers: { motionfield: { url: string; headers: Record<string, string> } } };
  expect(httpCursor.mcpServers.motionfield.headers.Authorization)
    .toBe("Bearer ${env:MOTIONFIELD_API_KEY}");
  expect(httpSnippets["http-codex"]).toContain("[mcp_servers.motionfield]");
  expect(httpSnippets["http-codex"]).toContain('url = "http://127.0.0.1:8790/mcp"');
  expect(httpSnippets["http-codex"]).toContain('bearer_token_env_var = "MOTIONFIELD_API_KEY"');
  const httpOpencode = JSON.parse(httpSnippets["http-opencode"]) as
    { mcp: { motionfield: { type: string; url: string; headers: Record<string, string> } } };
  expect(httpOpencode.mcp.motionfield.type).toBe("remote");
  expect(httpOpencode.mcp.motionfield.headers.Authorization).toContain("{env:MOTIONFIELD_API_KEY}");
  expect(httpSnippets["http-generic"]).toContain("Authorization: Bearer");

  /* the install block is a command, not a control - and it names the real script */
  const install = await page.getByTestId("mcp-install").innerText();
  expect(install).toContain("install-cli.sh");

  /* spawn motionfield-mcp exactly as the generic snippet says - command +
   * env keys, with the placeholder key/url swapped for the real ones */
  const generic = JSON.parse(snippets.generic) as { command: string; env: Record<string, string> };
  expect(generic.command).toBe("motionfield-mcp");
  expect(Object.keys(generic.env).sort()).toEqual(["MOTIONFIELD_API_KEY", "MOTIONFIELD_URL"]);

  const transport = new StdioClientTransport({
    command: generic.command,
    args: [],
    env: {
      ...process.env,
      PATH: `${prefix}/bin:${process.env.PATH ?? ""}`,
      MOTIONFIELD_URL: base,
      MOTIONFIELD_API_KEY: apiKey,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "s7-honest-e2e", version: "0" });
  let stderr = "";
  transport.stderr?.on("data", (c) => { stderr += c; });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    /* the advertised set is computed - core + the live 3d set for this
     * server's reported capabilities + catalog, never a hard-coded count */
    const ctx = await request.newContext({ baseURL: base });
    try {
      const auth = { authorization: `Bearer ${apiKey}` };
      const caps = ((await (await ctx.get("/api/v1/capabilities", { headers: auth })).json()) as { capabilities: string[] }).capabilities;
      const eps = ((await (await ctx.get("/api/v1/models", { headers: auth })).json()) as { models: { id: string }[] }).models.map((m) => m.id);
      expect(tools.map((t) => t.name).sort()).toEqual(advertisedSet(["core", "3d"], caps, eps));
    } finally {
      await ctx.dispose();
    }
  } finally {
    await client.close().catch(() => {});
    transport.close().catch(() => {});
  }
  expect(stderr).not.toContain(apiKey);
});
