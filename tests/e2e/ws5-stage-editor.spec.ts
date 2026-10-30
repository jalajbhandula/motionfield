import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { llmEnvConfigured } from "@/lib/llm/index";
import { focalForHFov, hFov } from "@/lib/camera/lens";

/**
 * Stage (OF-s4): the /scene-3d scene list + /scene-3d/[id] grey-box editor.
 * Covers API ownership/concurrency, the prompt surface (LLM-gated and
 * stub-routed), and the real three.js editor - outliner, inspector, views,
 * camera path dragging, moves, keyframes, undo, autosave.
 */

const base = `http://localhost:${process.env.PORT || "3100"}`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test.describe.configure({ mode: "serial" });

// the no-LLM assertions only hold when the dev server's env has no provider
const envLlm = llmEnvConfigured();

/* ---------- helpers ---------- */

async function signup(ctx: APIRequestContext | { request: APIRequestContext }, label: string) {
  const api = "request" in ctx ? ctx.request : ctx;
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await api.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 Stage" } })).ok()
        || (await api.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

async function mkEmpty(ctx: APIRequestContext, title?: string) {
  const r = await ctx.post("/api/stage", { data: { empty: true } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; revision: number; scene: unknown };
}

const canvasSha = async (page: Page) =>
  sha(await page.evaluate(() => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png")));

async function canvasInk(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width; d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, d.width, d.height).data;
    const bg = (px[0] << 16) | (px[1] << 8) | px[2];
    let n = 0;
    for (let i = 0; i + 2 < px.length; i += 4 * 11) {
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (v !== bg) n++;
    }
    return n;
  });
}

async function waitInk(page: Page) {
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => canvasInk(page), { timeout: 30_000 }).toBeGreaterThan(30);
}

/** the test hook the editor mounts on window */
interface StageHook {
  scene: {
    meta: { duration: number; title: string; aspect: string; renderSize: { w: number; h: number } };
    env: { background: string; ambient: number; sun: { intensity: number; direction: number[] } };
    nodes: {
      id: string; name: string; kind: string; parent?: string;
      keys?: { t: number; path: string; value: unknown }[];
      transform: { pos: number[]; rot: number[]; scale: number[] };
      props: Record<string, unknown>;
    }[];
  };
  t: number;
  setT(t: number): void;
  cameraAt(t: number): { pos: number[]; yaw: number; pitch: number; roll: number; fov: number } | null;
  sample(t: number): Record<string, { pos: number[]; rot: number[]; scale: number[] }> | null;
  exportPath(): { frames: { t: number; pos: number[] }[] };
  handlePos(i: number): { x: number; y: number } | null;
  previewRev: number | null;
  previewScene: StageHook["scene"] | null;
  undoDepth: number;
  screenPos(id: string): { x: number; y: number } | null;
  screenPosAt(pos: number[]): { x: number; y: number } | null;
}
const stage = (page: Page) =>
  page.evaluate(() => (window as never as { __ofStage: StageHook }).__ofStage);
// functions don't serialize across evaluate - call them inside the page
const stageCameraAt = (page: Page, t: number) =>
  page.evaluate((tt) => (window as never as { __ofStage: StageHook }).__ofStage.cameraAt(tt), t);
const stageSample = (page: Page, t: number) =>
  page.evaluate((tt) => (window as never as { __ofStage: StageHook }).__ofStage.sample(tt), t);
const stageExportPath = (page: Page) =>
  page.evaluate(() => (window as never as { __ofStage: StageHook }).__ofStage.exportPath());
const stageHandlePos = (page: Page, i: number) =>
  page.evaluate((ii) => (window as never as { __ofStage: StageHook }).__ofStage.handlePos(ii), i);

const waitHook = (page: Page) =>
  page.waitForFunction(() => Boolean((window as never as { __ofStage?: unknown }).__ofStage));

/** set a React-controlled input's value (fires onChange) - for <input type=color> */
const setInputValue = (loc: ReturnType<Page["locator"]>, v: string) =>
  loc.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);

/** average RGB of a 5×5 patch at the canvas centre */
const centerPixel = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width; d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData((c.width >> 1) - 2, (c.height >> 1) - 2, 5, 5).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
    return [r / n, gg / n, b / n] as const;
  });

/* ================= API ownership / CRUD ================= */

test("stage API - create/list/put/revision/foreign-user/delete", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sa");
    await signup(B, "ws5sb");

    // anonymous is refused
    const anon = await playwrightRequest.newContext({ baseURL });
    const a401 = await anon.post("/api/stage", { data: { empty: true } });
    expect(a401.status()).toBe(401);
    await anon.dispose();

    const created = await mkEmpty(A);
    expect(created.revision).toBe(1);

    const list = await (await A.get("/api/stage")).json();
    expect(list.scenes.map((s: { id: string }) => s.id)).toContain(created.id);

    // full row loads
    const got = await A.get(`/api/stage/${created.id}`);
    expect(got.status()).toBe(200);
    const row = await got.json();
    expect(row.scene.nodes.some((n: { kind: string }) => n.kind === "camera")).toBeTruthy();

    // optimistic concurrency
    const stale = await A.put(`/api/stage/${created.id}`, {
      data: { base_revision: 99, title: "stale" },
    });
    expect(stale.status()).toBe(409);

    const saved = await A.put(`/api/stage/${created.id}`, {
      data: { base_revision: 1, title: "Renamed by test" },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).revision).toBe(2);

    // invalid scene → 400, stored row untouched
    const bad = await A.put(`/api/stage/${created.id}`, {
      data: { base_revision: 2, scene: { version: 1, meta: {}, env: {}, nodes: [] } },
    });
    expect(bad.status()).toBe(400);

    // everything foreign-user reads 404, never a leak
    for (const r of [
      await B.get(`/api/stage/${created.id}`),
      await B.put(`/api/stage/${created.id}`, { data: { base_revision: 2, title: "hijack" } }),
      await B.post(`/api/stage/${created.id}/prompt`, { data: { instruction: "x", base_revision: 2 } }),
      await B.delete(`/api/stage/${created.id}`),
    ]) expect(r.status()).toBe(404);

    // delete as the owner
    expect((await A.delete(`/api/stage/${created.id}`)).status()).toBe(200);
    expect((await A.get(`/api/stage/${created.id}`)).status()).toBe(404);
  } finally {
    await A.dispose(); await B.dispose();
  }
});

test("stage prompt routes - 503 NEEDS_LLM with no writer route; bad ids 404", async ({ baseURL }) => {
  test.skip(envLlm, "LLM_* set in runner env - no-LLM behavior can't be observed");
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sp");
    const gen = await A.post("/api/stage", { data: { prompt: "a lonely box" } });
    expect(gen.status()).toBe(503);
    expect((await gen.json()).code).toBe("NEEDS_LLM");

    const created = await mkEmpty(A);
    const pr = await A.post(`/api/stage/${created.id}/prompt`, {
      data: { instruction: "add a spotlight", base_revision: 1 },
    });
    expect(pr.status()).toBe(503);
  } finally {
    await A.dispose();
  }
});

/* ================= stub-writer flows ================= */

const STAGE_DRAFT = {
  title: "Stub scene",
  nodes: [
    { kind: "primitive", name: "Pedestal", shape: "box", size: [1.4, 0.4, 1.4], pos: [0, 0.2, 0], color: "#7a8296" },
    { kind: "mannequin", name: "Figure", pose: "stand", height: 1.7, pos: [0, 0.4, 0] },
    { kind: "camera", name: "Hero cam", pos: [5, 3, 7], rot: [-18, 36, 0], focalMm: 40, lookAt: "Pedestal" },
  ],
};

test("stub writer - prompt create lands a scene; refs w/o vision stay noted; foreign ref 404; prompt edit applies ops", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const calls: string[] = [];
  const stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        calls.push(body);
        const isOps = body.includes('"ops"');
        // the ops prompt embeds CURRENT SCENE - pull a real node id out so the
        // stub's update op lands on something that exists
        let target = "cam_main";
        try {
          const msg = (JSON.parse(body) as { messages: { role: string; content: string }[] })
            .messages.find((m) => m.role === "user")?.content ?? "";
          const m = /"id":"([A-Za-z][\w-]*)"/.exec(msg);
          if (m) target = m[1];
        } catch { /* keep default */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(
            isOps ? { ops: [{ op: "update", id: target, path: "name", value: "RenamedByStub" }] } : STAGE_DRAFT,
          ) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = (stub.address() as AddressInfo).port;

  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5st-a");
    await signup(B, "ws5st-b");
    // per-user Settings provider → writer route (no vision route on purpose)
    expect((await A.put("/api/llm/providers/custom", {
      data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
    })).status()).toBe(200);
    expect((await A.put("/api/llm/routes/writer", {
      data: { providerId: "custom", model: "stub-1" },
    })).status()).toBe(200);

    // A owns an upload; B's upload must 404 as A's ref
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upA = await A.post("/api/uploads", {
      multipart: { file: { name: "ref-a.png", mimeType: "image/png", buffer: png } },
    });
    expect(upA.status()).toBe(201);
    const urlA = (await upA.json()).url as string;
    const upB = await B.post("/api/uploads", {
      multipart: { file: { name: "ref-b.png", mimeType: "image/png", buffer: png } },
    });
    const urlB = (await upB.json()).url as string;

    const foreign = await A.post("/api/stage", { data: { prompt: "stage from ref", refs: [urlB] } });
    expect(foreign.status(), await foreign.text()).toBe(404);

    const gen = await A.post("/api/stage", { data: { prompt: "a pedestal figure", refs: [urlA] } });
    expect(gen.status(), await gen.text()).toBe(201);
    const created = await gen.json();
    expect(created.scene.nodes.length).toBeGreaterThanOrEqual(3);
    expect(created.refs_read).toBe(false); // no vision route - refs saved, not read
    expect(created.scene.nodes.filter((n: { kind: string }) => n.kind === "camera")).toHaveLength(1);

    // the editor surfaces the no-vision note
    const got = await A.get(`/api/stage/${created.id}`);
    const row = await got.json();
    expect(row.refs[0].url).toBe(urlA);
    expect(row.refs[0].description).toBeUndefined();

    // prompt edit - the stub reads a node id out of the request and renames it
    const firstId = row.scene.nodes[0].id as string;
    const edit = await A.post(`/api/stage/${created.id}/prompt`, {
      data: { instruction: "rename the first node", base_revision: row.revision },
    });
    expect(edit.status(), await edit.text()).toBe(200);
    const edited = await edit.json();
    expect(edited.revision).toBe(row.revision + 1);
    expect(edited.scene.nodes.find((n: { id: string }) => n.id === firstId).name).toBe("RenamedByStub");

    // a stale base_revision on the same route 409s
    const stale = await A.post(`/api/stage/${created.id}/prompt`, {
      data: { instruction: "again", base_revision: 1 },
    });
    expect(stale.status()).toBe(409);
  } finally {
    await A.dispose(); await B.dispose();
    stub.close();
  }
});

