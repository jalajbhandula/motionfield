/**
 * WS2 s8 "Memory map + projects" e2e (GENERATION_PROVIDER=mock):
 *  P1. Session-bound builtin steps execute inline - memory_save twice,
 *      todo, refs_list, notes - zero-credit typed leaves; a memory links to
 *      the caller's own job and a memory_forget run hard-deletes row+links.
 *  P2. The assistant Memory panel saves a memory by name, lists it and
 *      forgets it - live UI round-trip.
 *  P3. "remember …", "jot down …", "save this as X" and "forget memory X"
 *      land as memory_save / notes / memory_save / memory_forget builtin
 *      steps through the deterministic planner (no LLM configured).
 *  P4. A project-bound session's planner turn carries the project's memory
 *      DATA-framed; an unbound session with the same brief never sees it.
 *      Proven by a loopback OpenAI-wire stub recording llmPlan's messages.
 *  P5. /projects/:id shows title, instructions, folders, the SVG memory map
 *      (data-node-id/data-edge) and pinned uploads - all persisting reload.
 *  P6. Every ownership gate: another user's project/memory/folder/fav/
 *      session-bind and graph scope all 404 or return caller-scoped empties.
 *  P7. Naming rules: duplicate POST 409s, the tool upserts the existing name,
 *      and a PATCH rename frees the old name.
 *  P8. Explicit memory intents only (F1): an LLM stub's memory_forget plan
 *      strips on a media brief; "forget memory X" bypasses the stub and
 *      deletes; "save this as NAME" links the session's last job; a bare
 *      save with nothing produced asks "save what?".
 *  P9. Scoped upsert (F2): same-scope re-save updates; cross-scope and
 *      user-wide-vs-project collisions 409 with the real scope named.
 *  P10. Project chats (F3): "New chat in this project" binds the session -
 *      the chip names the project, the planner sees instructions + project
 *      memory; an unbound chat sees neither. (s12fix6 F2: instructions
 *      cap at 4000 - a 4001-char PATCH 400s, the textarea refuses typing
 *      past it, and Save surfaces the server's reply.)
 *  P11. Memory map interactions (F5): focusable nodes open a detail pane;
 *      Edit persists, Forget removes node + edges - and the next bound
 *      chat's planner request no longer carries the memory (s12fix4 G5).
 *  P12. Folders hold pins (F6): PATCH files a pin, foreign folder 404s,
 *      folder delete leaves items pinned but unfiled.
 *  P13. Upload→@ref slug retry (F7): a taken name lands <slug>-3, the tile
 *      shows the @name across reloads, and "animate @hero-3" plans i2v on
 *      the upload url with no ask (s12fix4 G5).
 *  P14. Only memory phrasings skip the model (s12fix4 G1): a fetch-shaped
 *      media brief reaches the stub planner route (its 2-step plan lands,
 *      not a lone agent/web_fetch); "forget memory X" still bypasses it;
 *      planner=builtin still plans agent/web_fetch.
 *  P15. A forget must name a memory (s12fix5 MF1): "delete that logo" is no
 *      memory phrasing - the stub is consulted and even its memory_forget
 *      answer strips, so the row survives; "forget memory logo" still
 *      bypasses the stub and deletes.
 *  P16. Model plans use shown media only (s12fix5 MF2): a stub plan naming
 *      an image_url the turn never showed 422s with the ask wording; one
 *      echoing the attached /files/ url verbatim plans (201).
 *  P17. Correction answers pass the same guards (s12fix6 F1): a stub
 *      answering by call count - 2 refused plans, then (a) an invented
 *      image_url → the ask wording, 3 calls, no run; (b) a trailing
 *      memory_forget step → stripped, the run plans without it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, request, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const T2I = "motionfield/z-image-turbo/text-to-image";
const MEM_SAVE = "agent/memory_save";
const MEM_FORGET = "agent/memory_forget";
const NOTES = "agent/notes";
const TODO = "agent/todo";
const REFS = "agent/refs_list";

type RunView = {
  id: string; status: string;
  steps: { step_id: string; status: string; endpoint_id: string; cost?: number | null; outputs?: { url: string; type?: string }[]; error?: string | null }[];
};
type Memory = { id: string; name: string; kind: string; content: string; project_id: string | null; links: { target_type: string; target_id: string }[] };

async function signUpCtx(baseURL: string | undefined, name: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `ws2proj-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
    });
    if (r.ok()) return ctx;
    if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));
  }
  return ctx;
}

const step = (id: string, endpoint: string, params: Record<string, unknown>, depends_on: string[] = []) =>
  ({ id, title: id, endpoint_id: endpoint, params, depends_on });

async function runPlan(ctx: APIRequestContext, body: Record<string, unknown>): Promise<RunView> {
  const r = await ctx.post("/api/agent/runs", { data: body });
  expect(r.status(), `runPlan: ${await r.text()}`).toBe(201);
  return (await r.json()).run as RunView;
}

async function pollRun(ctx: APIRequestContext, id: string, timeout = 90_000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const r = await ctx.get(`/api/agent/runs/${id}`);
    expect(r.ok()).toBeTruthy();
    const view = (await r.json()).run as RunView;
    if (["done", "failed", "stopped"].includes(view.status)) return view;
    if (Date.now() - t0 > timeout) { console.error(`pollRun timeout: ${JSON.stringify(view).slice(0, 2000)}`); return view; }
    await new Promise((r) => setTimeout(r, 900));
  }
}

const listMem = async (ctx: APIRequestContext, project_id?: string) =>
  ((await (await ctx.get(`/api/agent/memories${project_id ? `?project_id=${project_id}` : ""}`)).json()).memories ?? []) as Memory[];

const mkProject = async (ctx: APIRequestContext, title = "E2E project") => {
  const r = await ctx.post("/api/projects", { data: { title } });
  expect(r.status(), `project: ${await r.text()}`).toBe(201);
  return (await r.json()).project as { id: string; slug: string; title: string };
};

function stubServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  return {
    listen: () => new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/* -------------------------- P1 - builtin memory steps -------------------------- */

