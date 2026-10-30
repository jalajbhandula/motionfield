import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";

/**
 * Stage (OF-s4b): the typed ops API - revision + idempotency guards
 * (OF-0549), revision history with restore (OF-0534), still/GLB artifact
 * upload validation (OF-0539/0540/0541/0550), the inspect endpoint agents
 * read (OF-0548), and bearer-key agent access (OF-0547). UI-side coverage
 * (drawer, preview, export buttons) lives in ws5-stage-editor.spec.ts.
 */

test.describe.configure({ mode: "serial" });

async function signup(ctx: APIRequestContext, label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    try {
      if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 Ops" } })).ok()
        || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error("signup failed");
}

async function mkEmpty(ctx: APIRequestContext) {
  const r = await ctx.post("/api/stage", { data: { empty: true } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; revision: number; scene: { nodes: { id: string }[] } };
}

const ops = (base: number, list: unknown[], selection?: string) =>
  ({ base_revision: base, ops: list, ...(selection ? { selection } : {}) });

/** a 33-byte minimal PNG whose IHDR declares w×h - enough for the route's
 *  signature+dims check (the file doesn't need to be renderable) */
function pngBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

function glbBytes(json: unknown): Buffer {
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(js.length, 0);
  head.writeUInt32LE(0x4e4f534a, 4);
  const out = Buffer.alloc(12);
  out.write("glTF", 0, "latin1");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(12 + 8 + js.length, 8);
  return Buffer.concat([out, head, js]);
}

const GLB_MIN = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }], nodes: [] };

/* ============================ OF-0549: ops ============================ */

test("OF-0549 ops - apply typed ops, stale base 409s, selection scopes, proto paths refused", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5oa");
    await signup(B, "ws5ob");
    const sc = await mkEmpty(A);
    const camId = sc.scene.nodes.find((n) => n.id === "cam_main")!.id;

    // anonymous + foreign are refused before the body is even looked at
    const anon = await playwrightRequest.newContext({ baseURL });
    expect((await anon.post(`/api/stage/${sc.id}/ops`, { data: ops(1, []) })).status()).toBe(401);
    await anon.dispose();
    expect((await B.post(`/api/stage/${sc.id}/ops`, { data: ops(1, [{ op: "remove", id: "ground" }]) })).status()).toBe(404);
    expect((await A.post(`/api/stage/nope/ops`, { data: ops(1, [{ op: "remove", id: "ground" }]) })).status()).toBe(404);

    // apply an add + update
    const r1 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(1, [
        { op: "add", node: { kind: "primitive", name: "Pylon", props: { shape: "box", size: [1, 1, 1], color: "#3366aa" } } },
        { op: "update", id: camId, path: "transform.pos", value: [3, 2, 6] },
      ]),
    });
    expect(r1.status(), await r1.text()).toBe(200);
    const d1 = await r1.json();
    expect(d1.revision).toBe(2);
    const pylon = d1.scene.nodes.find((n: { name: string }) => n.name === "Pylon");
    expect(pylon.id).toMatch(/^[a-z0-9_]+$/);
    expect(d1.scene.nodes.find((n: { id: string }) => n.id === camId).transform.pos).toEqual([3, 2, 6]);

    // stale base → 409 carrying the head
    const stale = await A.post(`/api/stage/${sc.id}/ops`, { data: ops(1, [{ op: "remove", id: "ground" }]) });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).head_revision).toBe(2);

    // proto + non-whitelisted paths → 400, head untouched
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: camId, path: "__proto__.polluted", value: 1 }]),
    })).status()).toBe(400);
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: camId, path: "props.focalMm.nested.deep", value: 1 }]),
    })).status()).toBe(400);

    // a model src that isn't an owned upload is refused at commit time
    const withModel = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "add", node: { kind: "model", name: "Ext", props: { src: "/files/uploads/not-mine.glb" } } }]),
    });
    expect([400, 404]).toContain(withModel.status());
    expect((await A.get(`/api/stage/${sc.id}`)).status()).toBe(200);
    expect((await (await A.get(`/api/stage/${sc.id}`)).json()).revision).toBe(2);

    // selection scoping - ops outside the selection never land
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: "ground", path: "name", value: "no" }], camId),
    })).status()).toBe(400);
    const scoped = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: camId, path: "name", value: "Scoped" }], camId),
    });
    expect(scoped.status(), await scoped.text()).toBe(200);
    expect((await scoped.json()).scene.nodes.find((n: { id: string }) => n.id === camId).name).toBe("Scoped");

    // empty ops array fails schema; >200 ops fails schema
    expect((await A.post(`/api/stage/${sc.id}/ops`, { data: ops(3, []) })).status()).toBe(400);
    const big = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(3, Array.from({ length: 201 }, () => ({ op: "update", id: camId, path: "name", value: "x" }))),
    });
    expect(big.status()).toBe(400);
  } finally {
    await A.dispose(); await B.dispose();
  }
});

