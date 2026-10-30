import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@/db";
import { v1err } from "@/lib/api/v1";
import { listV1Models } from "@/lib/api/models";
import { RestrictedLicenseError, endpointLicense, LICENSE_ENABLE_PATH } from "@/lib/catalog/license-gate";
import { ALL_MODELS } from "@/lib/catalog/video-models";
import { LICENSE_VERSION } from "@/lib/catalog/licenses";

/** Unused by these tests - mocked so importing jobs.ts never touches a provider. */
vi.mock("@/lib/generation", () => ({
  getProvider: () => {
    throw new Error("provider must not be used in models tests");
  },
}));

// PGlite setup + migrate can exceed the default 10s hook timeout under
// parallel-suite load - give it room.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-ws1-0123456789abcdef0123456789ab";
  process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "of-ws1-models-"));
  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], {
    env: { ...process.env }, stdio: "pipe",
  });
});

let seq = 0;
let userId = "";
beforeEach(async () => {
  seq++;
  userId = `u-models-${seq}`;
  await sql(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `${userId}@test.dev`]);
});

/** The restricted set, derived straight from the catalog + license map -
 *  independent ground truth for what listV1Models must hide. */
const restrictedIds = ALL_MODELS.flatMap((m) => m.workflows)
  .filter((w) => endpointLicense(w).class === "restricted")
  .map((w) => w.endpointId);
const openIds = ALL_MODELS.flatMap((m) => m.workflows)
  .filter((w) => endpointLicense(w).class === "open")
  .map((w) => w.endpointId);

describe("v1err license mapping", () => {
  it("maps RestrictedLicenseError to a structured 403", async () => {
    const res = v1err(new RestrictedLicenseError("Open RAIL-M"));
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error.code).toBe("restricted_license");
    expect(error.license).toBe("Open RAIL-M");
    expect(error.enable_at).toBe(LICENSE_ENABLE_PATH);
    expect(error.message).toContain("Open RAIL-M");
  });
});

describe("listV1Models", () => {
  it("hides every restricted endpoint without an opt-in row", async () => {
    // sanity: the catalog really does carry restricted endpoints today
    expect(restrictedIds).toContain("motionfield/ltx-video/text-to-video");
    expect(restrictedIds.length).toBeGreaterThan(0); // ReCut left the restricted set once it became a VACE recipe

    const models = await listV1Models(userId);
    const ids = models.map((m) => m.id);
    for (const id of restrictedIds) expect(ids, id).not.toContain(id);
    for (const id of openIds) expect(ids, id).toContain(id);
  });

  it("shows restricted endpoints once the user has an opt-in row", async () => {
    await sql(`INSERT INTO license_optins (user_id, version) VALUES ($1,$2)`, [userId, LICENSE_VERSION]);
    const models = await listV1Models(userId);
    const byId = new Map(models.map((m) => [m.id, m]));
    for (const id of restrictedIds) {
      const m = byId.get(id);
      expect(m, id).toBeTruthy();
      expect(m!.license.class).toBe("restricted");
      expect(m!.license.components.length).toBeGreaterThan(0);
      for (const c of m!.license.components) {
        expect(typeof c.name).toBe("string");
        expect(typeof c.license).toBe("string");
        expect(typeof c.url).toBe("string");
      }
    }
    // the opt-in only unhides - open endpoints are still all present
    for (const id of openIds) expect(byId.has(id), id).toBe(true);
  });

  it("carries license components and a credit estimate on every row", async () => {
    const models = await listV1Models(userId);
    const zimage = models.find((m) => m.id === "motionfield/z-image-turbo/text-to-image");
    expect(zimage).toBeTruthy();
    expect(zimage!.license.class).toBe("open");
    expect(zimage!.license.components.length).toBeGreaterThan(0);
    expect(zimage!.estimate.credits === null || typeof zimage!.estimate.credits === "number").toBe(true);
    expect(zimage!.inputs.type).toBe("object");
    expect(["local", "cloud"]).toContain(zimage!.tier);
  });

  it("estimates 0 credits for models that are unlimited on the caller's plan", async () => {
    // free user first: the same endpoint shows its computed cost
    const free = await listV1Models(userId);
    const wanFree = free.find((m) => m.id === "motionfield/wan-2.1/text-to-video");
    expect(wanFree).toBeTruthy();
    expect(wanFree!.estimate.credits).toBeGreaterThan(0);

    // 'pro' lists wan-2-1 as unlimited - the default-params estimate drops to 0
    await sql(`INSERT INTO profiles (user_id, plan_id) VALUES ($1,'pro')
               ON CONFLICT (user_id) DO UPDATE SET plan_id = 'pro'`, [userId]);
    const pro = await listV1Models(userId);
    const wanPro = pro.find((m) => m.id === "motionfield/wan-2.1/text-to-video");
    expect(wanPro).toBeTruthy();
    expect(wanPro!.estimate.credits).toBe(0);
    // a model not on the unlimited list keeps its computed estimate
    const z = pro.find((m) => m.id === "motionfield/z-image-turbo/text-to-image");
    expect(z!.estimate.credits).toBeGreaterThan(0);
  });
});
