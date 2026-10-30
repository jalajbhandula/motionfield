import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { LICENSE_VERSION } from "@/lib/catalog/licenses";

export const runtime = "nodejs";

const Body = z.strictObject({ confirm: z.literal(true).optional() });

function shape(row: { version: string } | undefined) {
  return {
    opted_in: row?.version === LICENSE_VERSION,
    version: row?.version ?? null,
    current_version: LICENSE_VERSION,
  };
}

async function optinRow(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.licenseOptins)
    .where(eq(schema.licenseOptins.userId, userId)).limit(1);
  return row;
}

/** GET → { opted_in, version, current_version } for the session user. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    return json(shape(await optinRow(user.id)));
  } catch (e) {
    return err(e);
  }
}

/** Record the caller's acceptance of restricted-weight license terms
 *  (e.g. LTX-Video Open RAIL-M). Body is empty or { confirm: true } - the
 *  server always stores its own LICENSE_VERSION; the gate honors a row only
 *  while row.version === LICENSE_VERSION. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const raw = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw ?? {});
    if (!parsed.success) return json({ error: "invalid body - send {} or {\"confirm\": true}" }, 400);
    const db = await getDb();
    await db.insert(schema.licenseOptins)
      .values({ userId: user.id, version: LICENSE_VERSION })
      .onConflictDoUpdate({ target: schema.licenseOptins.userId, set: { version: LICENSE_VERSION, acceptedAt: new Date() } });
    return json({ ok: true, ...shape({ version: LICENSE_VERSION }) });
  } catch (e) {
    return err(e);
  }
}

/** Revoke the caller's opt-in. */
export async function DELETE(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const db = await getDb();
    await db.delete(schema.licenseOptins).where(eq(schema.licenseOptins.userId, user.id));
    return json({ ok: true, opted_in: false, current_version: LICENSE_VERSION });
  } catch (e) {
    return err(e);
  }
}
