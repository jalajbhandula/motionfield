import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

/**
 * Stage-lane feature coverage: the apply_move op (catalog-move baking,
 * fuzzy names, dry-run, guards), the upgraded inspect views (problems +
 * all-camera shots), a writer draft carrying a camera move, and the
 * editor's new surfaces - the pose picker, subject-bound framing presets,
 * the bird's-eye layout camera, and the duration-over-cap warning.
 * Security assertions sit inside each test: ownership, schema strictness,
 * no absolute paths leaking to the client.
 */

test.describe.configure({ mode: "serial" });

async function signup(ctx: APIRequestContext, label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "StageLane" } })).ok()
        || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

async function mkEmpty(ctx: APIRequestContext) {
  const r = await ctx.post("/api/stage", { data: { empty: true } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as {
    id: string; revision: number;
    scene: { meta: { duration: number }; nodes: { id: string; kind: string; keys?: unknown[]; props: Record<string, unknown> }[] };
  };
}

const NO_ABS_PATH = /"(?:\/Users|\/home|\/tmp|C:\\\\)[^"]*"/;

async function waitInk(page: Page) {
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
}

/* ================= apply_move + dry_run ================= */

test("apply_move - bakes catalog moves (fuzzy names too), dry_run writes nothing, guards hold", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "sl-am-a");
    await signup(B, "sl-am-b");
    const sc = await mkEmpty(A);
    const camId = sc.scene.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;

    // dolly-in by catalog id → baked transform.pos + focalMm keys
    const r1 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: sc.revision, ops: [{ op: "apply_move", id: camId, move: "dolly-in" }] },
    });
    expect(r1.status(), await r1.text()).toBe(200);
    const j1 = await r1.json();
    expect(j1.revision).toBe(sc.revision + 1);
    const cam = j1.scene.nodes.find((n: { id: string }) => n.id === camId);
    const posKeys = cam.keys.filter((k: { path: string }) => k.path === "transform.pos");
    const focalKeys = cam.keys.filter((k: { path: string }) => k.path === "props.focalMm");
    expect(posKeys.length).toBeGreaterThan(10);
    expect(focalKeys.length).toBeGreaterThan(10);
    // the dolly actually travels - first→last key distance shrinks
    const p0 = posKeys[0].value as number[], pN = posKeys[posKeys.length - 1].value as number[];
    expect(Math.hypot(pN[0] - p0[0], pN[1] - p0[1], pN[2] - p0[2])).toBeGreaterThan(0.5);
    // scene JSON carries no absolute server paths
    expect(JSON.stringify(j1)).not.toMatch(NO_ABS_PATH);

    // fuzzy name - "push in" resolves to dolly-in
    const r2 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: j1.revision, ops: [{ op: "apply_move", id: camId, move: "push in" }] },
    });
    expect(r2.status(), await r2.text()).toBe(200);

    // duration_s + strength bound the bake - a 1s move ends by 1s
    const r3 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: (await r2.json()).revision, ops: [{ op: "apply_move", id: camId, move: "truck-left", duration_s: 1, strength: 0.5 }] },
    });
    expect(r3.status(), await r3.text()).toBe(200);
    const j3 = await r3.json();
    const ks = j3.scene.nodes.find((n: { id: string }) => n.id === camId).keys
      .filter((k: { path: string }) => k.path === "transform.pos");
    const times = ks.map((k: { t: number }) => k.t);
    expect(Math.max(...times)).toBeLessThanOrEqual(sc.scene.meta.duration);

    // dry_run - validates and returns the result without a revision bump
    const rev = j3.revision;
    const dry = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, dry_run: true, ops: [{ op: "apply_move", id: camId, move: "orbit-360" }] },
    });
    expect(dry.status(), await dry.text()).toBe(200);
    const dj = await dry.json();
    expect(dj.dry_run).toBe(true);
    expect(dj.revision).toBe(rev);
    const head = await (await A.get(`/api/stage/${sc.id}`)).json();
    expect(head.revision).toBe(rev);
    // …and the orbit didn't land: the stored cam's keys aren't the dry-run's
    const storedCam = head.scene.nodes.find((n: { id: string }) => n.id === camId);
    expect(JSON.stringify(storedCam.keys)).not.toBe(JSON.stringify(dj.scene.nodes.find((n: { id: string }) => n.id === camId).keys));

    /* ---- security / validation guards ---- */
    // unknown move → 400
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, ops: [{ op: "apply_move", id: camId, move: "totally-not-a-move" }] },
    })).status()).toBe(400);
    // apply_move on a non-camera node → 400
    const groundId = sc.scene.nodes.find((n) => n.kind === "primitive")!.id;
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, ops: [{ op: "apply_move", id: groundId, move: "dolly-in" }] },
    })).status()).toBe(400);
    // a move name over the 64-char schema bound → 400
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, ops: [{ op: "apply_move", id: camId, move: "x".repeat(80) }] },
    })).status()).toBe(400);
    // duration_s out of range → 400
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, ops: [{ op: "apply_move", id: camId, move: "dolly-in", duration_s: 0 }] },
    })).status()).toBe(400);
    // stale base_revision even on a dry run → 409, nothing written
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: 1, dry_run: true, ops: [{ op: "apply_move", id: camId, move: "dolly-in" }] },
    })).status()).toBe(409);
    // another owner's scene → 404 (ownership checked before op semantics)
    expect((await B.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: rev, ops: [{ op: "apply_move", id: camId, move: "dolly-in" }] },
    })).status()).toBe(404);
  } finally {
    await A.dispose(); await B.dispose();
  }
});

