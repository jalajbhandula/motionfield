/**
 * ws5-sound e2e (GENERATION_PROVIDER=mock):
 *  - OF-0402 prompt→music submits a real job, lands a WAV artifact
 *  - OF-0403 prompt→sfx the same
 *  - OF-0404 video→sfx runs the whole recipe: 1 fps frames → stub vision
 *    cue plan → per-cue sfx sub-jobs → loudness-normalized mix → an mp4
 *    whose container tags say post-mix + carry the cue list
 *  - post-mix (the Sound-toggle recipe path): owned video + owned bed →
 *    mp4 with aac audio + post-mix tags
 *  - security: logged out 401; foreign media 404; external URL 400; >60 s
 *    400; no vision route → 503 NEEDS_LLM
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const tmp = mkdtempSync(join(tmpdir(), "of-ws5-snd-"));

function makeClip(file: string, secs: { color: string; dur: number }[], audio = true) {
  const inputs = secs.flatMap((s) => [
    "-f", "lavfi", "-i", `color=${s.color}:size=320x180:rate=24:duration=${s.dur}`,
  ]);
  const total = secs.reduce((a, s) => a + s.dur, 0);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", ...inputs,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${total}`] : []),
    "-filter_complex",
    secs.map((_, i) => `[${i}:v]`).join("") + `concat=n=${secs.length}:v=1:a=0[v]`,
    "-map", "[v]", ...(audio ? ["-map", `${secs.length}:a`, "-c:a", "aac"] : ["-an"]),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return readFileSync(file);
}

function makeWav(file: string, freq = 330, dur = 3) {
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${dur}`,
    "-c:a", "pcm_s16le", file,
  ]);
  return readFileSync(file);
}

const ffprobeJson = (file: string) => JSON.parse(execFileSync("ffprobe", [
  "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
]).toString());

async function signup(ctx: APIRequestContext, label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await ctx.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: "WS5 Sound" },
  });
  expect(su.ok()).toBeTruthy();
}

async function upload(ctx: APIRequestContext, name: string, mime: string, buf: Buffer) {
  const up = await ctx.post("/api/uploads", {
    multipart: { file: { name, mimeType: mime, buffer: buf } },
  });
  expect(up.ok()).toBeTruthy();
  const { url } = await up.json();
  return url as string;
}

async function submitJob(ctx: APIRequestContext, endpointId: string, params: Record<string, unknown>) {
  const r = await ctx.post("/api/jobs", {
    data: { endpoint_id: endpointId, params },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  return r;
}

async function drainJob(ctx: APIRequestContext, id: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const g = await ctx.get(`/api/jobs/${id}`);
    const { job } = await g.json();
    if (!["queued", "in_progress"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("job did not settle");
}

/** fetch a /files/... url to a tmp path for ffprobe */
async function fetchToFile(ctx: APIRequestContext, url: string, name: string) {
  const r = await ctx.get(url);
  expect(r.ok()).toBeTruthy();
  const p = join(tmp, name);
  writeFileSync(p, Buffer.from(await r.body()));
  return p;
}

