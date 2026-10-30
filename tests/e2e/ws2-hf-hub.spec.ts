import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * WS2 s3c - Settings → download any Hugging Face model (e2e):
 *  a mock HF Hub on 127.0.0.1:3197 (MOTIONFIELD_HF_BASE seam), a stub Ollama
 *  reached through PUT /api/llm/providers/ollama {baseUrl}, COMFYUI_DIR and
 *  MOTIONFIELD_HUB_TEST_FREE_GB=12 from the env. Skips with a plain reason
 *  when MOTIONFIELD_HF_BASE is unset.
 *
 *  E1 apache-2.0 inspect → ~2 MB .safetensors into loras, sha-verified, label
 *  E2 drop mid-file → failed row → Resume → Range bytes=<part>- → 206 → done
 *  E3 wrong bytes → checksum mismatch, nothing left behind
 *  E4 NC / "other" / gated / restricted-opt-in licence verdicts
 *  E5 3 GB declared file → the 10 GB floor wording, nothing written
 *  E6 traversal/absolute/unknown subfolder/.ckpt → 400, nothing escapes models/
 *  E7 GGUF pull → Ollama stub sees hf.co/<repo>:<quant>; NC → 0 stub calls
 *  E8 401 signed-out; user B sees no A rows; B's DELETE on A's id → 404
 *  E9 Offline on → inspect/start/pull 403 but GET/DELETE still pass (K8)
 *  E10 concurrent POSTs → 202+409; DELETE mid-download → canceled, .part kept
 *      → re-POST resumes with Range (K4, K14)
 *  E11 a 200 answering a Range restarts the file + hash → done, sha ok (K2)
 *  E12 red-flag repo/file → 400 "banned list" before any HF request (K11)
 *  E13 symlink target / symlink .part → 400 before anything writes (K12)
 *  E14 a pull stream that ends without a success line → failed, never done (K3)
 *  E15 turning Offline on aborts a live download; reads still pass (K8, K14)
 */

test.describe.configure({ mode: "serial" });

const HF_ENV = process.env.MOTIONFIELD_HF_BASE;
const COMFY = process.env.COMFYUI_DIR ?? "/tmp/of-e2e-comfy";
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** K1: COMFY must realpath under the OS tmpdir (or /tmp) inside an of-*
 *  dir - the spec-owned basename is the first segment under the tmp root
 *  (/tmp/of-ws2/comfy → "of-ws2"). Anything else and the suite refuses to
 *  touch the disk. */
const COMFY_REAL = (() => {
  try { return realpathSync(COMFY); } catch { return resolve(COMFY); }
})();
const TMP_REAL = realpathSync(tmpdir());
const TMP_SEG = (() => {
  for (const root of [TMP_REAL, "/tmp"]) {
    if (COMFY_REAL.startsWith(`${root}/`)) return COMFY_REAL.slice(root.length + 1).split("/")[0] ?? "";
  }
  return "";
})();
const COMFY_OK = TMP_SEG.startsWith("of-");

type RepoSpec = {
  license?: string | string[];
  gated?: false | "auto" | "manual";
  priv?: boolean;
  files: { path: string; body?: Buffer; declaredSize?: number; declaredSha?: string }[];
  dropOnceBytes?: number; // serve only the head once, then destroy the socket
  slowMs?: number;        // drip the body in chunks - a mid-download cancel is reachable
  slowChunk?: number;
  ignoreRange?: boolean;  // answer 200 with the full body even to a Range request
};

const GOOD_BODY = randomBytes(2 * 1024 * 1024);
const RESUME_BODY = randomBytes(1024 * 1024);
const SMALL = randomBytes(64 * 1024);
const SLOW_BODY = randomBytes(2 * 1024 * 1024);
const FULL_BODY = randomBytes(1024 * 1024);

