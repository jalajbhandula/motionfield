/**
 * hasCurrentOptIn / assertLicenseAllowed - the stored opt-in row must match the
 * CURRENT LICENSE_VERSION; a stale version is treated as not opted in. @/db is
 * mocked: the chain select().from().where().limit() resolves to `row`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let row: { version: string }[] = [];
vi.mock("@/db", () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => row }) }) }),
  }),
  schema: { licenseOptins: { userId: {} } },
}));

import { hasCurrentOptIn, assertLicenseAllowed, RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { LICENSE_VERSION } from "@/lib/catalog/licenses";
import type { WorkflowDef } from "@/lib/catalog/types";

const restrictedWf: WorkflowDef = {
  id: "x", label: "X", endpointId: "motionfield/x/restricted", kind: "video", params: [], cost: () => 0,
  providers: { comfy: { workflow: "ltx-txt2video.json" } },
};
const openWf: WorkflowDef = {
  id: "y", label: "Y", endpointId: "motionfield/y/open", kind: "image", params: [], cost: () => 0,
  providers: { comfy: { workflow: "zimage-txt2img.json" } },
};
// a permissive-terms endpoint - allowed without opt-in, its notice surfaces
const termsWf: WorkflowDef = {
  id: "z", label: "Z", endpointId: "motionfield/z/terms", kind: "video", params: [], cost: () => 0,
  providers: {},
  license: {
    class: "permissive-terms",
    components: [{ name: "CMU mocap clips", license: "free to use with credit notice", url: "http://mocap.cs.cmu.edu/", class: "permissive-terms", notice: "credit CMU Graphics Lab" }],
  },
};

beforeEach(() => { row = []; });

describe("hasCurrentOptIn", () => {
  it("false with no row", async () => {
    expect(await hasCurrentOptIn("u")).toBe(false);
  });
  it("true only at the current LICENSE_VERSION", async () => {
    row = [{ version: LICENSE_VERSION }];
    expect(await hasCurrentOptIn("u")).toBe(true);
  });
  it("false on a stale version", async () => {
    row = [{ version: "of-licenses-v0" }];
    expect(await hasCurrentOptIn("u")).toBe(false);
  });
});

describe("assertLicenseAllowed", () => {
  it("open endpoints never consult the opt-in row", async () => {
    row = [];
    await expect(assertLicenseAllowed(openWf, "u")).resolves.toBeUndefined();
  });
  it("a permissive-terms endpoint passes without opt-in", async () => {
    row = [];
    await expect(assertLicenseAllowed(termsWf, "u")).resolves.toBeUndefined();
  });
  it("restricted endpoints throw without a current opt-in", async () => {
    row = [];
    await expect(assertLicenseAllowed(restrictedWf, "u")).rejects.toBeInstanceOf(RestrictedLicenseError);
    row = [{ version: "of-licenses-v0" }];
    await expect(assertLicenseAllowed(restrictedWf, "u")).rejects.toBeInstanceOf(RestrictedLicenseError);
    row = [{ version: LICENSE_VERSION }];
    await expect(assertLicenseAllowed(restrictedWf, "u")).resolves.toBeUndefined();
  });
});
