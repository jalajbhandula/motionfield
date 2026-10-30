import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { NextRequest } from "next/server";
import { sql } from "@/db";
import { createApiKey } from "@/lib/api/apikeys";
import { GET as refsGET, POST as refsPOST } from "@/app/api/v1/refs/route";
import { GET as refGET } from "@/app/api/v1/refs/[name]/route";

/**
 * /api/v1/refs security set - owner scoping is the whole contract:
 * a ref image must be one of the caller's own /files urls (external → 400,
 * another user's → 404 with no existence leak), person/character refs need
 * likeness_consent:true, duplicates are 409, and no route ever reads or
 * writes across the (user_id, name) boundary.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const USER = "u-refs-v1";
const OTHER = "u-refs-v1b";
let apiKey: string;
let otherKey: string;
let mineUrl = "";
let theirsUrl = "";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

/** every file the suite writes - removed in afterAll so `npm test` never
 *  leaves uploads behind in the worktree */
const written: string[] = [];

/** a real file + an uploads row → resolveOwnedMedia answers for its owner */
async function ownedUpload(user: string): Promise<string> {
  const name = `${crypto.randomUUID()}.png`;
  const url = `/files/uploads/${name}`;
  const dir = path.join(process.cwd(), "public", "files", "uploads");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, name);
  writeFileSync(fp, PNG);
  written.push(fp);
  await sql(
    `INSERT INTO uploads (id, user_id, url, mime, bytes, name) VALUES ($1,$2,$3,'image/png',$4,$5)`,
    [crypto.randomUUID(), user, url, PNG.length, name]);
  return url;
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-refs-v1-0123456789abcdef0123456789ab";
  delete process.env.MOTIONFIELD_HOSTED;
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-refs-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
  for (const u of [USER, OTHER]) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)
               ON CONFLICT (id) DO NOTHING`, [u, u, `${u}@test.dev`]);
    await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 25)
               ON CONFLICT (user_id) DO NOTHING`, [u]);
  }
  apiKey = (await createApiKey(USER, "refs-v1")).key;
  otherKey = (await createApiKey(OTHER, "refs-v1-other")).key;
  mineUrl = await ownedUpload(USER);
  theirsUrl = await ownedUpload(OTHER);
});

afterAll(() => {
  for (const fp of written) rmSync(fp, { force: true });
});

const req = (path: string, key = apiKey) =>
  new NextRequest(`http://localhost${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

const post = (payload: unknown, key = apiKey) =>
  new NextRequest("http://localhost/api/v1/refs", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

describe("/api/v1/refs - auth + owner scoping", () => {
  it("401 without a bearer key on list, get and create", async () => {
    expect((await refsGET(req("/api/v1/refs", ""))).status).toBe(401);
    expect((await refGET(req("/api/v1/refs/x", ""),
      { params: Promise.resolve({ name: "x" }) })).status).toBe(401);
    expect((await refsPOST(new NextRequest("http://localhost/api/v1/refs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", images: [mineUrl] }),
    }))).status).toBe(401);
  });

  it("create → slugified name, get/list see only the caller's refs", async () => {
    const made = await refsPOST(post({
      name: "Hero Shot!", kind: "prop", category: "prop",
      images: [mineUrl], description: "the product still",
    }));
    expect(made.status, await made.clone().text()).toBe(201);
    const { ref } = await made.json() as { ref: { name: string; images: string[] } };
    expect(ref.name).toBe("hero-shot");
    expect(ref.images).toEqual([mineUrl]);

    const one = await refGET(req("/api/v1/refs/hero-shot"),
      { params: Promise.resolve({ name: "hero-shot" }) });
    expect(one.status).toBe(200);

    // the other user: their list is empty, their get is 404 - no existence leak
    const theirs = await refsGET(req("/api/v1/refs", otherKey));
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { refs: unknown[] }).refs).toEqual([]);
    const stolen = await refGET(req("/api/v1/refs/hero-shot", otherKey),
      { params: Promise.resolve({ name: "hero-shot" }) });
    expect(stolen.status).toBe(404);

    const missing = await refGET(req("/api/v1/refs/nope"),
      { params: Promise.resolve({ name: "nope" }) });
    expect(missing.status).toBe(404);
  });

  it("duplicate (user, name) is a 409 - the other user's same name is free", async () => {
    const dup = await refsPOST(post({
      name: "hero-shot", kind: "prop", category: "prop", images: [mineUrl],
    }));
    expect(dup.status).toBe(409);
    const other = await refsPOST(post({
      name: "hero-shot", kind: "prop", category: "prop", images: [theirsUrl],
    }, otherKey));
    expect(other.status, await other.text()).toBe(201);
  });

  it("person/character refs need likeness_consent:true; props don't", async () => {
    for (const body of [
      { name: "p1", kind: "person", category: "prop", images: [mineUrl] },
      { name: "p2", kind: "prop", category: "character", images: [mineUrl] },
      { name: "p3", images: [mineUrl] }, // category defaults to character
      { name: "p4", kind: "person", images: [mineUrl], likeness_consent: false },
    ]) {
      const res = await refsPOST(post(body));
      expect(res.status, `${JSON.stringify(body)} → ${await res.clone().text()}`).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message)
        .toContain("likeness consent");
    }
    const okPerson = await refsPOST(post({
      name: "p5", kind: "person", images: [mineUrl], likeness_consent: true,
    }));
    expect(okPerson.status, await okPerson.text()).toBe(201);
    const okProp = await refsPOST(post({
      name: "p6", kind: "prop", category: "prop", images: [mineUrl],
    }));
    expect(okProp.status, await okProp.text()).toBe(201);
  });

  it("external urls are 400 and another user's /files url is 404", async () => {
    const ext = await refsPOST(post({
      name: "ext", kind: "prop", category: "prop", images: ["https://evil.example/x.png"],
    }));
    expect(ext.status).toBe(400);
    const stolen = await refsPOST(post({
      name: "stolen", kind: "prop", category: "prop", images: [theirsUrl],
    }));
    expect(stolen.status, await stolen.text()).toBe(404);
    const gone = await refsPOST(post({
      name: "gone", kind: "prop", category: "prop", images: [`/files/uploads/${crypto.randomUUID()}.png`],
    }));
    expect(gone.status).toBe(404);
  });

  it("?category narrows and a bad value is a 400", async () => {
    const props = await refsGET(req("/api/v1/refs?category=prop"));
    expect(props.status).toBe(200);
    const list = ((await props.json()) as { refs: { category: string }[] }).refs;
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) expect(r.category).toBe("prop");
    const bad = await refsGET(req("/api/v1/refs?category=nope"));
    expect(bad.status).toBe(400);
  });
});
