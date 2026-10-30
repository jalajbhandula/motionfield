import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { getDb, schema } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { llmConfigured } from "@/lib/llm/index";
import { filesPathSchema } from "@/lib/render/spec";
import { writerReady } from "@/lib/render/generate";
import { readCappedText } from "@/lib/render/body";
import { describeRefs } from "@/lib/stage/refs";
import { emptyScene, ASPECTS, assertSceneFits, type StageScene } from "@/lib/stage/scene";
import { writeStageScene } from "@/lib/stage/writer";
import { stageApiUser } from "@/lib/stage/api";
import { insertCreateRevision } from "@/lib/stage/revisions";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

const NEEDS_LLM_BODY = {
  error: "no LLM configured - add a model in Settings → Models & LLMs, or set LLM_PROVIDER/LLM_MODEL",
  code: "NEEDS_LLM",
};

const MAX_BODY = 64 * 1024;

const createSchema = z.strictObject({
  prompt: z.string().min(1).max(4000).optional(),
  refs: z.array(filesPathSchema).max(8).optional(),
  duration: z.number().min(1).max(60).optional(),
  aspect: z.enum(ASPECTS).optional(),
  fps: z.union([z.literal(24), z.literal(30)]).optional(),
  /** skip the writer entirely - an empty-ish starting scene */
  empty: z.literal(true).optional(),
});

/** GET /api/stage - the caller's scenes, newest first (≤100). */
export async function GET(req: NextRequest) {
  try {
    const { userId } = await stageApiUser(req);
    const db = await getDb();
    const rows = await db
      .select({
        id: schema.stageScenes.id,
        title: schema.stageScenes.title,
        revision: schema.stageScenes.revision,
        created_at: schema.stageScenes.createdAt,
        updated_at: schema.stageScenes.updatedAt,
      })
      .from(schema.stageScenes)
      .where(eq(schema.stageScenes.userId, userId))
      .orderBy(desc(schema.stageScenes.updatedAt))
      .limit(100);
    return json({ scenes: rows });
  } catch (e) {
    return err(e);
  }
}

/** Look up an owned upload/asset row by /files/… url (mime included when known). */
async function ownedRef(userId: string, url: string) {
  const db = await getDb();
  const [u] = await db.select({ url: schema.uploads.url, mime: schema.uploads.mime })
    .from(schema.uploads)
    .where(and(eq(schema.uploads.userId, userId), eq(schema.uploads.url, url)))
    .limit(1);
  if (u) return u;
  const [a] = await db.select({ url: schema.assets.url, mime: schema.assets.mime })
    .from(schema.assets)
    .where(and(eq(schema.assets.userId, userId), eq(schema.assets.url, url)))
    .limit(1);
  return a ?? null;
}

/**
 * POST /api/stage - create a scene.
 *   {empty:true} → an empty-ish starting scene (no LLM needed).
 *   {prompt, refs?, duration?, aspect?} → writer route → scene.
 * The writer gate fires before any DB/network work - a user with no writer
 * route gets 503 NEEDS_LLM, and the UI offers Empty scene instead.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await stageApiUser(req);

    let text: string;
    try {
      text = await readCappedText(req, MAX_BODY);
    } catch (e) {
      if (e instanceof JobError && e.status === 413) return json({ error: "body too large (max 64 KB)" }, 413);
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const body = createSchema.safeParse(raw);
    if (!body.success) return json({ error: body.error.issues[0]?.message ?? "bad body" }, 400);
    const { prompt, refs, duration, aspect, fps, empty } = body.data;

    if (empty) {
      const scene = emptyScene({ title: "Untitled scene", duration, aspect, fps });
      const db = await getDb();
      const [row] = await db.insert(schema.stageScenes)
        .values({ userId, title: scene.meta.title, scene, refs: [], refsRead: false })
        .returning({ id: schema.stageScenes.id, revision: schema.stageScenes.revision });
      await insertCreateRevision(row.id, userId, scene);
      return json({ id: row.id, revision: row.revision, scene, refs: [], refs_read: false }, 201);
    }

    if (!prompt) return json({ error: "prompt is required (or pass empty: true)" }, 400);

    // before any DB/network work: can this user's writer route even run?
    if (!(await writerReady(userId))) return json(NEEDS_LLM_BODY, 503);

    // refs must be the caller's own uploads/assets - another user's /files
    // url is a 404, never a peek
    const owned: { url: string; mime?: string | null }[] = [];
    for (const url of refs ?? []) {
      const row = await ownedRef(userId, url);
      if (!row) return json({ error: "ref not found" }, 404);
      owned.push(row);
    }

    const budget = AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]);

    // vision route describes the caller's image refs when one is configured
    let stageRefs: { url: string; description?: string }[] = owned.map((r) => ({ url: r.url }));
    const visionOn = await llmConfigured(userId, "vision").catch(() => false);
    // refs_read = a vision pass ran - persisted on the row so the editor's
    // "weren't read" note is driven by fact, not inferred descriptions
    let refsRead = false;
    if (visionOn && owned.length) {
      stageRefs = await describeRefs(owned, { userId, signal: budget });
      refsRead = true;
    }

    let scene: StageScene;
    try {
      scene = await writeStageScene(
        { prompt, duration, aspect, fps, refs: stageRefs },
        { userId, signal: budget },
      );
    } catch (e) {
      return json({ error: `scene writer failed: ${e instanceof Error ? e.message : e}` }, 502);
    }
    try {
      assertSceneFits(scene);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const db = await getDb();
    const [row] = await db.insert(schema.stageScenes)
      .values({ userId, title: scene.meta.title, scene, refs: stageRefs, refsRead })
      .returning({ id: schema.stageScenes.id, revision: schema.stageScenes.revision });
    await insertCreateRevision(row.id, userId, scene);
    return json({ id: row.id, revision: row.revision, scene, refs: stageRefs, refs_read: refsRead }, 201);
  } catch (e) {
    return err(e);
  }
}
