import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { filesPathSchema, parseSceneSpec } from "@/lib/render/spec";
import { fetchBrandContext } from "@/lib/render/brand";
import { motionRenderRecipe } from "@/lib/generation/recipes/motion-render";
import { POST } from "@/app/api/render/specs/route";
import { emptyScene } from "@/lib/stage/scene";
import { applyOps, StageOpError } from "@/lib/stage/ops";
import { decideOpReplay, hashOpBody, isValidOpKey } from "@/lib/stage/idempotency";
import { validateGlb, validatePng } from "@/lib/stage/exports";
import { muxCuesOntoVideo } from "@/lib/audio-mix/mix";
import { sanitizeCues } from "@/lib/audio-mix/cues";
import { resolveOwnedMedia } from "@/lib/media-owned";
import type { RecipeCtx } from "@/lib/generation/recipe";
import type { SubmitInput } from "@/lib/generation/types";

/**
 * ws5-security - the spec/route guards (A5-A8), overlay-mode ownership, the
 * stage ops security cases, the s4b surfaces (op idempotency verdicts,
 * PNG/GLB export validation, symlink-safe file resolution) and the s6 sound
 * guards (shell-free ffmpeg argv, LLM cue sanitization, the MOSS repo
 * allow-list). DB and auth are mocked; brand fetching uses its injectable
 * fetchImpl so nothing touches the network.
 */

const state = vi.hoisted(() => ({ selectRows: [] as unknown[][] }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requireApiUser: async () => ({ user: { id: "u-sec" } }),
}));

vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: async () => ({
    // select() pops one queued row-set per query (jobs → uploads → assets …)
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(state.selectRows.shift() ?? []) }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: "row-1" }] }) }),
  }),
}));

