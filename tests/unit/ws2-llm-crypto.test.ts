import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/llm/crypto";

/** AES-256-GCM round trips for stored provider keys (HKDF from BETTER_AUTH_SECRET). */

const SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = saved;
});

describe("llm key crypto", () => {
  it("encrypt → decrypt round trips", () => {
    const enc = encryptSecret("sk-test-abc123");
    expect(decryptSecret(enc)).toBe("sk-test-abc123");
  });

  it("ciphertext never contains the plaintext and differs per call (random IV)", () => {
    const a = encryptSecret("sk-test-abc123");
    const b = encryptSecret("sk-test-abc123");
    expect(a).not.toBe(b);
    for (const enc of [a, b]) {
      expect(enc).not.toContain("sk-test-abc123");
      expect(Buffer.from(enc, "base64").length).toBeGreaterThan(12 + 16);
    }
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const buf = Buffer.from(encryptSecret("sk-test-abc123"), "base64");
    buf[buf.length - 1] ^= 0x01;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const buf = Buffer.from(encryptSecret("sk-test-abc123"), "base64");
    buf[14] ^= 0x01;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("a different BETTER_AUTH_SECRET cannot decrypt", () => {
    const enc = encryptSecret("sk-test-abc123");
    process.env.BETTER_AUTH_SECRET = "different-secret-0123456789abcdef0123456789";
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("fails closed without a usable secret", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => encryptSecret("x")).toThrow(/BETTER_AUTH_SECRET/);
    process.env.BETTER_AUTH_SECRET = "short";
    expect(() => encryptSecret("x")).toThrow(/BETTER_AUTH_SECRET/);
  });
});
