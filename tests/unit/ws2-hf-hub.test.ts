import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyLicenseIds, classifyRepoCard, downloadHopError, hfBase,
  hubTestFreeBytes, quantTagFor, redFlagWeight, repoFileError, weightFileError,
  isRepoName, PICKLE_REASON,
} from "@/lib/model-hub/guards";
import { resolveModelTarget } from "@/lib/model-hub/downloads";
import { inspectRepo } from "@/lib/model-hub/hf";

// hosted-mode test: every hub route takes its session from requireApiUser -
// mock it once for the whole file so the gates (hosted/offline) run past auth.
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  requireApiUser: async () => ({ user: { id: "u1" } }),
}));

/**
 * The hub's security surface, proved in ≤8 cases: fail-closed licences and
 * paths, hosted-mode refusal at every entry point, dead seams in
 * production/hosted, loopback-only base override, redirect hop policy,
 * no Authorization header ever, pickle refusal.
 */

const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
};
const ENV_KEYS = [
  "MOTIONFIELD_HF_BASE", "MOTIONFIELD_HUB_TEST_FREE_GB", "MOTIONFIELD_HOSTED", "NODE_ENV",
];

beforeEach(() => { for (const k of ENV_KEYS) setEnv(k, undefined); });
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete saved[k];
  }
});

/* 1 - the licence table fails closed (arrays, gated) */
it("fails closed: worst licence id wins; gated/private refuse outright", () => {
  expect(classifyLicenseIds(["apache-2.0"]).cls).toBe("open");
  expect(classifyLicenseIds([]).cls).toBe("refused");
  expect(classifyLicenseIds([""]).cls).toBe("refused");
  expect(classifyLicenseIds(["mit", "cc-by-nc-4.0"]).cls).toBe("refused");
  expect(classifyLicenseIds(["apache-2.0", "other"]).cls).toBe("refused");
  expect(classifyLicenseIds(["mit", "ltx-video-community"]).cls).toBe("restricted");
  expect(classifyLicenseIds(["cc-by-4.0", "apache-2.0"]).cls).toBe("permissive-terms");
  expect(classifyRepoCard({ licenseIds: ["apache-2.0"], gated: "auto" }).reason)
    .toBe("gated or private repos aren't supported");
  expect(classifyRepoCard({ licenseIds: ["apache-2.0"], gated: "manual" }).cls).toBe("refused");
  expect(classifyRepoCard({ licenseIds: ["apache-2.0"], priv: true }).cls).toBe("refused");
  expect(classifyRepoCard({ licenseIds: ["apache-2.0"], gated: false }).cls).toBe("open");
});