test("P1: memory_save/todo/refs_list/notes run as job-less steps; links bind own job; forget deletes row+links", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P1");
  const jobs0 = ((await (await ctx.get("/api/jobs")).json()).jobs as unknown[]).length;

  // a real job to link - one mock t2i run, done fast
  const jobRun = await runPlan(ctx, { ask_first: false, plan: { title: "job", steps: [step("s1", T2I, { prompt: "a hero" })] } });
  expect((await pollRun(ctx, jobRun.id)).status).toBe("done");
  const jobs = (await (await ctx.get("/api/jobs")).json()).jobs as { id: string }[];
  const jobId = jobs[0].id;

  const sess = await (await ctx.post("/api/agent/sessions", { data: { title: "mem session" } })).json();
  const run = await runPlan(ctx, {
    session_id: sess.session.id, ask_first: false,
    plan: { title: "mem steps", steps: [
      step("n1", MEM_SAVE, { name: "notes", content: "the look bible lives here" }),
      step("n2", MEM_SAVE, { name: "hero-look", content: "chrome and rust palette", kind: "style" }),
      step("t1", TODO, { items: [{ text: "draft look", done: false }, { text: "animate", done: false }] }),
      step("r1", REFS, {}),
      step("w1", NOTES, { text: "scratch: teal key light" }),
    ] },
  });
  const done = await pollRun(ctx, run.id);
  expect(done.status).toBe("done");
  for (const s of done.steps) {
    expect(s.status).toBe("done");
    expect(s.cost ?? 0).toBe(0); // builtin leaves are zero-credit
    expect(s.outputs?.[0]?.type).toMatch(/text|json/);
  }

  const mems = await listMem(ctx);
  const notes = mems.find((m) => m.name === "notes");
  const hero = mems.find((m) => m.name === "hero-look");
  expect(notes?.content).toBe("the look bible lives here");
  expect(hero?.kind).toBe("style");

  // link hero-look to the caller's own job - the graph shows the edge
  const lp = await ctx.patch(`/api/agent/memories/${hero!.id}`, {
    data: { links: [{ target_type: "job", target_id: jobId }] },
  });
  expect(lp.status(), `link: ${await lp.text()}`).toBe(200);
  const graph = await (await ctx.get("/api/agent/memories/graph")).json();
  expect(graph.nodes.some((n: { id: string }) => n.id === `mem:${hero!.id}`)).toBe(true);
  expect(graph.nodes.some((n: { id: string }) => n.id === `job:${jobId}`)).toBe(true);
  expect(graph.edges.some((e: { from: string; to: string }) => e.from === `mem:${hero!.id}` && e.to === `job:${jobId}`)).toBe(true);

  // a memory_forget step on hero-look → the row AND its link are gone
  const forgetRun = await runPlan(ctx, { ask_first: false, plan: { title: "f", steps: [step("f1", MEM_FORGET, { name: "hero-look" })] } });
  expect((await pollRun(ctx, forgetRun.id)).status).toBe("done");
  const after = await listMem(ctx);
  expect(after.some((m) => m.name === "hero-look")).toBe(false);
  const g2 = await (await ctx.get("/api/agent/memories/graph")).json();
  expect(g2.nodes.some((n: { id: string }) => n.id === `mem:${hero!.id}`)).toBe(false);
  expect(g2.edges.length).toBe(0);

  // the session shows the run; no generation jobs were created for leaves
  expect((await (await ctx.get("/api/jobs")).json()).jobs.length).toBe(jobs0 + 1);
  await ctx.dispose();
});

/* -------------------------- P2 - the assistant Memory panel -------------------------- */

test("P2: the assistant sidebar does not show the unused chrome", async ({ page }) => {
  await page.goto("/ai-assistant");
  const side = page.locator("aside");
  await expect(side.getByRole("link", { name: "Skills" })).toHaveCount(0);
  await expect(side.getByRole("link", { name: "Connectors" })).toHaveCount(0);
  await expect(side.getByRole("link", { name: "MotionField" })).toHaveCount(0);
  await expect(side.getByRole("link", { name: "Pricing" })).toHaveCount(0);
  await expect(side.getByRole("link", { name: "Log in" })).toHaveCount(0);
  await expect(page.getByTestId("memory-panel")).toHaveCount(0);
});

/* -------------------------- P3 - deterministic memory intents -------------------------- */

test("P3: remember/save-as/forget/jot phrasings land as memory tools through the builtin planner", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const ctx = await signUpCtx(baseURL, "P3");
  const brief = async (text: string) => {
    const r = await ctx.post("/api/agent/runs", { data: { text, planner: "builtin", ask_first: false } });
    expect(r.status(), `"${text}": ${await r.text()}`).toBe(201);
    const view = await pollRun(ctx, (await r.json()).run.id);
    expect(view.status, `"${text}" → ${JSON.stringify(view.steps.map((s) => [s.endpoint_id, s.status]))}`).toBe("done");
    return view;
  };

  const rem = await brief("remember our hero look is chrome-and-rust");
  expect(rem.steps[0].endpoint_id).toBe(MEM_SAVE);
  const jot = await brief("jot down a note: key light is teal");
  expect(jot.steps[0].endpoint_id).toBe(NOTES);
  const save = await brief("save this as brand-sound: warm analog synths");
  expect(save.steps[0].endpoint_id).toBe(MEM_SAVE);
  const forgot = await brief("forget memory brand-sound");
  expect(forgot.steps[0].endpoint_id).toBe(MEM_FORGET);

  const mems = await listMem(ctx);
  // "remember …" derives the name from the content's first words
  expect(mems.some((m) => m.name === "our-hero-look-is")).toBe(true);
  expect(mems.some((m) => m.name === "brand-sound")).toBe(false);
  await ctx.dispose();
});

/* -------------------------- P4 - project-scoped retrieval -------------------------- */