/* ================= inspect: problems + all-camera shots ================= */

test("inspect - problems reports grounding/frustum/camera/duration; shots lists every camera", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "sl-insp");
    const sc = await mkEmpty(A);
    const camId = sc.scene.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;

    // stage a problem set in one revision: a floater, a sinker, an
    // off-frustum node, a second (helper) camera
    const r = await A.post(`/api/stage/${sc.id}/ops`, {
      data: {
        base_revision: sc.revision,
        ops: [
          { op: "add", node: { id: "floater", kind: "primitive", name: "Floater", transform: { pos: [0, 3, 0] }, props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#445566" } } },
          { op: "add", node: { id: "sinker", kind: "primitive", name: "Sinker", transform: { pos: [1, -0.4, 0] }, props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#445566" } } },
          { op: "add", node: { id: "wayoff", kind: "primitive", name: "WayOff", transform: { pos: [80, 0.5, -60] }, props: { shape: "box", size: [0.4, 0.4, 0.4], color: "#445566" } } },
          { op: "add", node: { id: "cam_b", kind: "camera", name: "B cam", transform: { pos: [3, 2, 3] }, props: { focalMm: 50, sensor: "full_frame" } } },
        ],
      },
    });
    expect(r.status(), await r.text()).toBe(200);

    const insp = await (await A.get(`/api/stage/${sc.id}/inspect?view=problems&t=0`)).json();
    const codes = insp.problems.map((p: { code: string }) => p.code);
    expect(codes).toContain("floating");
    expect(codes).toContain("below-ground");
    expect(codes).toContain("outside-frustum");
    const nodes = insp.problems.map((p: { node?: string }) => p.node);
    expect(nodes.join(",")).toContain("wayoff");

    // physics reports real groundedness (metres to the floor), no fake gravity
    const phys = await (await A.get(`/api/stage/${sc.id}/inspect?view=physics&t=0`)).json();
    expect(phys.gravity).toBeUndefined();
    const floater = phys.bodies.find((b: { id: string }) => b.id === "floater");
    expect(typeof floater.groundedM).toBe("number");
    expect(floater.groundedM).toBeGreaterThan(0.05);

    // shots lists BOTH cameras; only the original is isRender
    const shots = await (await A.get(`/api/stage/${sc.id}/inspect?view=shots&t=0`)).json();
    expect(shots.cameras.length).toBe(2);
    expect(shots.cameras.filter((c: { isRender: boolean }) => c.isRender)).toHaveLength(1);
    expect(shots.cameras[0].id).toBe(camId); // render cam first
    for (const c of shots.cameras) expect(c.shots.length).toBeGreaterThan(0);

    // the ops guard refuses to strip the only render flag - no-render-camera
    // scenes can't be authored this way (unit tests cover the inspect branch
    // for legacy/corrupt docs)
    const r2 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: (await r.json()).revision, ops: [{ op: "update", id: camId, path: "props.isRender", value: false }] },
    });
    expect(r2.status(), await r2.text()).toBe(400);

    // dry_run exercises the same guard without writing a revision either
    const r2d = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: (await r.json()).revision, dry_run: true, ops: [{ op: "update", id: camId, path: "props.isRender", value: false }] },
    });
    expect(r2d.status(), await r2d.text()).toBe(400);

    // over-cap duration → flagged (authoring keeps working; the render just can't reach)
    const r3 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: { base_revision: (await r.json()).revision, ops: [{ op: "set_meta", meta: { duration: 20 } }] },
    });
    expect(r3.status(), await r3.text()).toBe(200);
    const insp3 = await (await A.get(`/api/stage/${sc.id}/inspect?view=problems`)).json();
    expect(insp3.problems.map((p: { code: string }) => p.code)).toContain("duration-over-render-cap");
  } finally {
    await A.dispose();
  }
});

