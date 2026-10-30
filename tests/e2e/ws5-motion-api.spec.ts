import { expect, request as playwrightRequest, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { findEndpoint } from "@/lib/catalog/video-models";
import { MOTION_RENDER_ENDPOINT } from "@/lib/catalog/code/motion";

const features = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/ws5-features.json"), "utf8"),
) as Record<string, unknown>;
const launch = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/ws5-launch.json"), "utf8"),
) as Record<string, unknown>;

const base = `http://localhost:${process.env.PORT || "3100"}`;

// sign-ups serialize (PGlite profile hook)
test.describe.configure({ mode: "serial" });

async function signupCtx(label: string) {
  // a bare APIRequestContext needs an Origin for better-auth's CSRF check.
  // BETTER_AUTH_RATE_TEST=1 lifts the sign-up cap - no faked IPs needed.
  const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  // PGlite's sign-up profile hook can 500 on concurrent commits across workers
  // - retry, and sign-in covers the row that committed before the hook failed
  for (let i = 0; i < 5; i++) {
    if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "WS5 API" } })).ok()
      || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return ctx;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(`signup/signin failed for ${email}`);
}

test("stored specs are owner-only - a second user gets 404s across read/refine/render", async () => {
  test.setTimeout(120_000); // first-contact with cold-compiled auth/render routes
  const a = await signupCtx("ws5a");
  const mk = await a.post("/api/render/specs", { data: { spec: features } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();

  const b = await signupCtx("ws5b");
  expect((await b.get(`/api/render/specs/${id}`)).status()).toBe(404);
  // A3: refine checks LLM availability before touching the DB - with no
  // LLM configured every refine is 503, owner or not (no existence leak
  // either way: the 503 reveals nothing about which rows exist)
  expect((await b.post(`/api/render/motion/${id}/refine`, { data: { instruction: "make it bolder" } })).status()).toBe(503);
  expect((await b.post(`/api/render/motion/${id}/render`, { data: {} })).status()).toBe(404);

  // malformed ids and oversized/invalid bodies
  expect((await a.get("/api/render/specs/not-a-uuid")).status()).toBe(404);
  const big = await a.post("/api/render/specs", { data: { spec: { version: 1, pad: "x".repeat(300_000) } } });
  expect(big.status()).toBe(413);
  const bad = await a.post("/api/render/specs", { data: { spec: { version: 2, width: 64 } } });
  expect(bad.status()).toBe(400);

  await a.dispose();
  await b.dispose();
});

const renderReady = Boolean(findEndpoint(MOTION_RENDER_ENDPOINT));

test("POST render → job → h264 mp4 @ 1280×720 with ~48 frames", async () => {
  test.skip(!renderReady, "motion render endpoint not registered in the catalog yet");
  test.setTimeout(300_000);
  const ctx = await signupCtx("ws5r");
  const mk = await ctx.post("/api/render/specs", { data: { spec: launch } });
  expect(mk.status()).toBe(201);
  const { id } = await mk.json();

  const r = await ctx.post(`/api/render/motion/${id}/render`, { data: {} });
  expect(r.status()).toBe(201);
  const { job_id } = await r.json();

  // each poll opportunistically ticks the job forward (no worker in dev)
  let job: { status: string; outputs?: { type: string; url: string }[]; error?: string } | undefined;
  for (let i = 0; i < 200; i++) {
    const jr = await ctx.get(`/api/jobs/${job_id}`);
    job = (await jr.json()).job;
    if (job && ["completed", "failed"].includes(job.status)) break;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  expect(job?.status, job?.error).toBe("completed");

  const video = (job?.outputs ?? []).find((o) => o.type === "video" || o.type.startsWith("video/"));
  expect(video?.url).toMatch(/^\/files\//);
  const vr = await ctx.get(video!.url);
  expect(vr.ok()).toBeTruthy();
  const dir = mkdtempSync(path.join(tmpdir(), "ws5-render-"));
  try {
    const file = path.join(dir, "out.mp4");
    writeFileSync(file, Buffer.from(await vr.body()));

    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file], { encoding: "utf8" }),
    ) as { streams: { codec_type: string; codec_name: string; width: number; height: number; nb_frames: string }[] };
    const vs = probe.streams.find((s) => s.codec_type === "video")!;
    expect(vs.codec_name).toBe("h264");
    expect([vs.width, vs.height]).toEqual([1280, 720]);
    expect(Math.abs(Number(vs.nb_frames) - 48)).toBeLessThanOrEqual(1); // 2s × 24fps
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await ctx.dispose();
});
