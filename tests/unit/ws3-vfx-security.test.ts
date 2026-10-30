import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { POST as probePost } from "@/app/api/vfx-lab/probe/route";
import { POST as submitPost } from "@/app/api/vfx-lab/submit/route";
import { POST as targetPost } from "@/app/api/vfx-lab/target/route";
import { getAuth } from "@/lib/auth";
import { sql } from "@/db";
import {
  VFX_LOCK_SIGMAS, VFX_LOCK_DENOISE, VFX_LTX098_FILE, VFX_LTX_TOKEN_CAP,
  ltx098Installed, vfxDims, vfxFrames, vfxTokens, vfxAltFrames, vfxAltDims,
} from "@/lib/catalog/video/vfx";
import { VFX_PRESETS, vfxPresetVerified } from "@/lib/catalog/presets/vfx-lab";
import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicenseFor } from "@/lib/catalog/licenses";

/* VFX Lab security + honesty gates (ws3 s10):
 *   - the endpoint validate() refuses every hand-rolled field (unknown keys,
 *     mismatched sigmas/denoise vs the lock table, bad 8n+1, fps≠24, token cap)
 *   - ltx098 exists only while its exact checkpoint file does
 *   - the route enforces ownership before charge, stamps server-probed fields,
 *     and refuses unverified presets - verified ≠ label
 *   - /api/jobs direct calls hit the same endpoint gate */

const filesRoot = resolve(process.cwd(), "public", "files", "uploads");
const tag = `w3vfx-${randomUUID().slice(0, 8)}`;
const clipUrl = `/files/uploads/${tag}.mp4`;
const imgUrl = `/files/uploads/${tag}.png`;
const clipFile = join(filesRoot, `${tag}.mp4`);
const imgFile = join(filesRoot, `${tag}.png`);

async function makeUser(t: string): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `${t}-${randomUUID().slice(0, 8)}@ws3.test`, password: "password-1234", name: t },
    returnHeaders: true,
  });
  const cookie = String(out.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("session_token");
  return { id: out.response.user.id, cookie };
}

function stage() {
  mkdirSync(filesRoot, { recursive: true });
  // 2 s video @24fps - the plate probes to 48 stream frames
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipFile,
  ]);
  // a real still - 640×360 png via ffmpeg (probeImageDims needs video-stream dims)
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=0.1",
    "-frames:v", "1", imgFile,
  ]);
}
afterAll(() => {
  for (const f of [clipFile, imgFile]) if (existsSync(f)) rmSync(f, { force: true });
});

async function stageRows(userId: string) {
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 1024, $3)
             ON CONFLICT DO NOTHING`, [userId, clipUrl, `${tag}.mp4`]);
  await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 1024, $3)
             ON CONFLICT DO NOTHING`, [userId, imgUrl, `${tag}.png`]);
}

/** restricted endpoints need the license opt-in at the CURRENT version -
 *  this is what the /settings/licenses toggle writes */
async function optIn(userId: string) {
  await sql(`INSERT INTO license_optins (user_id, version) VALUES ($1, 'of-licenses-v1')
             ON CONFLICT (user_id) DO UPDATE SET version = 'of-licenses-v1'`, [userId]);
}

/** The gate checks must not depend on which presets happen to be verified in
 *  the committed fixture today - point the records at an empty temp file so
 *  "unverified preset → 400" stays true regardless of real runs. */
const noVerifyFile = join(mkdtempSync(join(os.tmpdir(), "vfx-verify-")), "none.json");
writeFileSync(noVerifyFile, '{"version":1,"records":{}}');
process.env.VFX_VERIFY_FILE = noVerifyFile;

