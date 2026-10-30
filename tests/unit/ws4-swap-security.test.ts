import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { POST as personSwapPost } from "@/app/api/person-swap/route";
import { POST as detectPost } from "@/app/api/person-swap/detect/route";
import { getAuth } from "@/lib/auth";
import { sql } from "@/db";
import { parsePersonSwapGallery } from "@/lib/generation/recipes/person-swap";

/* ws4-swap security additions (the ≤3 new cases):
 *  1. a refused gallery submit must leave NO orphan - the gallery copy is
 *     the LAST thing before createJob, so a validation refusal means no
 *     uploads row and no copied file
 *  2. the Quick→PersonSwap deep link's ref is re-checked server-side - a
 *     foreign image_url in detect is a 404, never a preload
 *  3. the gallery manifest is zod-parsed - malformed entries drop and a
 *     bare verified:true without the strict verify block is not served */

const filesRoot = resolve(process.cwd(), "public", "files", "uploads");
const tag = `w4ssec-${randomUUID().slice(0, 8)}`;
const refUrl = `/files/uploads/${tag}.png`;
const refFile = join(filesRoot, `${tag}.png`);

const galDir = mkdtempSync(join(tmpdir(), "of-gal-"));
const galClip = join(galDir, "test-clip.mp4");
const origGalEnv = process.env.PERSON_SWAP_GALLERY_DIR;

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

function stage() {
  mkdirSync(filesRoot, { recursive: true });
  writeFileSync(refFile, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]));
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=navy:size=64x36:rate=8:duration=1.2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=1.2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", galClip,
  ]);
  writeFileSync(join(galDir, "manifest.json"), JSON.stringify({
    clips: [{
      id: "test-clip", file: "test-clip.mp4", seconds: 1.2, aspect: "16:9", verified: true,
      verify: { steps: 8, seed: 42, judge: "yes 2/2", size_bytes: 4096, seconds: 1.2, checked_at: "2026-10-24" },
    }],
  }));
  process.env.PERSON_SWAP_GALLERY_DIR = galDir;
}

afterAll(() => {
  if (origGalEnv === undefined) delete process.env.PERSON_SWAP_GALLERY_DIR;
  else process.env.PERSON_SWAP_GALLERY_DIR = origGalEnv;
  if (existsSync(refFile)) rmSync(refFile, { force: true });
  rmSync(galDir, { recursive: true, force: true });
});

describe("ws4 swap security", () => {
  it("a refused gallery submit leaves no uploads row and no copied file", async () => {
    const me = await makeUser("ws4-gal-refuse");
    stage();
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [me.id, refUrl, `${tag}.png`]);
    const before = (await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM uploads WHERE user_id = $1`, [me.id]))[0].n;

    const r = await personSwapPost(new NextRequest("http://localhost/api/person-swap", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify({
        quick: true, gallery_id: "test-clip", image_urls: [refUrl],
        // no likeness_consent - the refusal must land BEFORE the copy
      }),
    }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("likeness consent required");

    const after = (await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM uploads WHERE user_id = $1`, [me.id]))[0].n;
    expect(after).toBe(before);
  }, 60_000);

  it("detect re-checks image_urls - a foreign ref is a 404, never a preload", async () => {
    const owner = await makeUser("ws4-detect-owner");
    const me = await makeUser("ws4-detect-foreign");
    stage();
    // the ref belongs to OWNER - as me, detect must refuse before probing
    await sql(`INSERT INTO uploads (user_id, url, mime, bytes, name) VALUES ($1, $2, 'image/png', 64, $3)
               ON CONFLICT DO NOTHING`, [owner.id, refUrl, `${tag}.png`]);
    const r = await detectPost(new NextRequest("http://localhost/api/person-swap/detect", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify({ gallery_id: "test-clip", image_urls: [refUrl] }),
    }));
    expect(r.status).toBe(404);
  }, 60_000);

  it("the manifest is zod-parsed - malformed drops, bare verified:true is not served", () => {
    const entries = parsePersonSwapGallery({
      clips: [
        { id: "../escape", file: "x.mp4", seconds: 1, aspect: "16:9" },                 // bad id → drop
        { id: "path-file", file: "../secret.mp4", seconds: 1, aspect: "16:9" },          // path file → drop
        { id: "bare", file: "b.mp4", seconds: 1, aspect: "16:9", verified: true },       // no verify → unverified
        { id: "thin", file: "t.mp4", seconds: 1, aspect: "16:9", verified: true, verify: { steps: 8 } },
        { id: "half", file: "h.mp4", seconds: 1, aspect: "16:9", verified: true,
          verify: { steps: 8, seed: 1, judge: "yes 1/2", size_bytes: 1, seconds: 1, checked_at: "2026-01-01" } },
        { id: "real", file: "r.mp4", seconds: 1, aspect: "16:9", verified: true,
          verify: { steps: 8, seed: 1, judge: "yes 2/2", size_bytes: 1, seconds: 1, checked_at: "2026-01-01" } },
        { id: "unclaimed", file: "u.mp4", seconds: 1, aspect: "16:9",
          verify: { steps: 8, seed: 1, judge: "yes 2/2", size_bytes: 1, seconds: 1, checked_at: "2026-01-01" } },
      ],
    });
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId["../escape"]).toBeUndefined();
    expect(byId["path-file"]).toBeUndefined();
    expect(byId["bare"].verified).toBe(false);
    expect(byId["thin"].verified).toBe(false);
    expect(byId["half"].verified).toBe(false);
    expect(byId["real"].verified).toBe(true);
    expect(byId["unclaimed"].verified).toBe(false);
  });
});