const REPOS: Record<string, RepoSpec> = {
  "open/good": { license: "apache-2.0", files: [{ path: "model.safetensors", body: GOOD_BODY }] },
  "open/resume": {
    license: "apache-2.0",
    files: [{ path: "resume.safetensors", body: RESUME_BODY }],
    dropOnceBytes: 400_000,
  },
  "open/slow": {
    license: "apache-2.0",
    files: [{ path: "slow.safetensors", body: SLOW_BODY }],
    slowMs: 25, slowChunk: 16 * 1024,
  },
  "open/full200": {
    license: "apache-2.0",
    files: [{ path: "full.safetensors", body: FULL_BODY }],
    dropOnceBytes: 400_000, ignoreRange: true,
  },
  "open/links": {
    license: "apache-2.0",
    files: [{ path: "link.safetensors", body: SMALL }, { path: "part.safetensors", body: SMALL }],
  },
  "bad/wrong": {
    license: "apache-2.0",
    files: [{ path: "w.safetensors", body: SMALL, declaredSha: sha256(randomBytes(32)) }],
  },
  "nc/mix": { license: "cc-by-nc-4.0", files: [{ path: "n.safetensors", body: SMALL }] },
  "alien/blob": { license: "other", files: [{ path: "o.safetensors", body: SMALL }] },
  "auto/gated": { license: "apache-2.0", gated: "auto", files: [{ path: "g.safetensors", body: SMALL }] },
  "comm/pack": { license: "ltx-community", files: [{ path: "c.safetensors", body: SMALL }] },
  "huge/blob": { license: "apache-2.0", files: [{ path: "h.safetensors", declaredSize: 3 * 2 ** 30 }] },
  "brain/gguf": {
    license: "apache-2.0",
    files: [{ path: "m-Q4_K_M.gguf", body: SMALL }, { path: "m-F16.gguf", body: SMALL }],
  },
  "nc/gguf": { license: "cc-by-nc-4.0", files: [{ path: "n-Q4_K_M.gguf", body: SMALL }] },
};

const hfCalls: { url: string; range: string | undefined }[] = [];
const ollamaPulls: string[] = [];
let droppedOnce = false;
const resolveCalls = (frag = "") => hfCalls.filter((c) => c.url.includes("/resolve/") && c.url.includes(frag));

function hfServer(port: number) {
  return createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const parts = u.pathname.split("/").filter(Boolean);
    hfCalls.push({ url: u.pathname, range: req.headers.range });
    // /api/models/<o>/<n> and /api/models/<o>/<n>/tree/<sha>
    if (parts[0] === "api" && parts[1] === "models" && parts.length >= 4) {
      const spec = REPOS[`${parts[2]}/${parts[3]}`];
      res.setHeader("content-type", "application/json");
      if (!spec) { res.writeHead(404).end("{}"); return; }
      if (parts[4] === "tree") {
        res.writeHead(200).end(JSON.stringify(spec.files.map((f) => ({
          type: "file", path: f.path,
          size: f.declaredSize ?? f.body?.length ?? 0,
          lfs: { oid: f.declaredSha ?? sha256(f.body ?? Buffer.alloc(0)), size: f.declaredSize ?? f.body?.length ?? 0 },
        }))));
        return;
      }
      res.writeHead(200).end(JSON.stringify({
        // a real card sha is a 40-hex commit id - K6 keeps it that way
        sha: createHash("sha1").update(`${parts[2]}/${parts[3]}`).digest("hex"),
        gated: spec.gated ?? false,
        private: !!spec.priv,
        cardData: { license: spec.license ?? null },
      }));
      return;
    }
    // /<o>/<n>/resolve/<sha>/<file...>
    if (parts[2] === "resolve" && parts.length >= 5) {
      const spec = REPOS[`${parts[0]}/${parts[1]}`];
      const file = spec?.files.find((f) => f.path === parts.slice(4).join("/"));
      if (!file?.body) { res.writeHead(404).end(); return; }
      res.on("error", () => {}); // a client-aborted drip is not a crash
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (spec.dropOnceBytes && !droppedOnce && !range) {
        droppedOnce = true;
        res.writeHead(200, { "content-length": file.body.length });
        res.write(file.body.subarray(0, spec.dropOnceBytes), () => req.socket.destroy());
        return;
      }
      if (range && !spec.ignoreRange) {
        const start = Number(range[1]);
        res.writeHead(206, {
          "content-range": `bytes ${start}-${file.body.length - 1}/${file.body.length}`,
          "content-length": file.body.length - start,
        }).end(file.body.subarray(start));
        return;
      }
      if (spec.slowMs && !range) {
        // slow drip - keeps the transfer in flight long enough to cancel
        res.writeHead(200, { "content-length": file.body.length });
        let off = 0;
        const chunk = spec.slowChunk ?? 16 * 1024;
        const tick = () => {
          if (req.socket.destroyed || res.writableEnded) return;
          try {
            const c = file.body!.subarray(off, off + chunk);
            off += c.length;
            res.write(c);
            if (off >= file.body!.length) res.end();
            else setTimeout(tick, spec.slowMs);
          } catch { /* client gone */ }
        };
        setTimeout(tick, spec.slowMs);
        return;
      }
      // an ignoreRange repo answers a Range with the full body - the client
      // must restart file + hash (K2)
      res.writeHead(200, { "content-length": file.body.length }).end(file.body);
      return;
    }
    res.writeHead(404).end();
  }).listen(port, "127.0.0.1");
}