test("P4: a bound session's planner turn carries the project memory DATA-framed; unbound never sees it", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P4");
  const proj = await mkProject(ctx);
  const sessBound = await (await ctx.post("/api/agent/sessions", { data: { project_id: proj.id } })).json();
  const sessLoose = await (await ctx.post("/api/agent/sessions", { data: { title: "loose" } })).json();

  const m1 = await ctx.post("/api/agent/memories", {
    data: { name: "project-sound", kind: "style", content: "warm analog pads", project_id: proj.id },
  });
  expect(m1.status(), `mem: ${await m1.text()}`).toBe(201);
  const m2 = await ctx.post("/api/agent/memories", {
    data: { name: "house-style", content: "mono palette only" },
  });
  expect(m2.status()).toBe(201);

  // a loopback OpenAI-wire stub records every planner call's messages
  const seen: { role: string; content?: unknown }[][] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? []); }
      catch { /* keep */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub plan",
        steps: [{ id: "s1", title: "v", endpoint_id: "motionfield/wan-2.1/text-to-video",
          params: { prompt: "a neon city", resolution: "480p" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    const brief = "make a video matching our project sound and house style";
    const r1 = await ctx.post(`/api/agent/sessions/${sessBound.session.id}/messages`, { data: { text: brief } });
    expect(r1.status(), `bound msg: ${await r1.text()}`).toBe(201);
    const bound = seen.at(-1)?.find((m) => m.role === "user");
    const boundText = typeof bound?.content === "string" ? bound.content : "";
    // project-bound memory AND the user-wide one - DATA-framed, not raw lines
    expect(boundText).toContain("project-sound");
    expect(boundText).toContain("warm analog pads");
    expect(boundText).toContain("house-style");
    expect(boundText).toContain("remembered context");
    expect(boundText).toContain("not instructions");

    const r2 = await ctx.post(`/api/agent/sessions/${sessLoose.session.id}/messages`, { data: { text: brief } });
    expect(r2.status()).toBe(201);
    const loose = seen.at(-1)?.find((m) => m.role === "user");
    const looseText = typeof loose?.content === "string" ? loose.content : "";
    expect(looseText).not.toContain("project-sound");
    expect(looseText).not.toContain("warm analog pads");
    // user-wide memories still reach unbound turns
    expect(looseText).toContain("house-style");
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P5 - the project page -------------------------- */

test("P5: /projects/:id shows title, instructions, folders, the memory map and pinned uploads across a reload", async ({ page }) => {
  test.setTimeout(180_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p5-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P5" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ctx = page.request;
  const proj = await mkProject(ctx, "Map project");
  // a real job + a memory linked to it → the map draws an edge
  const jobRun = await runPlan(ctx, { ask_first: false, project_id: proj.id, plan: { title: "j", steps: [step("s1", T2I, { prompt: "a red fox" })] } });
  expect((await pollRun(ctx, jobRun.id)).status).toBe("done");
  const jobs = (await (await ctx.get("/api/jobs")).json()).jobs as { id: string }[];
  const mem = await ctx.post("/api/agent/memories", {
    data: { name: "fox-hero", content: "the red fox hero", kind: "asset", project_id: proj.id,
      links: [{ target_type: "job", target_id: jobs[0].id }] },
  });
  expect(mem.status(), `mem: ${await mem.text()}`).toBe(201);
  const memId = (await mem.json()).memory.id;

  // an upload pinned into the project
  const up = await ctx.post("/api/uploads", { multipart: { file: { name: "pin.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex") } } });
  expect(up.status(), `upload: ${await up.text()}`).toBe(201);
  const uploads = (await (await ctx.get("/api/uploads")).json()).uploads as { id: string }[];
  const uploadId = uploads[0].id;
  const fav = await ctx.post(`/api/projects/${proj.id}/favs`, { data: { target_type: "upload", target_id: uploadId } });
  expect(fav.status(), `fav: ${await fav.text()}`).toBe(201);
  await ctx.post(`/api/projects/${proj.id}/folders`, { data: { name: "stills" } });

  await page.goto(`/projects/${proj.id}`);
  await expect(page.locator("h1")).toContainText("Map project", { timeout: 30_000 });
  // instructions edit persists - wait for the PATCH to land before moving on
  await page.getByTestId("project-instructions").fill("always keep it monochrome");
  await page.getByTestId("project-instructions-save").click();
  await expect(page.getByTestId("project-instructions-note")).toHaveText("saved");
  // the map: memory node + linked job node + the edge
  const map = page.getByTestId("memory-map");
  await expect(map).toBeVisible({ timeout: 30_000 });
  await expect(map.locator(`[data-node-id="mem:${memId}"]`)).toHaveCount(1);
  await expect(map.locator(`[data-node-id="job:${jobs[0].id}"]`)).toHaveCount(1);
  await expect(map.locator(`[data-edge="mem:${memId}->job:${jobs[0].id}"]`)).toHaveCount(1);
  // project memory row + folder + pinned upload
  await expect(page.getByTestId("project-memory-fox-hero")).toBeVisible();
  await expect(page.getByTestId("project-folder-stills")).toBeVisible();
  await expect(page.getByTestId(`project-upload-${uploadId}`)).toBeVisible();
  await expect(page.getByTestId(`fav-upload-${uploadId}`)).toContainText("★");

  // everything persists across a reload
  await page.reload();
  await expect(page.getByTestId("project-instructions")).toHaveValue("always keep it monochrome", { timeout: 30_000 });
  await expect(page.getByTestId("project-folder-stills")).toBeVisible();
  await expect(page.getByTestId(`project-upload-${uploadId}`)).toBeVisible();
  await expect(page.getByTestId(`fav-upload-${uploadId}`)).toContainText("★");
  await expect(map.locator(`[data-node-id="mem:${memId}"]`)).toHaveCount(1);
});

/* -------------------------- P6 - ownership walls -------------------------- */

test("P6: foreign project/memory/folder/fav/session-bind all refuse; graph is caller-scoped", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const a = await signUpCtx(baseURL, "P6-a");
  const b = await signUpCtx(baseURL, "P6-b");
  const proj = await mkProject(a, "victim");
  const mem = await ctx_postMem(a, proj.id);
  const victimJob = (await (await a.get("/api/jobs")).json()).jobs[0]?.id
    ?? (await (async () => {
      const run = await runPlan(a, { ask_first: false, plan: { title: "j", steps: [step("s1", T2I, { prompt: "x" })] } });
      await pollRun(a, run.id);
      return ((await (await a.get("/api/jobs")).json()).jobs as { id: string }[])[0].id;
    })());

  // every foreign id is a 404 - nothing reads, nothing writes
  expect((await b.get(`/api/projects/${proj.id}`)).status()).toBe(404);
  expect((await b.patch(`/api/projects/${proj.id}`, { data: { instructions: "inject" } })).status()).toBe(404);
  expect((await b.patch(`/api/projects/${proj.id}`, { data: { title: "hijacked" } })).status()).toBe(404);
  expect((await b.post(`/api/projects/${proj.id}/folders`, { data: { name: "x" } })).status()).toBe(404);
  expect((await b.get(`/api/projects/${proj.id}/folders`)).status()).toBe(404);
  expect((await b.post(`/api/projects/${proj.id}/favs`, { data: { target_type: "job", target_id: victimJob } })).status()).toBe(404);
  expect((await b.delete(`/api/projects/${proj.id}/favs`, { data: { target_type: "job", target_id: victimJob } })).status()).toBe(404);
  expect((await b.get(`/api/agent/memories/${mem.id}`)).status()).toBe(404);
  expect((await b.patch(`/api/agent/memories/${mem.id}`, { data: { content: "hijack" } })).status()).toBe(404);
  expect((await b.delete(`/api/agent/memories/${mem.id}`)).status()).toBe(404);
  expect((await b.post("/api/agent/memories", { data: { name: "x", content: "c", project_id: proj.id } })).status()).toBe(404);
  expect((await b.post("/api/agent/sessions", { data: { project_id: proj.id } })).status()).toBe(404);
  expect((await b.post("/api/agent/runs", { data: { project_id: proj.id, plan: { title: "t", steps: [step("s1", NOTES, { text: "x" })] } } })).status()).toBe(404);

  // the graph scoped to a foreign project returns the caller's own (empty)
  // set - the victim's rows never appear
  const g = await (await b.get(`/api/agent/memories/graph?project_id=${proj.id}`)).json();
  expect(g.nodes).toEqual([]);
  expect(g.edges).toEqual([]);
  expect((await listMem(b, proj.id)).length).toBe(0);

  // the victim's rows are intact
  const own = await listMem(a, proj.id);
  expect(own.find((m) => m.id === mem.id)?.content).toBe("mine");
  expect((await (await a.get(`/api/projects/${proj.id}`)).json()).project.title).toBe("victim");
  await a.dispose(); await b.dispose();
});

async function ctx_postMem(ctx: APIRequestContext, project_id: string) {
  const r = await ctx.post("/api/agent/memories", { data: { name: "victim-mem", content: "mine", project_id } });
  expect(r.status()).toBe(201);
  return (await r.json()).memory as Memory;
}

/* -------------------------- P7 - naming rules -------------------------- */

test("P7: duplicate names 409 on the API, the tool upserts, renames free the old name", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const ctx = await signUpCtx(baseURL, "P7");

  const first = await ctx.post("/api/agent/memories", { data: { name: "dup-name", content: "v1" } });
  expect(first.status()).toBe(201);
  const dup = await ctx.post("/api/agent/memories", { data: { name: "dup-name", content: "v2" } });
  expect(dup.status()).toBe(409);

  // the memory_save TOOL upserts - re-saving the same name rewrites it
  const re = await runPlan(ctx, { ask_first: false, plan: { title: "r", steps: [step("s1", MEM_SAVE, { name: "dup-name", content: "v2" })] } });
  expect((await pollRun(ctx, re.id)).status).toBe("done");
  const mems = await listMem(ctx);
  expect(mems.filter((m) => m.name === "dup-name").length).toBe(1);
  expect(mems[0].content).toBe("v2");

  // a rename frees the old name
  const id = mems[0].id;
  const renamed = await ctx.patch(`/api/agent/memories/${id}`, { data: { name: "freed-name" } });
  expect(renamed.status()).toBe(200);
  const re2 = await ctx.post("/api/agent/memories", { data: { name: "dup-name", content: "fresh" } });
  expect(re2.status(), `recreate freed name: ${await re2.text()}`).toBe(201);
  await ctx.dispose();
});

/* -------------------------- P8 - explicit memory intents (F1) -------------------------- */

test("P8: memory steps need the user's own phrasing - LLM-invented ones strip; bare 'save this as NAME' links the last job", async ({ baseURL }) => {
  test.setTimeout(240_000);
  const ctx = await signUpCtx(baseURL, "P8");
  const sess = await (await ctx.post("/api/agent/sessions", { data: { title: "p8" } })).json();
  const seed = await ctx.post("/api/agent/memories", { data: { name: "keep-me", content: "stays" } });
  expect(seed.status()).toBe(201);

  // a loopback planner stub whose every answer is a memory_forget plan -
  // a media brief must never let that step reach a run
  const calls: unknown[] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "t", steps: [{ id: "s1", title: "x", endpoint_id: MEM_FORGET,
          params: { name: "keep-me" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // a media brief - the stub "plans" a memory delete; the step strips to
    // nothing → ask (422), and the row survives
    const r1 = await ctx.post("/api/agent/runs", {
      data: { session_id: sess.session.id, text: "make a video of a fox", ask_first: true },
    });
    expect(r1.status(), `strip: ${await r1.text()}`).toBe(422);
    expect((await listMem(ctx)).some((m) => m.name === "keep-me")).toBe(true);

    // an implicit "make a note" is no memory phrasing either - same strip,
    // and no memory row appears
    const r2 = await ctx.post("/api/agent/runs", {
      data: { session_id: sess.session.id, text: "make a note of our style", ask_first: true },
    });
    expect(r2.status(), `note: ${await r2.text()}`).toBe(422);
    expect((await listMem(ctx)).filter((m) => m.name !== "keep-me")).toEqual([]);

    // the explicit phrasing goes through BUILTIN_INTENTS - the stub is never
    // even consulted (calls don't grow) and the row is really deleted
    const calls0 = calls.length;
    const r3 = await ctx.post("/api/agent/runs", {
      data: { session_id: sess.session.id, text: "forget memory keep-me", ask_first: false },
    });
    expect(r3.status(), `forget: ${await r3.text()}`).toBe(201);
    expect((await pollRun(ctx, (await r3.json()).run.id)).status).toBe("done");
    expect((await listMem(ctx)).some((m) => m.name === "keep-me")).toBe(false);
    expect(calls.length).toBe(calls0);
  } finally { await stub.close(); }

  // generate (mock) → a bare "save this as NAME" saves an asset memory
  // linked to the caller's own job whose output the session last produced
  const gen = await runPlan(ctx, {
    session_id: sess.session.id, text: "generate an image of a fox",
    planner: "builtin", ask_first: false,
  });
  expect((await pollRun(ctx, gen.id)).status).toBe("done");
  const jobId = ((await (await ctx.get("/api/jobs")).json()).jobs as { id: string }[])[0].id;

  const save = await runPlan(ctx, {
    session_id: sess.session.id, text: "save this as heroine", ask_first: false,
  });
  const saved = await pollRun(ctx, save.id);
  expect(saved.status, `save: ${JSON.stringify(saved.steps.map((s) => [s.endpoint_id, s.status, s.error]))}`).toBe("done");
  const heroine = (await listMem(ctx)).find((m) => m.name === "heroine");
  expect(heroine?.kind).toBe("asset");
  expect(heroine?.links.some((l) => l.target_type === "job" && l.target_id === jobId)).toBe(true);

  // nothing produced yet → the same phrasing asks "save what?" - no guess
  const fresh = await (await ctx.post("/api/agent/sessions", { data: { title: "empty" } })).json();
  const r4 = await ctx.post("/api/agent/runs", {
    data: { session_id: fresh.session.id, text: "save this as nothing-yet", ask_first: false },
  });
  const t4 = await r4.text();
  expect(r4.status(), `empty save: ${t4}`).toBe(422);
  expect(t4).toMatch(/save what/i);
  await ctx.dispose();
});

/* -------------------------- P9 - scopes never overwrite (F2) -------------------------- */

test("P9: the same name in the same scope upserts; across scopes it 409s and nothing moves", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P9");
  const projA = await mkProject(ctx, "A scope");
  const projB = await mkProject(ctx, "B scope");

  // same scope (project A): saving twice keeps one row, content updates
  const a1 = await runPlan(ctx, { ask_first: false, project_id: projA.id, plan: { title: "m", steps: [step("s1", MEM_SAVE, { name: "shared", content: "A v1" })] } });
  expect((await pollRun(ctx, a1.id)).status).toBe("done");
  const a2 = await runPlan(ctx, { ask_first: false, project_id: projA.id, plan: { title: "m", steps: [step("s1", MEM_SAVE, { name: "shared", content: "A v2" })] } });
  expect((await pollRun(ctx, a2.id)).status).toBe("done");
  const memsA = await listMem(ctx, projA.id);
  expect(memsA.filter((m) => m.name === "shared").length).toBe(1);
  expect(memsA[0].content).toBe("A v2");

  // cross scope (project B): the name is taken in A - the step fails with
  // the scope wording, A's row is untouched, B's list stays empty
  const bx = await runPlan(ctx, { ask_first: false, project_id: projB.id, plan: { title: "m", steps: [step("s1", MEM_SAVE, { name: "shared", content: "B clobber" })] } });
  const bfail = await pollRun(ctx, bx.id);
  expect(bfail.status).toBe("failed");
  expect(bfail.steps[0].error).toMatch(/another scope/);
  expect((await listMem(ctx, projA.id))[0].content).toBe("A v2");
  expect((await listMem(ctx, projB.id)).length).toBe(0);

  // the user-wide scope collides the same way - the name is already taken
  // in project A, so a user-scope upsert 409s too
  const uw = await runPlan(ctx, { ask_first: false, plan: { title: "m", steps: [step("s1", MEM_SAVE, { name: "shared", content: "user scope" })] } });
  const uwfail = await pollRun(ctx, uw.id);
  expect(uwfail.status).toBe("failed");
  expect(uwfail.steps[0].error).toMatch(/another scope \(a different project\)/);

  // the planner's memory block in a project-B turn never quotes project A's
  // memory - a loopback stub records what llmPlan was shown
  const seen: { role: string; content?: unknown }[][] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? []); }
      catch { /* keep */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub plan", steps: [{ id: "s1", title: "v", endpoint_id: "motionfield/wan-2.1/text-to-video",
          params: { prompt: "a city", resolution: "480p" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();
    const sessB = await (await ctx.post("/api/agent/sessions", { data: { project_id: projB.id } })).json();
    const r = await ctx.post(`/api/agent/sessions/${sessB.session.id}/messages`, {
      data: { text: "make a video about our shared look" },
    });
    expect(r.status(), `bound msg: ${await r.text()}`).toBe(201);
    const user = seen.at(-1)?.find((m) => m.role === "user");
    const text = typeof user?.content === "string" ? user.content : "";
    expect(text).not.toContain("A v2"); // another project's memory never leaks in
    expect(text).not.toContain("remembered context"); // and nothing else matched either
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P10 - project chats (F3) -------------------------- */

test("P10: 'New chat in this project' binds the session - instructions + project memory reach the planner; the chip links back", async ({ page }) => {
  test.setTimeout(240_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p10-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P10" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ctx = page.request;
  const proj = await mkProject(ctx, "Chat project");
  const patch = await ctx.patch(`/api/projects/${proj.id}`, { data: { instructions: "always keep it teal" } });
  expect(patch.ok()).toBeTruthy();
  const mem = await ctx.post("/api/agent/memories", {
    data: { name: "teal-look", content: "teal grade on everything", project_id: proj.id },
  });
  expect(mem.status(), `mem: ${await mem.text()}`).toBe(201);

  // the stub records every llmPlan request's message list
  const seen: { role: string; content?: unknown }[][] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? []); }
      catch { /* keep */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub plan", steps: [{ id: "s1", title: "v", endpoint_id: "motionfield/wan-2.1/text-to-video",
          params: { prompt: "a city", resolution: "480p" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // the button routes through ?project=<id>; the chip names the project
    await page.goto(`/projects/${proj.id}`);
    // s12fix6 F2 - instructions cap at 4000: the API 400s one char over and
    // the textarea refuses keystrokes past the cap; a save lands a note
    expect((await ctx.patch(`/api/projects/${proj.id}`, {
      data: { instructions: "x".repeat(4001) },
    })).status()).toBe(400);
    const instrTa = page.getByTestId("project-instructions");
    await expect(instrTa).toHaveValue("always keep it teal", { timeout: 30_000 });
    await expect(instrTa).toHaveAttribute("maxlength", "4000");
    await instrTa.fill("a".repeat(3999));
    await instrTa.pressSequentially("bcdef"); // only "b" fits - the cap refuses the rest
    expect((await instrTa.inputValue()).length).toBe(4000);
    await instrTa.fill("always keep it teal");
    await page.getByTestId("project-instructions-save").click();
    await expect(page.getByTestId("project-instructions-note")).toContainText("saved", { timeout: 15_000 });
    await expect(page.getByTestId("project-new-chat")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("project-new-chat").click();
    await page.waitForURL(/\/ai-assistant\?project=/, { timeout: 30_000 });
    const chip = page.getByTestId("project-chip");
    await expect(chip).toContainText("Chat project", { timeout: 30_000 });
    expect(await chip.getAttribute("href")).toBe(`/projects/${proj.id}`);

    // send a brief - the bound session's planner turn carries the project's
    // instructions (system) and its memory DATA block (user)
    await page.locator("textarea").fill("make a video of a city");
    await page.getByTitle("Send").click();
    await expect.poll(() => seen.length, { timeout: 45_000 }).toBeGreaterThan(0);
    const bound = seen.at(-1)!;
    const sysText = String(bound.find((m) => m.role === "system")?.content ?? "");
    const userText = String(bound.find((m) => m.role === "user")?.content ?? "");
    expect(sysText).toContain("always keep it teal");
    expect(userText).toContain("teal-look");
    expect(userText).toContain("remembered context");

    // a reopened bound session still shows its chip - the binding lives on
    // the session row, not the URL
    await page.goto("/ai-assistant");
    await page.locator("button", { hasText: "make a video of a city" }).first().click();
    await expect(page.getByTestId("project-chip")).toContainText("Chat project", { timeout: 30_000 });

    // a fresh unbound chat sees neither the instructions nor the memory
    seen.length = 0;
    await page.locator("button", { hasText: "New chat" }).first().click();
    await page.locator("textarea").fill("make a video of a town");
    await page.getByTitle("Send").click();
    await expect.poll(() => seen.length, { timeout: 45_000 }).toBeGreaterThan(0);
    const loose = seen.at(-1)!;
    const looseSys = String(loose.find((m) => m.role === "system")?.content ?? "");
    const looseUser = String(loose.find((m) => m.role === "user")?.content ?? "");
    expect(looseSys).not.toContain("always keep it teal");
    expect(looseUser).not.toContain("teal-look");
  } finally { await stub.close(); }
});

/* -------------------------- P11 - memory map interactions (F5) -------------------------- */

test("P11: memory nodes are focusable - a click/Enter opens the detail pane; Edit persists, Forget removes node + edges", async ({ page }) => {
  test.setTimeout(240_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p11-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P11" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ctx = page.request;
  const proj = await mkProject(ctx, "Map project");

  // a project-bound job the memory can link to
  const gen = await runPlan(ctx, {
    project_id: proj.id, ask_first: false,
    plan: { title: "g", steps: [step("s1", T2I, { prompt: "a fox" })] },
  });
  expect((await pollRun(ctx, gen.id)).status).toBe("done");
  const jobId = ((await (await ctx.get("/api/jobs")).json()).jobs as { id: string }[])[0].id;

  const mem = await ctx.post("/api/agent/memories", {
    data: { name: "fox-still", content: "the fox frame", kind: "asset",
      project_id: proj.id, links: [{ target_type: "job", target_id: jobId }] },
  });
  expect(mem.status(), `mem: ${await mem.text()}`).toBe(201);

  // a loopback planner stub records what a project-bound chat is shown -
  // used below to prove the forgotten memory leaves the planner's context
  const seen: { role: string; content?: unknown }[][] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? []); }
      catch { /* keep */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub plan", steps: [{ id: "s1", title: "v", endpoint_id: "motionfield/wan-2.1/text-to-video",
          params: { prompt: "a city", resolution: "480p" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

  await page.goto(`/projects/${proj.id}`);
  const map = page.getByTestId("memory-map");
  await expect(map).toBeVisible({ timeout: 30_000 });
  const memNode = map.locator("[data-node-type='memory']").first();

  // focusable + Enter-selectable: the detail pane shows name, kind, content, links
  await memNode.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByTestId("memory-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail).toContainText("fox-still");
  await expect(detail).toContainText("asset");
  await expect(detail).toContainText("the fox frame");
  await expect(detail).toContainText("job");

  // Edit persists through PATCH
  await page.getByTestId("memory-edit").click();
  await page.getByTestId("memory-edit-content").fill("the fox frame v2");
  await page.getByTestId("memory-edit-save").click();
  await expect.poll(async () => {
    const d = await (await ctx.get(`/api/agent/memories?project_id=${proj.id}`)).json();
    return (d.memories as { name: string; content: string }[]).find((m) => m.name === "fox-still")?.content;
  }, { timeout: 15_000 }).toBe("the fox frame v2");

  // baseline: a chat bound to this project DOES see the memory - its absence
  // after Forget (below) then means it really left the planner's context
  const boundSess = await (await ctx.post("/api/agent/sessions", { data: { project_id: proj.id } })).json();
  const m0 = await ctx.post(`/api/agent/sessions/${boundSess.session.id}/messages`, {
    data: { text: "make a video of our fox" },
  });
  expect(m0.status(), `bound msg: ${await m0.text()}`).toBe(201);
  const before = String(seen.at(-1)?.find((m) => m.role === "user")?.content ?? "");
  expect(before).toContain("fox-still");
  expect(before).toContain("the fox frame v2");

  // the target node: label, thumbnail, open link, and its memory back-links
  const jobNode = map.locator("[data-node-type='job']").first();
  await jobNode.focus();
  await page.keyboard.press("Enter");
  await expect(detail.getByTestId("memory-target-thumb")).toBeVisible({ timeout: 15_000 });
  await expect(detail.locator("a", { hasText: "open file" })).toBeVisible();
  await expect(detail.getByTestId("memory-target-backlinks")).toContainText("fox-still");

  // Forget deletes - the node AND its edge leave the map
  await memNode.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("memory-forget-detail")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("memory-forget-detail").click();
  await expect(map.locator("[data-node-type='memory']")).toHaveCount(0, { timeout: 15_000 });
  await expect(map.locator("[data-edge]")).toHaveCount(0);

  // …and the next bound-chat planner request carries no trace of it -
  // neither the name nor the content (s12fix4 G5)
  const m1 = await ctx.post(`/api/agent/sessions/${boundSess.session.id}/messages`, {
    data: { text: "make another video of our fox" },
  });
  expect(m1.status(), `bound msg 2: ${await m1.text()}`).toBe(201);
  const after = String(seen.at(-1)?.find((m) => m.role === "user")?.content ?? "");
  expect(after).not.toContain("fox-still");
  expect(after).not.toContain("the fox frame");
  expect(after).not.toContain("remembered context");
  } finally { await stub.close(); }
});

/* -------------------------- P12 - folders hold pinned items (F6) -------------------------- */

test("P12: folders hold pinned items - PATCH files them, a foreign folder 404s, DELETE unfiles, the picker persists", async ({ page }) => {
  test.setTimeout(240_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p12-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P12" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ctx = page.request;
  const proj = await mkProject(ctx, "Filing");
  const proj2 = await mkProject(ctx, "Other");

  // a project job to pin
  const gen = await runPlan(ctx, {
    project_id: proj.id, ask_first: false,
    plan: { title: "g", steps: [step("s1", T2I, { prompt: "a fox" })] },
  });
  expect((await pollRun(ctx, gen.id)).status).toBe("done");
  const jobId = ((await (await ctx.get("/api/jobs")).json()).jobs as { id: string }[])[0].id;
  const pin = await ctx.post(`/api/projects/${proj.id}/favs`, { data: { target_type: "job", target_id: jobId } });
  expect(pin.status()).toBe(201);

  const folder = await (await ctx.post(`/api/projects/${proj.id}/folders`, { data: { name: "Hero shots" } })).json();
  const folderId = folder.folder.id;
  const other = await (await ctx.post(`/api/projects/${proj2.id}/folders`, { data: { name: "Other" } })).json();

  // a foreign project's folder refuses; the real one files the pin
  const bad = await ctx.patch(`/api/projects/${proj.id}/favs`, {
    data: { target_type: "job", target_id: jobId, folder_id: other.folder.id },
  });
  expect(bad.status()).toBe(404);
  const ok = await ctx.patch(`/api/projects/${proj.id}/favs`, {
    data: { target_type: "job", target_id: jobId, folder_id: folderId },
  });
  expect(ok.status(), `file: ${await ok.text()}`).toBe(200);
  const loaded = await (await ctx.get(`/api/projects/${proj.id}`)).json();
  expect((loaded.favs as { target_id: string; folder_id: string | null }[]).find((f) => f.target_id === jobId)?.folder_id).toBe(folderId);

  // UI: the pinned tile's picker shows the folder, the chip counts it, and
  // filters show/hide the tile
  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByTestId(`pinned-job-${jobId}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`pin-folder-${jobId}`)).toHaveValue(folderId);
  await expect(page.getByTestId("pin-filter-Hero shots")).toContainText("(1)");
  await page.getByTestId("pin-filter-unfiled").click();
  await expect(page.getByTestId(`pinned-job-${jobId}`)).toHaveCount(0);
  await page.getByTestId("pin-filter-Hero shots").click();
  await expect(page.getByTestId(`pinned-job-${jobId}`)).toHaveCount(1);

  // the picker files/unfiles - a reload keeps the filing
  await page.getByTestId("pin-filter-all").click();
  await page.getByTestId(`pin-folder-${jobId}`).selectOption("");
  await expect.poll(async () => {
    const d = await (await ctx.get(`/api/projects/${proj.id}`)).json();
    return (d.favs as { target_id: string; folder_id: string | null }[]).find((f) => f.target_id === jobId)?.folder_id ?? "unfiled";
  }, { timeout: 15_000 }).toBe("unfiled");
  await page.getByTestId(`pin-folder-${jobId}`).selectOption(folderId);
  await page.reload();
  await expect(page.getByTestId(`pin-folder-${jobId}`)).toHaveValue(folderId, { timeout: 30_000 });

  // deleting the folder leaves the item pinned but unfiled - never unpinned
  await page.getByTestId("folder-delete-Hero shots").click();
  await expect.poll(async () => {
    const d = await (await ctx.get(`/api/projects/${proj.id}`)).json();
    const f = (d.favs as { target_id: string; folder_id: string | null }[]).find((x) => x.target_id === jobId);
    return f ? (f.folder_id ?? "unfiled") : "gone";
  }, { timeout: 15_000 }).toBe("unfiled");
  await expect(page.getByTestId(`pinned-job-${jobId}`)).toBeVisible();
});

/* -------------------------- P13 - upload→@ref slug retry (F7) -------------------------- */

test("P13: a taken upload→@ref name retries <slug>-2…-9 and the tile shows the resulting @name", async ({ page }) => {
  test.setTimeout(240_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p13-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P13" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ctx = page.request;
  const proj = await mkProject(ctx, "Refs");

  // upload hero.png and pin it into the project
  const tmp = mkdtempSync(join(tmpdir(), "of-ws2p13-"));
  const png = join(tmp, "hero.png");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=64x64:duration=1", "-frames:v", "1", png]);
  const up = await ctx.post("/api/uploads", {
    multipart: { file: { name: "hero.png", mimeType: "image/png", buffer: readFileSync(png) } },
  });
  expect(up.ok()).toBeTruthy();
  const { url: imgUrl } = await up.json();
  const upRow = ((await (await ctx.get("/api/uploads")).json()).uploads as { id: string; url: string }[])
    .find((u) => u.url === imgUrl);
  if (!upRow) throw new Error("upload row for imgUrl missing");
  const upId = upRow.id;
  const pin = await ctx.post(`/api/projects/${proj.id}/favs`, { data: { target_type: "upload", target_id: upId } });
  expect(pin.status()).toBe(201);

  // @hero and @hero-2 are already taken - the button must land @hero-3.
  // The seeds hold a DIFFERENT file: a ref already carrying this upload's
  // url would name the tile itself and leave nothing to click (s12fix4 G4)
  const seedUp = await ctx.post("/api/uploads", {
    multipart: { file: { name: "seed.png", mimeType: "image/png", buffer: readFileSync(png) } },
  });
  expect(seedUp.ok()).toBeTruthy();
  const { url: seedUrl } = await seedUp.json();
  for (const name of ["hero", "hero-2"]) {
    const seeded = await ctx.post("/api/refs", { data: { name, category: "prop", images: [seedUrl] } });
    expect(seeded.status(), `seed ${name}: ${await seeded.text()}`).toBe(201);
  }

  await page.goto(`/projects/${proj.id}`);
  await expect(page.getByTestId(`upload-to-ref-${upId}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`upload-to-ref-${upId}`).click();
  await expect(page.getByTestId(`upload-ref-name-${upId}`)).toHaveText("@hero-3", { timeout: 30_000 });

  // after a reload the tile still shows the @name - a ref already holds this
  // upload's url, so a second click can't mint another ref for it (s12fix4 G4)
  await page.reload();
  await expect(page.getByTestId(`upload-ref-name-${upId}`)).toHaveText("@hero-3", { timeout: 30_000 });
  await expect(page.getByTestId(`upload-to-ref-${upId}`)).toHaveCount(0);

  // "animate @hero-3" plans i2v on the ref's own image - the upload url -
  // with no ask (s12fix4 G5)
  const anim = await ctx.post("/api/agent/runs", {
    data: { text: "animate @hero-3", planner: "builtin", ask_first: true },
  });
  expect(anim.status(), `animate: ${await anim.text()}`).toBe(201);
  const animRun = (await anim.json()).run as RunView & { steps: { params?: Record<string, unknown> }[] };
  expect(animRun.steps[0]?.endpoint_id).toMatch(/image-to-video/);
  expect(animRun.steps[0]?.params?.image_url).toBe(imgUrl);
});

/* -------------------------- P14 - only memory phrasings skip the model (s12fix4 G1) -------------------------- */

test("P14: non-memory builtin phrasings reach the planner route - the stub's plan lands; memory phrasings still bypass", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P14");
  const seed = await ctx.post("/api/agent/memories", { data: { name: "p14-keep", content: "stays" } });
  expect(seed.status()).toBe(201);

  // a loopback planner stub answering a fetch→video two-step - a plan the
  // full intent table would never produce for a "summarize <url>" brief
  const calls: unknown[] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub two-step",
        steps: [
          { id: "s1", title: "fetch", endpoint_id: "agent/web_fetch",
            params: { url: "https://example.com/post" }, depends_on: [] },
          { id: "s2", title: "explain", endpoint_id: "motionfield/wan-2.1/text-to-video",
            params: { prompt: "a 20 s explainer about the post", resolution: "480p" }, depends_on: ["s1"] },
        ],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // "summarize <url> into a 20 s explainer video" - the FULL intent table
    // would have hijacked this into a lone agent/web_fetch; with only the
    // memory slice skipping the model, the stub plans it instead
    const calls0 = calls.length;
    const r1 = await ctx.post("/api/agent/runs", {
      data: { text: "summarize https://example.com/post into a 20 s explainer video", ask_first: true },
    });
    expect(r1.status(), `stubbed plan: ${await r1.text()}`).toBe(201);
    expect(calls.length).toBe(calls0 + 1);
    const run1 = (await r1.json()).run as RunView;
    expect(run1.steps.map((s) => s.endpoint_id))
      .toEqual(["agent/web_fetch", "motionfield/wan-2.1/text-to-video"]);

    // memory phrasings still bypass the model entirely - the stub never
    // sees "forget memory …" and the row is really deleted
    const calls1 = calls.length;
    const r2 = await ctx.post("/api/agent/runs", {
      data: { text: "forget memory p14-keep", ask_first: false },
    });
    expect(r2.status(), `forget: ${await r2.text()}`).toBe(201);
    expect((await pollRun(ctx, (await r2.json()).run.id)).status).toBe("done");
    expect((await listMem(ctx)).some((m) => m.name === "p14-keep")).toBe(false);
    expect(calls.length).toBe(calls1);

    // planner=builtin keeps the full table - a bare fetch phrasing still
    // plans agent/web_fetch without the model
    const r3 = await ctx.post("/api/agent/runs", {
      data: { text: "fetch https://example.com", planner: "builtin", ask_first: true },
    });
    expect(r3.status(), `builtin fetch: ${await r3.text()}`).toBe(201);
    const run3 = (await r3.json()).run as RunView;
    expect(run3.steps.map((s) => s.endpoint_id)).toEqual(["agent/web_fetch"]);
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P15 - a forget must name a memory (s12fix5 MF1) -------------------------- */

test("P15: 'delete that logo' is no memory phrasing - the stub plans it, its forget strips, the row survives", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P15");
  const sess = await (await ctx.post("/api/agent/sessions", { data: { title: "p15" } })).json();
  const seed = await ctx.post("/api/agent/memories", { data: { name: "logo", content: "the mark" } });
  expect(seed.status()).toBe(201);

  // a loopback planner stub whose every answer forgets "logo" - the brief
  // must reach it (calls grow), and even a hostile memory_forget plan can
  // only strip: "delete that logo" names no memory, so keepMemory is off
  const calls: unknown[] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "t", steps: [{ id: "s1", title: "x", endpoint_id: MEM_FORGET,
          params: { name: "logo" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // "delete that logo" - the old table would have slug-matched "logo" and
    // run a 0-credit forget straight away (ask_first:false). Now the brief
    // reaches the stub, its forget strips to nothing → ask → 422, logo lives
    const calls0 = calls.length;
    const r1 = await ctx.post("/api/agent/runs", {
      data: { session_id: sess.session.id, text: "delete that logo", ask_first: false },
    });
    expect(r1.status(), `delete-that: ${await r1.text()}`).toBe(422);
    expect(calls.length).toBe(calls0 + 1); // the stub planner WAS consulted
    expect((await listMem(ctx)).some((m) => m.name === "logo")).toBe(true);

    // the real phrasing still works and never touches the stub
    const calls1 = calls.length;
    const r2 = await ctx.post("/api/agent/runs", {
      data: { session_id: sess.session.id, text: "forget memory logo", ask_first: false },
    });
    expect(r2.status(), `forget: ${await r2.text()}`).toBe(201);
    expect((await pollRun(ctx, (await r2.json()).run.id)).status).toBe("done");
    expect((await listMem(ctx)).some((m) => m.name === "logo")).toBe(false);
    expect(calls.length).toBe(calls1);
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P16 - the model may only use media it was shown (s12fix5 MF2) -------------------------- */

test("P16: an unseen literal media url asks instead of planning; the attached /files/ url plans verbatim", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const ctx = await signUpCtx(baseURL, "P16");

  // a real upload - the /files/ url the brief attaches below
  const up = await ctx.post("/api/uploads", {
    multipart: { file: { name: "hero.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex") } },
  });
  expect(up.status(), `upload: ${await up.text()}`).toBe(201);
  const { url: imgUrl } = (await up.json()) as { url: string };

  // the stub reads the attachment llmPlan showed it ("Available media:")
  // and echoes it into an upscale plan verbatim; with nothing attached it
  // invents an https url instead - exactly the hallucination MF2 refuses
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let attUrl: string | undefined;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { role?: string; content?: unknown }[] };
        const user = (body.messages ?? []).find((m) => m.role === "user");
        const content = typeof user?.content === "string" ? user.content : "";
        attUrl = /- attached image: (\S+)/.exec(content)?.[1];
      } catch { /* keep */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "stub upscale",
        steps: [{ id: "s1", title: "Upscale", endpoint_id: "motionfield/upscale/image",
          params: { image_url: attUrl ?? "https://cdn.evil.test/invented.png" }, depends_on: [] }],
      }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // nothing attached - the stub's invented url isn't in the shown
    // messages and no earlier step outputs an image, so the turn asks
    const r1 = await ctx.post("/api/agent/runs", {
      data: { text: "upscale this image", ask_first: true },
    });
    const t1 = await r1.text();
    expect(r1.status(), `invented: ${t1}`).toBe(422);
    const d1 = JSON.parse(t1) as { error?: string };
    expect(d1.error ?? "").toMatch(/needs a image for "image_url" - attach one or name an @ref; I won't guess a file/);

    // the upload attached - the stub echoes the shown /files/ url verbatim
    // and the plan survives end to end (201, parked for approval)
    const r2 = await ctx.post("/api/agent/runs", {
      data: { text: "upscale this image", ask_first: true,
        attachments: [{ url: imgUrl, mime: "image/png", name: "hero.png" }] },
    });
    expect(r2.status(), `verbatim: ${await r2.text()}`).toBe(201);
    const run2 = (await r2.json()).run as RunView & { steps: { params?: Record<string, unknown> }[] };
    expect(run2.steps[0]?.endpoint_id).toBe("motionfield/upscale/image");
    expect(run2.steps[0]?.params?.image_url).toBe(imgUrl);
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P17 - correction answers pass the same guards (s12fix6 F1) -------------------------- */

test("P17: a plan refused twice then 'fixed' still runs the guards - a late invented url asks, a late memory step strips", async ({ baseURL }) => {
  test.setTimeout(240_000);
  const ctx = await signUpCtx(baseURL, "P17");

  // a real upload - the /files/ url the brief attaches below
  const up = await ctx.post("/api/uploads", {
    multipart: { file: { name: "hero.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex") } },
  });
  expect(up.status(), `upload: ${await up.text()}`).toBe(201);
  const { url: imgUrl } = (await up.json()) as { url: string };
  const seed = await ctx.post("/api/agent/memories", { data: { name: "logo", content: "the mark" } });
  expect(seed.status()).toBe(201);

  // the stub answers by call count within a planning turn (n resets per
  // case) - calls 1-2 echo the shown attachment url but add an undeclared
  // "bogus" param (validatePlan refuses → a correction round each); the
  // third answer is set per case below. `calls` records every request.
  const calls: unknown[] = [];
  let n = 0;
  let third: { id: string; title: string; endpoint_id: string; params: Record<string, unknown>; depends_on: string[] }[] = [];
  const stub = stubServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      n += 1;
      const steps = n <= 2
        ? [{ id: "s1", title: "Upscale", endpoint_id: "motionfield/upscale/image",
             params: { image_url: imgUrl, bogus: 1 }, depends_on: [] as string[] }]
        : third;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "stub", steps }) } }] }));
    });
  });
  try {
    const port = await stub.listen();
    expect((await ctx.put("/api/llm/providers/lmstudio", { data: { baseUrl: `http://127.0.0.1:${port}/v1` } })).ok()).toBeTruthy();
    expect((await ctx.put("/api/llm/routes/planner", { data: { providerId: "lmstudio", model: "stub-m" } })).ok()).toBeTruthy();

    // (a) the third answer invents an image_url - a pre-guard fix would have
    // returned it unguarded; now shownMedia still sees the unseen literal →
    // the ask wording, exactly 3 calls, and no run is created
    const runs0 = ((await (await ctx.get("/api/agent/runs")).json()).runs as unknown[]).length;
    third = [{ id: "s1", title: "Upscale", endpoint_id: "motionfield/upscale/image",
      params: { image_url: "https://cdn.evil.test/late.png" }, depends_on: [] }];
    const r1 = await ctx.post("/api/agent/runs", {
      data: { text: "upscale this image", ask_first: true,
        attachments: [{ url: imgUrl, mime: "image/png", name: "hero.png" }] },
    });
    const t1 = await r1.text();
    expect(r1.status(), `late invented: ${t1}`).toBe(422);
    expect((JSON.parse(t1) as { error?: string }).error ?? "")
      .toMatch(/attach one or name an @ref; I won't guess a file/);
    expect(calls.length).toBe(3);
    expect(((await (await ctx.get("/api/agent/runs")).json()).runs as unknown[]).length).toBe(runs0);

    // (b) the third answer is a clean upscale step plus a smuggled
    // memory_forget - the strip still runs on it: 201 with only the upscale
    // step, and "logo" survives the run end to end
    n = 0;
    third = [
      { id: "s1", title: "Upscale", endpoint_id: "motionfield/upscale/image",
        params: { image_url: imgUrl }, depends_on: [] },
      { id: "s2", title: "forget", endpoint_id: MEM_FORGET,
        params: { name: "logo" }, depends_on: [] },
    ];
    const r2 = await ctx.post("/api/agent/runs", {
      data: { text: "upscale this image", ask_first: false,
        attachments: [{ url: imgUrl, mime: "image/png", name: "hero.png" }] },
    });
    expect(r2.status(), `late forget: ${await r2.text()}`).toBe(201);
    const run2 = (await r2.json()).run as RunView;
    expect(run2.steps.map((s) => s.endpoint_id)).toEqual(["motionfield/upscale/image"]);
    expect((await pollRun(ctx, run2.id)).status).toBe("done");
    expect((await listMem(ctx)).some((m) => m.name === "logo")).toBe(true);
    expect(calls.length).toBe(6);
  } finally { await stub.close(); }
  await ctx.dispose();
});

