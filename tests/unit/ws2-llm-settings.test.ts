/**
 * Step-3 settings layer: per-user provider rows (keys encrypted at rest,
 * bound to userId:providerId AAD; legacy ciphertexts upgraded on read),
 * task routes, prefs, URL validation and hosted-mode rules.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";

import {
  checkBaseUrl, deleteProviderRow, deleteTaskRoute, getPrefs, getProviderRow,
  listTaskRoutes, putProviderRow, putTaskRoute, setPrefs, userOffline,
  LlmHttpError, taskGuard,
} from "@/lib/llm/settings";
import { readProviderKey } from "@/lib/llm/provider-key";
import { decryptSecret, encryptSecret, keyAad } from "@/lib/llm/crypto";
import { resolveRoute } from "@/lib/llm/router";

beforeAll(() => {
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws2-settings-"));
  process.env.BETTER_AUTH_SECRET = "test-secret-ws2-0123456789abcdef0123456789ab";
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
}, 60_000);

const GUARDED_ENV = ["MOTIONFIELD_HOSTED", "MOTIONFIELD_OFFLINE", "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY"];
afterEach(() => { for (const k of GUARDED_ENV) delete process.env[k]; });

let n = 0;
const made = new Set<string>();
async function uid() {
  const id = `u-set-${++n}`;
  if (!made.has(id)) {
    made.add(id);
    await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true)`, [id, id, `${id}@test.dev`]);
  }
  return id;
}
const encOf = (u: string, providerId: string) =>
  sql<{ api_key_enc: string | null }>(
    `SELECT api_key_enc FROM llm_provider_settings WHERE user_id = $1 AND provider_id = $2`, [u, providerId]);

describe("provider rows", () => {
  it("stores keys encrypted and returns them via readProviderKey only", async () => {
    const u = await uid();
    const row = await putProviderRow(u, "custom", { apiKey: "sk-live-secret" });
    expect(row.hasKey).toBe(true);
    expect("key" in row).toBe(false);
    expect("apiKey" in row).toBe(false);
    expect("apiKeyEnc" in row).toBe(false);

    const raw = await encOf(u, "custom");
    expect(raw[0].api_key_enc).toBeTruthy();
    expect(raw[0].api_key_enc).not.toContain("sk-live-secret");

    // AAD-bound ciphertext: decrypting with the row's user:provider succeeds…
    expect(await readProviderKey({ userId: u, providerId: "custom", apiKeyEnc: raw[0].api_key_enc }))
      .toBe("sk-live-secret");
    // …and fails under any other binding - a stolen row can't be replayed
    expect(() => decryptSecret(raw[0].api_key_enc!, keyAad("other-user", "custom"))).toThrow();
    expect(() => decryptSecret(raw[0].api_key_enc!, keyAad(u, "lmstudio"))).toThrow();
  });

  it("upgrades pre-AAD ciphertexts on first read", async () => {
    const u = await uid();
    // simulate a row written before AAD existed
    const legacy = encryptSecret("sk-old");
    await sql(
      `INSERT INTO llm_provider_settings (user_id, provider_id, api_key_enc) VALUES ($1,'vllm',$2)`,
      [u, legacy]);
    const key = await readProviderKey({ userId: u, providerId: "vllm", apiKeyEnc: legacy });
    expect(key).toBe("sk-old");

    // the read rewrote the row AAD-bound - verify the new cipher shape
    const [after] = await encOf(u, "vllm");
    expect(after.api_key_enc).not.toBe(legacy);
    expect(decryptSecret(after.api_key_enc!, keyAad(u, "vllm"))).toBe("sk-old");
    expect(() => decryptSecret(after.api_key_enc!)).toThrow(); // no longer legacy-decryptable
  });

  it("base-url validation: https ok, http only on loopback, junk refused", async () => {
    expect(await checkBaseUrl("https://api.example.com/v1")).toBeNull();
    expect(await checkBaseUrl("http://127.0.0.1:1234/v1")).toBeNull();
    expect(await checkBaseUrl("ftp://x")).toMatch(/http or https/);
    expect(await checkBaseUrl("not a url")).toMatch(/invalid/);

    // saving a non-loopback https URL is allowed pre-hosted (it's the user's machine)
    const u = await uid();
    const row = await putProviderRow(u, "custom", { baseUrl: "https://proxy.example.com/v1" });
    expect(row.baseUrl).toBe("https://proxy.example.com/v1");
    await expect(putProviderRow(u, "custom", { baseUrl: "ht!tp://" })).rejects.toBeInstanceOf(LlmHttpError);
    await deleteProviderRow(u, "custom");
    expect(await getProviderRow(u, "custom")).toBeNull();
  });
});

describe("task routes", () => {
  it("round-trips provider+model and resolves through the router", async () => {
    const u = await uid();
    await putProviderRow(u, "custom", { apiKey: "k", baseUrl: "http://127.0.0.1:9/v1" });
    await putTaskRoute(u, "writer", { providerId: "custom", model: "my-model" });
    const routes = await listTaskRoutes(u);
    expect(routes.find((r) => r.task === "writer")).toMatchObject({ providerId: "custom", model: "my-model" });

    const r = await resolveRoute("writer", u);
    expect(r.providerId).toBe("custom");
    expect(r.model).toBe("my-model");
    expect(r.apiKey).toBe("k");
    expect(r.source).toBe("db");

    await deleteTaskRoute(u, "writer");
    expect((await listTaskRoutes(u)).find((r) => r.task === "writer")).toBeUndefined();
  });

  it("refuses unknown providers, a custom endpoint with no base URL, and capability mismatches", async () => {
    const u = await uid();
    await expect(putTaskRoute(u, "writer", { providerId: "nope", model: "m" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(putTaskRoute(u, "planner", { providerId: "custom", model: "m" }))
      .rejects.toMatchObject({ status: 400 });
    expect(taskGuard("planner", { tools: false, vision: false, jsonSchema: false })).toMatch(/tool/);
    expect(taskGuard("vision", { tools: true, vision: false, jsonSchema: true })).toMatch(/image/);
    expect(taskGuard("writer", { tools: false, vision: false, jsonSchema: false })).toBeNull();
  });
});

describe("prefs", () => {
  it("persists the offline toggle per user and honors the env lock", async () => {
    const u = await uid();
    expect(await getPrefs(u)).toEqual({ offline: false, locked: false, searxngUrl: null });
    expect(await setPrefs(u, true)).toEqual({ offline: true, locked: false });
    expect(await userOffline(u)).toBe(true);
    expect(await userOffline(await uid())).toBe(false);

    process.env.MOTIONFIELD_OFFLINE = "1";
    expect(await getPrefs(u)).toEqual({ offline: true, locked: true, searxngUrl: null });
    await expect(setPrefs(u, false)).rejects.toMatchObject({ status: 409 });
    delete process.env.MOTIONFIELD_OFFLINE;
  });
});

describe("hosted rules", () => {
  it("refuses local providers and non-https user URLs", async () => {
    process.env.MOTIONFIELD_HOSTED = "1";
    const u = await uid();
    await expect(putProviderRow(u, "ollama", {})).rejects.toMatchObject({ status: 403 });
    await expect(putProviderRow(u, "custom", { baseUrl: "http://127.0.0.1:1234/v1" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(putProviderRow(u, "custom", { baseUrl: "http://api.example.com" }))
      .rejects.toMatchObject({ status: 400 });
    // hosted refuses unresolvable hosts too - the check fails closed
    expect(await checkBaseUrl("https://api.example.com/v1",
      async () => [{ address: "10.1.2.3", family: 4 }])).toMatch(/not allowed/);
    // a stub lookup that resolves public lets an https URL through
    const publicDns = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
    expect(await checkBaseUrl("https://api.example.com/v1", publicDns)).toBeNull();
  });
});