const BASE_SPEC = {
  version: 1, width: 64, height: 64, fps: 24, duration: 1, seed: 1,
  background: { color: "#000000" },
  camera: { keyframes: [{ t: 0, position: [0, 0, 4], target: [0, 0, 0] }] },
  layers: [{ id: "b", type: "box", props: { width: 1, height: 1, depth: 1 } }],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/render/specs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("ws5-security", () => {
  it("specs POST rejects oversized bodies 413 - declared or streamed", async () => {
    const res = await POST(post({ spec: BASE_SPEC }, { "content-length": String(300_000) }));
    expect(res.status).toBe(413);

    const chunks = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(70_000)); // 280 KB, no content-length
        c.close();
      },
    });
    const req = new NextRequest("http://localhost/api/render/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks,
      duplex: "half",
    } as never);
    expect((await POST(req)).status).toBe(413);
  });

  it("filesPathSchema rejects traversal, percent-encoding, backslashes, queries, fragments, empty segments", () => {
    for (const bad of [
      "/files/../etc/passwd",
      "/files/%2e%2e/x",
      "/files/a\\b",
      "/files/a?x=1",
      "/files/a#frag",
      "/files//double",
      "/files/",
      "/etc/passwd",
      "files/no-slash",
      "/files/./x",
    ]) {
      expect(filesPathSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(filesPathSchema.safeParse("/files/uploads/u_1/clip.final-v2.mp4").success).toBe(true);
  });

  it("spec guards: external image URLs rejected, /files + data:image allowed; keyframe types enforced; param binds are single paths; captions ordering; post windows", () => {
    const spec = (patch: Record<string, unknown>) => ({
      ...BASE_SPEC,
      layers: [{ id: "p", type: "plane", props: { width: 1, height: 1, ...patch } }],
    });
    expect(() => parseSceneSpec(spec({ image: "https://evil.example/x.png" }))).toThrow(/image/);
    expect(() => parseSceneSpec(spec({ image: "//evil.example/x.png" }))).toThrow(/image/);
    expect((parseSceneSpec(spec({ image: "/files/u/x.png" })).layers[0].props as { image?: string }).image).toBe("/files/u/x.png");
    expect((parseSceneSpec(spec({ image: "data:image/png;base64,iVBOR" })).layers[0].props as { image?: string }).image).toMatch(/^data:/);

    // string values only on color paths
    const withKf = (path_: string, value: unknown) => ({
      ...BASE_SPEC,
      layers: [{ id: "b", type: "box", props: { width: 1, height: 1, depth: 1 }, keyframes: [{ t: 0, path: path_, value }] }],
    });
    expect(() => parseSceneSpec(withKf("position.x", "#ff0000"))).toThrow(/not a string|number/);
    expect(() => parseSceneSpec(withKf("props.width", "wide"))).toThrow(/numeric|string/);
    expect(() => parseSceneSpec(withKf("opacity", "half"))).toThrow(/numeric|string/);
    expect(() => parseSceneSpec(withKf("color", "#ff0000"))).not.toThrow();

    // param bind must resolve to ONE animatable path - extra segments fail
    const withParam = (bind: string) => ({
      ...BASE_SPEC,
      params: [{ id: "p1", label: "P", min: 0, max: 1, step: 0.1, default: 0.5, bind }],
    });
    expect(() => parseSceneSpec(withParam("b.props.width.extra"))).toThrow(/bind|animatable/);
    expect(() => parseSceneSpec(withParam("b.position.x.y"))).toThrow(/bind|animatable/);
    expect(() => parseSceneSpec(withParam("b.props.width"))).not.toThrow();

    // captions words ordered with positive duration; punch indexes exist; post windows need t1>t0
    const cap = (words: unknown[], extra: Record<string, unknown> = {}) => ({
      ...BASE_SPEC,
      layers: [{ id: "c", type: "captions", props: { words, ...extra } }],
    });
    const w = (t: string, s: number, e: number) => ({ text: t, start: s, end: e });
    expect(() => parseSceneSpec(cap([w("A", 1, 0.5)]))).toThrow(/end must be after start/);
    expect(() => parseSceneSpec(cap([w("A", 1, 2), w("B", 0.5, 3)]))).toThrow(/start order/);
    expect(() => parseSceneSpec(cap([w("A", 0, 1)], { punch: [5] }))).toThrow(/punch index/);
    expect(() => parseSceneSpec(cap([w("A", 0, 1)], { punch: [0] }))).not.toThrow();
    expect(() => parseSceneSpec({ ...BASE_SPEC, post: { mono: [{ t0: 1, t1: 1 }] } })).toThrow(/t1 must be after t0/);
    expect(() => parseSceneSpec({ ...BASE_SPEC, post: { glow: [{ t0: 0, t1: 1, strength: 0.5 }] } })).not.toThrow();
  });

  it("brand fetch drops a mislabeled og:image and survives empty-body statuses", async () => {
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    // og:image declares image/png but serves HTML bytes → never reaches storage
    const fetchImpl = async (url: string) => {
      if (url.includes("img.example")) {
        return new Response("<html>not an image</html>", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(
        '<html><head><title>B</title><meta property="og:image" content="https://img.example/x.png"></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };
    const ctx = await fetchBrandContext("https://brand.example", { lookup, fetchImpl });
    expect(ctx.title).toBe("B");
    expect(ctx.ogImage).toBeUndefined();

    // 204 - no body by definition; the fetch stack must not trip over it
    // (204 is res.ok, so it reaches the content-type check and fails there)
    const noBody = async () => new Response(null, { status: 204 });
    await expect(fetchBrandContext("https://brand.example", { lookup, fetchImpl: noBody }))
      .rejects.toThrow(/not an HTML page/);
  });

  it("overlay mode: a foreign /files/… source (or a vanished file) fails closed before any export spawn", async () => {
    const ctx: RecipeCtx = { signal: new AbortController().signal, progress: () => {} };
    const mk = (jobId: string, source: string): SubmitInput => ({
      jobId,
      model: {} as SubmitInput["model"],
      workflow: {} as SubmitInput["workflow"],
      params: { spec: BASE_SPEC, source },
      appBaseUrl: "http://localhost",
    });
    // jobs → owner row; uploads → miss; assets → miss → never the recipe
    state.selectRows.push([{ userId: "u-job" }], [], []);
    await expect(motionRenderRecipe(mk("j-1", "/files/uploads/victim.mp4"), ctx))
      .rejects.toThrow(/source not found/i);
    // an owned row whose file vanished still fails closed
    state.selectRows.push([{ userId: "u-job" }], [{ id: "u-1" }]);
    await expect(motionRenderRecipe(mk("j-2", "/files/uploads/definitely-not-on-disk-xyz.mp4"), ctx))
      .rejects.toThrow(/source not found/i);
  });

  it("ASR: whisper/ffmpeg run via argv arrays (no shell); a media path outside the allowed roots → ASR_PATH before any spawn", async () => {
    const { transcribeWords } = await import("@/lib/captions");
    const dir = mkdtempSync(join(tmpdir(), "of-asr-arg-"));
    try {
    const media = join(dir, "clip.mp4"); // non-wav → ffprobe + ffmpeg conversion runs too
    const model = join(dir, "ggml.bin");
    writeFileSync(media, "RIFF");
    writeFileSync(model, "x");
    const calls: { bin: string; argv: string[]; shell: unknown }[] = [];
    const fakeSpawn = ((bin: string, argv: string[], opts: { shell?: unknown }) => {
      calls.push({ bin, argv: [...argv], shell: opts?.shell });
      const proc = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(), stdout: new EventEmitter(), stdin: null, kill: () => true,
      });
      setImmediate(() => proc.emit("close", 0));
      return proc;
    }) as unknown as typeof import("node:child_process").spawn;

    // /etc/passwd is outside tmpdir/public-files - rejected before ANY spawn
    const err = await transcribeWords("/etc/passwd", { deps: { spawn: fakeSpawn } }).then(() => null, (e) => e);
    expect(err?.code).toBe("ASR_PATH");
    expect(calls).toHaveLength(0);

    // a file inside the allowed roots: binaries still run shell-free, argv-clean.
    // argv carries the realpath'd path - /var → /private/var on macOS.
    await transcribeWords(media, { deps: { spawn: fakeSpawn, model, tmpdir: dir } }).catch(() => {});
    const ff = calls.find((c) => /ffmpeg/.test(c.bin) && c.argv.includes(realpathSync(media)));
    const wh = calls.find((c) => /whisper/.test(c.bin) && c.argv.includes("-ojf"));
    expect(ff, "an ffmpeg -i <media> call").toBeTruthy();
    expect(wh, "a whisper -ojf call").toBeTruthy();
    // one word per max_len segment - the word-splitting contract
    expect(wh!.argv).toEqual(expect.arrayContaining(["-m", model, "-ml", "1", "-sow"]));
    for (const c of calls) {
      expect(Array.isArray(c.argv)).toBe(true);
      expect(c.shell ?? false, `${c.bin} must not run through a shell`).toBe(false);
    }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------- s4b: stage ops security ---------- */

describe("stage guards", () => {
  it("ops: non-whitelisted update paths, proto segments, selection escapes + idempotency verdicts", () => {
    const s = emptyScene();
    expect(() => applyOps(s, [
      { op: "update", id: "ground", path: "props.focalMm", value: 50 },
    ])).toThrow(StageOpError);
    expect(() => applyOps(s, [
      { op: "update", id: "ground", path: "__proto__.polluted", value: 1 },
    ])).toThrow(StageOpError);
    expect(() => applyOps(s, [
      { op: "update", id: "ground", path: "props.src", value: "/etc/passwd" },
    ])).toThrow(StageOpError);

    expect(() => applyOps(s, [
      { op: "update", id: "ground", path: "name", value: "nope" },
    ], { selection: "cam_main" })).toThrow(/selection/);
    expect(() => applyOps(s, [{ op: "set_env", env: { ambient: 1 } }], { selection: "cam_main" })).toThrow(/global/);
    const ok = applyOps(s, [{ op: "update", id: "cam_main", path: "name", value: "Main Cam" }], { selection: "cam_main" });
    expect(ok.nodes.find((n) => n.id === "cam_main")!.name).toBe("Main Cam");

    // op idempotency: key format + body hash + fresh/replay/mismatch verdicts
    expect(isValidOpKey("op_7f2c")).toBe(true);
    expect(isValidOpKey("a".repeat(128))).toBe(true);
    expect(isValidOpKey("has spaces")).toBe(false);
    expect(isValidOpKey("")).toBe(false);
    expect(isValidOpKey("b".repeat(129))).toBe(false);

    const h1 = hashOpBody('{"base_revision":1,"ops":[]}');
    const h2 = hashOpBody('{"ops":[],"base_revision":1}'); // different bytes → different hash
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);

    expect(decideOpReplay(null, "sc1", h1)).toBe("fresh");
    expect(decideOpReplay({ scene_id: "sc1", body_hash: h1 }, "sc1", h1)).toBe("replay");
    expect(decideOpReplay({ scene_id: "sc1", body_hash: h1 }, "sc1", h2)).toBe("mismatch");
    expect(decideOpReplay({ scene_id: "sc1", body_hash: h1 }, "sc2", h1)).toBe("mismatch");
  });
});

/* ---------- s4b: export validation ---------- */

/** 24-byte minimal PNG: signature + IHDR header with w/h at 16/20. */
function pngBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33); // sig + len + IHDR + data + crc
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);              // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8; b[25] = 6;           // bit depth 8, color type 6
  return b;
}

/** minimal GLB container around a JSON document (+ optional BIN chunk). */
function glbBytes(json: unknown, bin?: Uint8Array): Uint8Array {
  let js = Buffer.from(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
  const chunks: Buffer[] = [Buffer.concat([head(js.length, 0x4e4f534a), js])];
  if (bin) {
    let bb = Buffer.from(bin);
    const bpad = (4 - (bb.length % 4)) % 4;
    bb = Buffer.concat([bb, Buffer.alloc(bpad)]);
    chunks.push(Buffer.concat([head(bb.length, 0x004e4942), bb]));
  }
  const total = 12 + chunks.reduce((a, c) => a + c.length, 0);
  const out = Buffer.alloc(12);
  out.write("glTF", 0, "latin1");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  return new Uint8Array(Buffer.concat([out, ...chunks]));

  function head(len: number, type: number) {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(len, 0);
    h.writeUInt32LE(type, 4);
    return h;
  }
}

describe("stage export validation", () => {
  it("PNG good bytes pass while wrong dims/non-PNG fail; GLB minimal 2.0 passes while bad magic/version/data-URI buffers/over-limit nodes fail", async () => {
    expect(validatePng(pngBytes(320, 180), 320, 180)).toBeNull();
    expect(validatePng(pngBytes(320, 180), 640, 360)).toMatch(/320×180/);
    expect(validatePng(new Uint8Array([1, 2, 3, 4, 5]), 64, 64)).toMatch(/not a PNG/);
    expect(validatePng(pngBytes(64, 64).slice(0, 20), 64, 64)).toMatch(/not a PNG/);

    const good = glbBytes({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }], nodes: [] });
    expect(await validateGlb(good)).toBeNull();

    const badMagic = good.slice(); badMagic[0] = 0x00;
    expect(await validateGlb(badMagic)).toMatch(/bad magic/);

    const v1 = Buffer.from(good); v1.writeUInt32LE(1, 4);
    expect(await validateGlb(new Uint8Array(v1))).toMatch(/2\.0/);

    const withExt = glbBytes({
      asset: { version: "2.0" },
      buffers: [{ uri: "data:application/octet-stream;base64,AA==", byteLength: 1 }],
    });
    expect(await validateGlb(withExt)).toBeTruthy(); // self-contained only

    const many = glbBytes({
      asset: { version: "2.0" }, scene: 0,
      scenes: [{ nodes: Array.from({ length: 301 }, (_, i) => i) }],
      nodes: Array.from({ length: 301 }, (_, i) => ({ name: `n${i}` })),
    });
    expect(await validateGlb(many)).toMatch(/too many nodes/);
  });
});

/* ---------- s4b: symlink-safe file resolution ---------- */

describe("storage symlink guards", () => {
  it("filePathFor/generatedPathFor refuse links that escape; saveBytes refuses a linked dir", async () => {
    /* never touch the real public/files - the module reads ROOT off
     * process.cwd() at import time, so a fresh module bound to a temp dir
     * keeps every symlink inside tmp. */
    const tmp = mkdtempSync(join(tmpdir(), "of-sym-root-"));
    const outside = mkdtempSync(join(tmpdir(), "of-sym-out-"));
    mkdirSync(join(tmp, "public", "files", "uploads"), { recursive: true });
    mkdirSync(join(tmp, "public", "files", "generated"), { recursive: true });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.resetModules();
    const storage = await import("@/lib/storage");
    const ROOT = join(tmp, "public", "files");
    const linkDir = join(ROOT, "__wstest_sym__");
    const linkInGen = join(ROOT, "generated", "__wstest_sym__");
    try {
      symlinkSync(outside, linkDir, "dir");
      symlinkSync(join(ROOT, "uploads"), linkInGen, "dir"); // inside files/, outside generated/

      // a link inside public/files pointing at tmpdir - lexical join stays
      // "inside" ROOT, the realpath check is what catches it
      expect(storage.filePathFor("/files/__wstest_sym__/x.png")).toBeNull();
      // same trick inside generated/ must not launder a generated/ delete
      expect(storage.generatedPathFor("/files/generated/__wstest_sym__/x.png")).toBeNull();
      // writes refuse a linked intermediate dir before mkdir/writeFile
      await expect(storage.saveBytes("__wstest_sym__/x.bin", Buffer.from("x"))).rejects.toThrow(/outside files root/);

      // and the honest paths still work
      expect(storage.filePathFor("/files/uploads/x.png")).toMatch(/public[/\\]files[/\\]uploads[/\\]x\.png$/);
      expect(storage.generatedPathFor("/files/generated/re-edit/x.mp4")).toMatch(/generated[/\\]re-edit[/\\]x\.mp4$/);
    } finally {
      cwdSpy.mockRestore();
      vi.resetModules();
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/* ---------- s6: sound security ---------- */

describe("s6 sound guards", () => {
  it("audio-mix ffmpeg argv is shell-free and only carries file paths; the vision cue schema drops hostile LLM rows; OF_MossSFX refuses a non-allow-listed repo", async () => {
    /* 1 - every ffmpeg call goes through execFile argv arrays (never a
     * shell), and the inputs reaching argv are file paths the caller
     * resolved, not user strings. */
    const calls: { bin: string; argv: string[] }[] = [];
    const fakeExec = ((bin: string, argv: string[], _opts: unknown, cb: (e: null, o: string, s: string) => void) => {
      calls.push({ bin, argv: [...argv] });
      cb(null, "", "");
    }) as unknown as typeof import("node:child_process").execFile;
    await muxCuesOntoVideo({
      video: "/files/../definitely-not-lexically-ok.mp4", // the recipe resolves owned paths BEFORE this - argv still stays an array
      cues: [{ file: "/tmp/cue-0.wav", tStart: 1.5 }],
      out: "/tmp/out.mp4",
      durationSec: 3, sourceHasAudio: true,
      tags: { audio: "post-mix", comment: "sound added after generation", cues: "[]" },
      deps: { execFile: fakeExec },
    });
    expect(calls.length).toBe(1);
    const ff = calls[0];
    expect(ff.bin).toMatch(/ffmpeg/);
    expect(Array.isArray(ff.argv)).toBe(true);
    expect(ff.argv).toContain("-filter_complex");
    expect(ff.argv[ff.argv.indexOf("-filter_complex") + 1]).toContain("adelay=1500|1500");
    expect(ff.argv).toContain("-c:v");
    expect(ff.argv).toContain("copy");
    expect(ff.argv).toContain("aac");
    expect(ff.argv).toContain("audio=post-mix");
    expect(ff.argv).toContain("comment=sound added after generation");

    /* 2 - the cue planner's output is never trusted: out-of-window,
     * overlong, empty and out-of-bounds cues are dropped, the rest clamp
     * to the clip length. */
    const good = sanitizeCues([
      { t_start: 1, t_end: 4, prompt: "door slam" },
      { t_start: -2, t_end: 1, prompt: "before the clip" },
      { t_start: 9, t_end: 9, prompt: "zero length" },
      { t_start: 12, t_end: 14, prompt: "past the end" },
      { t_start: 5, t_end: 40, prompt: "x".repeat(400) },
      { t_start: 2, t_end: 9.9, prompt: "fine but tail-clamped" },
    ], 10);
    expect(good).toEqual([
      { t_start: 1, t_end: 4, prompt: "door slam" },
      { t_start: 2, t_end: 9.9, prompt: "fine but tail-clamped" },
    ]);

    /* 3 - the MOSS node's repo gate is exec'd in python: the one allow-
     * listed id passes; the old torch repo, a foreign repo, a padded id and
     * a case-folded id are all refused. The assert sits OUTSIDE the try -
     * the source-scan branch is a fallback for hosts without python3, not
     * an excuse to skip the check. */
    const node = resolve(__dirname, "../../comfy-nodes/motionfield_nodes/nodes_audio.py");
    let pyOut: string | null = null;
    try {
      pyOut = execFileSync("python3", ["-c",
        "import importlib.util as i;"
        + "s=i.spec_from_file_location('na'," + JSON.stringify(node) + ");"
        + "m=i.module_from_spec(s);s.loader.exec_module(m);"
        + "print(m.moss_repo_allowed('mlx-community/MOSS-SoundEffect-v2.0-4bit'),"
        + "m.moss_repo_allowed('OpenMOSS-Team/MOSS-SoundEffect-v2.0'),"
        + "m.moss_repo_allowed('evil-org/MOSS-SoundEffect-v2.0'),"
        + "m.moss_repo_allowed('mlx-community/MOSS-SoundEffect-v2.0-4bit ')," // trailing space must fail
        + "m.moss_repo_allowed('mlx-community/moss-soundeffect-v2.0-4bit'))", // case-fold must fail
      ], { encoding: "utf8" }).trim();
    } catch { /* no python3 - source-scan fallback below */ }
    if (pyOut !== null) {
      expect(pyOut).toBe("True False False False False");
    } else {
      const src = (await import("node:fs")).readFileSync(node, "utf8");
      expect(src).toContain('"mlx-community/MOSS-SoundEffect-v2.0-4bit"');
      expect(src).not.toContain('"OpenMOSS-Team/MOSS-SoundEffect-v2.0"');
      expect(src).toContain("return repo_id in MOSS_REPO_ALLOWLIST");
      expect(src).toContain("not on the allow-list");
    }

    /* 4 - a /files url the caller doesn't own is a 404 before the path is
     * ever touched: uploads miss, assets miss, resolveOwnedMedia refuses. */
    state.selectRows.push([], []);
    await expect(resolveOwnedMedia("u-sec", "/files/uploads/foreign.mp4"))
      .rejects.toThrow(/not found|404/);
  });
});