async function signUp(ctx: APIRequestContext, name: string) {
  for (let i = 0; i < 4; i++) {
    const r = await ctx.post("/api/auth/sign-up/email", {
      data: {
        email: `ws2-hub-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}@test.local`,
        password: "test-pass-1234", name,
      },
    });
    if (r.ok()) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("sign-up failed");
}

async function hubRow(
  ctx: APIRequestContext,
  pred: (r: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  const d = await (await ctx.get("/api/models/hub/downloads")).json();
  return (d.downloads as Record<string, unknown>[]).find(pred);
}

async function waitRow(
  ctx: APIRequestContext,
  pred: (r: Record<string, unknown>) => boolean,
  status: string[],
): Promise<Record<string, unknown>> {
  await expect.poll(
    async () => String((await hubRow(ctx, pred))?.status ?? ""),
    { timeout: 30_000 },
  ).toMatch(new RegExp(`^(${status.join("|")})$`));
  const row = await hubRow(ctx, pred);
  if (!row) throw new Error("hub row vanished after its status poll");
  return row;
}

test.describe("ws2 hf hub", () => {
  test.skip(!HF_ENV, "MOTIONFIELD_HF_BASE unset - the spec needs the loopback mock hub env (playwright config REQUEST pending)");
  test.skip(!COMFY_OK, `COMFYUI_DIR must realpath under ${TMP_REAL} or /tmp with an of-* basename - got ${COMFY_REAL}`);

  let hf: ReturnType<typeof hfServer> | undefined;
  /** dirs the spec created - afterAll removes only these plus spec files */
  const createdDirs: string[] = [];

  test.beforeAll(() => {
    if (!HF_ENV || !COMFY_OK) return;
    const port = Number(new URL(HF_ENV).port || 3197);
    hf = hfServer(port);
    if (!existsSync(COMFY)) createdDirs.push(COMFY);
    const models = join(COMFY, "models");
    if (!existsSync(models)) createdDirs.push(models);
    mkdirSync(models, { recursive: true });
  });

  test.afterAll(() => {
    hf?.close();
    if (!COMFY_OK) return;
    // K1: delete only what the spec created - the models tree when it made
    // it, COMFY when it made that too; inside a pre-existing models dir only
    // the exact repo files the spec downloaded
    const models = join(COMFY, "models");
    if (existsSync(models) && !createdDirs.includes(models)) {
      const specFiles = new Set(
        Object.values(REPOS).flatMap((r) => r.files.map((f) => basename(f.path))),
      );
      for (const sub of readdirSync(models)) {
        const dir = join(models, sub);
        if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const f of readdirSync(dir)) {
          if (specFiles.has(f.replace(/\.part$/, ""))) rmSync(join(dir, f), { force: true });
        }
      }
    }
    for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test.beforeEach(() => {
    hfCalls.length = 0;
    ollamaPulls.length = 0;
    droppedOnce = false;
  });

  test("E1 apache-2.0 repo: Check shows open; ~2MB into loras lands + sha verified + label", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E1");
    await page.goto("/settings/models");
    await expect(page.getByTestId("hub-panel")).toBeVisible();
    await expect(page.getByTestId("hub-scope-note")).toHaveText(
      "Custom weights are available to ComfyUI; MotionField presets use only the weights in Settings → Licenses.",
    );
    await page.getByTestId("hub-repo").fill("open/good");
    await page.getByTestId("hub-check").click();
    await expect(page.getByTestId("hub-licence-badge")).toHaveText("open");
    await page.getByTestId("hub-file").selectOption("model.safetensors");
    await page.getByTestId("hub-subfolder").selectOption("loras");
    await page.getByTestId("hub-download").click();
    await waitRow(page.request, (r) => r.repo === "open/good", ["done"]);
    const landed = join(COMFY, "models", "loras", "model.safetensors");
    expect(existsSync(landed), landed).toBe(true);
    expect(sha256(readFileSync(landed))).toBe(sha256(GOOD_BODY));
    expect(existsSync(`${landed}.part`)).toBe(false);
    await expect(page.getByTestId("hub-installed")).toContainText("model.safetensors");
    await expect(page.getByTestId("hub-installed")).toContainText("open");

    // K14: a custom weight stays a ComfyUI thing - the agent tool list and
    // the licenses page never mention it
    const tools = await (await page.request.get("/api/agent/tools")).json();
    expect(JSON.stringify(tools)).not.toContain("model.safetensors");
    expect(JSON.stringify(tools)).not.toContain("open/good");
    await page.goto("/settings/licenses");
    await expect(page.locator("body")).not.toContainText("model.safetensors");
    await expect(page.locator("body")).not.toContainText("open/good");
  });

  test("E2 drop mid-file → failed row offers Resume → Range at the .part offset → 206 → done", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E2");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/resume", kind: "weights" },
    })).json();
    expect(insp.allowed).toBe(true);
    const post = await page.request.post("/api/models/hub/downloads", {
      data: { repo: "open/resume", revision: insp.revision, file: "resume.safetensors", subfolder: "loras" },
    });
    expect(post.status()).toBe(202);
    const part = join(COMFY, "models", "loras", "resume.safetensors.part");
    const failed = await waitRow(page.request, (r) => r.repo === "open/resume", ["failed"]);
    expect(String(failed.error)).toContain("dropped mid-file");
    expect(Number(failed.bytesDone)).toBeGreaterThan(0);
    const partSize = statSync(part).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(RESUME_BODY.length);

    // the row offers a resume - the same POST again
    const again = await page.request.post("/api/models/hub/downloads", {
      data: { repo: "open/resume", revision: insp.revision, file: "resume.safetensors", subfolder: "loras" },
    });
    expect(again.status()).toBe(202);
    await waitRow(page.request, (r) => r.repo === "open/resume", ["done"]);
    const ranged = resolveCalls("resume.safetensors").find((c) => c.range);
    expect(ranged?.range, JSON.stringify(hfCalls)).toBe(`bytes=${partSize}-`);
    expect(sha256(readFileSync(join(COMFY, "models", "loras", "resume.safetensors")))).toBe(sha256(RESUME_BODY));
  });

  test("E3 wrong bytes → checksum mismatch; no file and no .part left", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E3");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "bad/wrong", kind: "weights" },
    })).json();
    expect(insp.allowed).toBe(true);
    const post = await page.request.post("/api/models/hub/downloads", {
      data: { repo: "bad/wrong", revision: insp.revision, file: "w.safetensors", subfolder: "unet" },
    });
    expect(post.status()).toBe(202);
    const row = await waitRow(page.request, (r) => r.repo === "bad/wrong", ["failed"]);
    expect(String(row.error)).toContain("checksum mismatch");
    const target = join(COMFY, "models", "unet", "w.safetensors");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  test("E4 nc/other/gated refused with reason; restricted needs the opt-in then downloads", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E4");
    for (const repo of ["nc/mix", "alien/blob", "auto/gated"]) {
      const d = await (await page.request.post("/api/models/hub/inspect", {
        data: { repo, kind: "weights" },
      })).json();
      expect(d.allowed, repo).toBe(false);
      expect(d.class, repo).toBe("refused");
      const post = await page.request.post("/api/models/hub/downloads", {
        data: { repo, revision: d.revision ?? "x", file: "x.safetensors", subfolder: "loras" },
      });
      expect([400, 403], repo).toContain(post.status());
      expect(String((await post.json()).error), repo).toContain(repo === "auto/gated" ? "gated or private" : "");
    }
    // UI: refused → the button is disabled with the reason; /resolve untouched
    await page.goto("/settings/models");
    await page.getByTestId("hub-repo").fill("nc/mix");
    await page.getByTestId("hub-check").click();
    await expect(page.getByTestId("hub-licence-badge")).toHaveText("refused");
    await expect(page.getByTestId("hub-download")).toBeDisabled();
    await expect(page.getByTestId("hub-refused-reason")).toBeVisible();
    expect(resolveCalls()).toHaveLength(0);

    // community licence - restricted until the opt-in is on
    let d = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "comm/pack", kind: "weights" },
    })).json();
    expect(d.class).toBe("restricted");
    expect(d.allowed).toBe(false);
    expect(d.optInRequired).toBe(true);
    expect((await page.request.post("/api/licenses/opt-in", { data: { confirm: true } })).status()).toBe(200);
    d = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "comm/pack", kind: "weights" },
    })).json();
    expect(d.allowed).toBe(true);
    const post = await page.request.post("/api/models/hub/downloads", {
      data: { repo: "comm/pack", revision: d.revision, file: "c.safetensors", subfolder: "loras" },
    });
    expect(post.status()).toBe(202);
    const row = await waitRow(page.request, (r) => r.repo === "comm/pack", ["done"]);
    expect(row.licenceClass).toBe("restricted");
    expect(sha256(readFileSync(join(COMFY, "models", "loras", "c.safetensors")))).toBe(sha256(SMALL));
  });

  test("E5 a 3 GB declared file → the 10 GB floor wording; nothing written", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E5");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "huge/blob", kind: "weights" },
    })).json();
    expect(insp.allowed).toBe(true);
    const post = await page.request.post("/api/models/hub/downloads", {
      data: { repo: "huge/blob", revision: insp.revision, file: "h.safetensors", subfolder: "checkpoints" },
    });
    expect(post.status()).toBe(400);
    expect(String((await post.json()).error))
      .toMatch(/needs 3 GB but only \d+ GB free - MotionField keeps 10 GB free/);
    expect(existsSync(join(COMFY, "models", "checkpoints", "h.safetensors"))).toBe(false);
    expect(resolveCalls("h.safetensors")).toHaveLength(0);
  });

  test("E6 traversal/absolute/unknown subfolder/.ckpt → 400; nothing outside models/", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E6");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/good", kind: "weights" },
    })).json();
    const bodies = [
      { file: "model.safetensors", subfolder: "../../tmp" },
      { file: "../x.safetensors", subfolder: "loras" },
      { file: "/x.safetensors", subfolder: "loras" },
      { file: "model.safetensors", subfolder: "nope" },
      { file: "x.ckpt", subfolder: "loras" },
    ];
    for (const b of bodies) {
      const post = await page.request.post("/api/models/hub/downloads", {
        data: { repo: "open/good", revision: insp.revision, ...b },
      });
      expect(post.status(), JSON.stringify(b)).toBe(400);
    }
    // everything under COMFY lives inside models/
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
    for (const f of walk(COMFY)) {
      expect(f.startsWith(join(COMFY, "models")), f).toBe(true);
    }
    expect(existsSync(join(COMFY, "..", "x.safetensors"))).toBe(false);
  });

  test("E7 GGUF pull → stub sees hf.co/<repo>:Q4_K_M → success; NC → 403, 0 stub calls", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E7");
    const stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/pull") {
        let b = "";
        req.on("data", (d) => { b += d; });
        req.on("end", () => {
          ollamaPulls.push((JSON.parse(b) as { name?: string }).name ?? "");
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end('{"status":"pulling manifest"}\n{"status":"success"}\n');
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    try {
      const port = (stub.address() as AddressInfo).port;
      expect((await page.request.put("/api/llm/providers/ollama", {
        data: { baseUrl: `http://127.0.0.1:${port}` },
      })).status()).toBe(200);
      const res = await page.request.post("/api/models/hub/pull", {
        data: { repo: "brain/gguf", quant: "Q4_K_M" },
      });
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toContain('"success"');
      expect(ollamaPulls).toEqual(["hf.co/brain/gguf:Q4_K_M"]);
      const row = await waitRow(page.request, (r) => r.repo === "brain/gguf", ["done"]);
      expect(row.kind).toBe("gguf");
      const refused = await page.request.post("/api/models/hub/pull", {
        data: { repo: "nc/gguf", quant: "Q4_K_M" },
      });
      expect(refused.status()).toBe(403);
      expect(ollamaPulls).toHaveLength(1);
    } finally {
      stub.close();
    }
  });

  test("E8 signed-out → 401 on every hub route; B sees no A rows; B DELETE A id → 404", async ({ page }) => {
    test.setTimeout(120_000);
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3100").origin;
    const anon = await pwRequest.newContext({ baseURL: origin });
    for (const [m, p] of [
      ["POST", "/api/models/hub/inspect"],
      ["GET", "/api/models/hub/downloads"],
      ["POST", "/api/models/hub/downloads"],
      ["POST", "/api/models/hub/pull"],
      ["DELETE", "/api/models/hub/downloads/00000000-0000-0000-0000-000000000000"],
    ] as const) {
      const r = await anon.fetch(`${origin}${p}`, { method: m, data: m === "POST" ? {} : undefined });
      expect(r.status(), `${m} ${p}`).toBe(401);
    }
    await anon.dispose();

    await signUp(page.request, "WS2 Hub E8-A");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/good", kind: "weights" },
    })).json();
    expect((await page.request.post("/api/models/hub/downloads", {
      data: { repo: "open/good", revision: insp.revision, file: "model.safetensors", subfolder: "vae" },
    })).status()).toBe(202);
    const rowA = await waitRow(page.request, (r) => r.repo === "open/good" && r.subfolder === "vae", ["done"]);
    const idA = String(rowA.id);

    const other = await pwRequest.newContext({ baseURL: origin });
    await signUp(other, "WS2 Hub E8-B");
    const list = await (await other.get("/api/models/hub/downloads")).json();
    expect(list.downloads).toHaveLength(0);
    expect((await other.delete(`/api/models/hub/downloads/${idA}`)).status()).toBe(404);
    await other.dispose();

    // K7: a malformed id is a plain 404 too - never a 500 from an invalid uuid
    expect((await page.request.delete("/api/models/hub/downloads/not-a-uuid")).status()).toBe(404);
    expect((await page.request.delete(`/api/models/hub/downloads/${randomUUID()}`)).status()).toBe(404);
  });

  test("E9 Offline on → inspect/start/pull refuse but GET/DELETE still pass (K8)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E9");
    expect((await page.request.put("/api/llm/prefs", { data: { offline: true } })).status()).toBe(200);
    try {
      // reads and local ops need no network - they pass while Offline
      const list = await page.request.get("/api/models/hub/downloads");
      expect(list.status()).toBe(200);
      expect((await page.request.delete("/api/models/hub/downloads/not-a-uuid")).status()).toBe(404);

      const before = hfCalls.length;
      for (const p of [
        page.request.post("/api/models/hub/inspect", { data: { repo: "open/good", kind: "weights" } }),
        page.request.post("/api/models/hub/downloads", {
          data: { repo: "open/good", revision: "x", file: "model.safetensors", subfolder: "loras" },
        }),
        page.request.post("/api/models/hub/pull", { data: { repo: "brain/gguf", quant: "Q4_K_M" } }),
      ]) {
        const r = await p;
        expect(r.status()).toBe(403);
        expect(String((await r.json()).error)).toContain("Offline mode is on - downloads need the network");
      }
      expect(hfCalls.length).toBe(before);
    } finally {
      await page.request.put("/api/llm/prefs", { data: { offline: false } });
    }
  });

  test("E10 concurrent POSTs → one 202 + one 409; DELETE mid-download → canceled, .part kept → resume", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E10");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/slow", kind: "weights" },
    })).json();
    expect(insp.allowed).toBe(true);
    const body = { repo: "open/slow", revision: insp.revision, file: "slow.safetensors", subfolder: "loras" };
    // two concurrent starts - exactly one gets the machine lock (K4)
    const [a, b] = await Promise.all([
      page.request.post("/api/models/hub/downloads", { data: body }),
      page.request.post("/api/models/hub/downloads", { data: body }),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([202, 409]);
    const slow = await waitRow(page.request, (r) => r.repo === "open/slow", ["running"]);
    const id = String(slow.id);

    // DELETE mid-download → canceled; the .part survives for resume
    const part = join(COMFY, "models", "loras", "slow.safetensors.part");
    await expect.poll(
      async () => statSync(part, { throwIfNoEntry: false })?.size ?? 0,
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    expect((await page.request.delete(`/api/models/hub/downloads/${id}`)).status()).toBe(200);
    await waitRow(page.request, (r) => r.id === id, ["canceled"]);
    const partSize = statSync(part).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(SLOW_BODY.length);
    expect(existsSync(join(COMFY, "models", "loras", "slow.safetensors"))).toBe(false);

    // the same POST resumes from the .part offset
    const again = await page.request.post("/api/models/hub/downloads", { data: body });
    expect(again.status()).toBe(202);
    await waitRow(page.request, (r) => r.repo === "open/slow", ["done"]);
    const ranged = resolveCalls("slow.safetensors").find((c) => c.range);
    expect(ranged?.range, JSON.stringify(hfCalls)).toBe(`bytes=${partSize}-`);
    expect(sha256(readFileSync(join(COMFY, "models", "loras", "slow.safetensors")))).toBe(sha256(SLOW_BODY));
  });

  test("E11 a 200 answering a Range restarts file + hash → done, sha verified (K2)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E11");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/full200", kind: "weights" },
    })).json();
    const body = { repo: "open/full200", revision: insp.revision, file: "full.safetensors", subfolder: "loras" };
    expect((await page.request.post("/api/models/hub/downloads", { data: body })).status()).toBe(202);
    const failed = await waitRow(page.request, (r) => r.repo === "open/full200", ["failed"]);
    expect(String(failed.error)).toContain("dropped mid-file");
    const partSize = statSync(join(COMFY, "models", "loras", "full.safetensors.part")).size;
    expect(partSize).toBeGreaterThan(0);

    // the re-POST sends its Range - the mock answers 200 with the WHOLE
    // body; the client must restart file + hash, not append to stale bytes
    expect((await page.request.post("/api/models/hub/downloads", { data: body })).status()).toBe(202);
    await waitRow(page.request, (r) => r.repo === "open/full200", ["done"]);
    const ranged = resolveCalls("full.safetensors").find((c) => c.range);
    expect(ranged?.range, JSON.stringify(hfCalls)).toBe(`bytes=${partSize}-`);
    const landed = join(COMFY, "models", "loras", "full.safetensors");
    expect(statSync(landed).size).toBe(FULL_BODY.length);
    expect(sha256(readFileSync(landed))).toBe(sha256(FULL_BODY));
  });

  test("E12 a red-flag repo or file refuses 'banned list' before any HF request (K11)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E12");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/good", kind: "weights" },
    })).json();
    const before = hfCalls.length;
    for (const b of [
      // a repo matching a banned-weight pattern - never inspected
      { repo: "briaai/RMBG-1.4", revision: "x", file: "m.safetensors", subfolder: "loras" },
      // a file matching one on an otherwise fine repo
      { repo: "open/good", revision: insp.revision, file: "causvid_1.3b.safetensors", subfolder: "loras" },
    ]) {
      const post = await page.request.post("/api/models/hub/downloads", { data: b });
      expect(post.status(), JSON.stringify(b)).toBe(400);
      expect(String((await post.json()).error)).toContain("this weight is on MotionField's banned list");
    }
    expect(hfCalls.length).toBe(before); // refused before a single HF request
  });

  test("E13 a symlink at the target or at .part is refused before anything writes (K12)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E13");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/links", kind: "weights" },
    })).json();
    const sub = join(COMFY, "models", "vae");
    mkdirSync(sub, { recursive: true });
    const victim = join(sub, "victim.bin");
    writeFileSync(victim, "never overwritten");

    // symlink at the target
    const target = join(sub, "link.safetensors");
    symlinkSync(victim, target);
    try {
      const post = await page.request.post("/api/models/hub/downloads", {
        data: { repo: "open/links", revision: insp.revision, file: "link.safetensors", subfolder: "vae" },
      });
      expect(post.status()).toBe(400);
      expect(String((await post.json()).error)).toContain("symlink");
    } finally {
      rmSync(target, { force: true });
    }

    // symlink at the .part
    const partLink = join(sub, "part.safetensors.part");
    symlinkSync(victim, partLink);
    try {
      const post = await page.request.post("/api/models/hub/downloads", {
        data: { repo: "open/links", revision: insp.revision, file: "part.safetensors", subfolder: "vae" },
      });
      expect(post.status()).toBe(400);
      expect(String((await post.json()).error)).toContain("symlink");
    } finally {
      rmSync(partLink, { force: true });
    }
    expect(readFileSync(victim).toString()).toBe("never overwritten");

    // sanity: with the links gone the same file downloads fine
    expect((await page.request.post("/api/models/hub/downloads", {
      data: { repo: "open/links", revision: insp.revision, file: "part.safetensors", subfolder: "vae" },
    })).status()).toBe(202);
    await waitRow(page.request, (r) => r.repo === "open/links" && r.file === "part.safetensors", ["done"]);
    rmSync(victim, { force: true });
  });

  test("E14 a pull stream ending without a success line lands failed, never done (K3)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E14");
    const stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/pull") {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          // progress events but never a "success" line
          res.end('{"status":"pulling manifest"}\n{"status":"downloading","completed":10,"total":100}\n');
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    try {
      const port = (stub.address() as AddressInfo).port;
      expect((await page.request.put("/api/llm/providers/ollama", {
        data: { baseUrl: `http://127.0.0.1:${port}` },
      })).status()).toBe(200);
      const res = await page.request.post("/api/models/hub/pull", {
        data: { repo: "brain/gguf", quant: "F16" },
      });
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toContain("pull ended early");
      const row = await waitRow(page.request, (r) => r.repo === "brain/gguf", ["failed"]);
      expect(String(row.error)).toContain("no success line");
    } finally {
      stub.close();
    }
  });

  test("E15 turning Offline on aborts a live download; GET/DELETE still pass (K8/K14)", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page.request, "WS2 Hub E15");
    const insp = await (await page.request.post("/api/models/hub/inspect", {
      data: { repo: "open/slow", kind: "weights" },
    })).json();
    expect((await page.request.post("/api/models/hub/downloads", {
      data: { repo: "open/slow", revision: insp.revision, file: "slow.safetensors", subfolder: "unet" },
    })).status()).toBe(202);
    const slow = await waitRow(page.request, (r) => r.repo === "open/slow" && r.subfolder === "unet", ["running"]);
    // flipping the Offline toggle kills the in-flight transfer
    expect((await page.request.put("/api/llm/prefs", { data: { offline: true } })).status()).toBe(200);
    try {
      const canceled = await waitRow(page.request, (r) => r.id === slow.id, ["canceled"]);
      expect(canceled.status).toBe("canceled");
      // reads + cancel stay alive while Offline (K8)
      expect((await page.request.get("/api/models/hub/downloads")).status()).toBe(200);
      expect((await page.request.delete(`/api/models/hub/downloads/${slow.id}`)).status()).toBe(200);
    } finally {
      await page.request.put("/api/llm/prefs", { data: { offline: false } });
    }
  });
});