/* 2 - the path guard */
it("refuses traversal, absolute paths, %2e escapes and symlink escapes", async () => {
  for (const bad of ["../x.safetensors", "a/../../x.safetensors", "/x.safetensors",
    "%2e%2e/x.safetensors", "a//b.safetensors", "C:\\x.safetensors", "x/../y.safetensors"])
    expect(repoFileError(bad), bad).not.toBeNull();
  expect(repoFileError("dir/model.safetensors")).toBeNull();
  expect(repoFileError("model.safetensors")).toBeNull();
  for (const bad of ["../x", "a b", "a..b", "", "a/b/c"]) expect(isRepoName(bad), bad).toBe(false);
  expect(isRepoName("open/repo-1.x")).toBe(true);

  const root = mkdtempSync(join(tmpdir(), "of-hub-"));
  try {
    const models = join(root, "models");
    mkdirSync(models);
    const outside = mkdtempSync(join(tmpdir(), "of-out-"));
    try {
      symlinkSync(outside, join(models, "loras"));
      await expect(resolveModelTarget(models, "loras", "x.safetensors")).rejects.toThrow(/inside the models dir/);
      mkdirSync(join(outside, "sub"));
      symlinkSync(join(outside, "sub"), join(models, "vae"));
      await expect(resolveModelTarget(models, "vae", "x.safetensors")).rejects.toThrow(/inside the models dir/);
      await expect(resolveModelTarget(join(root, "nope"), "loras", "x")).rejects.toThrow(/set COMFYUI_DIR/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
    const good = await resolveModelTarget(models, "unet", "sub/model.safetensors");
    expect(good).toBe(join(realpathSync(models), "unet", "model.safetensors"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* 3 - hosted mode refuses every entry point */
it("hosted mode 403s inspect, downloads (POST+GET), pull and cancel", async () => {
  setEnv("MOTIONFIELD_HOSTED", "1");
  const { NextRequest } = await import("next/server");
  const mk = (p: string, m = "GET") => new NextRequest(`http://localhost${p}`, { method: m });
  const inspect = await import("@/app/api/models/hub/inspect/route");
  const downloads = await import("@/app/api/models/hub/downloads/route");
  const pull = await import("@/app/api/models/hub/pull/route");
  const byId = await import("@/app/api/models/hub/downloads/[id]/route");
  const checks: [string, Promise<Response>][] = [
    ["inspect", inspect.POST(mk("/api/models/hub/inspect", "POST"))],
    ["downloads POST", downloads.POST(mk("/api/models/hub/downloads", "POST"))],
    ["downloads GET", downloads.GET(mk("/api/models/hub/downloads"))],
    ["pull", pull.POST(mk("/api/models/hub/pull", "POST"))],
    ["delete", byId.DELETE(mk("/api/models/hub/downloads/x", "DELETE"), { params: Promise.resolve({ id: "x" }) })],
  ];
  for (const [name, p] of checks) {
    const res = await p;
    expect(res.status, name).toBe(403);
    expect(await res.json(), name).toMatchObject({ error: expect.stringContaining("not available in hosted mode") });
  }
});

/* 4 - both seams ignored in production and hosted mode */
it("ignores MOTIONFIELD_HF_BASE and MOTIONFIELD_HUB_TEST_FREE_GB in production and hosted", () => {
  for (const env of [{ NODE_ENV: "production" }, { MOTIONFIELD_HOSTED: "1" }]) {
    for (const k of ENV_KEYS) setEnv(k, undefined);
    for (const [k, v] of Object.entries(env)) setEnv(k, v);
    setEnv("MOTIONFIELD_HF_BASE", "http://127.0.0.1:3197");
    setEnv("MOTIONFIELD_HUB_TEST_FREE_GB", "12");
    expect(hfBase(), JSON.stringify(env)).toBe("https://huggingface.co");
    expect(hubTestFreeBytes(), JSON.stringify(env)).toBeNull();
  }
});

/* 5 - the HF base override accepts loopback http only */
it("MOTIONFIELD_HF_BASE applies only for loopback http", () => {
  for (const bad of ["https://huggingface.co", "http://example.com", "https://127.0.0.1:3197",
    "http://10.0.0.1:3197", "not a url", "http://169.254.169.254"]) {
    setEnv("MOTIONFIELD_HF_BASE", bad);
    expect(hfBase(), bad).toBe("https://huggingface.co");
  }
  for (const good of ["http://127.0.0.1:3197", "http://localhost:3197", "http://[::1]:3197/"]) {
    setEnv("MOTIONFIELD_HF_BASE", good);
    expect(hfBase(), good).toBe(good.replace(/\/+$/, ""));
  }
});

/* 6 - a redirect to a non-HF host, a private IP or http is refused */
it("redirect hops: https + huggingface.co/hf.co only (loopback under the seam)", () => {
  for (const bad of ["https://evil.example/x", "https://huggingface.co.evil.example/x",
    "http://huggingface.co/x", "https://127.0.0.1/x", "https://10.1.2.3/x",
    "https://cdn.evil.hf.co.evil.example/x", "ftp://huggingface.co/x", "notaurl"])
    expect(downloadHopError(bad, false), bad).not.toBeNull();
  for (const good of ["https://huggingface.co/x", "https://cdn-lfs.huggingface.co/x", "https://cas-bridge.xethub.hf.co/x"])
    expect(downloadHopError(good, false), good).toBeNull();
  // test seam: loopback http(s) only
  expect(downloadHopError("http://127.0.0.1:3197/resolve/x", true)).toBeNull();
  expect(downloadHopError("https://example.com/x", true)).not.toBeNull();
  expect(downloadHopError("http://10.0.0.1/x", true)).not.toBeNull();
});

/* 7 - no Authorization header is ever sent */
it("never sends an Authorization header", async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const srv: Server = createServer((req: IncomingMessage, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/models/") && req.url.includes("/tree/")) {
      res.end(JSON.stringify([{ type: "file", path: "m.safetensors", size: 1, lfs: { oid: "aa", size: 1 } }]));
    } else {
      res.end(JSON.stringify({
        sha: "0123456789abcdef0123456789abcdef01234567",
        gated: false, private: false, cardData: { license: "apache-2.0" },
      }));
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = (srv.address() as AddressInfo).port;
    setEnv("MOTIONFIELD_HF_BASE", `http://127.0.0.1:${port}`);
    const insp = await inspectRepo("open/repo", "weights");
    expect(insp.files.map((f) => f.path)).toEqual(["m.safetensors"]);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) {
      expect(Object.keys(h).some((k) => k.toLowerCase() === "authorization")).toBe(false);
      expect(Object.keys(h).some((k) => k.toLowerCase() === "cookie")).toBe(false);
    }
  } finally {
    srv.close();
  }
});

/* 8 - pickle extensions are refused */
it("refuses pickle extensions and names quants", () => {
  for (const f of ["x.ckpt", "x.pt", "x.pth", "x.bin", "d/x.PTH"])
    expect(weightFileError(f), f).toBe(PICKLE_REASON);
  expect(weightFileError("x.txt")).not.toBeNull();
  expect(weightFileError("x.safetensors")).toBeNull();
  expect(weightFileError("x.sft")).toBeNull();
  expect(weightFileError("x.gguf")).toBeNull();
  expect(quantTagFor("llama-3.2-1b.Q4_K_M.gguf")).toBe("Q4_K_M");
  expect(quantTagFor("m-IQ2_XXS.gguf")).toBe("IQ2_XXS");
  expect(quantTagFor("m-F16.gguf")).toBe("F16");
  expect(quantTagFor("model.gguf")).toBeNull();
  expect(quantTagFor("x.safetensors")).toBeNull();
});

/* 9 - banned weight names refuse outright (K11) */
it("redFlagWeight catches banned repo and file names", () => {
  for (const bad of ["briaai/RMBG-1.4", "x/codeformer", "y/inswapper_128.onnx",
    "causvid_1.3b.safetensors", "u2net.onnx", "hunyuan3d.safetensors"])
    expect(redFlagWeight(bad), bad).toBe(true);
  for (const ok of ["open/repo", "model.safetensors", "flux-dev.safetensors"])
    expect(redFlagWeight(ok), ok).toBe(false);
});

/* 10 - a dead hub reads as a 502, not a crash (K7) */
it("transport errors read 'couldn't reach Hugging Face' (502)", async () => {
  // port 9 (discard) is closed - connect ECONNREFUSED, not a DNS lookup
  setEnv("MOTIONFIELD_HF_BASE", "http://127.0.0.1:9");
  await expect(inspectRepo("open/repo", "weights")).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining("couldn't reach Hugging Face"),
  });
});

/* 11 - a durable running row with no live entry reads interrupted (K9) */
it("a 'running' row whose process is gone reports 'interrupted', not polling", async () => {
  const rows = [{
    id: "orphan-1", userId: "u1", kind: "weights", repo: "open/r", revision: "r1",
    file: "f.safetensors", subfolder: "loras", sha256: null, bytes: 10,
    licenceId: "mit", licenceClass: "open", status: "running", error: null,
    createdAt: new Date(0),
  }];
  // listDownloadRows reaches @/db + drizzle-orm through per-call dynamic
  // imports - a doMock intercepts them without reloading the module graph
  vi.doMock("@/db", () => ({
    getDb: async () => ({
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
    }),
    schema: { hubDownloads: { userId: "u", createdAt: "c" } },
  }));
  vi.doMock("drizzle-orm", () => ({ eq: () => null, desc: () => null, ne: () => null, and: () => null }));
  try {
    vi.resetModules(); // downloads.ts was already cached via resolveModelTarget
    const { listDownloadRows } = await import("@/lib/model-hub/downloads");
    const [row] = await listDownloadRows("u1");
    expect(row.status).toBe("interrupted");
  } finally {
    vi.doUnmock("@/db");
    vi.doUnmock("drizzle-orm");
    vi.resetModules();
  }
});