test("OF-0549 ops idempotency - identical replay, mismatched key 422s, key rules", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5oi");
    const sc = await mkEmpty(A);
    const key = "op-key-1";
    const body = ops(1, [{ op: "update", id: "cam_main", path: "name", value: "Idem" }]);

    const r1 = await A.post(`/api/stage/${sc.id}/ops`, { data: body, headers: { "idempotency-key": key } });
    expect(r1.status(), await r1.text()).toBe(200);
    const d1 = await r1.json();
    expect(d1.revision).toBe(2);

    // byte-identical retry - the stored response replays, no new revision
    const r2 = await A.post(`/api/stage/${sc.id}/ops`, { data: body, headers: { "idempotency-key": key } });
    expect(r2.status()).toBe(200);
    const d2 = await r2.json();
    expect(d2.revision).toBe(2);
    // jsonb round-trips reorder keys - compare structurally
    expect(d2.scene).toEqual(d1.scene);
    expect((await (await A.get(`/api/stage/${sc.id}`)).json()).revision).toBe(2);

    // same key + different body → 422, scene untouched
    const r3 = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: "cam_main", path: "name", value: "Changed" }]),
      headers: { "idempotency-key": key },
    });
    expect(r3.status()).toBe(422);
    expect((await r3.json()).code).toBe("IDEMPOTENCY_MISMATCH");
    expect((await (await A.get(`/api/stage/${sc.id}`)).json()).revision).toBe(2);

    // the same key against a different scene → mismatch too
    const sc2 = await mkEmpty(A);
    const r4 = await A.post(`/api/stage/${sc2.id}/ops`, { data: body, headers: { "idempotency-key": key } });
    expect(r4.status()).toBe(422);

    // malformed keys 400 before anything else
    expect((await A.post(`/api/stage/${sc.id}/ops`, {
      data: body, headers: { "idempotency-key": "not a key!" },
    })).status()).toBe(400);

    // a key-less retry still hits the revision guard
    expect((await A.post(`/api/stage/${sc.id}/ops`, { data: body })).status()).toBe(409);
  } finally {
    await A.dispose();
  }
});

/* ============================ OF-0534: revisions ============================ */

test("OF-0534 revisions - list/get/restore, append-only, stale restore 409s", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5ra");
    await signup(B, "ws5rb");
    const sc = await mkEmpty(A);

    // creation itself wrote revision row 1
    const l0 = await (await A.get(`/api/stage/${sc.id}/revisions`)).json();
    expect(l0.revisions).toHaveLength(1);
    expect(l0.revisions[0].revision).toBe(1);
    expect(l0.revisions[0].source).toBe("create");

    // a PUT save and an ops commit each add a row
    await A.put(`/api/stage/${sc.id}`, { data: { base_revision: 1, title: "v2 title" } });
    await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(2, [{ op: "update", id: "cam_main", path: "name", value: "r3 cam" }]),
    });
    const l1 = await (await A.get(`/api/stage/${sc.id}/revisions`)).json();
    expect(l1.revisions.map((r: { revision: number }) => r.revision)).toEqual([3, 2, 1]);
    expect(l1.revisions.map((r: { source: string }) => r.source)).toEqual(["ops", "save", "create"]);

    // single-revision GET carries the full historical scene
    const r1 = await A.get(`/api/stage/${sc.id}/revisions/1`);
    expect(r1.status()).toBe(200);
    const d1 = await r1.json();
    expect(d1.revision).toBe(1);
    expect(d1.scene.nodes.find((n: { id: string }) => n.id === "cam_main").name).not.toBe("r3 cam");
    expect((await A.get(`/api/stage/${sc.id}/revisions/99`)).status()).toBe(404);
    expect((await A.get(`/api/stage/${sc.id}/revisions/0`)).status()).toBe(404);

    // restore r1 → new head revision 4, history keeps every row
    const stale = await A.post(`/api/stage/${sc.id}/revisions/1/restore`, { data: { base_revision: 1 } });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).head_revision).toBe(3);
    const ok = await A.post(`/api/stage/${sc.id}/revisions/1/restore`, { data: { base_revision: 3 } });
    expect(ok.status(), await ok.text()).toBe(200);
    const d4 = await ok.json();
    expect(d4.revision).toBe(4);
    expect(d4.scene.nodes.find((n: { id: string }) => n.id === "cam_main").name).toBe(d1.scene.nodes.find((n: { id: string }) => n.id === "cam_main").name);
    const l2 = await (await A.get(`/api/stage/${sc.id}/revisions`)).json();
    expect(l2.revisions.map((r: { revision: number }) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(l2.revisions[0].source).toBe("restore");

    // foreign user: all revision routes 404
    for (const r of [
      await B.get(`/api/stage/${sc.id}/revisions`),
      await B.get(`/api/stage/${sc.id}/revisions/1`),
      await B.post(`/api/stage/${sc.id}/revisions/1/restore`, { data: { base_revision: 4 } }),
    ]) expect(r.status()).toBe(404);
  } finally {
    await A.dispose(); await B.dispose();
  }
});