/* ================= the editor ================= */

test("editor - outliner/inspector/views/path/move/keys/undo/autosave", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5e");
  const created = await mkEmpty(page.request);

  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await page.waitForFunction(() => Boolean((window as unknown as { __ofStage?: unknown }).__ofStage));

  // outliner shows the empty scene's nodes
  for (const id of ["ground", "cam_main", "light_sun"]) {
    await expect(page.getByTestId(`outliner-${id}`)).toBeVisible();
  }

  // add a box - lands in the outliner and the canvas
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  // every row embeds a hidden parent <select> listing all nodes - match the
  // row whose own button carries the name, not descendant option text
  const primRow = page.locator("[data-testid^=outliner-]")
    .filter({ has: page.getByRole("button", { name: /primitive \d+/ }) });
  await expect(primRow).toBeVisible();

  // select it in the outliner → inspector fields show
  await primRow.getByRole("button", { name: /primitive \d+/ }).click();
  const beforeSha = await canvasSha(page);
  await page.getByLabel("X", { exact: true }).first().fill("3");
  await page.waitForTimeout(300);
  const afterSha = await canvasSha(page);
  expect(afterSha).not.toBe(beforeSha); // the block moved - paint changed

  // inspector-scene round trip via __ofStage
  const pos = (await stage(page)).scene.nodes.find((n) => n.name.startsWith("primitive"))!.transform.pos[0];
  expect(pos).toBe(3);

  // undo restores, redo replays
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(150);
  const undone = (await stage(page)).scene.nodes.find((n) => n.name.startsWith("primitive"))!.transform.pos[0];
  expect(undone).not.toBe(3);
  await page.getByRole("button", { name: "Redo" }).click();
  await page.waitForTimeout(150);
  const redone = (await stage(page)).scene.nodes.find((n) => n.name.startsWith("primitive"))!.transform.pos[0];
  expect(redone).toBe(3);

  // key the transform at t=0 → a diamond appears on its timeline row
  await primRow.getByRole("button", { name: /primitive \d+/ }).click();
  await page.getByRole("button", { name: /Key transform/ }).click();
  await expect(page.getByRole("button", { name: /key at 0s/ })).toHaveCount(1);

  // top view paints; camera view letterboxes to renderSize
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.waitForTimeout(200);
  expect(await canvasInk(page)).toBeGreaterThan(30);
  await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(200);
  const frame = page.locator(".camview-frame");
  await expect(frame).toBeVisible();
  const bb = await frame.boundingBox();
  expect(bb).toBeTruthy();
  expect(bb!.width / bb!.height).toBeCloseTo(16 / 9, 1);

  // aspect switches reshape the letterbox
  const ratios: Record<string, number> = {};
  for (const a of ["16:9", "1:1", "9:16"] as const) {
    await page.getByLabel("Aspect").selectOption(a);
    await page.waitForTimeout(120);
    const b = await frame.boundingBox();
    ratios[a] = b!.width / b!.height;
  }
  expect(ratios["1:1"]).toBeCloseTo(1, 1);
  expect(ratios["9:16"]).toBeLessThan(0.7);
  await page.getByLabel("Aspect").selectOption("16:9");

  // scrub via the hook → playhead reads it
  await page.evaluate(() => (window as never as { __ofStage: { setT(t: number): void } }).__ofStage.setT(3));
  await expect(page.getByTestId("playhead")).toHaveText("3.00s");

  // camera inspector → New path → handles visible → drag a point in Top view
  await page.getByTestId("outliner-cam_main").click();
  await page.getByRole("button", { name: "New path" }).click();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.waitForTimeout(250);
  // handle 0 sits at the camera's start pos - possibly outside the ±9 m top
  // view; handle 1 is the pulled-in midpoint, safely on-canvas
  const h0 = await stageHandlePos(page, 1);
  expect(h0).toBeTruthy();
  const pathBefore = JSON.stringify((await stage(page)).scene.nodes.find((n) => n.id === "cam_main"));
  await page.mouse.move(h0!.x, h0!.y);
  await page.mouse.down();
  await page.mouse.move(h0!.x + 60, h0!.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const pathAfter = JSON.stringify((await stage(page)).scene.nodes.find((n) => n.id === "cam_main"));
  expect(pathAfter).not.toBe(pathBefore); // dragging a control point rewrote the path

  // focal change re-inks the view (frustum helper) and the fov readout
  await page.getByRole("button", { name: "Persp" }).click();
  await page.waitForTimeout(250);
  const fSha0 = await canvasSha(page);
  const fov0 = await page.getByTestId("cam-fov").textContent();
  await page.getByLabel("Focal (mm)").fill("85");
  await page.waitForTimeout(300);
  const fSha1 = await canvasSha(page);
  expect(fSha1).not.toBe(fSha0);
  const fov1 = await page.getByTestId("cam-fov").textContent();
  expect(fov1).not.toBe(fov0);

  // apply a catalog move - rewrites the camera's keys; exported path differs
  const exp0 = await stageExportPath(page);
  await page.getByLabel("Camera move").selectOption("dolly-in");
  await page.getByRole("button", { name: "Apply move" }).click();
  await page.waitForTimeout(300);
  const keys = (await stage(page)).scene.nodes.find((n) => n.id === "cam_main")!.keys!.length;
  expect(keys).toBeGreaterThan(100);
  const exp1 = await stageExportPath(page);
  expect(exp1.frames).toHaveLength(15 * 24 + 1);
  expect(JSON.stringify(exp1.frames)).not.toBe(JSON.stringify(exp0.frames));

  // autosave lands, reload persists
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  await page.reload();
  await waitInk(page);
  const persisted = (await stage(page)).scene.nodes.some((n) => n.name.startsWith("primitive"));
  expect(persisted).toBeTruthy();
});

test("/scene-3d list - newest first, rename, delete, open", async ({ page }) => {
  test.setTimeout(120_000);
  await signup(page, "ws5l");
  await mkEmpty(page.request);
  const second = await mkEmpty(page.request);

  await page.goto("/scene-3d");
  await expect(page.getByText("My Scenes")).toBeVisible();
  const first = page.locator("ul li a").first();
  await expect(first).toHaveAttribute("href", `/scene-3d/${second.id}`); // newest first

  // rename inline
  page.once("dialog", (d) => d.accept("Renamed scene"));
  await page.locator("ul li").filter({ hasText: "Untitled scene" }).first()
    .getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Renamed scene")).toBeVisible();

  // delete removes the row
  page.once("dialog", (d) => d.accept());
  await page.locator("ul li").filter({ hasText: "Renamed scene" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Renamed scene")).toHaveCount(0);
});

/* ================= s4fix additions ================= */

const ASPECT_RATIO: Record<string, number> = {
  "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9,
};

test("[OF-0531][OF-0530] camera inspector - focal↔FOV both directions; path knots lie on the path; + Point mid-inserts", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5cam");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  await page.getByTestId("outliner-cam_main").getByRole("button").first().click();

  // focal → FOV readout: 50 mm on super35
  await page.getByLabel("Sensor").selectOption("super35");
  await page.getByLabel("Focal (mm)").fill("50");
  await page.waitForTimeout(300);
  const readout = await page.getByTestId("cam-fov").textContent();
  const shown = Number(/hFOV ([\d.]+)°/.exec(readout ?? "")?.[1]);
  expect(shown).toBeCloseTo(hFov(50, "super35"), 1);
  // a focal slider rides alongside the number field
  await expect(page.getByLabel("Focal slider")).toBeVisible();

  // FOV → focal: typing 60 writes focalForHFov(60, super35)
  await page.getByLabel("FOV °").fill("60");
  await page.waitForTimeout(300);
  const mm = Number((await stage(page)).scene.nodes.find((n) => n.id === "cam_main")!.props.focalMm);
  expect(mm).toBeCloseTo(focalForHFov(60, "super35"), 1);

  // camera path - New path → + Point mid-inserts a third valid knot
  await page.getByRole("button", { name: "New path" }).click();
  await page.getByRole("button", { name: "+ Point" }).click();
  await page.waitForTimeout(300);
  const cam = (await stage(page)).scene.nodes.find((n) => n.id === "cam_main")!;
  const p = cam.props.path as { points: number[][]; times: number[] };
  expect(p.points).toHaveLength(3);
  expect(p.times).toHaveLength(3);
  expect(p.times[1]).toBeCloseTo((p.times[0] + p.times[2]) / 2, 6);
  for (let c = 0; c < 3; c++) {
    expect(p.points[1][c]).toBeCloseTo((p.points[0][c] + p.points[2][c]) / 2, 5);
  }
  // every knot sits exactly on the sampled path
  for (let i = 0; i < p.points.length; i++) {
    const pose = await stageCameraAt(page, p.times[i]);
    expect(pose).toBeTruthy();
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(pose!.pos[c] - p.points[i][c])).toBeLessThan(1e-6);
    }
  }
});

test("[OF-0517][OF-0518] orbit drag + wheel repaint persp; the three views hash pairwise-differently and repaint identically", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5view");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  const canvas = page.locator("canvas");
  const bb = (await canvas.boundingBox())!;
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;

  const p1 = await canvasSha(page);
  // orbit drag changes the paint
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const p2 = await canvasSha(page);
  expect(p2).not.toBe(p1);
  // wheel zoom repaints too
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(400);
  const p3 = await canvasSha(page);
  expect(p3).not.toBe(p2);

  const hashes: Record<string, string> = {};
  for (const v of ["Persp", "Top", "Camera"] as const) {
    await page.getByRole("button", { name: v, exact: true }).click();
    await page.waitForTimeout(400);
    hashes[v] = await canvasSha(page);
  }
  expect(hashes.Persp).not.toBe(hashes.Top);
  expect(hashes.Persp).not.toBe(hashes.Camera);
  expect(hashes.Top).not.toBe(hashes.Camera);

  // s4fix regression - the through-camera view no longer sees its own lens
  const [r, g, b] = await centerPixel(page);
  const lensDist = Math.abs(r - 0x17) + Math.abs(g - 0x1b) + Math.abs(b - 0x22); // lens #171b22
  expect(lensDist).toBeGreaterThan(24);

  // each view repaints identically after a view round-trip
  for (const v of ["Persp", "Top", "Camera"] as const) {
    await page.getByRole("button", { name: v === "Persp" ? "Top" : "Persp", exact: true }).click();
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: v, exact: true }).click();
    await page.waitForTimeout(400);
    expect(await canvasSha(page)).toBe(hashes[v]);
  }
});