/* ================= writer draft carries a camera move ================= */

test("stub writer - a draft camera move bakes into keys on create", async ({ baseURL }) => {
  const DRAFT = {
    title: "Move scene",
    nodes: [
      { kind: "mannequin", name: "Walker", pose: "walk", height: 1.7, pos: [0, 0, 0] },
      { kind: "camera", name: "Hero", pos: [0, 1.5, 6], focalMm: 40, lookAt: "Walker", move: "dolly-in", moveStrength: 1 },
    ],
  };
  const stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(DRAFT) } }],
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
  try {
    await signup(A, "sl-wr");
    expect((await A.put("/api/llm/providers/custom", { data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } })).status()).toBe(200);
    expect((await A.put("/api/llm/routes/writer", { data: { providerId: "custom", model: "stub-1" } })).status()).toBe(200);

    const gen = await A.post("/api/stage", { data: { prompt: "a walker with a dolly-in", duration: 5 } });
    expect(gen.status(), await gen.text()).toBe(201);
    const created = await gen.json();
    const cam = created.scene.nodes.find((n: { kind: string }) => n.kind === "camera");
    expect(cam.props.isRender).toBe(true);
    const posKeys = (cam.keys ?? []).filter((k: { path: string }) => k.path === "transform.pos");
    // the dolly baked over the move window - sampled path actually travels
    expect(posKeys.length).toBeGreaterThan(10);
    const zs = posKeys.map((k: { value: number[] }) => k.value[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.3);
  } finally {
    await A.dispose();
    stub.close();
  }
});

/* ================= editor surfaces ================= */