/* ============================ OF-0539/0540/0541: exports ============================ */

test("OF-0539 still export - valid PNG uploads into /files + uploads row; bad bytes 400", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5xa");
    const sc = await mkEmpty(A);
    const upload = async (kind: string, fields: Record<string, string>, file: Buffer, name = "x.bin") =>
      A.post(`/api/stage/${sc.id}/exports`, {
        multipart: { kind, ...fields, file: { name, mimeType: "application/octet-stream", buffer: file } },
      });

    const ok = await upload("still", { w: "320", h: "180" }, pngBytes(320, 180), "still.png");
    expect(ok.status(), await ok.text()).toBe(201);
    const d = await ok.json();
    expect(d.url).toMatch(/^\/files\/uploads\/[0-9a-f-]+\.png$/);
    expect(d.mime).toBe("image/png");

    // the upload row lists the file - owner can fetch it back
    expect((await A.get(d.url)).status()).toBe(200);
    const ups = await (await A.get("/api/uploads")).json();
    expect(ups.uploads.map((u: { url: string }) => u.url)).toContain(d.url);

    // lying about dims or shipping non-PNG bytes → 400, nothing stored
    expect((await upload("still", { w: "640", h: "360" }, pngBytes(320, 180), "a.png")).status()).toBe(400);
    expect((await upload("still", { w: "64", h: "64" }, Buffer.from("not a png"), "b.png")).status()).toBe(400);
    expect((await upload("still", { w: "63", h: "64" }, pngBytes(64, 64), "c.png")).status()).toBe(400); // out of range
    expect((await upload("still", {}, pngBytes(64, 64), "d.png")).status()).toBe(400); // missing w/h
  } finally {
    await A.dispose();
  }
});

test("[OF-0540][OF-0541][OF-0550] GLB export - minimal doc uploads; bad magic/external refs/over-limit nodes refused", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  const B = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5gb");
    await signup(B, "ws5gc");
    const sc = await mkEmpty(A);
    const upload = (buf: Buffer, fields: Record<string, string> = {}) =>
      A.post(`/api/stage/${sc.id}/exports`, {
        multipart: { kind: "glb", ...fields, file: { name: "scene.glb", mimeType: "model/gltf-binary", buffer: buf } },
      });

    const ok = await upload(glbBytes(GLB_MIN));
    expect(ok.status(), await ok.text()).toBe(201);
    const d = await ok.json();
    expect(d.url).toMatch(/^\/files\/uploads\/[0-9a-f-]+\.glb$/);
    expect(d.mime).toBe("model/gltf-binary");

    const badMagic = glbBytes(GLB_MIN); badMagic[0] = 0x00;
    expect((await upload(badMagic)).status()).toBe(400);
    expect((await upload(Buffer.from("garbage"))).status()).toBe(400);
    expect((await upload(glbBytes({
      asset: { version: "2.0" },
      buffers: [{ uri: "https://evil.example/x.bin", byteLength: 4 }],
    }))).status()).toBe(400);
    expect((await upload(glbBytes({
      asset: { version: "2.0" }, scene: 0,
      scenes: [{ nodes: Array.from({ length: 301 }, (_, i) => i) }],
      nodes: Array.from({ length: 301 }, () => ({})),
    }))).status()).toBe(400);

    // wrong kind / missing file / foreign user / anonymous
    expect((await A.post(`/api/stage/${sc.id}/exports`, {
      multipart: { kind: "nope", file: { name: "x", mimeType: "application/octet-stream", buffer: Buffer.from("x") } },
    })).status()).toBe(400);
    expect((await B.post(`/api/stage/${sc.id}/exports`, {
      multipart: { kind: "glb", file: { name: "s.glb", mimeType: "model/gltf-binary", buffer: glbBytes(GLB_MIN) } },
    })).status()).toBe(404);
  } finally {
    await A.dispose(); await B.dispose();
  }
});

