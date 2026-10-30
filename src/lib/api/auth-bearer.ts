import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "./apikeys";
import { v1error } from "./v1";

export interface BearerAuth {
  /** owning user id */
  userId: string;
  /** api_keys row id (uuid) - stamped onto jobs.api_key_id */
  keyId: string;
  /** caller-set key label - surfaced by GET /api/v1/me */
  keyLabel: string;
  /** max live jobs allowed for this key */
  maxConcurrency: number;
  /** whether the key has a webhook signing secret configured */
  hasWebhookSecret: boolean;
}

/**
 * Parse `Authorization: Bearer of_...` and verify against api_keys.
 * Returns the auth context, or a ready 401 NextResponse with the v1 error shape.
 */
export async function requireBearer(req: NextRequest): Promise<BearerAuth | NextResponse> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) {
    return v1error("unauthorized", "missing or malformed Authorization header - expected 'Bearer <api key>'", 401);
  }
  const key = await verifyApiKey(match[1]);
  if (!key) return v1error("unauthorized", "invalid or revoked API key", 401);
  return { userId: key.userId, keyId: key.id, keyLabel: key.label, maxConcurrency: key.maxConcurrency, hasWebhookSecret: key.hasWebhookSecret };
}