test("[OF-0519][OF-0520][OF-0521] the Add menu places sphere/pyramid/sun/point/spot/camera - each inks; render-camera switch stays editable", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5add");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  const adds: { item: string; match: (n: StageHook["scene"]["nodes"][number]) => boolean }[] = [
    { item: "Primitive · sphere", match: (n) => n.kind === "primitive" && n.props.shape === "sphere" },
    { item: "Primitive · pyramid", match: (n) => n.kind === "primitive" && n.props.shape === "pyramid" },
    { item: "Light · sun", match: (n) => n.kind === "light" && n.props.light === "sun" && n.id !== "light_sun" },
    { item: "Light · point", match: (n) => n.kind === "light" && n.props.light === "point" },
    { item: "Light · spot", match: (n) => n.kind === "light" && n.props.light === "spot" },
    { item: "Camera", match: (n) => n.kind === "camera" && n.id !== "cam_main" },
  ];
  for (const a of adds) {
    const before = await canvasSha(page);
    const count = (await stage(page)).scene.nodes.length;
    await page.getByRole("button", { name: "+ Add node" }).click();
    await page.getByRole("menuitem", { name: a.item }).click();
    await page.waitForTimeout(400);
    const sc = (await stage(page)).scene;
    expect(sc.nodes.length).toBe(count + 1);
    expect(sc.nodes.some(a.match)).toBeTruthy();
    expect(await canvasSha(page)).not.toBe(before);
  }
  // still exactly one render camera after all those adds
  expect((await stage(page)).scene.nodes.filter((n) => n.kind === "camera" && n.props.isRender)).toHaveLength(1);

  // s4fix regression - switching the render camera must not corrupt state
  const cam2 = (await stage(page)).scene.nodes.find((n) => n.kind === "camera" && n.id !== "cam_main")!;
  await page.getByTestId(`outliner-${cam2.id}`).getByRole("button").first().click();
  await page.getByLabel("Render camera").check();
  await page.waitForTimeout(400);
  const sc = (await stage(page)).scene;
  expect(sc.nodes.filter((n) => n.kind === "camera" && n.props.isRender)).toHaveLength(1);
  expect(sc.nodes.find((n) => n.id === cam2.id)!.props.isRender).toBe(true);
  // …and later edits still land (the old bug left 0 render cameras → all rejected)
  await page.getByLabel("Focal (mm)").fill("55");
  await page.waitForTimeout(400);
  await expect(page.getByText(/Edit rejected/)).toHaveCount(0);
  expect((await stage(page)).scene.nodes.find((n) => n.id === cam2.id)!.props.focalMm).toBe(55);
});

test("[OF-0525][OF-0535] rename/delete/reparent through the UI; undo restores deep-equal, redo re-deletes; 100 edits undo cleanly", async ({ page }) => {
  test.setTimeout(300_000);
  await signup(page, "ws5ops");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  const addBox = async () => {
    await page.getByRole("button", { name: "+ Add node" }).click();
    await page.getByRole("menuitem", { name: "Primitive · box" }).click();
    await page.waitForTimeout(300);
    const sc = (await stage(page)).scene;
    return sc.nodes[sc.nodes.length - 1].id;
  };
  const idA = await addBox();
  const idB = await addBox();
  const rowA = page.getByTestId(`outliner-${idA}`);
  const rowB = page.getByTestId(`outliner-${idB}`);

  // rename through the inspector
  await rowA.getByRole("button").first().click();
  await page.getByLabel("Node name").fill("Hero Box");
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === idA)!.name).toBe("Hero Box");

  // reparent B under A through the row's parent select (hover reveals it)
  await rowB.hover();
  await rowB.locator("select").selectOption(idA);
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === idB)!.parent).toBe(idA);

  // delete B through the row's × - undo restores it deep-equal, redo re-deletes
  const bJson = JSON.stringify((await stage(page)).scene.nodes.find((n) => n.id === idB));
  await rowB.hover();
  await rowB.getByRole("button", { name: /^Delete / }).click();
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === idB)).toBeUndefined();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(250);
  const restored = (await stage(page)).scene.nodes.find((n) => n.id === idB);
  expect(JSON.stringify(restored)).toBe(bJson);
  expect(restored!.parent).toBe(idA);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === idB)).toBeUndefined();

  // 100 edits through the inspector, then 100 undos → the document is the
  // original. fill + Enter = one edit each (typing previews, Enter commits -
  // without a commit the fill is one live preview, not a stack entry)
  await rowA.getByRole("button").first().click();
  const orig = JSON.stringify((await stage(page)).scene);
  const xField = page.getByLabel("X", { exact: true }).first();
  for (let i = 1; i <= 100; i++) { await xField.fill(String(i)); await xField.press("Enter"); }
  await page.waitForTimeout(400);
  for (let i = 0; i < 100; i++) await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(600);
  expect(JSON.stringify((await stage(page)).scene)).toBe(orig);
});

test("[OF-0526] keys at t=0 and t=2 via the UI put the node halfway at t=1; timeline drags + deletes keys", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5key");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  await page.getByLabel("Duration").fill("4"); // a 4 s scene: ruler centre = t=2
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  const boxId = (await stage(page)).scene.nodes.at(-1)!.id;
  await page.getByTestId(`outliner-${boxId}`).getByRole("button").first().click();

  await page.getByLabel("X", { exact: true }).first().fill("0");
  await page.getByRole("button", { name: /Key transform/ }).click(); // key @ t=0

  // seek to t=2 through the timeline ruler
  const ruler = page.getByTestId("stage-timeline").locator("div").first();
  const rb = (await ruler.boundingBox())!;
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await expect(page.getByTestId("playhead")).toHaveText(/^2\.0/);

  await page.getByLabel("X", { exact: true }).first().fill("4");
  await page.getByRole("button", { name: /Key transform/ }).click(); // key @ t≈2
  await page.waitForTimeout(250);

  const posKeys = (await stage(page)).scene.nodes.find((n) => n.id === boxId)!
    .keys!.filter((k) => k.path === "transform.pos").map((k) => k.t).sort((a, b) => a - b);
  expect(posKeys[0]).toBeCloseTo(0, 3);
  expect(posKeys[1]).toBeGreaterThan(1.9);
  expect(posKeys[1]).toBeLessThan(2.1);

  const s1 = await stageSample(page, 1);
  const x1 = s1![boxId].pos[0];
  expect(Math.abs(x1 - (4 / posKeys[1]))).toBeLessThan(0.04); // the real interpolation is exact
  expect(Math.abs(x1 - 2)).toBeLessThan(0.1);                  // i.e. halfway, ±1% span

  // timeline: drag the later diamond left - every key at that t moves, one commit
  const diamond = page.getByRole("button", { name: /key at 2(\.\d+)?s/ }).first();
  const db = (await diamond.boundingBox())!;
  const rowW = (await page.locator("[data-keyrow]").first().boundingBox())!.width;
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2 - rowW * 0.1, db.y + db.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const times = () => (stage(page)).then((s) =>
    [...new Set(s.scene.nodes.find((n) => n.id === boxId)!.keys!.map((k) => k.t))].sort((a, b) => a - b));
  const moved = await times();
  expect(moved).toHaveLength(2);
  expect(moved[1]).toBeLessThan(1.9);
  expect(moved[1]).toBeGreaterThan(1.5);

  // one undo rolls the whole drag back
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(250);
  expect((await times())[1]).toBeCloseTo(posKeys[1], 3);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.waitForTimeout(250);
  expect((await times())[1]).toBeCloseTo(moved[1], 3);

  // click-select the diamond → its × removes every key at that t
  await page.getByRole("button", { name: /key at 1\.\d+s/ }).first().click();
  await page.getByRole("button", { name: /Delete key at/ }).click();
  await page.waitForTimeout(250);
  const after = await times();
  expect(after).toHaveLength(1);
  expect(after[0]).toBeCloseTo(0, 3);
});