/* ============================ OF-0548: inspect ============================ */

test("[OF-0548] inspect - meta + camera pose + world transforms + aabb; ?t and ?rev", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5ia");
    const sc = await mkEmpty(A);

    // key the render camera's x at t=0 vs t=5 so ?t visibly samples
    const keyed = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(1, [
        { op: "set_keys", id: "cam_main", keys: [
          { t: 0, path: "transform.pos", value: [0, 1.6, 8] },
          { t: 5, path: "transform.pos", value: [10, 1.6, 8] },
        ] },
      ]),
    });
    expect(keyed.status(), await keyed.text()).toBe(200);

    const at0 = await (await A.get(`/api/stage/${sc.id}/inspect?t=0`)).json();
    expect(at0.t).toBe(0);
    expect(at0.meta.title).toBeTruthy();
    const cam0 = at0.nodes.find((n: { id: string }) => n.id === "cam_main");
    expect(cam0.pos[0]).toBeCloseTo(0, 3);
    expect(at0.camera.pos[0]).toBeCloseTo(0, 3);
    expect(at0.bounds).toBeTruthy();

    const at5 = await (await A.get(`/api/stage/${sc.id}/inspect?t=5`)).json();
    expect(at5.nodes.find((n: { id: string }) => n.id === "cam_main").pos[0]).toBeCloseTo(10, 3);

    // ?rev reads the stored revision - r1 has no keys → the base transform
    const atRev = await (await A.get(`/api/stage/${sc.id}/inspect?rev=1`)).json();
    const revCam = atRev.nodes.find((n: { id: string }) => n.id === "cam_main");
    expect(revCam.pos[0]).toBeCloseTo(0, 3); // create-time base pos, not the keyed t=0

    expect((await A.get(`/api/stage/${sc.id}/inspect?rev=99`)).status()).toBe(404);
    expect((await A.get(`/api/stage/${sc.id}/inspect?rev=abc`)).status()).toBe(400);
  } finally {
    await A.dispose();
  }
});

test("[OF-0548b] inspect - view= contract: meta/tree/shots/physics/problems, compat t=<view>, invalid views 400", async ({ baseURL }) => {
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5iv");
    const sc = await mkEmpty(A);
    // a camera path so shots has real segments
    const pathed = await A.post(`/api/stage/${sc.id}/ops`, {
      data: ops(1, [{ op: "set_camera_path", id: "cam_main", path: {
        points: [[0, 1.6, 8], [4, 1.6, 6], [2, 2.5, 4]],
        times: [0, 4, 8],
      } }]),
    });
    expect(pathed.status(), await pathed.text()).toBe(200);

    const meta = await (await A.get(`/api/stage/${sc.id}/inspect?view=meta`)).json();
    expect(meta.view).toBe("meta");
    expect(meta.meta.title).toBeTruthy();
    expect(meta.nodeCount).toBeGreaterThan(0);
    expect(meta.nodes).toBeUndefined(); // meta is not the tree

    const tree = await (await A.get(`/api/stage/${sc.id}/inspect?view=tree&t=4`)).json();
    expect(tree.view).toBe("tree");
    expect(tree.t).toBe(4);
    expect(tree.nodes.find((n: { id: string }) => n.id === "cam_main")).toBeTruthy();

    const shots = await (await A.get(`/api/stage/${sc.id}/inspect?view=shots`)).json();
    expect(shots.view).toBe("shots");
    expect(shots.shots.map((s: { kind: string }) => s.kind)).toEqual(["path-segment", "path-segment", "static"]);
    expect(shots.shots[0].to).toEqual(shots.shots[1].from); // segments share the boundary pose
    expect(shots.shots[2].start).toBe(8);

    const phys = await (await A.get(`/api/stage/${sc.id}/inspect?view=physics`)).json();
    expect(phys.view).toBe("physics");
    expect(phys.bodies.length).toBe(meta.nodeCount);
    expect(phys.bodies.find((b: { id: string }) => b.id === "cam_main").animated).toBe(false);

    const probs = await (await A.get(`/api/stage/${sc.id}/inspect?view=problems`)).json();
    expect(probs.view).toBe("problems");
    expect(Array.isArray(probs.problems)).toBe(true);

    // compat - the old ?t=<view name> still routes (that's what pre-view
    // sdk/mcp/cli sent), and t=<number> still samples the tree
    const compat = await (await A.get(`/api/stage/${sc.id}/inspect?t=meta`)).json();
    expect(compat.view).toBe("meta");
    const compatShots = await (await A.get(`/api/stage/${sc.id}/inspect?t=shots`)).json();
    expect(compatShots.view).toBe("shots");

    // invalid - an explicit named view that doesn't exist is a 400, not a
    // silent t=0 tree; a numeric t is never a view error
    expect((await A.get(`/api/stage/${sc.id}/inspect?view=bogus`)).status()).toBe(400);
    expect((await A.get(`/api/stage/${sc.id}/inspect?t=banana`)).status()).toBe(400);
    expect((await A.get(`/api/stage/${sc.id}/inspect?t=2.5`)).status()).toBe(200);
  } finally {
    await A.dispose();
  }
});

