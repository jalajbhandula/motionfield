/**
 * WS1 s10 Chrome extension e2e (OF-0875).
 *
 * Loads plugins/chrome as a REAL unpacked MV3 extension in the full headless
 * Chromium (extensions don't load in chromium-headless-shell - that's why
 * `channel: "chromium"`), drives the real options page, fires
 * self.motionfield.onMenuClick exactly the way the contextMenus listener does,
 * and asserts the resulting job is a real server-side jobs row (source=api)
 * that mock-generates to a real output - plus the popup rendering it.
 */
import { expect, test, chromium, request } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page, Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_DIR = resolve(__dirname, "../../plugins/chrome");
const base = `http://localhost:${process.env.PORT || "3100"}`;

// evaluate callbacks run inside the extension context where chrome.* exists;
// no @types/chrome in the repo - this narrow ambient covers exactly the
// surfaces the spec uses, so a typo'd call fails typecheck instead of passing
// through `any`.
interface ChromeArea {
  get(keys: string | string[] | null, cb: (v: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, cb?: () => void): void;
}
declare const chrome: {
  storage: { local: ChromeArea; sync: ChromeArea; onChanged: unknown };
  contextMenus: { create(opts: { id?: string; title?: string; contexts?: string[]; parentId?: string }): string };
  runtime: { getManifest(): Record<string, unknown>; openOptionsPage(): Promise<void> };
  permissions: { contains(perms: { origins: string[] }): Promise<boolean> };
};

const IMG_ENDPOINT = "motionfield/birefnet/remove-background"; // required: image_url only - no defaults
const VID_ENDPOINT = "motionfield/wan-vace/restyle";           // required: video_url only, resolution defaulted

/* a real (tiny) PNG - the extension reads content-type from the fixture
 * server, so the bytes just have to be real enough to upload */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
/* a real clip - the swap family's video_url gate probes duration before
 * charging, so fake bytes now 400 at submit instead of sailing through */
let MP4 = Buffer.alloc(0);

let ctx: BrowserContext;
let profileDir: string;
let extId = "";
let apiKey = "";
let api: APIRequestContext;
let fixture: Server;
let fixtureBase = "";
/** The endpoint the click tests use - the spec's birefnet/restyle entry when
 *  present, else its first entry. Set by the menu-spec test (serial order). */
let imagePick: MenuSpecEntry = { endpoint: "motionfield/birefnet/remove-background", label: "", field: "image_url", array: false };
let videoPick: MenuSpecEntry = { endpoint: "motionfield/wan-vace/restyle", label: "", field: "video_url", array: false };

interface MenuSpecEntry { endpoint: string; label: string; field: string; array: boolean }

/** The service worker - it can go idle between tests; a storage write wakes
 *  it through its onChanged listener (exactly what an options save does). */
async function sw(): Promise<Worker> {
  const found = ctx.serviceWorkers().find((w) => w.url().includes("sw.js"));
  if (found) return found;
  const p = await ctx.newPage();
  try {
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.evaluate(() => chrome.storage.local.set({ ofPoke: Date.now() }));
    const w = await ctx.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => null);
    if (!w) throw new Error("extension service worker did not wake");
    return w;
  } finally {
    await p.close();
  }
}

