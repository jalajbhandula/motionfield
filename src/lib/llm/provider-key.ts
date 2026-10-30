import { decryptSecret, encryptSecret, keyAad } from "./crypto";

/**
 * Read a provider row's API key. Rows are sealed AES-256-GCM with AAD
 * `${userId}:${providerId}`; rows written before AAD (no associated data)
 * decrypt once with the legacy call and are immediately re-sealed under the
 * AAD - afterwards they only open under the right user+provider pair.
 */
export async function readProviderKey(row: {
  userId: string;
  providerId: string;
  apiKeyEnc: string | null;
}): Promise<string | undefined> {
  if (!row.apiKeyEnc) return undefined;
  const aad = keyAad(row.userId, row.providerId);
  try {
    return decryptSecret(row.apiKeyEnc, aad);
  } catch {
    // legacy no-AAD row - read once, then re-seal under the AAD
    const plain = decryptSecret(row.apiKeyEnc); // throws again when truly corrupt
    try {
      const { getDb, schema } = await import("@/db");
      const { and, eq } = await import("drizzle-orm");
      const db = await getDb();
      await db.update(schema.llmProviderSettings)
        .set({ apiKeyEnc: encryptSecret(plain, aad), updatedAt: new Date() })
        .where(and(
          eq(schema.llmProviderSettings.userId, row.userId),
          eq(schema.llmProviderSettings.providerId, row.providerId),
        ));
    } catch { /* the rewrite is best-effort - the read already succeeded */ }
    return plain;
  }
}