test("[OF-0515][OF-0516][OF-0524] duration 0.5/61 are 400, default is 15 s; all six aspects reshape the letterbox; scene-panel env edits repaint", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5dur");
    for (const duration of [0.5, 61]) {
      expect((await A.post("/api/stage", { data: { empty: true, duration } })).status()).toBe(400);
    }
    const created = await A.post("/api/stage", { data: { empty: true } });
    expect((await created.json()).scene.meta.duration).toBe(15);
  } finally {
    await A.dispose();
  }

  await signup(page, "ws5dur-ui");
  const mine = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${mine.id}`);
  await waitInk(page);
  await waitHook(page);

  // scene panel with nothing selected - env edits land and repaint
  const panel = page.locator('[aria-label="Scene panel"]');
  await expect(panel).toBeVisible();
  const expectInkChange = async (fn: () => Promise<void>) => {
    const h0 = await canvasSha(page);
    await fn();
    await page.waitForTimeout(450);
    expect(await canvasSha(page)).not.toBe(h0);
  };
  await expectInkChange(() => setInputValue(panel.getByLabel("Background"), "#663344"));
  await expectInkChange(() => panel.getByLabel("Ambient").fill("1.9"));
  await expectInkChange(() => panel.getByLabel("Sun intensity").fill("4.2"));
  await panel.getByLabel("X", { exact: true }).fill("-0.2"); // sun direction X
  const env = (await stage(page)).scene.env;
  expect(env.background).toBe("#663344");
  expect(env.ambient).toBeCloseTo(1.9, 5);
  expect(env.sun.intensity).toBeCloseTo(4.2, 5);
  expect(env.sun.direction[0]).toBeCloseTo(-0.2, 5);

  // render size through the same panel - W is editable, H follows the
  // aspect lock (16:9 → 640×360) and is a read-only readout
  await panel.getByLabel("W", { exact: true }).fill("640");
  await panel.getByLabel("W", { exact: true }).press("Enter");
  await page.waitForTimeout(200);
  expect((await stage(page)).scene.meta.renderSize).toEqual({ w: 640, h: 360 });
  await expect(panel.getByLabel("H", { exact: true })).toHaveValue("360");

  // all six aspects reshape the camera letterbox to their own ratio
  await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(300);
  const frame = page.locator(".camview-frame");
  const ratios = new Set<string>();
  for (const a of Object.keys(ASPECT_RATIO)) {
    await page.getByLabel("Aspect").selectOption(a);
    await page.waitForTimeout(180);
    const bb = await frame.boundingBox();
    expect(bb!.width / bb!.height).toBeCloseTo(ASPECT_RATIO[a], 1);
    ratios.add((bb!.width / bb!.height).toFixed(2));
  }
  expect(ratios.size).toBe(6);
});

test("[OF-0546] save→reload is deep-equal; stale PUT 409s with the real head; a 300 KB chunked PUT is 413; a My Scenes rename survives autosave", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5save");
  const created = await mkEmpty(page.request);

  // s4fix regression - rename on My Scenes, then prove an edit+autosave keeps it
  await page.goto("/scene-3d");
  page.once("dialog", (d) => d.accept("Survivor"));
  await page.locator("ul li").filter({ hasText: "Untitled scene" })
    .getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Survivor")).toBeVisible();

  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);
  await expect(page.getByLabel("Scene title")).toHaveValue("Survivor");

  // an edit (scene panel, nothing selected) → commit → autosave → the name persists
  const amb = page.locator('[aria-label="Scene panel"]').getByLabel("Ambient");
  await amb.fill("1.4");
  await amb.press("Enter"); // typing previews; Enter blurs → one commit
  await page.evaluate(() => (window as never as { __ofStage: { flushSaves(): Promise<void> } }).__ofStage.flushSaves());
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
  const rowAfterSave = await (await page.request.get(`/api/stage/${created.id}`)).json();
  expect(rowAfterSave.title).toBe("Survivor");
  expect(rowAfterSave.scene.meta.title).toBe("Survivor");

  // save → reload round-trips the document
  const before = (await stage(page)).scene;
  await page.reload();
  await waitInk(page);
  await waitHook(page);
  expect((await stage(page)).scene).toEqual(before);

  // stale base_revision → 409 + the real head revision
  const head = (await (await page.request.get(`/api/stage/${created.id}`)).json()).revision as number;
  const stale = await page.request.put(`/api/stage/${created.id}`, {
    data: { base_revision: head + 7, title: "stale" },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).head_revision).toBe(head);

  // chunked (no content-length) 300 KB → cut mid-stream at the 260 KB cap
  const cookie = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${base}/api/stage/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    // a node Readable body → chunked transfer encoding; duplex required by undici
    body: Readable.from([Buffer.alloc(300 * 1024, 0x61)]) as unknown as BodyInit,
    ...({ duplex: "half" } as { duplex: "half" }),
  });
  expect(res.status).toBe(413);
});

test("[OF-0512] no writer configured → the alert offers an editable Empty scene", async ({ page }) => {
  test.skip(envLlm, "LLM_* set in runner env - the no-writer path can't be observed");
  test.setTimeout(120_000);
  await signup(page, "ws5nollm");
  await page.goto("/scene-3d");
  await page.getByLabel("Scene prompt").fill("a pedestal between two crates");
  await page.getByRole("button", { name: "Generate scene" }).click();
  const alert = page.locator('p[role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("no LLM configured");
  await alert.getByRole("button", { name: "Empty scene" }).click();
  await page.waitForURL(/\/scene-3d\//);
  await waitInk(page);
  await waitHook(page);
  // the editor is live - an inspector edit lands
  await page.getByTestId("outliner-ground").getByRole("button").first().click();
  await page.getByLabel("X", { exact: true }).first().fill("2");
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === "ground")!.transform.pos[0]).toBe(2);
});

test("[OF-0532][OF-0533][OF-0513] stub writer - selection-scoped prompt edits only that node; unscoped edits env; unknown op path 400s; unread-refs note", async ({ page }) => {
  test.setTimeout(240_000);
  // the stub: create → STAGE_DRAFT; ops calls branch on the instruction -
  // "badpath" returns an unknown update path, a SELECTION op hits that node
  // only, anything else unscoped sets env.ambient=1.8
  const stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        let content: unknown = STAGE_DRAFT;
        try {
          const msg = (JSON.parse(body) as { messages: { role: string; content: string }[] })
            .messages.find((m) => m.role === "user")?.content ?? "";
          const sel = /SELECTION: only node "([^"]+)"/.exec(msg);
          const firstId = /"id":"([A-Za-z][\w-]*)"/.exec(msg)?.[1] ?? "cam_main";
          if (msg.includes("INSTRUCTION: badpath")) {
            content = { ops: [{ op: "update", id: firstId, path: "props.nope", value: 1 }] };
          } else if (sel) {
            content = { ops: [{ op: "update", id: sel[1], path: "name", value: "OnlySelected" }] };
          } else if (msg.includes("INSTRUCTION:")) {
            content = { ops: [{ op: "set_env", env: { ambient: 1.8 } }] };
          }
        } catch { /* keep the draft */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = (stub.address() as AddressInfo).port;

  try {
    await signup(page, "ws5stub2");
    expect((await page.request.put("/api/llm/providers/custom", {
      data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
    })).status()).toBe(200);
    expect((await page.request.put("/api/llm/routes/writer", {
      data: { providerId: "custom", model: "stub-1" },
    })).status()).toBe(200);

    // an owned ref, no vision route → saved unread
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const up = await page.request.post("/api/uploads", {
      multipart: { file: { name: "ref.png", mimeType: "image/png", buffer: png } },
    });
    const url = (await up.json()).url as string;
    const gen = await page.request.post("/api/stage", { data: { prompt: "pedestal scene", refs: [url] } });
    expect(gen.status(), await gen.text()).toBe(201);
    const created = await gen.json();
    expect(created.refs_read).toBe(false);

    await page.goto(`/scene-3d/${created.id}`);
    await waitInk(page);
    await waitHook(page);

    // [OF-0513] the "weren't read" note is visible in the editor
    await expect(page.getByText(/weren't read/)).toBeVisible();

    // select the box - a scoped prompt may only change it
    const sc0 = (await stage(page)).scene;
    const box = sc0.nodes.find((n) => n.kind === "primitive" && n.props.shape === "box")!;
    await page.getByTestId(`outliner-${box.id}`).getByRole("button").first().click();
    await page.getByLabel("Edit prompt").fill("rename it");
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect.poll(
      async () => (await stage(page)).scene.nodes.find((n) => n.id === box.id)?.name,
      { timeout: 30_000 },
    ).toBe("OnlySelected");
    const sc1 = (await stage(page)).scene;
    expect(sc1.nodes.length).toBe(sc0.nodes.length);
    for (const n of sc1.nodes) {
      if (n.id === box.id) continue;
      expect(JSON.stringify(n)).toBe(JSON.stringify(sc0.nodes.find((b) => b.id === n.id)));
    }
    expect(sc1.env).toEqual(sc0.env);

    // deselect: click empty canvas sky → nothing selected (scene panel returns)
    const cb = (await page.locator("canvas").boundingBox())!;
    await page.mouse.click(cb.x + 10, cb.y + 10);
    await expect(page.locator('[aria-label="Scene panel"]')).toBeVisible();

    // unscoped prompt - env changes scene-wide
    await page.getByLabel("Edit prompt").fill("brighten the room");
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect.poll(async () => (await stage(page)).scene.env.ambient, { timeout: 30_000 })
      .toBeCloseTo(1.8, 5);

    // an unknown op path → 400; the stored scene is untouched
    const row0 = await (await page.request.get(`/api/stage/${created.id}`)).json();
    const bad = await page.request.post(`/api/stage/${created.id}/prompt`, {
      data: { instruction: "badpath", base_revision: row0.revision },
    });
    expect(bad.status(), await bad.text()).toBe(400);
    const row1 = await (await page.request.get(`/api/stage/${created.id}`)).json();
    expect(row1.revision).toBe(row0.revision);
    expect(JSON.stringify(row1.scene)).toBe(JSON.stringify(row0.scene));
  } finally {
    stub.close();
  }
});

test("C1 - SIGTERM to an exporter running without --base exits 143 and leaves no descendants", async () => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(path.join(tmpdir(), "of-exp-c1-"));
  /* the exporter spawns its own `next dev` in a shadow project so it writes
   * its own .next, never the live e2e server's tree. The shadow must be a
   * REAL tree - Turbopack panics resolving through a symlinked project root
   * ("symlink target leaves the filesystem root"), so copies it is. APFS
   * clonefile (cp -c) makes real entries that share disk blocks; a serial
   * clone of ~200 k node_modules files takes minutes, so that dir fans out
   * per top-level entry. Falls back to plain cp -R off APFS. */
  const farm = mkdtempSync(path.join(tmpdir(), "of-exp-farm-"));
  const wt = process.cwd();
  let cpFlags = ["-Rc"];
  try { execFileSync("cp", ["-c", path.join(wt, "package.json"), path.join(dir, "_probe")]); }
  catch { cpFlags = ["-R"]; }
  const cp = (src: string, dstDir: string) =>
    new Promise<void>((res, rej) => {
      const p = spawn("cp", [...cpFlags, src, dstDir], { stdio: "ignore" });
      p.on("error", rej);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`cp ${src} → exit ${c}`))));
    });
  const top = readdirSync(wt).filter((n) =>
    !n.startsWith(".") && n !== "node_modules" && n !== "test-results" && n !== "public");
  await Promise.all(top.map((n) => {
    const src = path.join(wt, n);
    // clone the link target, not the link - a symlinked root is what broke
    return cp(lstatSync(src).isSymbolicLink() ? path.join(wt, readlinkSync(src)) : src, farm);
  }));
  // Runtime uploads/outputs are mutable and irrelevant to this box render.
  // Copy only static public assets so concurrent generation cannot race cp.
  mkdirSync(path.join(farm, "public"), { recursive: true });
  await Promise.all(readdirSync(path.join(wt, "public")).filter((n) => n !== "files").map((n) =>
    cp(path.join(wt, "public", n), path.join(farm, "public"))));
  mkdirSync(path.join(farm, "node_modules"), { recursive: true });
  const nm = readdirSync(path.join(wt, "node_modules"));
  for (let i = 0; i < nm.length; i += 10) {
    await Promise.all(nm.slice(i, i + 10).map((n) =>
      cp(path.join(wt, "node_modules", n), path.join(farm, "node_modules"))));
  }
  let proc: ReturnType<typeof spawn> | null = null;
  try {
    const specFile = path.join(dir, "spec.json");
    const out = path.join(dir, "out.mp4");
    writeFileSync(specFile, JSON.stringify({
      version: 1, width: 320, height: 180, fps: 24, duration: 30, seed: 7,
      background: { color: "#000000" },
      camera: { keyframes: [{ t: 0, position: [0, 0, 8], target: [0, 0, 0] }] },
      layers: [
        { id: "block", type: "box", props: { width: 2, height: 2, depth: 1, color: "#ff6600" } },
      ],
    }));
    proc = spawn(process.execPath, [
      "--experimental-strip-types", path.join(wt, "scripts/render/export.ts"),
      "--spec", specFile, "--out", out,
    ], {
      cwd: farm,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "e2e-secret-0123456789abcdef0123456789abcdef",
        PGLITE_DIR: path.join(farm, ".data", "pglite"),
      },
    });
    const procLog: string[] = [];
    proc.stdout?.on("data", (d) => procLog.push(String(d)));
    proc.stderr?.on("data", (d) => procLog.push(String(d)));

    // ps-tree bookkeeping. Two kinds of descendants:
    //  - ppid chain - normal children (ffmpeg, chromium helpers)
    //  - pgid - the exporter spawns its dev server `detached`, so the server
    //    leads its own group (pgid = its pid). next dev's re-exec'd children
    //    can be re-parented off the ppid chain (double-fork); the group id
    //    still gives them away as long as the leader was seen once.
    const descendants = new Set<number>();
    const commOf = new Map<number, string>();
    const collect = () => {
      try {
        const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" });
        const rows: { pid: number; ppid: number; pgid: number; comm: string }[] = [];
        for (const line of ps.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4] });
        }
        const parent = new Map<number, number>(rows.map((r) => [r.pid, r.ppid] as const));
        const under = (p: number) => {
          let cur = p;
          for (let i = 0; i < 40; i++) {
            const pp = parent.get(cur);
            if (pp == null) return false;
            if (pp === proc!.pid) return true;
            cur = pp;
          }
          return false;
        };
        for (let pass = 0; pass < 3; pass++) {
          let grew = false;
          for (const r of rows) {
            if (r.pid === proc!.pid || descendants.has(r.pid)) continue;
            if (under(r.pid) || (r.pgid > 1 && descendants.has(r.pgid))) {
              descendants.add(r.pid);
              commOf.set(r.pid, r.comm);
              grew = true;
            }
          }
          if (!grew) break;
        }
      } catch { /* ps is best-effort */ }
    };

    // SIGTERM goes out right after the exporter logs its first "frame i/N" -
    // by then the whole pipeline exists: dev server up (the previous race -
    // it can take tens of seconds to appear), chromium launched, ffmpeg
    // consuming frames. The render is long enough (720 real frames - an
    // empty 128×96 spec could finish inside the poll window) that it is
    // still mid-run when the signal lands - a finished exporter removes its
    // signal handlers in the finally, and a SIGTERM in that drain window
    // kills it raw (close code null) instead of exiting 143.
    const t0 = Date.now();
    let sawServer = false;
    let sawFrame = false;
    while (Date.now() - t0 < 150_000) {
      collect();
      if (!sawServer && [...descendants].some((p) => /next|node/i.test(commOf.get(p) ?? ""))) sawServer = true;
      if (/^frame \d+\/\d+/m.test(procLog.join(""))) { sawFrame = true; break; }
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    collect();
    const tail = () => `exporter log: ${procLog.join("").slice(-1500)}`;
    expect(sawServer, tail()).toBe(true);
    expect(sawFrame, tail()).toBe(true);
    expect(descendants.size).toBeGreaterThan(0);
    expect(proc.exitCode, tail()).toBe(null); // killed mid-render, not post-exit

    proc.kill("SIGTERM");
    const code = await new Promise<number>((res) => {
      proc!.on("close", (c) => res(c ?? -1));
      setTimeout(() => res(-9), 30_000);
    });
    collect();
    expect(code).toBe(143); // the signal handler's cleanup → exit 143
    // never produced a valid video - a mid-render kill can leave an unclosed
    // mp4 stub (moov is written on close), but ffprobe must fail on it
    let validVideo = true;
    try {
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", out],
        { stdio: ["ignore", "pipe", "pipe"] });
    } catch { validVideo = false; }
    expect(validVideo).toBe(false);

    const alive: number[] = [];
    for (const pid of descendants) {
      for (let i = 0; i < 30; i++) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); }
        catch { break; }
        if (i === 29) alive.push(pid);
      }
    }
    expect(alive).toEqual([]);
  } finally {
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    rmSync(farm, { recursive: true, force: true });
  }
});

/* ================= s4fix2 additions ================= */

const stageDrawn = (page: Page, id: string) =>
  page.evaluate((i) => (window as never as { __ofStage: { drawn(id: string): boolean } }).__ofStage.drawn(i), id);
const stageScreenPos = (page: Page, id: string) =>
  page.evaluate((i) => (window as never as { __ofStage: { screenPos(id: string): { x: number; y: number } | null } }).__ofStage.screenPos(i), id);
const stageSel = (page: Page) =>
  page.evaluate(() => (window as never as { __ofStage: { sel: string | null } }).__ofStage.sel);

test("s4fix2 - Camera view hides only the render cam's gizmo: render-switch restores, mounted nodes draw, path hides", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5camv");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  // a second camera joins as non-render
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(300);
  const cam2 = (await stage(page)).scene.nodes.find((n) => n.kind === "camera" && n.id !== "cam_main")!.id;

  // Camera view: the render cam's own gizmo hides, the other camera's stays
  await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(400);
  expect(await stageDrawn(page, "cam_main")).toBe(false);
  expect(await stageDrawn(page, cam2)).toBe(true);

  // switch the render camera while IN Camera view - cam_main's gizmo must
  // come straight back (the old bug hid its whole root and never restored)
  await page.getByTestId(`outliner-${cam2}`).getByRole("button").first().click();
  await page.getByLabel("Render camera").check();
  await page.waitForTimeout(400);
  expect(await stageDrawn(page, cam2)).toBe(false);
  expect(await stageDrawn(page, "cam_main")).toBe(true);

  // move cam2 (still selected) well clear - its frustum-helper lines raycast
  // with a fat threshold and must not overlap the click on cam_main's gizmo
  await page.getByLabel("X", { exact: true }).first().fill("-6");
  await page.getByLabel("Z", { exact: true }).first().fill("-4");
  await page.waitForTimeout(250);

  // Persp keeps it drawn - and it click-selects through the canvas picker
  await page.getByRole("button", { name: "Persp", exact: true }).click();
  await page.waitForTimeout(400);
  expect(await stageDrawn(page, "cam_main")).toBe(true);
  expect(await stageDrawn(page, cam2)).toBe(true);
  const pos = await stageScreenPos(page, "cam_main");
  expect(pos).toBeTruthy();
  await page.mouse.click(pos!.x, pos!.y);
  await page.waitForTimeout(250);
  expect(await stageSel(page)).toBe("cam_main");

  // back in Camera view: a box mounted on the render camera still draws
  await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  const boxId = (await stage(page)).scene.nodes.at(-1)!.id;
  const boxRow = page.getByTestId(`outliner-${boxId}`);
  await boxRow.hover();
  await boxRow.locator("select").selectOption(cam2);
  await page.waitForTimeout(300);
  expect((await stage(page)).scene.nodes.find((n) => n.id === boxId)!.parent).toBe(cam2);
  expect(await stageDrawn(page, boxId)).toBe(true);

  // the render camera's path line + knot handles don't draw in Camera view
  await page.getByTestId(`outliner-${cam2}`).getByRole("button").first().click();
  await page.getByRole("button", { name: "New path" }).click();
  await page.waitForTimeout(300);
  expect(await stageDrawn(page, "$path")).toBe(false);
  expect(await stageDrawn(page, "$handle:0")).toBe(false);
  expect(await stageDrawn(page, "$handle:1")).toBe(false);
  // …but they come back in Persp
  await page.getByRole("button", { name: "Persp", exact: true }).click();
  await page.waitForTimeout(400);
  expect(await stageDrawn(page, "$path")).toBe(true);
});

test("s4fix2 - deleting a parented node removes its mesh: drawn false, Persp paint identical to before the add", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5delp");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  const before = await canvasSha(page); // persp, nothing selected
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  const boxId = (await stage(page)).scene.nodes.at(-1)!.id;

  const row = page.getByTestId(`outliner-${boxId}`);
  await row.hover();
  await row.locator("select").selectOption("ground");
  await page.waitForTimeout(300);
  expect((await stage(page)).scene.nodes.find((n) => n.id === boxId)!.parent).toBe("ground");
  expect(await stageDrawn(page, boxId)).toBe(true);

  await row.hover();
  await row.getByRole("button", { name: /^Delete / }).click();
  await page.waitForTimeout(400);
  expect((await stage(page)).scene.nodes.find((n) => n.id === boxId)).toBeUndefined();
  expect(await stageDrawn(page, boxId)).toBe(false);
  // with nothing selected the paint is bit-identical - no frozen mesh left
  expect(await stageSel(page)).toBe(null);
  expect(await canvasSha(page)).toBe(before);
});

test("s4fix2 - Delete removes a selected diamond's keys OR the selected node, never the wrong one", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5delk");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  const boxId = (await stage(page)).scene.nodes.at(-1)!.id;
  await page.getByTestId(`outliner-${boxId}`).getByRole("button").first().click();
  await page.getByRole("button", { name: /Key transform/ }).click();
  await page.waitForTimeout(250);
  const keyCount = () => stage(page).then((s) => s.scene.nodes.find((n) => n.id === boxId)!.keys?.length ?? 0);
  expect(await keyCount()).toBe(3);

  // diamond selected, then ANOTHER node selected → Delete removes the NODE
  // and leaves the keys alone (the stale-diamond bug ate the old diamond)
  await page.getByRole("button", { name: /key at 0s/ }).click();
  await page.getByTestId("outliner-ground").getByRole("button").first().click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  expect((await stage(page)).scene.nodes.find((n) => n.id === "ground")).toBeUndefined();
  expect(await keyCount()).toBe(3);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.nodes.find((n) => n.id === "ground")).toBeTruthy();

  // diamond selected → Delete removes only its keys; one Undo restores them
  await page.getByRole("button", { name: /key at 0s/ }).click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  expect((await stage(page)).scene.nodes.find((n) => n.id === boxId)).toBeTruthy();
  expect(await keyCount()).toBe(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(250);
  expect(await keyCount()).toBe(3);
});

test("s4fix2 - NumField typing is not mangled (35 / -2.5 / 40° / 1920); Control+Shift+Z redoes", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5numf");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  const focalMm = () => stage(page).then((s) => Number(s.scene.nodes.find((n) => n.id === "cam_main")!.props.focalMm));
  const typeInto = async (loc: ReturnType<Page["locator"]>, text: string) => {
    await loc.click();
    await loc.selectText();
    await loc.pressSequentially(text, { delay: 30 });
    await page.waitForTimeout(250);
  };

  await page.getByTestId("outliner-cam_main").getByRole("button").first().click();

  // Focal "35" → 35 - the old field clamped "3" to 8 and finished at 85
  const focal = page.getByLabel("Focal (mm)");
  await typeInto(focal, "35");
  expect(await focalMm()).toBe(35);
  await focal.press("Enter"); // blur-commit resyncs, stays 35
  expect(await focalMm()).toBe(35);

  // X "-2.5" → -2.5 - the old field read "-" as "" → 0 and finished at 2
  const x = page.getByLabel("X", { exact: true }).first();
  await typeInto(x, "-2.5");
  const posX = () => stage(page).then((s) => s.scene.nodes.find((n) => n.id === "cam_main")!.transform.pos[0]);
  expect(await posX()).toBe(-2.5);
  await x.press("Enter");
  expect(await posX()).toBe(-2.5);

  // FOV "40" → focalForHFov(40, sensor) ±0.1 - typing "4" first is legal
  const sensor = String((await stage(page)).scene.nodes.find((n) => n.id === "cam_main")!.props.sensor) as Parameters<typeof focalForHFov>[1];
  const fov = page.getByLabel("FOV °");
  await typeInto(fov, "40");
  expect(await focalMm()).toBeCloseTo(focalForHFov(40, sensor), 1);
  await fov.press("Enter");

  // W "1920" → 1920 - start from a non-1920 aspect so the commit is real
  await page.getByLabel("Aspect").selectOption("4:3");
  await page.waitForTimeout(200);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1440);
  const cb = (await page.locator("canvas").boundingBox())!;
  await page.mouse.click(cb.x + 10, cb.y + 10); // empty sky → deselect → scene panel
  await expect(page.locator('[aria-label="Scene panel"]')).toBeVisible();
  const w = page.locator('[aria-label="Scene panel"]').getByLabel("W", { exact: true });
  await typeInto(w, "1920");
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1920);
  await w.press("Enter");
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1920);

  // [MF10] Control+Shift+Z redoes - focus is on <body> after the Enter blur
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.meta.renderSize.w).not.toBe(1920);
  await page.keyboard.press("Control+Shift+Z");
  await page.waitForTimeout(250);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1920);
});

test("[OF-0534][OF-0539][OF-0541] revisions drawer preview/restore + export popover still/GLB + helper no-pick + W→H lock", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5rev");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  /* canvas pick sanity - clicking the sun's gizmo selects it (helpers like
   * the frustum/shaft lines are raycast-disabled; the s4fix2 spec owns the
   * "helper must not steal the pick" case) */
  const sunPos = await page.evaluate(() =>
    (window as never as { __ofStage: { screenPos(id: string): { x: number; y: number } | null } }).__ofStage.screenPos("light_sun"));
  expect(sunPos).toBeTruthy();
  await page.mouse.click(sunPos!.x, sunPos!.y);
  await page.waitForTimeout(150);
  expect(await stageSel(page)).toBe("light_sun");
  // deselect via empty sky - the Scene panel comes back for the W→H step
  const cbb = (await page.locator("canvas").boundingBox())!;
  await page.mouse.click(cbb.x + 8, cbb.y + 8);
  await page.waitForTimeout(150);
  expect(await stageSel(page)).toBeNull();

  /* W→H aspect lock: deselected → Scene panel - typing W re-derives H */
  await page.locator('[aria-label="Scene panel"]').getByLabel("W", { exact: true }).fill("960");
  await page.locator('[aria-label="Scene panel"]').getByLabel("W", { exact: true }).press("Enter");
  await page.waitForTimeout(200);
  const rs = (await stage(page)).scene.meta.renderSize;
  expect(rs.w).toBe(960);
  expect(rs.h).toBe(540); // 16:9 derived - the H field is a readout

  /* make an edit → flush → a 'save' revision row joins 'create' */
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Dirty|Saving|Saved/, { timeout: 5_000 });
  await page.evaluate(() => (window as never as { __ofStage: { flushSaves(): Promise<void> } }).__ofStage.flushSaves());
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });

  /* drawer lists rows newest-first; previewing r1 freezes the document */
  const withBoxSha = await canvasSha(page);
  await page.getByRole("button", { name: "Revisions" }).click();
  const drawer = page.getByTestId("revisions-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("rev-1")).toBeVisible({ timeout: 10_000 });
  await drawer.getByTestId("rev-1").click();
  await expect(page.getByTestId("revision-banner")).toBeVisible();
  expect(await page.evaluate(() => (window as never as { __ofStage: { previewRev: number | null } }).__ofStage.previewRev)).toBe(1);
  // the previewed r1 predates the box - the canvas paints without it
  await page.waitForTimeout(300);
  expect(await canvasSha(page)).not.toBe(withBoxSha);
  // the live document is untouched and every edit affordance is frozen
  expect((await stage(page)).scene.nodes.some((n) => n.name.startsWith("primitive"))).toBe(true);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  /* restore r1 as the new head - the box stays gone, revision bumps */
  await page.getByRole("button", { name: "Restore as head" }).click();
  await expect(page.getByTestId("revision-banner")).toBeHidden();
  await page.waitForTimeout(300);
  const restored = await stage(page);
  expect(restored.scene.nodes.some((n) => n.name.startsWith("primitive"))).toBe(false);
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  const row = await (await page.request.get(`/api/stage/${created.id}`)).json();
  expect(row.revision).toBeGreaterThanOrEqual(3); // create + save(s) + restore - session-collapsed saves may slide
  expect(row.scene.nodes.some((n: { name: string }) => n.name.startsWith("primitive"))).toBe(false);

  /* export popover: PNG download + both save-to-library paths */
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const panel = page.getByTestId("export-panel");
  await expect(panel).toBeVisible();
  const dl = page.waitForEvent("download", { timeout: 30_000 });
  await panel.getByRole("button", { name: "Download PNG" }).click();
  const download = await dl;
  const dlPath = await download.path();
  const bytes = readFileSync(dlPath!);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await panel.getByRole("button", { name: "Save GLB to library" }).click();
  await expect(page.locator("text=/Saved to library/")).toBeVisible({ timeout: 15_000 });
  const ups = await (await page.request.get("/api/uploads")).json();
  expect(ups.uploads.some((u: { url: string }) => u.url.endsWith(".glb"))).toBe(true);
});

/* ---------- s4c carry-over: inspect accuracy + artifact pixels + glb round-trip ---------- */

test("[OF-0548] inspect accuracy - inspect.camera equals cameraAt within 1e-6; a camera-parented node's inspect pos projects onto its screen pos within 2 px", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5par");
  const created = await mkEmpty(page.request);

  // build the inspect-check scene over the API: cam_b with box_in PARENTED to it -
  // the world-pose composition the inspect endpoint and the viewport both do.
  // Cameras contribute their EFFECTIVE pose to descendants: cam_aim aims at
  // tgt_ext via lookAt, cam_path rides a CR path - kids under each must land
  // on the same pixels inspect reports. cam_self aims at its own child -
  // the cycle guard drops that lookAt instead of recursing forever.
  const head = await (await page.request.get(`/api/stage/${created.id}`)).json();
  const scene = head.scene;
  scene.nodes.push(
    { id: "cam_b", name: "Cam B", kind: "camera", transform: { pos: [0, 3, 8], rot: [-15, 25, 0], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame", isRender: false } },
    { id: "box_in", name: "Box", kind: "primitive", parent: "cam_b", transform: { pos: [-1, 2.2, 4.5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#8b93a3" } },
    { id: "tgt_ext", name: "Target", kind: "primitive", transform: { pos: [0, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#8b93a3" } },
    { id: "cam_aim", name: "Cam Aim", kind: "camera", transform: { pos: [3, 3, 7], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame", isRender: false, lookAt: "tgt_ext" } },
    { id: "kid_aim", name: "Kid Aim", kind: "primitive", parent: "cam_aim", transform: { pos: [0, 0, 2], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#8b93a3" } },
    { id: "cam_path", name: "Cam Path", kind: "camera", transform: { pos: [2, 3, 6], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame", isRender: false,
        path: { points: [[2, 3, 6], [4, 3, 2], [0, 3, 1]], times: [0, 4, 8] } } },
    { id: "kid_path", name: "Kid Path", kind: "primitive", parent: "cam_path", transform: { pos: [0, 0, 1.5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#8b93a3" } },
    { id: "cam_self", name: "Cam Self", kind: "camera", transform: { pos: [-4, 2, 5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame", isRender: false, lookAt: "kid_self" } },
    { id: "kid_self", name: "Kid Self", kind: "primitive", parent: "cam_self", transform: { pos: [0, 0, 3], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#8b93a3" } },
  );
  const put = await page.request.put(`/api/stage/${created.id}`, { data: { base_revision: head.revision, scene } });
  expect(put.status(), await put.text()).toBe(200);

  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  // inspect.camera ≈ the page's own cameraAt - same math, both engines.
  // roll sits on the residual-extraction noise floor across V8 builds (acos
  // near 1 + a near-zero cross-product sign), so it gets a 1e-5 epsilon;
  // a wrong convention would be degrees off, not micro-degrees.
  const insp = await (await page.request.get(`/api/stage/${created.id}/inspect?t=0`)).json();
  const camAt = await stageCameraAt(page, 0);
  for (const k of ["yaw", "pitch", "fov"] as const) {
    expect(insp.camera[k]).toBeCloseTo(camAt![k], 6);
  }
  expect(Math.abs(insp.camera.roll - camAt!.roll)).toBeLessThan(1e-5);
  for (let i = 0; i < 3; i++) expect(insp.camera.pos[i]).toBeCloseTo(camAt!.pos[i], 6);

  // a camera-parented node: the server's world pos, projected through the
  // view camera, lands on the drawn object's screen position - same check
  // for children of a lookAt camera and of a path camera (effective-pose
  // composition), and cam_self aiming at its own child loaded without hang
  // (the page painted at all).
  for (const id of ["box_in", "kid_aim", "kid_path", "kid_self"]) {
    const inspNode = insp.nodes.find((n: { id: string }) => n.id === id);
    const proj = await page.evaluate((p) =>
      (window as never as { __ofStage: StageHook }).__ofStage.screenPosAt(p), inspNode.pos);
    const drawn = await page.evaluate((i) =>
      (window as never as { __ofStage: StageHook }).__ofStage.screenPos(i), id);
    expect(proj, `${id} projects`).toBeTruthy();
    expect(drawn, `${id} draws`).toBeTruthy();
    expect(Math.abs(proj!.x - drawn!.x), `${id} x`).toBeLessThanOrEqual(2);
    expect(Math.abs(proj!.y - drawn!.y), `${id} y`).toBeLessThanOrEqual(2);
  }

  // cam_self's subtree lookAt was ignored, not crashed on - the inspect
  // still reports its (un-aimed) pose and the child under it
  const inspSelf = insp.nodes.find((n: { id: string }) => n.id === "cam_self");
  expect(inspSelf).toBeTruthy();
});

test("[s6fix] cross-aimed camera chains stay fast - 31-node PUT 200; inspect <3 s; the editor loads and autosaves", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5xaim");
  const created = await mkEmpty(page.request);

  // two 7-deep nested camera chains, every camera lookAt-ing a leaf under
  // the OTHER chain's deepest node - the exact cross-aim shape that made
  // worldOf re-resolve cameras exponentially (~59 s at 27 nodes). The
  // memo + in-progress bound resolves each camera once per call.
  // 3 (empty scene) + 14 cameras + 14 leaves = 31 nodes.
  const head = await (await page.request.get(`/api/stage/${created.id}`)).json();
  const scene = head.scene as { nodes: Record<string, unknown>[] };
  const cam = (id: string, parent: string | undefined, lookAt: string) => ({
    id, name: id, kind: "camera",
    ...(parent ? { parent } : {}),
    transform: { pos: [0, 1.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
    props: { focalMm: 35, sensor: "full_frame", isRender: false, lookAt },
  });
  const leaf = (id: string, parent: string) => ({
    id, name: id, kind: "primitive", parent,
    transform: { pos: [0, 0, 2], rot: [0, 0, 0], scale: [1, 1, 1] },
    props: { shape: "box", size: [0.3, 0.3, 0.3], color: "#8b93a3" },
  });
  for (let i = 1; i <= 7; i++) {
    scene.nodes.push(cam(`cam_a${i}`, i > 1 ? `cam_a${i - 1}` : undefined, `leaf_b${i}`));
    scene.nodes.push(cam(`cam_b${i}`, i > 1 ? `cam_b${i - 1}` : undefined, `leaf_a${i}`));
  }
  for (let i = 1; i <= 7; i++) {
    scene.nodes.push(leaf(`leaf_a${i}`, "cam_a7"), leaf(`leaf_b${i}`, "cam_b7"));
  }
  expect(scene.nodes).toHaveLength(31);
  const put = await page.request.put(`/api/stage/${created.id}`, { data: { base_revision: head.revision, scene } });
  expect(put.status(), await put.text()).toBe(200);

  const t0 = Date.now();
  const inspR = await page.request.get(`/api/stage/${created.id}/inspect?t=0`);
  const inspectMs = Date.now() - t0;
  expect(inspR.status()).toBe(200);
  expect(inspectMs).toBeLessThan(3000);
  expect(((await inspR.json()).nodes as unknown[])).toHaveLength(31);

  // the editor runs the same worldOf per frame - load it, make an edit,
  // autosave must land while the debounce + PUT run
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);
  await page.getByTestId("outliner-ground").click();
  await page.getByLabel("X", { exact: true }).first().fill("1.5");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
});

test("[OF-0539] the default render camera faces the stage - in Camera view the ground projects on-canvas and the frame isn't background-flat", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5aim");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
  await page.waitForTimeout(400);

  // the ground centre projects inside the canvas' MIDDLE HALF - the camera
  // is actually aimed at the stage, not just pointing somewhere over it
  const pos = await stageScreenPos(page, "ground");
  expect(pos).toBeTruthy();
  const cbb = (await page.locator("canvas").boundingBox())!;
  expect(pos!.x).toBeGreaterThanOrEqual(cbb.x + cbb.width / 4);
  expect(pos!.x).toBeLessThanOrEqual(cbb.x + (cbb.width * 3) / 4);
  expect(pos!.y).toBeGreaterThanOrEqual(cbb.y + cbb.height / 4);
  expect(pos!.y).toBeLessThanOrEqual(cbb.y + (cbb.height * 3) / 4);

  // real content reaches the frame - ≥25 % of sampled pixels are neither
  // the letterbox fill nor the flat env background (the old yaw left only
  // sky in frame)
  const frac = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = document.createElement("canvas");
    d.width = c.width; d.height = c.height;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0);
    const px = g.getImageData(0, 0, d.width, d.height).data;
    const lb = (px[0] << 16) | (px[1] << 8) | px[2]; // letterbox colour
    const env = 0x101318;                          // emptyScene env.background
    const far = (v: number, ref: number) =>
      Math.abs((v >> 16) - (ref >> 16)) > 12
      || Math.abs(((v >> 8) & 255) - ((ref >> 8) & 255)) > 12
      || Math.abs((v & 255) - (ref & 255)) > 12;
    let n = 0, total = 0;
    for (let i = 0; i + 2 < px.length; i += 4 * 11) {
      total++;
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (far(v, lb) && far(v, env)) n++;
    }
    return n / total;
  });
  expect(frac).toBeGreaterThanOrEqual(0.25);
});

test("[OF-0539] still export at 640×360 - PNG IHDR, non-blank, zero accent pixels; UI Save to library lists it in /api/uploads", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5px");
  const created = await mkEmpty(page.request);
  // no aim workaround - the default render camera already faces the stage
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  /* renderStill is what the Export panel calls for Download/Save - read the
   * IHDR straight off the blob and scan the pixels for helper leftovers */
  const info = await page.evaluate(async () => {
    const hook = (window as never as { __ofStage: { renderStill(w: number, h: number): Promise<Blob | null> } }).__ofStage;
    const blob = await hook.renderStill(640, 360);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let accent = 0, distinct = 0;
    const br = px[0], bg = px[1], bb = px[2];
    for (let i = 0; i + 2 < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      if (Math.abs(r - 0xd4) < 10 && Math.abs(gg - 0xff) < 10 && Math.abs(b - 0x3f) < 10) accent++;
      if (Math.abs(r - br) > 12 || Math.abs(gg - bg) > 12 || Math.abs(b - bb) > 12) distinct++;
    }
    const dv = new DataView(bytes.buffer);
    return { sig: [...bytes.slice(0, 8)], w: dv.getUint32(16), h: dv.getUint32(20), accent, distinct };
  });
  expect(info).toBeTruthy();
  expect(info!.sig).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(info!.w).toBe(640);
  expect(info!.h).toBe(360);
  expect(info!.distinct).toBeGreaterThan(500); // not a blank frame
  expect(info!.accent).toBe(0);                // no path/handle/selection pixels

  /* the same still at the same dims through the UI save path → uploads row */
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const panel = page.getByTestId("export-panel");
  await panel.getByLabel("Export width").fill("640");
  await panel.getByLabel("Export height").fill("360");
  await panel.getByRole("button", { name: "Save to library" }).click();
  await expect(page.locator("text=/Saved to library/")).toBeVisible({ timeout: 15_000 });
  const ups = await (await page.request.get("/api/uploads")).json();
  const mine = ups.uploads.filter((u: { url: string }) => u.url.endsWith(".png"));
  expect(mine.length).toBeGreaterThanOrEqual(1);
  const saved = Buffer.from(await (await page.request.get(mine[0].url)).body());
  const dv = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
  expect(dv.getUint32(16)).toBe(640);
  expect(dv.getUint32(20)).toBe(360);
});

test("[OF-0550] GLB round-trip - parses in gltf-transform with KHR_lights_punctual; Add → Model lists it, loads it, canvas changes", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5glb");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  // give the scene one of each exportable kind
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Mannequin" }).click();
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Light · spot" }).click();
  const sceneJson = (await stage(page)).scene;
  const camCount = sceneJson.nodes.filter((n) => n.kind === "camera").length;
  const lightCount = sceneJson.nodes.filter((n) => n.kind === "light").length;
  const meshNodes = sceneJson.nodes.filter((n) => ["primitive", "mannequin", "model"].includes(n.kind)).length;

  // Export → Save GLB to library
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByTestId("export-panel").getByRole("button", { name: "Save GLB to library" }).click();
  await expect(page.locator("text=/Saved to library/")).toBeVisible({ timeout: 20_000 });
  const ups = await (await page.request.get("/api/uploads")).json();
  const glbUrl = ups.uploads.find((u: { url: string }) => u.url.endsWith(".glb"))!.url as string;
  const buf = Buffer.from(await (await page.request.get(glbUrl)).body());

  /* gltf-transform parse: one glTF camera per scene camera, ≥ one mesh per
   * mesh-producing node, and lights riding KHR_lights_punctual - verified
   * off the raw JSON chunk so the extension isn't stripped unregistered */
  const { NodeIO } = await import("@gltf-transform/core");
  const doc = await new NodeIO().readBinary(new Uint8Array(buf));
  const root = doc.getRoot();
  expect(root.listCameras().length).toBe(camCount);
  expect(root.listMeshes().length).toBeGreaterThanOrEqual(meshNodes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const docJson = JSON.parse(buf.subarray(20, 20 + dv.getUint32(12, true)).toString("utf8"));
  expect(docJson.extensionsUsed).toContain("KHR_lights_punctual");
  const lightNodes = (docJson.nodes ?? []).filter(
    (n: { extensions?: Record<string, unknown> }) => n.extensions?.KHR_lights_punctual != null);
  expect(lightNodes.length).toBeGreaterThanOrEqual(lightCount);

  /* Add → Model lists the just-saved GLB (the refs cache must have been
   * invalidated), loads it over the network, and the canvas repaints */
  const before = await canvasSha(page);
  const glbFetch = page.waitForResponse((r) => r.url().endsWith(".glb") && r.status() === 200, { timeout: 20_000 });
  await page.getByRole("button", { name: "+ Add node" }).click();
  const item = page.getByRole("menuitem", { name: /Model · .*\.glb/ });
  await expect(item).toBeVisible();
  await item.click();
  const modelNode = (await stage(page)).scene.nodes.find((n) => n.kind === "model")!;
  expect(modelNode.props.src).toBe(glbUrl);
  await glbFetch; // the loader fetched the file - not just a placeholder box
  await expect.poll(async () => (await canvasSha(page)) !== before, { timeout: 15_000 }).toBe(true);
});

test("[OF-0534] previewed revision deep-equals GET /revisions/1; after a UI restore Undo is disabled outright", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5pvr");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  // an edit so revision 2 differs from the create revision
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · sphere" }).click();
  await page.evaluate(() => (window as never as { __ofStage: { flushSaves(): Promise<void> } }).__ofStage.flushSaves());

  await page.getByRole("button", { name: "Revisions" }).click();
  const drawer = page.getByTestId("revisions-drawer");
  await expect(drawer.getByTestId("rev-1")).toBeVisible({ timeout: 10_000 });
  await drawer.getByTestId("rev-1").click();
  await expect(page.getByTestId("revision-banner")).toBeVisible();

  const apiRev = await (await page.request.get(`/api/stage/${created.id}/revisions/1`)).json();
  const previewed = (await stage(page)).previewScene;
  expect(previewed).toEqual(apiRev.scene); // the preview IS the stored revision, not a stale live doc

  await page.getByRole("button", { name: "Restore as head" }).click();
  await expect(page.getByTestId("revision-banner")).toBeHidden();
  // restore clears the undo stack - the button disables outright
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect((await stage(page)).undoDepth).toBe(0);
  // and the restored head is revision 1's content
  const head = await (await page.request.get(`/api/stage/${created.id}`)).json();
  expect(head.scene).toEqual(apiRev.scene);
});

test("a failed save blocks the prompt - PUT 500 → no POST …/prompt is sent and the Save failed toast shows", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5guard");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  let promptPosts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/stage\/[^/]+\/prompt/.test(r.url())) promptPosts++;
  });
  // every scene PUT lands a 500 - the flush inside runPrompt must surface it
  await page.route("**/api/stage/**", (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }),
      });
    }
    return route.continue();
  });

  // an edit queues an autosave; clicking Prompt flushes it → 500 → error state
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  await page.getByLabel("Edit prompt").fill("add a second sun");
  await page.getByRole("button", { name: "Prompt" }).click();

  // the prompt never reaches the server - running it on the stale head would
  // replace the local scene and drop the unsaved edit. The runPrompt guard
  // owns the toast (the generic save-failure text would be stale context).
  await expect(page.locator("text=/prompt not sent - save failed/")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("save-state")).toHaveText("Save error");
  expect(promptPosts).toBe(0);
});

test("an aborted autosave surfaces 'Save error' and the next edit saves clean", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page, "ws5abort");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  // a dead connection (not a 500 - the fetch itself throws) must surface the
  // same error state, and the queue must not wedge: the next edit still saves
  await page.route("**/api/stage/**", (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue());
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · box" }).click();
  await expect(page.getByTestId("save-state")).toHaveText("Save error", { timeout: 15_000 });

  await page.unroute("**/api/stage/**");
  await page.getByRole("button", { name: "+ Add node" }).click();
  await page.getByRole("menuitem", { name: "Primitive · sphere" }).click();
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });

  // and the server head carries the edits - both nodes landed in one PUT
  const head = await (await page.request.get(`/api/stage/${created.id}`)).json();
  const names = head.scene.nodes.map((n: { name: string }) => n.name);
  expect(names).toContain("primitive 4");
  expect(names).toContain("primitive 5");
});

test("NumField - focus+blur commits nothing (deep-equal scene, same undo depth); Escape restores; ArrowUp adds step; one Undo returns W to exactly 1440", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5num2");
  const created = await mkEmpty(page.request);
  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  await page.getByLabel("Aspect").selectOption("4:3");
  await page.waitForTimeout(200);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1440);

  const w = () => page.locator('[aria-label="Scene panel"]').getByLabel("W", { exact: true });
  const depth = () => stage(page).then((s) => s.undoDepth);
  const sceneStr = () => stage(page).then((s) => JSON.stringify(s.scene));

  // focus → blur with no edit: no preview, no commit, identical document
  const s0 = await sceneStr();
  const d0 = await depth();
  await w().click();
  await w().blur();
  await page.waitForTimeout(150);
  expect(await sceneStr()).toBe(s0);
  expect(await depth()).toBe(d0);

  // typing previews live; Escape unwinds the preview back to the focus value
  await w().click();
  await w().selectText();
  await w().pressSequentially("2000", { delay: 25 });
  await page.waitForTimeout(150);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(2000);
  await w().press("Escape");
  await page.waitForTimeout(150);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1440);
  expect(await depth()).toBe(d0);

  // type 1920 + Enter → ONE commit; a single Undo returns W to exactly 1440
  await w().click();
  await w().selectText();
  await w().pressSequentially("1920", { delay: 25 });
  await w().press("Enter");
  await page.waitForTimeout(200);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1920);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(200);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1440);

  // ArrowUp adds the step as its own commit
  await w().click();
  await w().press("ArrowUp");
  await page.waitForTimeout(150);
  expect((await stage(page)).scene.meta.renderSize.w).toBe(1441);
  expect(await depth()).toBeGreaterThan(d0);
});

test("a box inside a non-render camera's frustum click-selects - helper lines never win the pick", async ({ page }) => {
  test.setTimeout(240_000);
  await signup(page, "ws5fru");
  const created = await mkEmpty(page.request);

  // cam_b aims at box_in via lookAt - the box is dead-centre in its frustum
  const head = await (await page.request.get(`/api/stage/${created.id}`)).json();
  const scene = head.scene;
  scene.nodes.push(
    { id: "cam_b", name: "Cam B", kind: "camera", transform: { pos: [0, 3, 8], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame", isRender: false, lookAt: "box_in" } },
    { id: "box_in", name: "Box", kind: "primitive", transform: { pos: [-1, 2.2, 4.5], rot: [0, 0, 0], scale: [1, 1, 1] },
      props: { shape: "box", size: [1, 1, 1], color: "#8b93a3" } },
  );
  const put = await page.request.put(`/api/stage/${created.id}`, { data: { base_revision: head.revision, scene } });
  expect(put.status(), await put.text()).toBe(200);

  await page.goto(`/scene-3d/${created.id}`);
  await waitInk(page);
  await waitHook(page);

  const pos = await page.evaluate(() =>
    (window as never as { __ofStage: StageHook }).__ofStage.screenPos("box_in"));
  expect(pos).toBeTruthy();
  const box = page.getByTestId("stage-viewport").locator("canvas");
  const bb = (await box.boundingBox())!;
  await box.click({ position: { x: pos!.x - bb.x, y: pos!.y - bb.y } });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as never as { __ofStage: { sel: string | null } }).__ofStage.sel)).toBe("box_in");
});

/* ---------- s6fix: default-cam draft + post-write SIGTERM ---------- */

test("[OF-0539] a writer draft with NO camera still opens aimed at the stage - the shared DEFAULT_RENDER_CAM fallback", async ({ page }) => {
  test.setTimeout(180_000);
  const stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify({
            title: "No cam draft",
            nodes: [
              { kind: "primitive", name: "Floor", shape: "plane", size: [24, 1, 24], pos: [0, 0, 0], color: "#232833" },
              { kind: "primitive", name: "Pedestal", shape: "box", size: [1.4, 0.4, 1.4], pos: [0, 0.2, 0], color: "#7a8296" },
              { kind: "mannequin", name: "Figure", pose: "stand", height: 1.7, pos: [0, 0.4, 0] },
            ],
          }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = (stub.address() as AddressInfo).port;

  try {
    await signup(page, "ws5aimw");
    expect((await page.request.put("/api/llm/providers/custom", {
      data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
    })).status()).toBe(200);
    expect((await page.request.put("/api/llm/routes/writer", {
      data: { providerId: "custom", model: "stub-1" },
    })).status()).toBe(200);

    const gen = await page.request.post("/api/stage", { data: { prompt: "a lit display" } });
    expect(gen.status()).toBe(201);
    const created = await gen.json();

    await page.goto(`/scene-3d/${created.id}`);
    await waitInk(page);
    await waitHook(page);

    // the draft had no camera - the writer fallback produced one at the
    // shared default pose (eye level, mild down-tilt toward the stage)
    const cam = (await stage(page)).scene.nodes.find((n) => n.kind === "camera")!;
    expect(cam.transform.pos).toEqual([0, 1.5, 6]);
    expect(cam.transform.rot).toEqual([-6, 180, 0]);
    expect(cam.props.isRender).toBe(true);

    await page.getByRole("group", { name: "View mode" }).getByRole("button", { name: "Camera", exact: true }).click();
    await page.waitForTimeout(400);

    // the floor centre projects inside the middle half of the canvas
    const floorId = (await stage(page)).scene.nodes.find((n) => n.name === "Floor")!.id;
    const pos = await stageScreenPos(page, floorId);
    expect(pos).toBeTruthy();
    const cbb = (await page.locator("canvas").boundingBox())!;
    expect(pos!.x).toBeGreaterThanOrEqual(cbb.x + cbb.width / 4);
    expect(pos!.x).toBeLessThanOrEqual(cbb.x + (cbb.width * 3) / 4);
    expect(pos!.y).toBeGreaterThanOrEqual(cbb.y + cbb.height / 4);
    expect(pos!.y).toBeLessThanOrEqual(cbb.y + (cbb.height * 3) / 4);

    const frac = await page.evaluate(() => {
      const c = document.querySelector("canvas") as HTMLCanvasElement;
      const d = document.createElement("canvas");
      d.width = c.width; d.height = c.height;
      const g = d.getContext("2d")!;
      g.drawImage(c, 0, 0);
      const px = g.getImageData(0, 0, d.width, d.height).data;
      const lb = (px[0] << 16) | (px[1] << 8) | px[2];
      const env = 0x101318;
      const far = (v: number, ref: number) =>
        Math.abs((v >> 16) - (ref >> 16)) > 12
        || Math.abs(((v >> 8) & 255) - ((ref >> 8) & 255)) > 12
        || Math.abs((v & 255) - (ref & 255)) > 12;
      let n = 0, total = 0;
      for (let i = 0; i + 2 < px.length; i += 4 * 11) {
        total++;
        const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        if (far(v, lb) && far(v, env)) n++;
      }
      return n / total;
    });
    expect(frac).toBeGreaterThanOrEqual(0.25);
  } finally { stub.close(); }
});

test("s6fix - SIGTERM right after 'export: wrote' exits 0 or 143 and leaves no process in its group", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(tmpdir(), "of-exp-wrote-"));
  const specFile = path.join(dir, "spec.json");
  const out = path.join(dir, "out.mp4");
  writeFileSync(specFile, JSON.stringify({
    version: 1, width: 160, height: 90, fps: 12, duration: 1, seed: 7,
    background: { color: "#000000" },
    camera: { keyframes: [{ t: 0, position: [0, 0, 8], target: [0, 0, 0] }] },
    layers: [
      { id: "block", type: "box", props: { width: 2, height: 2, depth: 1, color: "#ff6600" } },
    ],
  }));

  /* --base reuses the live e2e server - the export only needs ffmpeg +
   * chromium of its own, and the spec is tiny (12 frames) so "export: wrote"
   * lands fast. detached makes the exporter its own group leader so
   * kill(-pgid) can prove nothing of it lingers. */
  const proc = spawn(process.execPath, [
    "--experimental-strip-types", path.join(process.cwd(), "scripts/render/export.ts"),
    "--spec", specFile, "--out", out, "--base", base,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const procLog: string[] = [];
  proc.stdout?.on("data", (d) => procLog.push(String(d)));
  proc.stderr?.on("data", (d) => procLog.push(String(d)));

  try {
    const t0 = Date.now();
    let wrote = false;
    while (Date.now() - t0 < 120_000) {
      if (/export: wrote/.test(procLog.join(""))) { wrote = true; break; }
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(wrote, `exporter log: ${procLog.join("").slice(-1500)}`).toBe(true);

    // the write landed - kill mid-drain; a clean exit already underway
    // answers 0, a caught signal answers 143
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    const code = await new Promise<number>((res) => {
      if (proc!.exitCode !== null) { res(proc!.exitCode); return; }
      proc!.once("close", (c) => res(c ?? -1));
      setTimeout(() => res(-9), 15_000);
    });
    expect([0, 143]).toContain(code);

    // nothing in the exporter's group survived - ffmpeg/chromium included
    let groupAlive = true;
    for (let i = 0; i < 30; i++) {
      try { process.kill(-proc!.pid!, 0); }
      catch { groupAlive = false; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(groupAlive).toBe(false);
  } finally {
    if (proc.exitCode === null) { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