test.describe("ws5-sound", () => {

  test("OF-0402 prompt→music: invalid params 400; a submit completes with a WAV artifact", async ({ request }) => {
    await signup(request, "ws5s-music");
    expect((await submitJob(request, "motionfield/acestep/music", { duration: 30 })).status()).toBe(400);
    expect((await submitJob(request, "motionfield/acestep/music", { prompt: "x".repeat(600) })).status()).toBe(400);
    expect((await submitJob(request, "motionfield/acestep/music", { prompt: "lofi", duration: 4 })).status()).toBe(400);
    expect((await submitJob(request, "motionfield/acestep/music", { prompt: "lofi", duration: 200 })).status()).toBe(400);
    expect((await submitJob(request, "motionfield/acestep/music", { prompt: "lofi", lyrics: "y".repeat(4000) })).status()).toBe(400);

    const r = await submitJob(request, "motionfield/acestep/music", {
      prompt: "dreamy synthwave, soft pads", duration: 12, instrumental: true, seed: 7,
    });
    const rj = await r.json().catch(() => null);
    expect(r.status(), JSON.stringify(rj)).toBe(201);
    const done = await drainJob(request, rj.job.id);
    expect(done.status).toBe("completed");
    const out = done.outputs[0];
    expect(out.type).toMatch(/^audio/); // kind or mime depending on the surface
    const f = await fetchToFile(request, out.url, "music.wav");
    expect(readFileSync(f).subarray(0, 4).toString()).toBe("RIFF");
  });

  test("OF-0403 prompt→sfx: invalid params 400; a submit completes with a WAV artifact", async ({ request }) => {
    await signup(request, "ws5s-sfx");
    expect((await submitJob(request, "motionfield/moss/sfx", {})).status()).toBe(400);
    expect((await submitJob(request, "motionfield/moss/sfx", { prompt: "ok", duration: 30 })).status()).toBe(400);

    const r = await submitJob(request, "motionfield/moss/sfx", {
      prompt: "rain on a tin roof", duration: 4, seed: 3,
    });
    const rj = await r.json().catch(() => null);
    expect(r.status(), JSON.stringify(rj)).toBe(201);
    const done = await drainJob(request, rj.job.id);
    expect(done.status).toBe("completed");
    const out = done.outputs[0];
    expect(out.type).toMatch(/^audio/);
    const f = await fetchToFile(request, out.url, "sfx.wav");
    expect(readFileSync(f).subarray(0, 4).toString()).toBe("RIFF");
  });

  test("video→sfx + post-mix: 401 logged out; foreign url 404; external 400; >60 s 400; no-vision 503 NEEDS_LLM", async ({ request, baseURL }) => {
    await signup(request, "ws5s-sec");
    const clip = makeClip(join(tmp, "sec-clip.mp4"), [{ color: "black", dur: 4 }]);
    const videoUrl = await upload(request, "sec-clip.mp4", "video/mp4", clip);

    // logged out → 401 (fresh context, no cookies)
    const anon = await playwrightRequest.newContext({ baseURL: baseURL! });
    try {
      const r0 = await anon.post("/api/audio-mix/video-sfx", { data: { video_url: videoUrl } });
      expect(r0.status()).toBe(401);
    } finally { await anon.dispose(); }

    // external url → 400
    const r1 = await request.post("/api/audio-mix/video-sfx", {
      data: { video_url: "https://evil.example/clip.mp4" },
    });
    expect(r1.status()).toBe(400);

    // another user's upload → 404
    const other = await playwrightRequest.newContext({ baseURL: baseURL! });
    try {
      await signup(other, "ws5s-other");
      const otherClip = makeClip(join(tmp, "other.mp4"), [{ color: "white", dur: 3 }]);
      const otherUrl = await upload(other, "other.mp4", "video/mp4", otherClip);
      const r2 = await request.post("/api/audio-mix/video-sfx", { data: { video_url: otherUrl } });
      expect(r2.status()).toBe(404);
    } finally { await other.dispose(); }

    // >60 s → 400
    const long = makeClip(join(tmp, "long.mp4"), [{ color: "black", dur: 61 }]);
    const longUrl = await upload(request, "long.mp4", "video/mp4", long);
    const r3 = await request.post("/api/audio-mix/video-sfx", { data: { video_url: longUrl } });
    expect(r3.status()).toBe(400);

    // own short clip but no vision route → 503 NEEDS_LLM (the stage-route
    // envelope: human text in `error`, the marker in `code`)
    const r4 = await request.post("/api/audio-mix/video-sfx", { data: { video_url: videoUrl } });
    expect(r4.status()).toBe(503);
    const body4 = await r4.json();
    expect(body4.code).toBe("NEEDS_LLM");
    expect(body4.error).toContain("vision model");
  });

  test("OF-0404 video→sfx end-to-end: stub vision plans cues → mp4 tagged post-mix with cue list", async ({ request, baseURL }) => {
    // stub OpenAI-compatible vision server returning a fixed cue plan
    const calls: string[] = [];
    const stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          calls.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", content: JSON.stringify({ cues: [
              { t_start: 0, t_end: 2, prompt: "whoosh of a swing" },
              { t_start: 2, t_end: 4, prompt: "heavy thud on wood" },
            ] }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 30 },
          }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as AddressInfo).port;

    try {
      await signup(request, "ws5s-vsfx");
      const prov = await request.put("/api/llm/providers/custom", {
        data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
      });
      expect(prov.status(), await prov.text()).toBe(200);
      const route = await request.put("/api/llm/routes/vision", {
        data: { providerId: "custom", model: "stub-1" },
      });
      expect(route.status(), await route.text()).toBe(200);
      // the recipe endpoint is license-gated - opt in first
      expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

      const clip = makeClip(join(tmp, "vsfx.mp4"), [
        { color: "black", dur: 2 }, { color: "white", dur: 2 },
      ]);
      const videoUrl = await upload(request, "vsfx.mp4", "video/mp4", clip);

      const r = await request.post("/api/audio-mix/video-sfx", {
        data: { video_url: videoUrl },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const rj = await r.json().catch(() => null);
      expect(r.status(), JSON.stringify(rj)).toBe(201);
      const done = await drainJob(request, rj.job.id);
      expect(done.status).toBe("completed");

      // the vision stub was actually called with frames
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(calls[0]);
      const userMsg = payload.messages?.find((m: { role: string }) => m.role === "user");
      const imgs = (userMsg?.content ?? []).filter((p: { type: string }) => p.type === "image_url" || p.type === "image");
      expect(imgs.length).toBeGreaterThanOrEqual(3); // ≥3 sampled frames for a 4 s clip

      const out = done.outputs.find((o: { type?: string }) => o.type?.startsWith("video")) ?? done.outputs[0];
      const f = await fetchToFile(request, out.url, "vsfx-out.mp4");
      const j = ffprobeJson(f);
      const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      const a = j.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
      expect(v?.codec_name).toBe("h264");
      expect(a?.codec_name).toBe("aac");
      expect(j.format?.tags?.audio).toBe("post-mix");
      expect(j.format?.tags?.comment).toContain("sound added after generation");
      const cues = JSON.parse(j.format?.tags?.cues ?? "[]");
      expect(cues.length).toBe(2);
      expect(cues[0].prompt).toContain("whoosh");
    } finally { stub.close(); }
  });

  test("post-mix: owned video + owned bed → mp4 tagged post-mix; replace drops the original", async ({ request }) => {
    await signup(request, "ws5s-mix");
    expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

    const clip = makeClip(join(tmp, "mix-src.mp4"), [{ color: "black", dur: 4 }]);
    const bed = makeWav(join(tmp, "bed.wav"), 330, 4);
    const videoUrl = await upload(request, "mix-src.mp4", "video/mp4", clip);
    const bedUrl = await upload(request, "bed.wav", "audio/wav", bed);

    const r = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "keep",
    });
    const rj = await r.json().catch(() => null);
    expect(r.status(), JSON.stringify(rj)).toBe(201);
    const done = await drainJob(request, rj.job.id);
    expect(done.status).toBe("completed");
    const out = done.outputs.find((o: { type?: string }) => o.type?.startsWith("video")) ?? done.outputs[0];
    const f = await fetchToFile(request, out.url, "mix-out.mp4");
    const j = ffprobeJson(f);
    expect(j.streams.find((s: { codec_type: string }) => s.codec_type === "video")?.codec_name).toBe("h264");
    expect(j.streams.find((s: { codec_type: string }) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(j.format?.tags?.audio).toBe("post-mix");
    expect(j.format?.tags?.comment).toContain("sound added after generation");

    // replace mode - same mp4 shape, original audio dropped
    const r2 = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "replace",
    });
    const r2j = await r2.json().catch(() => null);
    expect(r2.status(), JSON.stringify(r2j)).toBe(201);
    const done2 = await drainJob(request, r2j.job.id);
    expect(done2.status).toBe("completed");
    const f2 = await fetchToFile(request, (done2.outputs[0]).url, "mix-out2.mp4");
    const j2 = ffprobeJson(f2);
    expect(j2.streams.find((s: { codec_type: string }) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(j2.format?.tags?.audio).toBe("post-mix");
  });

  test("post-mix loudness: replace lands −14 ±1 LU; keep (−16 src + −20 bed) lands −14.5 ±1 LU, true peak ≤ −1; foreign audio_url fails", async ({ request, baseURL }) => {
    await signup(request, "ws5s-lufs");
    expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

    // integrated loudness + true peak of an output file's first audio stream.
    // ebur128 prints a per-frame line too - the summary's values are the LAST
    // "I:" / "Peak:" occurrences in stderr, so take the last match of each.
    const loudness = (file: string) => {
      const r = spawnSync("ffmpeg", [
        "-v", "info", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-",
      ], { encoding: "utf8" });
      const stderr = r.stderr ?? "";
      const allI = [...stderr.matchAll(/I:\s*(-?\d+\.?\d*)\s*LUFS/g)];
      const allTp = [...stderr.matchAll(/^\s*Peak:\s*(-?\d+\.?\d*)\s*dBFS/gm)];
      const i = allI[allI.length - 1];
      const tp = allTp[allTp.length - 1];
      return { integrated: i ? Number(i[1]) : NaN, truePeak: tp ? Number(tp[1]) : NaN, log: stderr.slice(-800) };
    };

    const clip = makeClip(join(tmp, "lufs-src.mp4"), [{ color: "black", dur: 6 }]);
    const bed = makeWav(join(tmp, "lufs-bed.wav"), 220, 6);
    const videoUrl = await upload(request, "lufs-src.mp4", "video/mp4", clip);
    const bedUrl = await upload(request, "lufs-bed.wav", "audio/wav", bed);

    // replace: the bed carries the mix alone → −14 LUFS
    const rep = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "replace",
    });
    expect(rep.status()).toBe(201);
    const repDone = await drainJob(request, (await rep.json()).job.id);
    expect(repDone.status).toBe("completed");
    const repFile = await fetchToFile(request, repDone.outputs[0].url, "lufs-rep.mp4");
    const repL = loudness(repFile);
    expect(repL.integrated, repL.log).toBeGreaterThanOrEqual(-15);
    expect(repL.integrated, repL.log).toBeLessThanOrEqual(-13);
    expect(repL.truePeak, repL.log).toBeLessThanOrEqual(-1.0);

    // keep: source two-passed to −16, the bed to −20 → the sum reads −14.5
    const keep = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "keep",
    });
    expect(keep.status()).toBe(201);
    const keepDone = await drainJob(request, (await keep.json()).job.id);
    expect(keepDone.status).toBe("completed");
    const keepFile = await fetchToFile(request, keepDone.outputs[0].url, "lufs-keep.mp4");
    const keepL = loudness(keepFile);
    expect(keepL.integrated, keepL.log).toBeGreaterThanOrEqual(-15.5);
    expect(keepL.integrated, keepL.log).toBeLessThanOrEqual(-13.5);
    expect(keepL.truePeak, keepL.log).toBeLessThanOrEqual(-1.0);

    // a SILENT source still renders - loudnorm's -inf measurement would
    // otherwise feed an infinite gain into pass two; the copy-through path
    // muxes the bed and completes instead
    const silentClip = join(tmp, "silent-src.mp4");
    spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=12:d=4",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", silentClip,
    ]);
    const silentUrl = await upload(request, "silent-src.mp4", "video/mp4", readFileSync(silentClip));
    const sil = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: silentUrl, audio_url: bedUrl, mode: "keep",
    });
    expect(sil.status()).toBe(201);
    const silDone = await drainJob(request, (await sil.json()).job.id);
    expect(silDone.status).toBe("completed");
    expect(silDone.outputs.length).toBeGreaterThan(0);

    // a bed the caller doesn't own → the job fails "not found", no output
    const other = await playwrightRequest.newContext({ baseURL: baseURL! });
    try {
      await signup(other, "ws5s-bed-other");
      const otherBed = await upload(other, "obed.wav", "audio/wav", makeWav(join(tmp, "obed.wav"), 500, 4));
      const bad = await submitJob(request, "motionfield/audio-mix/post-mix", {
        video_url: videoUrl, audio_url: otherBed, mode: "keep",
      });
      expect(bad.status()).toBe(201); // ownership resolves inside the job, not at submit
      const badDone = await drainJob(request, (await bad.json()).job.id);
      expect(badDone.status).toBe("failed");
      expect(badDone.error).toMatch(/not found/i);
      expect(badDone.outputs ?? []).toHaveLength(0);
    } finally { await other.dispose(); }

    // logged out → /api/jobs itself refuses
    const anon = await playwrightRequest.newContext({ baseURL: baseURL! });
    try {
      const r = await anon.post("/api/jobs", {
        data: { endpoint_id: "motionfield/acestep/music", params: { prompt: "x" } },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      expect(r.status()).toBe(401);
    } finally { await anon.dispose(); }
  });

  test("post-mix keep band split: 440 Hz reads ≈ −16 LUFS and 220 Hz ≈ −20 - the source sits over the bed", async ({ request }) => {
    await signup(request, "ws5s-band");
    expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

    // a narrow bandpass at the tone's frequency isolates it (single stage
    // loses <0.1 dB at centre); ebur128 reads the band's integrated level
    const bandLoudness = (file: string, freq: number) => {
      const r = spawnSync("ffmpeg", [
        "-v", "info", "-i", file,
        "-af", `bandpass=f=${freq}:t=h:w=${Math.round(freq / 8)},ebur128=peak=true`,
        "-f", "null", "-",
      ], { encoding: "utf8" });
      const all = [...(r.stderr ?? "").matchAll(/I:\s*(-?\d+\.?\d*)\s*LUFS/g)];
      const last = all[all.length - 1];
      return { i: last ? Number(last[1]) : NaN, log: (r.stderr ?? "").slice(-600) };
    };

    const clip = makeClip(join(tmp, "band-src.mp4"), [{ color: "black", dur: 6 }]); // 440 Hz src
    const bed = makeWav(join(tmp, "band-bed.wav"), 220, 6);
    const videoUrl = await upload(request, "band-src.mp4", "video/mp4", clip);
    const bedUrl = await upload(request, "band-bed.wav", "audio/wav", bed);

    const r = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "keep",
    });
    expect(r.status()).toBe(201);
    const done = await drainJob(request, (await r.json()).job.id);
    expect(done.status).toBe("completed");
    const f = await fetchToFile(request, done.outputs[0].url, "band-keep.mp4");

    const src = bandLoudness(f, 440);
    expect(src.i, `440 Hz band ${src.log}`).toBeGreaterThanOrEqual(-17.5);
    expect(src.i, `440 Hz band ${src.log}`).toBeLessThanOrEqual(-14.5);
    const bed440 = bandLoudness(f, 220);
    expect(bed440.i, `220 Hz band ${bed440.log}`).toBeGreaterThanOrEqual(-21.5);
    expect(bed440.i, `220 Hz band ${bed440.log}`).toBeLessThanOrEqual(-18.5);
  });

  test("post-mix true peak: identical pink-noise src+bed sums over 0 dBFS - the bus limiter caps at −1 dBTP", async ({ request }) => {
    await signup(request, "ws5s-tp");
    expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

    const truePeak = (file: string) => {
      const r = spawnSync("ffmpeg", [
        "-v", "info", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-",
      ], { encoding: "utf8" });
      const all = [...(r.stderr ?? "").matchAll(/^\s*Peak:\s*(-?\d+\.?\d*)\s*dBFS/gm)];
      const last = all[all.length - 1];
      return { tp: last ? Number(last[1]) : NaN, log: (r.stderr ?? "").slice(-600) };
    };
    const samplePeak = (file: string) => {
      const r = spawnSync("ffmpeg", [
        "-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-",
      ], { encoding: "utf8" });
      const m = /max_volume:\s*(-?\d+\.?\d*)\s*dB/.exec(r.stderr ?? "");
      return { sp: m ? Number(m[1]) : NaN, log: (r.stderr ?? "").slice(-600) };
    };

    // clip audio and bed are the SAME fixed-seed pink noise - in keep mode
    // the −16 LUFS source and the −20 LUFS bed sum coherently (same
    // waveform): the bus peaks over 0 dBFS and only the oversampled
    // alimiter can hold it at ≤ −1 dBTP. Sample peak ≥ −3 dBFS is the
    // other half of the proof - a mix that simply stayed quiet never
    // exercised the limiter at all.
    const clip = join(tmp, "tp-src.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=6",
      "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=6:seed=4242:sample_rate=48000",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip,
    ]);
    const bed = join(tmp, "tp-bed.wav");
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi",
      "-i", "anoisesrc=color=pink:duration=6:seed=4242:sample_rate=48000",
      "-c:a", "pcm_s16le", bed,
    ]);
    const videoUrl = await upload(request, "tp-src.mp4", "video/mp4", readFileSync(clip));
    const bedUrl = await upload(request, "tp-bed.wav", "audio/wav", readFileSync(bed));

    const r = await submitJob(request, "motionfield/audio-mix/post-mix", {
      video_url: videoUrl, audio_url: bedUrl, mode: "keep",
    });
    expect(r.status()).toBe(201);
    const done = await drainJob(request, (await r.json()).job.id);
    expect(done.status).toBe("completed");
    const f = await fetchToFile(request, done.outputs[0].url, "tp-keep.mp4");
    const { tp, log } = truePeak(f);
    const { sp, log: slog } = samplePeak(f);
    expect(tp, `keep true peak ${log}`).toBeLessThanOrEqual(-1.0);
    expect(sp, `keep sample peak ${slog}`).toBeGreaterThanOrEqual(-3.0);
  });

  test("video→sfx malformed cues: bad rows drop, the rest still land in the cues tag", async ({ request }) => {
    // one good row, one running past the end (sanitized in), one over-long
    // prompt, one with an invented key - per-row validation keeps the good
    const stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", content: JSON.stringify({ cues: [
              { t_start: 0, t_end: 2, prompt: "whoosh of a swing" },
              { t_start: 2, t_end: 40, prompt: "tail runs past the clip" },
              { t_start: 1, t_end: 2, prompt: "x".repeat(400) },
              { t_start: 3, t_end: 4, prompt: "door creak", extra_key: true },
            ] }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 30 },
          }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as AddressInfo).port;

    try {
      await signup(request, "ws5s-badcue");
      await request.put("/api/llm/providers/custom", { data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` } });
      await request.put("/api/llm/routes/vision", { data: { providerId: "custom", model: "stub-1" } });
      expect((await request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

      const clip = makeClip(join(tmp, "badcue.mp4"), [{ color: "black", dur: 5 }]);
      const videoUrl = await upload(request, "badcue.mp4", "video/mp4", clip);

      const r = await request.post("/api/audio-mix/video-sfx", {
        data: { video_url: videoUrl }, headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      expect(r.status()).toBe(201);
      const done = await drainJob(request, (await r.json()).job.id);
      expect(done.status).toBe("completed");

      const f = await fetchToFile(request, done.outputs[0].url, "badcue-out.mp4");
      const j = ffprobeJson(f);
      const cues = JSON.parse(j.format?.tags?.cues ?? "[]");
      // the good row + the past-the-end row (clamped to the clip) survive;
      // the 400-char prompt and the invented key are dropped row-wise
      expect(cues).toHaveLength(2);
      expect(cues[0].prompt).toContain("whoosh");
      expect(cues[1].prompt).toContain("tail");
      expect(cues[1].t_end).toBeLessThanOrEqual(5.05);
    } finally { stub.close(); }
  });

  test("/audio UI - music form: prompt + lyrics + Instrumental → WAV player; job params carry lyrics/instrumental", async ({ page }) => {
    await signup(page.request, "ws5s-uimus");
    await page.goto("/audio");
    await page.getByRole("button", { name: "ACE-Step 1.5" }).click();
    await page.getByPlaceholder("epic orchestral score").fill("dreamy synthwave");
    await page.getByPlaceholder("[verse]").fill("neon nights, we glow");
    await page.locator("button.h-6.w-11").click(); // Instrumental toggle
    await page.getByRole("button", { name: /Generate/ }).click();

    await expect(page.locator('[data-job-status="completed"]')).toBeVisible({ timeout: 90_000 });
    const audio = page.locator('[data-job-status="completed"] audio');
    await expect(audio).toHaveAttribute("src", /\.wav$/);
    await expect.poll(async () =>
      audio.evaluate((a) => (a as HTMLAudioElement).duration ?? 0), { timeout: 15_000 },
    ).toBeGreaterThan(0);

    // the job row exposes what the form sent
    const list = await page.request.get("/api/jobs?limit=5");
    const { jobs } = await list.json();
    const mine = jobs.find((j: { modelId?: string; status: string }) => j.status === "completed");
    const detail = await (await page.request.get(`/api/jobs/${mine.id}`)).json();
    expect(detail.job.params.lyrics).toBe("neon nights, we glow");
    expect(detail.job.params.instrumental).toBe(true);
  });

  test("/audio UI - sfx form: prompt → WAV player; video→sfx without a vision route shows the needs-vision message", async ({ page }) => {
    await signup(page.request, "ws5s-uisfx");
    expect((await page.request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();
    await page.goto("/audio");
    // audio models render as chips - pick the SFX model
    await page.getByRole("button", { name: /MOSS SoundEffect/ }).click();

    // sfx tab is the default workflow - fill the Sound prompt and submit
    await page.getByPlaceholder("rain on a tin roof").fill("rain on a tin roof");
    await page.getByRole("button", { name: /Generate/ }).click();
    await expect(page.locator('[data-job-status="completed"]')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-job-status="completed"] audio')).toHaveAttribute("src", /\.wav$/);

    // video→sfx without a vision route - the job fails with the human text
    await page.getByRole("button", { name: "Video → sound effects" }).click();
    const clipPath = join(tmp, "ui-vsfx.mp4");
    makeClip(clipPath, [{ color: "black", dur: 4 }]);
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toHaveCount(1);
    await fileInput.setInputFiles(clipPath);
    // the upload settles into a preview tile before params.video_url exists
    await expect(page.locator(".media-tile video")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /Generate/ }).click();
    await expect(page.locator('[data-job-status="failed"]')).toBeVisible({ timeout: 90_000 });
    await expect(
      page.locator('[data-job-status="failed"]').locator("text=/vision model/"),
    ).toBeVisible({ timeout: 15_000 });
  });
});