async function extPage(): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/options.html`);
  return p;
}

/** Mint an API key through the real /settings/keys UI - the one-time key is
 *  read back out of the show-once panel. The caller's page must be logged in. */
async function createKeyViaUi(page: Page, label: string): Promise<string> {
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill(label);
  await page.getByTestId("create-key").click();
  await expect(page.getByTestId("show-once")).toBeVisible();
  const key = (await page.getByTestId("key-value").innerText()).trim();
  expect(key).toMatch(/^of_[A-Za-z0-9]{12}_/);
  return key;
}

/** Read chrome.storage.local inside an extension page - chrome.* only exists there. */
async function storageGet(page: Page, keys: string | string[] | null = null) {
  return page.evaluate((k) => new Promise<Record<string, unknown>>((r) =>
    chrome.storage.local.get(k, (v: unknown) => r(v as Record<string, unknown>))), keys);
}

/** Patch chrome.contextMenus.create in the SW to record every created item
 *  (menus can't be enumerated via the API), then force a rebuild. */
async function createdMenus(worker: Worker): Promise<{ id?: string; title?: string; contexts?: string[] }[]> {
  await worker.evaluate(() => {
    const g = self as unknown as {
      __menuCalls: { id?: string; title?: string; contexts?: string[] }[];
      __menuPatched?: boolean;
      motionfield: { rebuildMenus: () => Promise<void> };
    };
    if (!g.__menuPatched) {
      const orig = chrome.contextMenus.create.bind(chrome.contextMenus);
      chrome.contextMenus.create = ((o: { id?: string; title?: string; contexts?: string[] }) => {
        g.__menuCalls.push(o);
        return orig(o);
      }) as typeof chrome.contextMenus.create;
      g.__menuPatched = true;
    }
    g.__menuCalls = [];
  });
  await worker.evaluate(() => (self as unknown as { motionfield: { rebuildMenus: () => Promise<void> } }).motionfield.rebuildMenus());
  return worker.evaluate(() => (self as unknown as { __menuCalls: { id?: string; title?: string; contexts?: string[] }[] }).__menuCalls);
}

interface V1Model {
  id: string; label: string; kind?: string; tags?: string[];
  license?: { class?: string };
  inputs?: {
    properties?: Record<string, {
      "x-media"?: string; type?: string; accepts?: string; default?: unknown;
      items?: { "x-media"?: string; accepts?: string };
    }>;
    required?: string[];
  };
}

/** The field names a click may fill for an endpoint: the picked media field
 *  plus every input that declares a schema `default`. */
function fillableFields(m: V1Model, field: string): { field: string; defaults: Map<string, unknown> } {
  const props = m.inputs?.properties ?? {};
  const defaults = new Map<string, unknown>();
  for (const [name, p] of Object.entries(props))
    if (name !== field && p?.default !== undefined) defaults.set(name, p.default);
  return { field, defaults };
}

/** menuSpec.image derived exactly the way the SW derives it - media x-media
 *  fields (property or items), every required input fillable (the picked
 *  field or a schema default), ordered by label, capped at 8. */
function expectedMenuSpec(models: V1Model[], mediaType: "image" | "video"): MenuSpecEntry[] {
  const match = (p?: { "x-media"?: string; accepts?: string; items?: { "x-media"?: string; accepts?: string } }) => {
    const m = p?.["x-media"] ?? p?.items?.["x-media"];
    if (m === mediaType) return true;
    if (m !== "media") return false;
    const acc = p?.accepts ?? p?.items?.accepts ?? "";
    return !acc || acc.includes(`${mediaType}/`);
  };
  return models
    .map((m) => {
      const props = m.inputs?.properties ?? {};
      const required = new Set(m.inputs?.required ?? []);
      let first: { field: string; array: boolean } | null = null;
      for (const [name, p] of Object.entries(props)) {
        if (!match(p)) continue;
        const cand = { field: name, array: p.type === "array" };
        if (required.has(name)) { first = cand; break; }
        first ??= cand;
      }
      if (!first) return null;
      // every required input must be the picked field or carry a default -
      // the click never invents a value
      const fill = [...required].every((n) => n === first.field || props[n]?.default !== undefined);
      return fill ? { m, pick: first } : null;
    })
    .filter((x): x is { m: V1Model; pick: { field: string; array: boolean } } => !!x)
    .sort((a, b) => a.m.label.localeCompare(b.m.label))
    .slice(0, 8)
    .map(({ m, pick }) => ({ endpoint: m.id, label: m.label, field: pick.field, array: pick.array }));
}

test.beforeAll(async () => {
  test.setTimeout(240_000); // cold `next dev` compiles signup + several API routes
  // the fixture clip is real h264 ≥4 s - wan-vace/restyle's minSeconds gate
  // probes the upload before charging, and fake bytes die at the door
  const clipFile = join(mkdtempSync(join(tmpdir(), "of-ext-")), "clip.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=5:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipFile,
  ]);
  MP4 = readFileSync(clipFile);
  // media fixture server - the extension fetches these through its own
  // permissions (127.0.0.1/* is a required host permission)
  fixture = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/img.png") { res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length }); return res.end(PNG); }
    if (p === "/clip.mp4") { res.writeHead(200, { "content-type": "video/mp4", "content-length": MP4.length }); return res.end(MP4); }
    if (p === "/page.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>not media</html>"); }
    if (p === "/media.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body><img src=\"/img.png\"></body></html>"); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  fixtureBase = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  profileDir = mkdtempSync(join(tmpdir(), "of-ext-profile-"));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",      // the full build - headless-shell can't load extensions
    headless: true,
    baseURL: base,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  extId = new URL(worker.url()).hostname;
  expect(extId).toBeTruthy();

  // real signup on the real app, then a real API key minted through the
  // /settings/keys UI - the same path a user takes
  const page = await ctx.newPage();
  try {
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("Chrome E2E");
    await page.getByPlaceholder("you@email.com").fill(`chrome-${Date.now()}@e2e.test`);
    await page.getByPlaceholder(/Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
    const sub = await page.request.post("/api/billing", { data: { action: "subscribe", plan_id: "pro" } });
    expect(sub.ok()).toBeTruthy();
    apiKey = await createKeyViaUi(page, "chrome-e2e");
  } finally {
    await page.close();
  }
  expect(apiKey).toMatch(/^of_/);

  api = await request.newContext({
    baseURL: base,
    extraHTTPHeaders: { authorization: `Bearer ${apiKey}` },
  });
});

test.afterAll(async () => {
  await api?.dispose().catch(() => {});
  await ctx?.close().catch(() => {});
  fixture?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

test.describe.serial("chrome extension e2e", () => {

  test("[OF-0875] unconfigured → setup menu only; a click reports not_configured", async () => {
    const worker = await sw();
    const calls = await createdMenus(worker);
    const titles = calls.map((c) => c.title);
    expect(titles).toEqual(["Set up MotionField…"]);
    expect(calls[0].contexts?.sort()).toEqual(["image", "video"]);
    // clicking anything still needs a config - the SW answers honestly and
    // opens the options page (an extra options tab may appear; harmless)
    const r = await worker.evaluate(
      (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
      { srcUrl: `${fixtureBase}/img.png`, mediaType: "image", endpoint: IMG_ENDPOINT });
    expect((r as { ok: boolean; error: { code: string } }).ok).toBe(false);
    expect((r as { ok: boolean; error: { code: string } }).error.code).toBe("not_configured");
  });

  test("[OF-0875] options page Check saves only after /me accepts; menus rebuild on save", async () => {
    const page = await extPage();
    try {
      // the key is NOT saved before a successful check
      await page.fill("#of-url", base);
      await page.fill("#of-key", "of_deadbeef_wrongkey");
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("key rejected", { timeout: 15_000 });
      let stored = await storageGet(page, "ofConfig");
      expect(stored.ofConfig).toBeUndefined();

      await page.fill("#of-key", apiKey);
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("connected - chrome-", { timeout: 15_000 });
      await expect(page.locator("#of-status")).toContainText("pro");
      stored = await storageGet(page, "ofConfig");
      const cfg = stored.ofConfig as { baseUrl: string; apiKey: string };
      expect(cfg.baseUrl).toBe(base);
      expect(cfg.apiKey).toBe(apiKey);
      // the key never roams - storage.sync must stay empty
      const syncAll = await page.evaluate(() =>
        new Promise<Record<string, unknown>>((r) => chrome.storage.sync.get(null, (v: unknown) => r(v as Record<string, unknown>))));
      expect(syncAll).toEqual({});
      // the menu rebuild (via storage.onChanged) ran on save
      await expect.poll(async () =>
        ((await storageGet(page, "ofMenuSpec")).ofMenuSpec as { image?: unknown[] })?.image?.length ?? 0,
        { timeout: 15_000 }).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] stored menu spec equals the API's image+video endpoints (≤8, ordered by label)", async () => {
    const page = await extPage();
    try {
      const { models } = await (await api.get("/api/v1/models")).json() as { models: V1Model[] };
      const spec = (await storageGet(page, "ofMenuSpec")).ofMenuSpec as { image: MenuSpecEntry[]; video: MenuSpecEntry[] };
      expect(spec.image).toEqual(expectedMenuSpec(models, "image"));
      expect(spec.video).toEqual(expectedMenuSpec(models, "video"));
      expect(spec.image.length).toBeGreaterThan(0);
      expect(spec.image.length).toBeLessThanOrEqual(8);
      expect(spec.video.length).toBeGreaterThan(0);
      // no fallbacks - the named endpoints must be in the spec the click
      // tests exercise, or the rest of this suite means nothing
      imagePick = spec.image.find((e) => e.endpoint === IMG_ENDPOINT)!;
      videoPick = spec.video.find((e) => e.endpoint === VID_ENDPOINT)!;
      expect(imagePick, `menu spec must contain ${IMG_ENDPOINT}`).toBeTruthy();
      expect(videoPick, `menu spec must contain ${VID_ENDPOINT}`).toBeTruthy();
      // and the catalog's upscale endpoint is one of the image items -
      // the spec is the real catalog, not the picked pair alone
      expect(spec.image.map((e) => e.endpoint)).toContain("motionfield/upscale/image");

      // every spec entry's required inputs are the picked field or carry a
      // schema default - a click never submits an invented value
      const byId = new Map(models.map((m) => [m.id, m]));
      for (const e of [...spec.image, ...spec.video]) {
        const m = byId.get(e.endpoint);
        expect(m, `spec endpoint ${e.endpoint} exists in /api/v1/models`).toBeTruthy();
        const { defaults } = fillableFields(m!, e.field);
        for (const r of m!.inputs?.required ?? [])
          expect(r === e.field || defaults.has(r), `${e.endpoint} required ${r}`).toBe(true);
        // and no restricted-license endpoint reaches a non-opted-in account's menu
        expect(m!.license?.class, `${e.endpoint} license`).not.toBe("restricted");
      }
      // the whole catalog served to this (non-opted) account is license-clean
      expect(models.every((m) => m.license?.class !== "restricted")).toBe(true);
      // x-media markers + model tags ride the schema (drives the menu pick)
      const img2img = byId.get("motionfield/z-image-turbo/img2img");
      expect(img2img?.inputs?.properties?.image_url?.["x-media"]).toBe("image");
      expect(Array.isArray(img2img?.tags)).toBe(true);
      // and the real menus Chrome built carry the same spec - one assert per
      // registered item id + contexts, not a shape check
      const worker = await sw();
      const calls = await createdMenus(worker);
      expect(calls[0].id).toBe("of-send");
      expect(calls[0].title).toBe("Send to MotionField");
      expect(calls[0].contexts?.sort()).toEqual(["image", "video"]);
      const menuById = new Map(calls.slice(1).map((c) => [c.id, c]));
      for (const e of spec.image) {
        const item = menuById.get(`of-ep:image:${e.endpoint}`);
        expect(item, `menu of-ep:image:${e.endpoint}`).toBeTruthy();
        expect(item!.title).toBe(e.label);
        expect(item!.contexts).toEqual(["image"]);
      }
      for (const e of spec.video) {
        const item = menuById.get(`of-ep:video:${e.endpoint}`);
        expect(item, `menu of-ep:video:${e.endpoint}`).toBeTruthy();
        expect(item!.title).toBe(e.label);
        expect(item!.contexts).toEqual(["video"]);
      }
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] options: non-covered hosts refuse honestly - insecure box or the grant hint", async () => {
    const page = await extPage();
    try {
      // http + a host the manifest doesn't cover → the insecure checkbox is
      // the only way forward (no silent fetch)
      await page.fill("#of-url", "http://example.com");
      await page.fill("#of-key", apiKey);
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("allow insecure", { timeout: 15_000 });
      // ::1 counts as remote - the manifest can't express it as a host pattern
      await page.fill("#of-url", "http://[::1]:3100");
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("allow insecure", { timeout: 15_000 });
      // an https host outside the required loopback permissions → the
      // options page says to grant site access, not a bare failure
      await page.fill("#of-url", "https://of.invalid");
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("grant site access first", { timeout: 15_000 });
      // restore the working config - nothing above should have saved
      await page.fill("#of-url", base);
      await page.click("#of-check");
      await expect(page.locator("#of-status")).toContainText("connected", { timeout: 15_000 });
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] image click uploads the media and submits a real job (source=api)", async () => {
    const ep = imagePick;
    const worker = await sw();
    const r = await worker.evaluate(
      (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
      { srcUrl: `${fixtureBase}/img.png`, mediaType: "image", endpoint: ep.endpoint }) as
      { ok: boolean; job?: { id: string; endpoint: string }; error?: { code: string; message: string } };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.job?.endpoint).toBe(ep.endpoint);

    // a real jobs row, owned by this key's user
    const view = await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json() as {
      endpoint: string; kind: string; params: Record<string, unknown>;
      source: string; status: string; outputs?: { url: string }[];
    };
    expect(view.endpoint).toBe(ep.endpoint);
    const { models } = await (await api.get("/api/v1/models")).json() as { models: V1Model[] };
    expect(view.kind).toBe(models.find((m) => m.id === ep.endpoint)?.kind);
    const sent = view.params[ep.field];
    const sentUrl = Array.isArray(sent) ? String(sent[0]) : String(sent);
    expect(sentUrl).toMatch(/^\/files\/uploads\//);
    expect(view.source).toBe("api");
    // params carry only the media field plus schema-declared defaults -
    // no stock prompt, no media copied into a field of the wrong kind
    const model = models.find((m) => m.id === ep.endpoint)!;
    const { field, defaults } = fillableFields(model, ep.field);
    for (const [k, v] of Object.entries(view.params)) {
      if (k === field) continue;
      expect(defaults.has(k), `${ep.endpoint} param "${k}" is neither the media field nor schema-defaulted`).toBe(true);
      expect(v, `${ep.endpoint} param "${k}"`).toEqual(defaults.get(k));
    }

    // mock generation completes with a real output (the SW's per-job polling
    // also ticks it forward - reads advance the job)
    await expect.poll(async () =>
      (await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json()).status,
      { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe("completed");
    const done = await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json();
    expect((done.outputs as { url: string }[])[0]?.url).toMatch(/^\/files\/generated\//);

    // and it's remembered in the recent list the popup reads
    const page = await extPage();
    try {
      // the SW's pollLive loop writes the terminal status a tick after the API
      // reports it - poll storage rather than assume the write already landed
      let recent: { id: string; endpoint: string; status: string }[] = [];
      await expect.poll(async () => {
        recent = ((await storageGet(page, "ofRecentJobs")).ofRecentJobs ?? []) as typeof recent;
        return recent[0]?.status;
      }, { timeout: 15_000 }).toBe("completed");
      expect(recent[0].id).toBe(r.job!.id);
      expect(recent.length).toBeLessThanOrEqual(20);
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] popup shows the completed job with a rendered >0-byte output", async () => {
    const popup = await ctx.newPage();
    try {
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await expect(popup.locator(".job").first()).toBeVisible({ timeout: 15_000 });
      await expect(popup.locator(".job .st").first()).toContainText("completed", { timeout: 30_000 });
      const out = popup.locator("[data-testid='output']").first();
      await expect(out).toBeVisible({ timeout: 15_000 });
      expect(Number(await out.getAttribute("data-bytes"))).toBeGreaterThan(0);
      await expect.poll(() => out.getAttribute("src"), { timeout: 15_000 }).toMatch(/^blob:/);
      const src = await out.getAttribute("src");
      expect(src).not.toContain(apiKey); // the bearer never reaches the DOM
      const body = await popup.locator("body").innerHTML();
      expect(body).not.toContain(apiKey);
    } finally {
      await popup.close();
    }
  });

  test("[OF-0875] bad media sources are refused honestly (file:, chrome:, non-media)", async () => {
    const worker = await sw();
    const before = (await (await api.get("/api/v1/jobs?limit=100")).json() as { jobs: unknown[] }).jobs.length;

    for (const [srcUrl, code] of [
      ["file:///etc/passwd", "bad_source"],
      ["chrome://settings", "bad_source"],
      ["blob:https://example.com/abc", "bad_source"],
      [`${fixtureBase}/page.html`, "unsupported_media_type"],
    ] as const) {
      const r = await worker.evaluate(
        (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
        { srcUrl, mediaType: "image", endpoint: imagePick.endpoint }) as { ok: boolean; error: { code: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error.code, `${srcUrl} → ${r.error.code}`).toBe(code);
      expect(r.error.message.length).toBeGreaterThan(0);
    }
    // no job was minted for any of them
    const after = await (await api.get("/api/v1/jobs?limit=100")).json() as { jobs: { id: string }[] };
    expect(after.jobs.length).toBe(before);
  });

  test("[OF-0875] data: media works the same path (upload → job → completed)", async () => {
    const worker = await sw();
    const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
    const r = await worker.evaluate(
      (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
      { srcUrl: dataUrl, mediaType: "image", endpoint: imagePick.endpoint }) as
      { ok: boolean; job?: { id: string }; error?: { code: string; message: string } };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await expect.poll(async () =>
      (await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json()).status,
      { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe("completed");
  });

  test("[OF-0875] video menu spec + video click submits on the picked video field", async () => {
    const vid = videoPick;
    expect(vid, "video spec non-empty").toBeTruthy();
    if (vid.endpoint === VID_ENDPOINT) expect(vid.field).toBe("video_url");

    const worker = await sw();
    const r = await worker.evaluate(
      (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
      { srcUrl: `${fixtureBase}/clip.mp4`, mediaType: "video", endpoint: vid.endpoint }) as
      { ok: boolean; job?: { id: string }; error?: { code: string; message: string } };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const view = await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json() as {
      endpoint: string; kind: string; params: Record<string, unknown>; source: string;
    };
    expect(view.endpoint).toBe(vid.endpoint);
    const { models } = await (await api.get("/api/v1/models")).json() as { models: V1Model[] };
    expect(view.kind).toBe(models.find((m) => m.id === vid.endpoint)?.kind);
    const sent = view.params[vid.field];
    const sentUrl = Array.isArray(sent) ? String(sent[0]) : String(sent);
    expect(sentUrl).toMatch(/^\/files\/uploads\//);
    expect(view.source).toBe("api");
    const vmodel = models.find((m) => m.id === vid.endpoint)!;
    const { field: vfield, defaults: vdefaults } = fillableFields(vmodel, vid.field);
    for (const [k, v] of Object.entries(view.params)) {
      if (k === vfield) continue;
      expect(vdefaults.has(k), `${vid.endpoint} param "${k}" is neither the media field nor schema-defaulted`).toBe(true);
      expect(v, `${vid.endpoint} param "${k}"`).toEqual(vdefaults.get(k));
    }
    await expect.poll(async () =>
      (await (await api.get(`/api/v1/jobs/${r.job!.id}`)).json()).status,
      { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe("completed");
  });

  test("[OF-0875] popup fetches each output once - ≤1 /files/generated/ request per job, stable blob src", async () => {
    const popup = await ctx.newPage();
    try {
      const genReqs: string[] = [];
      popup.on("request", (r) => { if (r.url().includes("/files/generated/")) genReqs.push(r.url()); });
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      const out = popup.locator("[data-testid='output']").first();
      await expect(out).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => out.getAttribute("src"), { timeout: 15_000 }).toMatch(/^blob:/);
      const src1 = await out.getAttribute("src");
      // five seconds covers ≥3 poll ticks - a re-fetch or a new blob url
      // would show up inside this window
      await popup.waitForTimeout(5000);
      const src2 = await out.getAttribute("src");
      expect(src2).toBe(src1);
      const perUrl = new Map<string, number>();
      for (const u of genReqs) perUrl.set(u, (perUrl.get(u) ?? 0) + 1);
      expect(perUrl.size).toBeGreaterThan(0);
      for (const [u, n] of perUrl) expect(n, u).toBeLessThanOrEqual(1);
    } finally {
      await popup.close();
    }
  });

  test("[OF-0875] the key never reaches a host page (content, console)", async () => {
    const page = await ctx.newPage();
    try {
      const consoleLines: string[] = [];
      page.on("console", (m) => consoleLines.push(m.text()));
      await page.goto(`${fixtureBase}/media.html`);
      await expect(page.locator("img")).toBeVisible();
      const worker = await sw();
      const r = await worker.evaluate(
        (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
        { srcUrl: `${fixtureBase}/img.png`, mediaType: "image", endpoint: imagePick.endpoint }) as
        { ok: boolean; error?: { code: string; message: string } };
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await page.content()).not.toContain(apiKey);
      for (const line of consoleLines) expect(line).not.toContain(apiKey);
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] MV3 module service worker, exact permissions, no content scripts", async () => {
    const worker = await sw();
    expect(new URL(worker.url()).pathname).toBe("/sw.js");
    const page = await extPage();
    try {
      const manifest = await page.evaluate(() => chrome.runtime.getManifest());
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(expect.arrayContaining(["contextMenus", "storage"]));
      expect(manifest.permissions).toHaveLength(2);
      expect(manifest.background).toEqual({ service_worker: "sw.js", type: "module" });
      expect("content_scripts" in manifest).toBe(false);
      // required hosts stay loopback-only - the broad grant is optional and
      // still not granted (the options page is the only place that asks)
      const granted = await page.evaluate(() =>
        chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }));
      expect(granted).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("[OF-0875] revoked key → click unauthorized, popup 'key rejected', no new job", async () => {
    const jobsCount = async (a: APIRequestContext) =>
      ((await (await a.get("/api/v1/jobs?limit=100")).json()) as { jobs: unknown[] }).jobs.length;
    const before = await jobsCount(api);

    // revoke through the real /settings/keys UI - the row testid embeds key_id
    const page = await ctx.newPage();
    try {
      await page.goto("/settings/keys");
      const keyRow = page.getByTestId(`key-row-${apiKey.split("_")[1]}`);
      await expect(keyRow).toBeVisible();
      page.once("dialog", (d) => void d.accept());
      await keyRow.getByRole("button", { name: "Revoke" }).click();
      await expect(keyRow.getByText("revoked")).toBeVisible();

      // the very next click is refused: /api/v1/models answers 401
      const worker = await sw();
      const r = await worker.evaluate(
        (a) => (self as unknown as { motionfield: { onMenuClick: (x: unknown) => Promise<unknown> } }).motionfield.onMenuClick(a),
        { srcUrl: `${fixtureBase}/img.png`, mediaType: "image", endpoint: imagePick.endpoint }) as
        { ok: boolean; error?: { code: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("unauthorized");

      // and the popup surfaces the same rejection
      const popup = await ctx.newPage();
      try {
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        await expect(popup.locator("#of-banner")).toContainText("key rejected", { timeout: 15_000 });
      } finally {
        await popup.close();
      }
    } finally {
      await page.close();
    }

    // the refused click minted nothing - verified through a fresh key minted
    // in the same UI (the revoked one can't read anymore)
    const verify = await ctx.newPage();
    try {
      const key2 = await createKeyViaUi(verify, "chrome-e2e-verify");
      const api2 = await request.newContext({
        baseURL: base,
        extraHTTPHeaders: { authorization: `Bearer ${key2}` },
      });
      try {
        expect(await jobsCount(api2)).toBe(before);
      } finally {
        await api2.dispose();
      }
    } finally {
      await verify.close();
    }
  });
});
