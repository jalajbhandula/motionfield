import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET, POST } from "@/app/api/refs/route";
import { GET as ALIAS_GET, POST as ALIAS_POST } from "@/app/api/elements/route";
import { getAuth } from "@/lib/auth";
import { getDb, schema, sql } from "@/db";
import { saveCheckedUpload } from "@/lib/api/uploads";

/* Refs API - the renamed elements surface. Covers create/list shape, the
 * per-image ownership check, slug + 409 on dupes, and legacy category reads. */

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

async function makeUser(tag: string): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `${tag}-${randomUUID().slice(0, 8)}@ws4.test`, password: "password-1234", name: tag },
    returnHeaders: true,
  });
  const cookie = String(out.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("session_token");
  return { id: out.response.user.id, cookie };
}

/** A /files url the user actually owns - file on disk + uploads row. */
async function ownImage(userId: string): Promise<string> {
  const saved = await saveCheckedUpload(new File([PNG], "ref.png", { type: "image/png" }));
  const db = await getDb();
  await db.insert(schema.uploads).values({ userId, url: saved.url, mime: saved.mime, bytes: saved.bytes, name: "ref.png" });
  return saved.url;
}

const post = (cookie: string, body: unknown) =>
  POST(new NextRequest("http://localhost/api/refs", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }));
const get = (cookie: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/refs${qs}`, { headers: { cookie } }));

describe("refs api", () => {
  it("[OF-0020] creates a ref - slug name, kind, owned images; rejects other users' files", async () => {
    const me = await makeUser("refs-a");
    const them = await makeUser("refs-b");
    const mine = await ownImage(me.id);
    const theirs = await ownImage(them.id);

    const ok = await post(me.cookie, { name: "Hero Girl!", category: "character", kind: "person", images: [mine], likeness_consent: true });
    expect(ok.status).toBe(201);
    const { ref } = await ok.json();
    expect(ref.name).toBe("hero-girl");
    expect(ref.category).toBe("character");
    expect(ref.kind).toBe("person");
    expect(ref.images).toEqual([mine]);

    // these posts still need likeness_consent - default category 'character'
    // is a person-kind ref, so the consent gate fires before the checks
    // below would otherwise be reached

    // duplicate slug → 409
    const dup = await post(me.cookie, { name: "hero-girl", images: [mine], likeness_consent: true });
    expect(dup.status).toBe(409);

    // someone else's /files url → 404 (no existence leak)
    const stolen = await post(me.cookie, { name: "stolen", images: [theirs], likeness_consent: true });
    expect(stolen.status).toBe(404);

    // an external url → 400
    const ext = await post(me.cookie, { name: "ext", images: ["https://evil.example/x.png"], likeness_consent: true });
    expect(ext.status).toBe(400);

    // unauthenticated → 401
    const anon = await post("", { name: "anon", images: [mine] });
    expect(anon.status).toBe(401);
  }, 30_000);

  it("[OF-0021] lists refs with ?category= - legacy 'location' rows read as environment", async () => {
    const me = await makeUser("refs-c");
    const img = await ownImage(me.id);
    await post(me.cookie, { name: "prop-one", category: "prop", kind: "prop", images: [img] });
    // a row written before the rename still lives in the same table
    await sql(`INSERT INTO elements (user_id, name, category, kind, images) VALUES ($1, 'old-place', 'location', NULL, '[]'::jsonb)`, [me.id]);

    const all = await (await get(me.cookie)).json();
    expect(all.refs.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["prop-one", "old-place"]));
    expect(all.refs.find((r: { name: string }) => r.name === "old-place").category).toBe("environment");

    const env = await (await get(me.cookie, "?category=environment")).json();
    expect(env.refs.map((r: { name: string }) => r.name)).toEqual(["old-place"]);

    const prop = await (await get(me.cookie, "?category=prop")).json();
    expect(prop.refs.map((r: { name: string }) => r.name)).toEqual(["prop-one"]);
    expect(prop.refs[0].kind).toBe("prop");

    // an unknown category is a 400, not a silent fall-through
    const bad = await get(me.cookie, "?category=location2");
    expect(bad.status).toBe(400);

    // another user sees none of this
    const them = await makeUser("refs-d");
    const theirs = await (await get(them.cookie)).json();
    expect(theirs.refs).toEqual([]);
  }, 30_000);

  it("/api/elements is the same handlers - the internal alias", () => {
    expect(ALIAS_GET).toBe(GET);
    expect(ALIAS_POST).toBe(POST);
  });
});
