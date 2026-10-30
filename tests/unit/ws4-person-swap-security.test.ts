import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POST as personSwapPost } from "@/app/api/person-swap/route";
import { getAuth } from "@/lib/auth";
import { sql } from "@/db";
import { PERSON_SWAP_ENDPOINT } from "@/lib/generation/recipes/person-swap";

/* PersonSwap batch-hold security: units that don't fit the caller's free slots
 * are held as charged queued rows that never pass through createJob - so the
 * route must run the workflow's own gates (likeness consent, refs) before a
 * single held row exists. A consentless POST while a live job occupies the
 * user's only slot must 400 and leave zero held rows. */

const filesRoot = resolve(process.cwd(), "public", "files", "uploads");
const tag = `w4dsec-${randomUUID().slice(0, 8)}`;
const clipUrl = `/files/uploads/${tag}.mp4`;
const refUrl = `/files/uploads/${tag}.png`;
const clipFile = join(filesRoot, `${tag}.mp4`);
const refFile = join(filesRoot, `${tag}.png`);

async function makeUser(t: string): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `${t}-${randomUUID().slice(0, 8)}@ws4.test`, password: "password-1234", name: t },
    returnHeaders: true,
  });
  const cookie = String(out.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("session_token");
  return { id: out.response.user.id, cookie };
}

function stageMedia() {
  mkdirSync(filesRoot, { recursive: true });
  // 1.2 s synthetic clip (color + tone) - long enough to pass PERSON_SWAP_MIN_S
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=navy:size=64x36:rate=8:duration=1.2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=1.2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipFile,
  ]);
  // 1×1 png for the identity ref
  writeFileSync(refFile, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]));
}

afterAll(() => {
  for (const f of [clipFile, refFile]) if (existsSync(f)) rmSync(f, { force: true });
});

describe("person-swap held-batch gates", () => {
  it("a user with a live job POSTing without consent → 400 and no held row", async () => {
    const me = await makeUser("ws4-person-swap-held");
    stageMedia();
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 1024, $3)
               ON CONFLICT DO NOTHING`, [me.id, clipUrl, `${tag}.mp4`]);
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [me.id, refUrl, `${tag}.png`]);

    // occupy the free plan's one video slot - every unit would be HELD
    await sql(`INSERT INTO jobs (user_id, kind, model_id, endpoint_id, workflow, provider,
                                 provider_request_id, status)
               VALUES ($1, 'video', 'wan-2.1', 'motionfield/wan-2.1/text-to-video', 'text-to-video',
                       'mock', $2, 'in_progress')`,
      [me.id, `mock-blocker-${randomUUID().slice(0, 8)}`]);

    const r = await personSwapPost(new NextRequest("http://localhost/api/person-swap", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify({
        video_url: clipUrl, mode: "person", image_urls: [refUrl],
        // no likeness_consent - the held path must gate like createJob
      }),
    }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    // nothing was created - no submitted job, no held row, no charge
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND endpoint_id = $2`,
      [me.id, PERSON_SWAP_ENDPOINT]);
    expect(n).toBe(0);
  }, 60_000);

  it("a held row without consent in stored params fails+refunds on release", async () => {
    const me = await makeUser("ws4-person-swap-rel");
    stageMedia();
    // a pre-gate held row: queued, charged, no provider id, consent absent
    await sql(
      `INSERT INTO jobs (user_id, kind, model_id, endpoint_id, workflow, provider,
                         provider_meta, status, cost_credits, params)
       VALUES ($1, 'v2v', 'person-swap', $2, 'swap', 'recipe', '{}'::jsonb, 'queued', 35, $3::jsonb)`,
      [me.id, PERSON_SWAP_ENDPOINT, JSON.stringify({
        video_url: clipUrl, mode: "person", image_urls: [refUrl],
        likeness_consent: false, windows: 1, lip_sync: false, resolution: "480p",
      })]);
    const before = (await sql<{ credits: string }>(
      `SELECT credits::text FROM profiles WHERE user_id = $1`, [me.id]))[0];

    const { releasePersonSwapHolds } = await import("@/lib/generation/recipes/person-swap");
    await releasePersonSwapHolds(me.id);

    const rows = await sql<{ status: string; error: string | null; provider_request_id: string | null }>(
      `SELECT status, error, provider_request_id FROM jobs WHERE user_id = $1 AND endpoint_id = $2`,
      [me.id, PERSON_SWAP_ENDPOINT]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("likeness consent required");
    expect(rows[0].provider_request_id).toBeNull();
    const after = (await sql<{ credits: string }>(
      `SELECT credits::text FROM profiles WHERE user_id = $1`, [me.id]))[0];
    expect(Number(after.credits) - Number(before.credits)).toBe(35);
  }, 60_000);
});

/* PersonSwap Quick hard gates - the short path is the same endpoint, so every
 * safety surface the full path has applies identically: consent first,
 * foreign media 404s, and a gallery id is resolved server-side only (a
 * client-supplied path or unknown id is a 400, never a file read). */
describe("person-swap quick gates", () => {
  const post = (cookie: string, body: Record<string, unknown>) =>
    personSwapPost(new NextRequest("http://localhost/api/person-swap", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }));

  it("quick without likeness consent → 400", async () => {
    const me = await makeUser("ws4-quick-noconsent");
    stageMedia();
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 1024, $3)
               ON CONFLICT DO NOTHING`, [me.id, clipUrl, `${tag}.mp4`]);
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [me.id, refUrl, `${tag}.png`]);
    const r = await post(me.cookie, {
      quick: true, video_url: clipUrl, image_urls: [refUrl],
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND endpoint_id = $2`,
      [me.id, PERSON_SWAP_ENDPOINT]);
    expect(n).toBe(0);
  }, 60_000);

  it("quick with another user's /files media → 404", async () => {
    const owner = await makeUser("ws4-quick-owner");
    const me = await makeUser("ws4-quick-foreign");
    stageMedia();
    // the clip + ref belong to OWNER - as me they must 404, never probe
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'video/mp4', 1024, $3)
               ON CONFLICT DO NOTHING`, [owner.id, clipUrl, `${tag}.mp4`]);
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [owner.id, refUrl, `${tag}.png`]);
    const r = await post(me.cookie, {
      quick: true, video_url: clipUrl, image_urls: [refUrl], likeness_consent: true,
    });
    expect(r.status).toBe(404);
  }, 60_000);

  it("quick with a path-shaped or unknown gallery_id → 400, no file read", async () => {
    const me = await makeUser("ws4-quick-gal");
    stageMedia();
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [me.id, refUrl, `${tag}.png`]);
    for (const bad of ["../../etc/passwd", "../manifest.json", "no-such-clip-xyz"]) {
      const r = await post(me.cookie, {
        quick: true, gallery_id: bad, image_urls: [refUrl], likeness_consent: true,
      });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain("unknown gallery clip");
    }
  }, 60_000);
});