/* ================= OF-0547: bearer keys + 401 on every route ================= */

test("[OF-0547] Bearer API key - create/list/get/inspect/ops/revisions/exports all work; logged-out callers get 401 on every stage route", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const A = await playwrightRequest.newContext({ baseURL });
  const anon = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5key");
    const keyRes = await A.post("/api/keys", { data: { label: "stage-e2e" } });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const { key } = await keyRes.json();
    expect(key).toMatch(/^of_[A-Za-z0-9]{12}_/);
    const K = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { authorization: `Bearer ${key}` },
    });

    // an of_ key drives every stage route a session can - no cookies needed
    const mk = await K.post("/api/stage", { data: { empty: true } });
    expect(mk.status(), await mk.text()).toBe(201);
    const sc = await mk.json();

    const list = await (await K.get("/api/stage")).json();
    expect(list.scenes.map((s: { id: string }) => s.id)).toContain(sc.id);
    expect((await K.get(`/api/stage/${sc.id}`)).status()).toBe(200);
    expect((await K.get(`/api/stage/${sc.id}/inspect`)).status()).toBe(200);

    const op = await K.post(`/api/stage/${sc.id}/ops`, {
      data: ops(1, [{ op: "update", id: "cam_main", path: "name", value: "Keyed" }]),
    });
    expect(op.status(), await op.text()).toBe(200);
    expect((await op.json()).revision).toBe(2);

    const revs = await (await K.get(`/api/stage/${sc.id}/revisions`)).json();
    expect(revs.revisions.length).toBeGreaterThanOrEqual(2);
    expect((await K.get(`/api/stage/${sc.id}/revisions/1`)).status()).toBe(200);
    expect((await K.post(`/api/stage/${sc.id}/revisions/1/restore`, { data: { base_revision: 2 } })).status()).toBe(200);

    const ex = await K.post(`/api/stage/${sc.id}/exports`, {
      multipart: { kind: "still", w: "320", h: "180", file: { name: "s.png", mimeType: "image/png", buffer: pngBytes(320, 180) } },
    });
    expect(ex.status(), await ex.text()).toBe(201);

    // a bad of_ token is 401 outright - it never falls through to session auth
    const bad = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: "Bearer of_zzzzzzzzzzzz_wrong" } });
    expect((await bad.get(`/api/stage/${sc.id}`)).status()).toBe(401);
    await bad.dispose();
    await K.dispose();

    // logged-out: EVERY stage route is 401 - not just ops
    for (const hit of [
      () => anon.get("/api/stage"),
      () => anon.post("/api/stage", { data: { empty: true } }),
      () => anon.get(`/api/stage/${sc.id}`),
      () => anon.put(`/api/stage/${sc.id}`, { data: { base_revision: 1, title: "x" } }),
      () => anon.delete(`/api/stage/${sc.id}`),
      () => anon.post(`/api/stage/${sc.id}/ops`, { data: ops(1, [{ op: "remove", id: "ground" }]) }),
      () => anon.post(`/api/stage/${sc.id}/prompt`, { data: { instruction: "x", base_revision: 1 } }),
      () => anon.get(`/api/stage/${sc.id}/revisions`),
      () => anon.get(`/api/stage/${sc.id}/revisions/1`),
      () => anon.post(`/api/stage/${sc.id}/revisions/1/restore`, { data: { base_revision: 1 } }),
      () => anon.get(`/api/stage/${sc.id}/inspect`),
      () => anon.post(`/api/stage/${sc.id}/exports`, { multipart: { kind: "still", file: { name: "x.png", mimeType: "image/png", buffer: pngBytes(64, 64) } } }),
    ]) {
      const r = await hit();
      expect(r.status(), `${r.url()}`).toBe(401);
    }
  } finally {
    await A.dispose(); await anon.dispose();
  }
});

