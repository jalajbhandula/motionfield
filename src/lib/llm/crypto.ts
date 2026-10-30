import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * At-rest encryption for per-user provider API keys (llm_provider_settings.
 * api_key_enc). AES-256-GCM with a data key derived via HKDF-SHA256 from
 * BETTER_AUTH_SECRET - the same root secret already required for auth, so no
 * new secret to manage. Output is base64(iv ‖ tag ‖ ciphertext); keys are
 * never returned to clients in plain text.
 */

const enc = new TextEncoder();

function dataKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("BETTER_AUTH_SECRET (>=16 chars) is required to store LLM provider keys");
  }
  return Buffer.from(
    hkdfSync("sha256", secret, "motionfield-llm-keys", "llm-provider-key", 32),
  );
}

/** The GCM additional-authenticated-data a provider key is bound to: a row
 *  encrypted for one user or provider can never be replayed under another. */
export const keyAad = (userId: string, providerId: string) => `${userId}:${providerId}`;

export function encryptSecret(plain: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(packed: string, aad?: string): string {
  const buf = Buffer.from(packed, "base64");
  if (buf.length < 12 + 16) throw new Error("corrupt encrypted key");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), buf.subarray(0, 12));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(12, 28));
  // throws on tampered ciphertext/tag - GCM authentication
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