const post = (route: (req: NextRequest) => Promise<Response>, body: unknown, cookie?: string) =>
  route(new NextRequest("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));

const PLATE = findEndpoint("motionfield/ltx-video/vfx-lab-plate")!.workflow;
const IMG = findEndpoint("motionfield/ltx-video/vfx-lab-image")!.workflow;
const ALT = findEndpoint("motionfield/wan-vace/vfx-lab-alt")!.workflow;

const validPlate = {
  video_url: clipUrl, engine: "ltx095", plate_lock: "medium", hold: 9,
  prompt: "frost", resolution: "480p", steps: 8,
  frames: 49, fps: 24, duration: 2, width: 832, height: 480,
  denoise: VFX_LOCK_DENOISE.medium, sigmas: VFX_LOCK_SIGMAS.medium.join(", "),
};

describe("vfx endpoint gate - hand-rolled params", () => {
  it("refuses unknown keys - no workflow/ckpt/node smuggling", () => {
    for (const key of ["workflow", "ckpt_name", "nodes", "graph", "endpoint", "model_name"])
      expect(PLATE.validate!({ ...validPlate, [key]: "x" })).toMatch(new RegExp(`unexpected param ${key}`));
  });
  it("refuses a sigmas string that isn't the lock's tail", () => {
    expect(PLATE.validate!({ ...validPlate, engine: "ltx098", sigmas: "1.0, 0.5, 0" })).not.toBeNull();
  });
  it("refuses a denoise that isn't the lock's", () => {
    expect(PLATE.validate!({ ...validPlate, denoise: 0.99 })).toMatch(/denoise/);
  });
  it("refuses ltx098 while the exact checkpoint is absent", () => {
    // on this Mac the distilled file is not installed - the gate must hold
    expect(ltx098Installed()).toBe(false);
    expect(PLATE.validate!({ ...validPlate, engine: "ltx098" })).toMatch(/ltx098 isn't installed/);
  });
  it("refuses bad frame counts - not 8n+1, out of range", () => {
    expect(PLATE.validate!({ ...validPlate, frames: 50 })).toMatch(/8n\+1/);
    expect(PLATE.validate!({ ...validPlate, frames: 999 })).toMatch(/17-241/);
    expect(PLATE.validate!({ ...validPlate, frames: 9 })).toMatch(/17-241/);
  });
  it("refuses fps off the LTX rate and duration over the budget", () => {
    expect(PLATE.validate!({ ...validPlate, fps: 30 })).toMatch(/fps must be 24/);
    expect(PLATE.validate!({ ...validPlate, duration: 30 })).toMatch(/10 s/);
  });
  it("refuses the token cap - frames×dims over budget", () => {
    expect(vfxTokens(97, 832, 480)).toBeLessThanOrEqual(VFX_LTX_TOKEN_CAP);
    expect(PLATE.validate!({ ...validPlate, frames: 241, width: 1280, height: 704 })).toMatch(/token/);
  });
  it("refuses a url that isn't an owned /files/ ref", () => {
    expect(PLATE.validate!({ ...validPlate, video_url: "https://x.example/clip.mp4" })).toMatch(/\/files\//);
    expect(PLATE.validate!({ ...validPlate, video_url: "/files/../escape.mp4" })).toMatch(/traversal/);
    expect(PLATE.validate!({ ...validPlate, end_image_url: "https://x.example/e.png" })).toMatch(/\/files\//);
  });
  it("image plate: sigmas must be the full distilled tail on ltx098", () => {
    const base = {
      image_url: imgUrl, engine: "ltx095", prompt: "x", duration: 3,
      frames: 73, fps: 24, width: 832, height: 480, sigmas: VFX_LOCK_SIGMAS.full.join(", "),
    };
    expect(IMG.validate!(base)).toBeNull();
    // under ltx095 the sigmas string is inert - but a wrong one still can't be smuggled through ltx098's field
    expect(IMG.validate!({ ...base, duration: 9 })).toMatch(/2-5 s/);
  });
  it("alt: exactly one plate kind, structure fits the plate, 4n+1 frames", () => {
    const base = {
      structure: "depth", alt_length: "preview", prompt: "x",
      frames: 33, fps: 16, duration: 2, width: 832, height: 480,
    };
    expect(ALT.validate!({ ...base })).toMatch(/exactly one/);
    expect(ALT.validate!({ ...base, video_url: clipUrl, image_url: imgUrl })).toMatch(/exactly one/);
    expect(ALT.validate!({ ...base, image_url: imgUrl })).toMatch(/needs a video plate/);
    expect(ALT.validate!({ ...base, video_url: clipUrl, structure: "image" })).toMatch(/needs an image plate/);
    expect(ALT.validate!({ ...base, video_url: clipUrl, frames: 34 })).toMatch(/4n\+1/);
    expect(ALT.validate!({ ...base, video_url: clipUrl, frames: 97 })).toMatch(/81/);
    expect(ALT.validate!({ ...base, video_url: clipUrl })).toBeNull();
    expect(ALT.validate!({ ...base, image_url: imgUrl, structure: "image" })).toBeNull();
  });
});

describe("vfx dims/tokens math", () => {
  it("1080p clip fits the 480p box; 10 s shrinks until the cap holds", () => {
    expect(vfxDims(1920, 1080, "480p", 97)).toEqual([832, 448]); // 1080×0.4333=468→448 (floor to 32)
    const [w, h] = vfxDims(1920, 1080, "480p", vfxFrames(10));
    expect(vfxTokens(vfxFrames(10), w, h)).toBeLessThanOrEqual(VFX_LTX_TOKEN_CAP);
  });
  it("portrait swaps the box, alt dims are multiples of 16", () => {
    const [w, h] = vfxDims(1080, 1920, "480p", 97);
    expect(h).toBeGreaterThan(w);
    const [aw, ah] = vfxAltDims(1920, 1080);
    expect(aw % 16).toBe(0); expect(ah % 16).toBe(0);
    expect(aw).toBe(832); expect(ah).toBe(464);
    expect(vfxAltFrames(2, "preview")).toBeLessThanOrEqual(33);
  });
});

describe("vfx preset gate", () => {
  it("no preset is verified without a matching record - verified ≠ label", () => {
    // the committed fixture has no records yet (smokes write them)
    expect(VFX_PRESETS.length).toBe(20);
    for (const p of VFX_PRESETS) expect(vfxPresetVerified(p.id, {})).toBe(false);
  });
  it("a verified record pins the current hash - stale hash drops the preset", () => {
    const p = VFX_PRESETS[0];
    expect(vfxPresetVerified(p.id, { [p.id]: { mechanism_hash: "stale", status: "verified" } })).toBe(false);
  });
});

describe("vfx submit route - ownership, server-stamped params", () => {
  it("rejects unauthenticated, the license gate, and every ownership hole", async () => {
    stage();
    const r0 = await submitPost(new NextRequest("http://localhost/api/vfx-lab/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ video_url: clipUrl }),
    }));
    expect(r0.status).toBe(401);
    const me = await makeUser("w3-vfx-sub");
    await stageRows(me.id);
    // restricted LTX - no opt-in row → structured 403, never a charge
    const rl = await post(submitPost, { video_url: clipUrl }, me.cookie);
    expect(rl.status).toBe(403);
    expect((await rl.json()).error.code).toBe("restricted_license");
    await optIn(me.id);
    for (const [body, code] of [
      [{ video_url: "https://example.com/v.mp4" }, 400],
      [{ video_url: "/files/uploads/nope.mp4" }, 404],
      [{ video_url: clipUrl, image_url: imgUrl }, 400],           // both plates
      [{ video_url: clipUrl, engine: "ltx098" }, 400],            // not installed
      [{ video_url: clipUrl, vfx_preset: "vfx-frostbite" }, 400], // not verified yet
      [{ image_url: imgUrl, structure: "depth" }, 400],           // structure needs video
      [{ video_url: clipUrl, structure: "image" }, 400],          // image structure needs still
      [{ video_url: clipUrl, hold: 5 }, 400],                     // hold not in the pick list
    ] as const) {
      const r = await post(submitPost, body, me.cookie);
      expect(r.status, JSON.stringify(body)).toBe(code);
    }
  }, 60_000);

  it("a real plate submits - params are probe-stamped, denoise matches the lock", async () => {
    const me = await makeUser("w3-vfx-ok");
    await stageRows(me.id);
    await optIn(me.id);
    const r = await post(submitPost, {
      video_url: clipUrl, plate_lock: "strong", hold: 17, prompt: "frost", vfx_preset: undefined,
    }, me.cookie);
    expect(r.status).toBe(201);
    const { job } = await r.json();
    const [row] = await sql<{ params: Record<string, unknown> }>(
      `SELECT params FROM jobs WHERE id = $1`, [job.id]);
    const p = row.params;
    expect(p.frames).toBe(41);                       // 2 s @24 → 48 target → largest 8n+1 ≤ it
    expect(p.fps).toBe(24);
    expect(Number(p.duration)).toBeCloseTo(2.0, 3);  // stream truth
    // the 320×180 plate is under the 480p box - dims floor to multiples of 32,
    // never upscale
    expect(p.width).toBe(320); expect(p.height).toBe(160);
    expect(p.denoise).toBe(VFX_LOCK_DENOISE.strong);
    expect(p.sigmas).toBe(VFX_LOCK_SIGMAS.strong.join(", "));
    expect(p.plate_lock).toBe("strong");
    expect(p.hold).toBe(17);
  }, 60_000);

  it("a real still submits on the image endpoint", async () => {
    const me = await makeUser("w3-vfx-img");
    await stageRows(me.id);
    await optIn(me.id);
    const r = await post(submitPost, { image_url: imgUrl, prompt: "ash" }, me.cookie);
    expect(r.status).toBe(201);
    const { job } = await r.json();
    const [row] = await sql<{ params: Record<string, unknown>; endpoint_id: string }>(
      `SELECT params, endpoint_id FROM jobs WHERE id = $1`, [job.id]);
    expect(row.endpoint_id).toBe("motionfield/ltx-video/vfx-lab-image");
    expect(row.params.frames).toBe(65);              // 3 s @ 24fps → 8n+1
    expect(row.params.fps).toBe(24);
    expect(Number(row.params.width) % 32).toBe(0);
  }, 60_000);

  it("the alt path submits structure/length with 4n+1 @16 frames", async () => {
    const me = await makeUser("w3-vfx-alt");
    await stageRows(me.id);
    const r = await post(submitPost, { video_url: clipUrl, structure: "depth", alt_length: "preview" }, me.cookie);
    expect(r.status).toBe(201);
    const { job } = await r.json();
    const [row] = await sql<{ params: Record<string, unknown>; endpoint_id: string }>(
      `SELECT params, endpoint_id FROM jobs WHERE id = $1`, [job.id]);
    expect(row.endpoint_id).toBe("motionfield/wan-vace/vfx-lab-alt");
    expect(row.params.fps).toBe(16);
    expect((Number(row.params.frames) - 1) % 4).toBe(0);
    expect(Number(row.params.frames)).toBeLessThanOrEqual(33);
    expect(Number(row.params.width) % 16).toBe(0);
  }, 60_000);
});

describe("vfx licenses", () => {
  it("plate/image carry the restricted LTX class; the wan alt is open", () => {
    expect(endpointLicenseFor(PLATE, { engine: "ltx095" }).class).toBe("restricted");
    expect(endpointLicenseFor(IMG, { engine: "ltx095" }).class).toBe("restricted");
    expect(endpointLicenseFor(ALT, { structure: "depth" }).class).toBe("open");
    // ltx098's variant graph resolves open (placeholder ckpt - the weights
    // aren't named in the file); what holds it shut is the install gate, not
    // the badge - and the base class still dominates the endpoint
    expect(endpointLicenseFor(PLATE, { engine: "ltx098" }).class).toBe("restricted");
  });
});

describe("vfx probe + target routes", () => {
  it("probe: a clip returns render dims + estimates + hidden ltx098", async () => {
    const me = await makeUser("w3-vfx-probe");
    await stageRows(me.id);
    const r = await post(probePost, { video_url: clipUrl }, me.cookie);
    expect(r.status).toBe(200);
    const { probe } = await r.json();
    expect(probe.frames).toBe(48);
    expect(probe.render_width % 32).toBe(0);
    expect(probe.fps).toBe(24);
    expect(probe.ltx098).toBe(false);
    expect(probe.estimates.ltx095).toBeGreaterThan(0);
    // a real still probes on the image slot
    const rs = await post(probePost, { image_url: imgUrl }, me.cookie);
    expect(rs.status).toBe(200);
    const s = await rs.json();
    expect(s.probe.kind).toBe("image");
    expect(s.probe.width).toBe(640);
    // a clip on the image slot and a still on the video path → both 400
    const rc = await post(probePost, { image_url: clipUrl }, me.cookie);
    expect(rc.status).toBe(400);
    const rv = await post(probePost, { video_url: imgUrl }, me.cookie);
    expect(rv.status).toBe(400);
    expect((await rv.json()).error).toMatch(/single frame|not a readable video/);
  }, 60_000);

  it("target: refuses without instruction, makes a klein-edit job with one", async () => {
    const me = await makeUser("w3-vfx-tgt");
    await stageRows(me.id);
    const r0 = await post(targetPost, { image_url: imgUrl }, me.cookie);
    expect(r0.status).toBe(400);
    const r = await post(targetPost, { image_url: imgUrl, instruction: "cover it in frost" }, me.cookie);
    expect(r.status).toBe(201);
    const { job } = await r.json();
    const [row] = await sql<{ endpoint_id: string }>(`SELECT endpoint_id FROM jobs WHERE id = $1`, [job.id]);
    expect(row.endpoint_id).toBe("motionfield/flux2-klein/edit");
  }, 60_000);
});
