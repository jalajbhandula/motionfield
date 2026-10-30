import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { desc, eq } from "drizzle-orm";
import { parseSceneSpec } from "@/lib/render/spec";
import { readCappedText } from "@/lib/render/body";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

const MAX_BODY = 256 * 1024;

/** POST /api/render/specs - validate + store a SceneSpec; returns { id }. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    let text: string;
    try {
      text = await readCappedText(req, MAX_BODY);
    } catch (e) {
      if (e instanceof JobError && e.status === 413) return json({ error: "body too large (max 256 KB)" }, 413);
      throw e;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const raw = (body as { spec?: unknown } | null)?.spec ?? body;
    if (!raw || typeof raw !== "object") return json({ error: "spec object required" }, 400);
    let spec;
    try {
      spec = parseSceneSpec(raw);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const db = await getDb();
    const [row] = await db.insert(schema.renderSpecs)
      .values({ userId: user.id, spec })
      .returning({ id: schema.renderSpecs.id });
    return json({ id: row.id }, 201);
  } catch (e) {
    return err(e);
  }
}

/** GET /api/render/specs - the signed-in user's own specs, newest 20. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    const rows = await db
      .select({ id: schema.renderSpecs.id, title: schema.renderSpecs.title, created_at: schema.renderSpecs.createdAt })
      .from(schema.renderSpecs)
      .where(eq(schema.renderSpecs.userId, user.id))
      .orderBy(desc(schema.renderSpecs.createdAt))
      .limit(20);
    return json({ specs: rows });
  } catch (e) {
    return err(e);
  }
}
