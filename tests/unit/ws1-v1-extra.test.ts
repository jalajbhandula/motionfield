import { describe, it, expect, vi, beforeAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { sql } from "@/db";
import { createApiKey } from "@/lib/api/apikeys";
import { GET as jobsGET } from "@/app/api/v1/jobs/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { GET as systemGET } from "@/app/api/v1/system/route";
import { GET as skillsGET } from "@/app/api/v1/skills/route";
import { GET as skillGET } from "@/app/api/v1/skills/[slug]/route";
import { GET as capsGET } from "@/app/api/v1/capabilities/route";

// PGlite setup can exceed the default 10s hook timeout on a busy machine.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const USER = "u-v1x";
const OTHER = "u-v1x2";
let apiKey: string;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  delete process.env.MOTIONFIELD_HOSTED;
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-v1x-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
  for (const u of [USER, OTHER]) {
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)
               ON CONFLICT (id) DO NOTHING`, [u, u, `${u}@test.dev`]);
    await sql(`INSERT INTO profiles (user_id, credits) VALUES ($1, 25)
               ON CONFLICT (user_id) DO NOTHING`, [u]);
  }
  apiKey = (await createApiKey(USER, "v1x-label")).key;
});

const req = (path: string, auth = true) =>
  new NextRequest(`http://localhost${path}`, {
    headers: auth ? { authorization: `Bearer ${apiKey}` } : {},
  });

async function insertJob(user: string, createdAt: string, status = "completed") {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO jobs (id, user_id, kind, model_id, endpoint_id, workflow, provider,
                       status, progress, cost_credits, created_at, updated_at)
     VALUES ($1,$2,'image','m','e','w','mock',$3,100,0,$4::timestamptz,$4::timestamptz)`,
    [id, user, status, createdAt]);
  return id;
}

describe("new v1 routes require Bearer", () => {
  it("me, system, jobs list, skills, skill detail, capabilities all 401 without a key", async () => {
    const responses = await Promise.all([
      meGET(req("/api/v1/me", false)),
      systemGET(req("/api/v1/system", false)),
      jobsGET(req("/api/v1/jobs", false)),
      skillsGET(req("/api/v1/skills", false)),
      skillGET(req("/api/v1/skills/x", false), { params: Promise.resolve({ slug: "x" }) }),
      capsGET(req("/api/v1/capabilities", false)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    }
  });
});

describe("[OF-0822] me / system / capabilities / skills", () => {
  it("me reports the user, plan, credits and key label - never the secret", async () => {
    const res = await meGET(req("/api/v1/me"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(USER);
    expect(body.email).toBe(`${USER}@test.dev`);
    expect(body.credits).toBe(25);
    expect(body.key.label).toBe("v1x-label");
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  it("system reads queue, gpu busy and disk from the db - never ComfyUI", async () => {
    const res = await systemGET(req("/api/v1/system"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.queue.queued).toBe("number");
    expect(typeof body.queue.in_progress).toBe("number");
    expect(typeof body.gpu.busy).toBe("boolean");
    expect(body.tier).toBe("local");
    expect(body.disk.free_gb === null || typeof body.disk.free_gb === "number").toBe(true);
  });

  it("capabilities returns the static registry", async () => {
    const res = await capsGET(req("/api/v1/capabilities"));
    expect(res.status).toBe(200);
    expect((await res.json()).capabilities).toEqual([
        "jobs", "jobs.list", "jobs.source", "runs", "skills.read", "system",
        "models", "estimate", "uploads", "assets", "presets", "refs", "stage",
        "threed",
      ]);
  });

  it("skills lists the catalog; a slug returns a generated SKILL.md", async () => {
    const list = await skillsGET(req("/api/v1/skills"));
    expect(list.status).toBe(200);
    const { skills } = await list.json();
    expect(skills.length).toBeGreaterThan(0);
    const slug = skills[0].slug;
    for (const s of skills) {
      expect(typeof s.slug).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
    }

    const detail = await skillGET(req(`/api/v1/skills/${slug}`), { params: Promise.resolve({ slug }) });
    expect(detail.status).toBe(200);
    const d = await detail.json();
    expect(d.slug).toBe(slug);
    expect(d.skill_md.startsWith("---")).toBe(true);
    expect(d.skill_md).toContain("Endpoints it calls");

    const missing = await skillGET(req("/api/v1/skills/nope"), { params: Promise.resolve({ slug: "nope" }) });
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/v1/jobs", () => {
  it("returns only the caller's jobs, newest first, cursor pages with no dupes or gaps - even on tied timestamps", async () => {
    // Postgres stores microseconds: four rows share .123456, bracketed by
    // .123001 and .123999 - a cursor truncated to ms would lose the tied rows
    const tLo = "2030-01-04T00:00:00.123001Z";
    const tMid = "2030-01-04T00:00:00.123456Z";
    const tHi = "2030-01-04T00:00:00.123999Z";
    const stamps = [tLo, tMid, tMid, tMid, tMid, tHi];
    const mine: string[] = [];
    for (let i = 0; i < stamps.length; i++)
      mine.push(await insertJob(USER, stamps[i], i === 5 ? "queued" : "completed"));
    const foreign = [await insertJob(OTHER, tHi), await insertJob(OTHER, tLo)];

    const created = new Map(mine.map((id, i) => [id, stamps[i]]));
    const expected = [...mine].sort((a, b) => {
      const [ta, tb] = [created.get(a)!, created.get(b)!];
      return tb.localeCompare(ta) || b.localeCompare(a);
    });

    const page = async (qs = "") => {
      const res = await jobsGET(req(`/api/v1/jobs${qs}`));
      expect(res.status).toBe(200);
      return res.json() as Promise<{ jobs: { id: string; status: string }[]; next_cursor: string | null }>;
    };

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const p = await page(`?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...p.jobs.map((j) => j.id));
      cursor = p.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected); // order + completeness, dupes would break equality
    for (const f of foreign) expect(seen).not.toContain(f);

    // status filter narrows to the queued job
    const filtered = await page("?status=queued");
    expect(filtered.jobs.map((j) => j.id)).toContain(mine[5]);
    expect(filtered.jobs.every((j) => j.status === "queued")).toBe(true);
  });

  it("rejects bad limit / status / before with 400", async () => {
    for (const qs of ["?limit=abc", "?limit=0", "?limit=101", "?status=bogus", "?before=!!!"]) {
      const res = await jobsGET(req(`/api/v1/jobs${qs}`));
      expect(res.status, qs).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });
});