/* ============ OF-0534: session saves + revision pruning ============ */

test("[OF-0534] two session_id PUT streams keep one save row each; 205 ops calls prune to ≤200 with the head kept", async ({ baseURL }) => {
  test.setTimeout(240_000);
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5sess");
    const sc = await mkEmpty(A);
    const save = (rev: number, sid: string) =>
      A.put(`/api/stage/${sc.id}`, { data: { base_revision: rev, title: `t${rev}`, session_id: sid } });

    // interleaved sessions - each collapses into its own latest 'save' row
    let rev = 1;
    for (const sid of ["s-a", "s-a", "s-b", "s-a", "s-b"]) {
      const r = await save(rev, sid);
      expect(r.status()).toBe(200);
      rev = (await r.json()).revision;
    }
    expect(rev).toBe(6);
    const l = await (await A.get(`/api/stage/${sc.id}/revisions`)).json();
    const saves = l.revisions.filter((r: { source: string }) => r.source === "save");
    expect(saves).toHaveLength(2); // one per session - not five
    expect(l.revisions.at(-1).source).toBe("create");

    // a long ops stream prunes history but the head is never lost
    let head = rev;
    for (let i = 0; i < 205; i++) {
      const r = await A.post(`/api/stage/${sc.id}/ops`, {
        data: ops(head, [{ op: "update", id: "cam_main", path: "name", value: `Cam ${i}` }]),
      });
      expect(r.status()).toBe(200);
      head = (await r.json()).revision;
    }
    expect(head).toBe(6 + 205);
    const list = await (await A.get(`/api/stage/${sc.id}/revisions`)).json();
    expect(list.revisions[0].revision).toBe(head); // head kept
    expect(list.revisions[0].source).toBe("ops");
    // the table holds 208 rows (create + 2 session saves + 205 ops) - pruning
    // keeps the head plus the newest 199 others by revision → r12..r211
    // survive; r11 and below (create + the slid saves) are gone. The list
    // endpoint tops out at 100 rows, so fetch the boundary rows directly.
    expect((await A.get(`/api/stage/${sc.id}/revisions/${head - 199}`)).status()).toBe(200);
    expect((await A.get(`/api/stage/${sc.id}/revisions/${head - 200}`)).status()).toBe(404);
    expect((await A.get(`/api/stage/${sc.id}/revisions/1`)).status()).toBe(404);
  } finally {
    await A.dispose();
  }
});

/* ============ OF-0539/0541: oversize artifacts refuse 413 ============ */

test("[OF-0539][OF-0541] oversize artifacts - a still over 16 MB and a GLB over 32 MB both get 413", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const A = await playwrightRequest.newContext({ baseURL });
  try {
    await signup(A, "ws5xl");
    const sc = await mkEmpty(A);

    // a >16 MB PNG - the size check runs before signature parsing
    const big = Buffer.alloc(17 * 1024 * 1024, 0x61);
    pngBytes(4096, 4096).copy(big, 0);
    const still = await A.post(`/api/stage/${sc.id}/exports`, {
      multipart: { kind: "still", w: "4096", h: "4096", file: { name: "big.png", mimeType: "image/png", buffer: big } },
    });
    expect(still.status()).toBe(413);
    expect((await still.json()).error).toMatch(/too large/);

    // a >32 MB GLB exceeds even the read cap → 413
    const huge = Buffer.alloc(33 * 1024 * 1024, 0x62);
    const glb = await A.post(`/api/stage/${sc.id}/exports`, {
      multipart: { kind: "glb", file: { name: "big.glb", mimeType: "model/gltf-binary", buffer: huge } },
    });
    expect(glb.status()).toBe(413);
    expect((await glb.json()).error).toMatch(/too large/);
  } finally {
    await A.dispose();
  }
});
