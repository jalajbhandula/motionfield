import crypto from "crypto";

/** Recursively sort object keys so equivalent payloads serialize identically
 *  regardless of the order keys were sent in. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 of the canonical request body - { endpoint, params } with sorted keys. */
export function hashJobRequest(endpoint: string, params: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ endpoint, params }), "utf8")
    .digest("hex");
}

/** True when a stored request hash provably differs from the incoming one.
 *  A missing stored hash can't be compared - caller treats it as match. */
export function hashMismatch(stored: string | null | undefined, incoming: string): boolean {
  return stored != null && stored !== incoming;
}

/** Idempotency-Key validity: 1-255 printable ASCII chars (0x20-0x7e). */
export function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 1 && key.length <= 255 && /^[\x20-\x7e]+$/.test(key);
}
