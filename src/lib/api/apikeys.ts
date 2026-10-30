import crypto from "crypto";
import { getDb, schema } from "@/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { encryptWebhookSecret, generateWebhookSecret } from "./webhooks";

/**
 * API keys - `of_<keyId>_<secret>`; only sha256(secret) is stored.
 * The full key is returned exactly once at creation.
 */

const KEY_PREFIX = "of_";
const KEY_ID_LENGTH = 12;
const SECRET_BYTES = 32;

export interface IssuedKey {
  /** api_keys row id (uuid) - referenced by jobs.api_key_id. */
  id: string;
  /** public id portion embedded in the token. */
  keyId: string;
  label: string;
  maxConcurrency: number;
  /** the full `of_...` token - shown once, never stored. */
  key: string;
  /** the `ofwh_…` webhook signing secret - shown once, stored encrypted. */
  webhookSecret: string;
}

/** Public id portion: 12 alphanumeric chars - no `_` so the token split is unambiguous. */
const KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateApiKey() {
  const bytes = crypto.randomBytes(KEY_ID_LENGTH);
  const keyId = Array.from(bytes, (b) => KEY_ID_ALPHABET[b % KEY_ID_ALPHABET.length]).join("");
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  return { keyId, secret, secretHash: sha256hex(secret) };
}

export function sha256hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  if (!token.startsWith(KEY_PREFIX)) return null;
  const rest = token.slice(KEY_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0) return null;
  const keyId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (keyId.length !== KEY_ID_LENGTH || !secret) return null;
  return { keyId, secret };
}

/** Constant-time compare of a candidate secret against a stored sha256 hex digest. */
export function secretMatches(secret: string, storedHashHex: string): boolean {
  const computed = Buffer.from(sha256hex(secret), "hex");
  const stored = Buffer.from(storedHashHex, "hex");
  return computed.length === stored.length && computed.length > 0 && crypto.timingSafeEqual(computed, stored);
}

export async function createApiKey(
  userId: string,
  label = "default",
  maxConcurrency?: number,
): Promise<IssuedKey> {
  const db = await getDb();
  const { keyId, secret, secretHash } = generateApiKey();
  const webhookSecret = generateWebhookSecret();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({ userId, keyId, secretHash, label })
    .returning();
  const limit = maxConcurrency != null && Number.isFinite(maxConcurrency)
    ? Math.max(1, Math.floor(maxConcurrency))
    : 2;
  await db.update(schema.apiKeysWs1)
    .set({ maxConcurrency: limit, webhookSecret: encryptWebhookSecret(webhookSecret, row.id) })
    .where(eq(schema.apiKeysWs1.id, row.id));
  return { id: row.id, keyId, label, maxConcurrency: limit, key: `${KEY_PREFIX}${keyId}_${secret}`, webhookSecret };
}

/** Replace a key's webhook signing secret; returns the new plaintext `ofwh_…`
 *  exactly once (stored AES-256-GCM). Only live, owner-owned keys rotate. */
export async function rotateWebhookSecret(userId: string, id: string): Promise<string | null> {
  const db = await getDb();
  const secret = generateWebhookSecret();
  const rows = await db.update(schema.apiKeysWs1)
    .set({ webhookSecret: encryptWebhookSecret(secret, id) })
    .where(and(
      eq(schema.apiKeysWs1.id, id),
      eq(schema.apiKeysWs1.userId, userId),
      isNull(schema.apiKeysWs1.revokedAt),
    ))
    .returning({ id: schema.apiKeysWs1.id });
  return rows.length ? secret : null;
}

export interface VerifiedKey {
  /** api_keys row id (uuid). */
  id: string;
  userId: string;
  keyId: string;
  label: string;
  maxConcurrency: number;
  /** whether a webhook signing secret is stored for this key */
  hasWebhookSecret: boolean;
}

/** Look up a presented token; returns the key row on success, null otherwise.
 *  last_used_at is written at most once per minute per key. */
export async function verifyApiKey(token: string): Promise<VerifiedKey | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.apiKeysWs1)
    .where(eq(schema.apiKeysWs1.keyId, parsed.keyId)).limit(1);
  if (!row || row.revokedAt) return null;
  if (!secretMatches(parsed.secret, row.secretHash)) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.apiKeysWs1)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeysWs1.id, row.id))
      .catch(() => {});
  }
  return {
    id: row.id,
    userId: row.userId,
    keyId: row.keyId,
    label: row.label,
    maxConcurrency: row.maxConcurrency ?? 2,
    hasWebhookSecret: row.webhookSecret != null,
  };
}

export async function revokeApiKey(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.update(schema.apiKeysWs1)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(schema.apiKeysWs1.id, id),
      eq(schema.apiKeysWs1.userId, userId),
      isNull(schema.apiKeysWs1.revokedAt),
    ))
    .returning({ id: schema.apiKeysWs1.id });
  return rows.length > 0;
}

export interface ApiKeyListItem {
  id: string;
  keyId: string;
  label: string;
  maxConcurrency: number;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listApiKeys(userId: string): Promise<ApiKeyListItem[]> {
  const db = await getDb();
  const rows = await db.select({
    id: schema.apiKeysWs1.id,
    keyId: schema.apiKeysWs1.keyId,
    label: schema.apiKeysWs1.label,
    maxConcurrency: schema.apiKeysWs1.maxConcurrency,
    createdAt: schema.apiKeysWs1.createdAt,
    lastUsedAt: schema.apiKeysWs1.lastUsedAt,
    revokedAt: schema.apiKeysWs1.revokedAt,
  })
    .from(schema.apiKeysWs1)
    .where(eq(schema.apiKeysWs1.userId, userId))
    .orderBy(desc(schema.apiKeysWs1.createdAt));
  return rows;
}