test("editor - pose picker, framing preset, layout cam, duration warning, move → render params", async ({ page }) => {
  test.setTimeout(300_000);
  await signup(page.request, "sl-ed");
  const sc = await mkEmpty(page.request);
  // a mannequin to pose + frame
  const add = await page.request.post(`/api/stage/${sc.id}/ops`, {
    data: { base_revision: sc.revision, ops: [{ op: "add", node: { id: "hero", kind: "mannequin", name: "Hero", props: { pose: "stand", height: 1.7 } } }] },
  });
  expect(add.status()).toBe(200);

  await page.goto(`/scene-3d/${sc.id}`);
  await waitInk(page);
  await page.waitForFunction(() => Boolean((window as never as { __ofStage?: unknown }).__ofStage));

  /* ---- pose picker: thumbnails + 26 poses, pick "wave" ---- */
  await page.getByTestId("outliner-hero").click();
  await page.getByTestId("pose-picker-toggle").click();
  const picker = page.getByTestId("pose-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("pose-wave")).toBeVisible();
  await expect(picker.getByTestId("pose-kneel")).toBeVisible();
  await expect(picker.getByTestId("pose-walk-contact")).toBeVisible();
  await picker.getByTestId("pose-wave").click();
  const s1 = await page.evaluate(() => (window as never as { __ofStage: { scene: { nodes: { id: string; props: { pose?: string } }[] } } }).__ofStage.scene);
  expect(s1.nodes.find((n) => n.id === "hero")?.props.pose).toBe("wave");

  /* ---- framing preset: close-up bound to Hero stamps lookAt + moves the cam ---- */
  await page.getByTestId("outliner-cam_main").click();
  const camId = sc.scene.nodes.find((n) => n.kind === "camera" && n.props.isRender)!.id;
  await page.getByTestId("preset-select").selectOption("close-up");
  await page.getByTestId("preset-subject").selectOption("hero");
  await page.getByTestId("preset-apply").click();
  const s2 = await page.evaluate(() => (window as never as { __ofStage: { scene: { nodes: { id: string; props: Record<string, unknown>; transform: { pos: number[] } }[] } } }).__ofStage.scene);
  const camNode = s2.nodes.find((n) => n.id === camId)!;
  expect(camNode.props.lookAt).toBe("hero");
  expect(Math.hypot(...camNode.transform.pos)).toBeLessThan(4); // pulled in close

  /* ---- layout cam: a non-render helper appears ---- */
  await page.getByRole("button", { name: "Layout cam" }).click();
  const s3 = await page.evaluate(() => (window as never as { __ofStage: { scene: { nodes: { id: string; name: string; kind: string; props: Record<string, unknown>; transform: { pos: number[] } }[] } } }).__ofStage.scene);
  const layout = s3.nodes.find((n) => n.name === "Layout cam")!;
  expect(layout.kind).toBe("camera");
  expect(layout.props.isRender).toBe(false);
  expect(layout.transform.pos[1]).toBeGreaterThan(3); // parked overhead
  // exactly one render camera still
  expect(s3.nodes.filter((n) => n.kind === "camera" && n.props.isRender === true)).toHaveLength(1);

  /* ---- duration warning: >9.5625 s flags, keeps authoring ---- */
  const durInput = page.getByLabel("Duration");
  await durInput.fill("20");
  await expect(page.getByTestId("duration-over-cap")).toBeVisible();
  await durInput.fill("8");
  await expect(page.getByTestId("duration-over-cap")).toHaveCount(0);

  /* ---- framing banner: an under-framed subject surfaces on the canvas ----
   * (the close-up preset bound lookAt→hero, so pushing it far makes it a
   *  speck - the tracked camera can't lose it, it just under-frames it) */
  await page.getByTestId("outliner-hero").click();
  const posWrap = page.getByLabel("Inspector")
    .locator("xpath=.//div[normalize-space()='Position (m)']/..");
  await posWrap.getByLabel("X").fill("80");
  await posWrap.getByLabel("X").press("Enter");
  const banner = page.getByTestId("framing-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("frame height");
  await posWrap.getByLabel("X").fill("0");
  await posWrap.getByLabel("X").press("Enter");
  // reframe to medium - the close-up's tight head-and-shoulders shot is
  // itself off-centre by rule, so the banner only clears at a sane distance
  await page.getByTestId("outliner-cam_main").click();
  await page.getByTestId("preset-select").selectOption("medium");
  await page.getByTestId("preset-subject").selectOption("hero");
  await page.getByTestId("preset-apply").click();
  await expect(banner).toHaveCount(0);

  /* ---- move → render: apply via toolbar, mock render carries the shot ---- */
  await page.getByLabel("Camera move").selectOption("dolly-in");
  await page.getByRole("button", { name: "Apply move" }).click();
  await page.getByRole("button", { name: "Render video" }).click();
  const dlg = page.getByTestId("render-dialog");
  await expect(dlg).toBeVisible();
  const composed = await page.getByTestId("render-composed-prompt").innerText();
  expect(composed).toContain("Scene:");
  expect(composed).toContain("Shot:");
  expect(composed).toContain("Only:");
  await dlg.getByLabel("Render duration").fill("2");
  await dlg.getByRole("button", { name: "Render", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/Render job submitted/, { timeout: 30_000 });
  const jobs = await (await page.request.get("/api/jobs")).json();
  const j = jobs.jobs.find((x: { endpointId: string }) => x.endpointId === "motionfield/stage/render");
  expect(j).toBeTruthy();
});