/* -------------------------- P18 - save affordances (K13/K14) -------------------------- */

test("P18: typing shows 'unsaved changes - hit Save'; an aborted PATCH shows the unreachable wording", async ({ page }) => {
  test.setTimeout(120_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `ws2p18-${Date.now()}-${attempt}@test.local`, password: "test-pass-1234", name: "P18" },
    });
    if (r.ok()) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const proj = await mkProject(page.request, "Save notes");
  await page.goto(`/projects/${proj.id}`);
  await expect(page.locator("h1")).toContainText("Save notes", { timeout: 30_000 });

  // editing the textarea flags the note as unsaved until Save
  await page.getByTestId("project-instructions").fill("keep it sepia");
  await expect(page.getByTestId("project-instructions-note")).toHaveText("unsaved changes - hit Save");
  await page.getByTestId("project-instructions-save").click();
  await expect(page.getByTestId("project-instructions-note")).toHaveText("saved", { timeout: 15_000 });

  // a dropped PATCH (browser-side abort) lands the unreachable wording
  await page.route(`**/api/projects/${proj.id}`, (route) => {
    if (route.request().method() === "PATCH") return route.abort();
    return route.continue();
  });
  await page.getByTestId("project-instructions").fill("keep it teal");
  await page.getByTestId("project-instructions-save").click();
  await expect(page.getByTestId("project-instructions-note")).toContainText("save failed - server unreachable", { timeout: 15_000 });
});
