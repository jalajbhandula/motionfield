import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { createApiKey, listApiKeys } from "@/lib/api/apikeys";
import { ts } from "@/lib/api/v1";

export const runtime = "nodejs";

const CreateKey = z.object({
  label: z.string().trim().min(1).max(80).default("default"),
  max_concurrency: z.number().int().min(1).max(64).optional(),
});

/** POST { label?, max_concurrency? } - the full key and the webhook signing
 *  secret are returned ONCE here. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const parsed = CreateKey.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: "invalid body - expected { label?, max_concurrency? }" }, 400);
    const body = parsed.data;
    const issued = await createApiKey(user.id, body.label, body.max_concurrency);
    return json({
      id: issued.id,
      key_id: issued.keyId,
      label: issued.label,
      max_concurrency: issued.maxConcurrency,
      key: issued.key,
      webhook_secret: issued.webhookSecret,
    }, 201);
  } catch (e) {
    return err(e);
  }
}

/** GET - list the caller's keys. Secret hashes are never returned. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const rows = await listApiKeys(user.id);
    return json({
      keys: rows.map((k) => ({
        id: k.id,
        key_id: k.keyId,
        label: k.label,
        max_concurrency: k.maxConcurrency,
        created_at: ts(k.createdAt),
        last_used_at: ts(k.lastUsedAt),
        revoked_at: ts(k.revokedAt),
      })),
    });
  } catch (e) {
    return err(e);
  }
}
