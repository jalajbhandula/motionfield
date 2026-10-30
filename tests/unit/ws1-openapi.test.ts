import { describe, it, expect } from "vitest";
import { buildOpenApi } from "@/lib/api/openapi";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { ALL_MODELS } from "@/lib/catalog/video-models";

describe("openapi document", () => {
  const doc = buildOpenApi() as any;

  it("is OpenAPI 3.1.x", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it("POST /jobs accepts exactly the catalog's open endpoints", () => {
    const oneOf = doc.paths["/api/v1/jobs"].post.requestBody.content["application/json"].schema.oneOf;
    const consts = oneOf.map((s: any) => s.properties.endpoint.const).sort();
    // ground truth computed straight from the catalog - never via the
    // function under test (openEndpoints)
    const expected = ALL_MODELS.flatMap((m) => m.workflows)
      .filter((w) => endpointLicense(w).class === "open")
      .map((w) => w.endpointId)
      .sort();
    expect(consts).toEqual(expected);
    expect(consts.length).toBeGreaterThan(0);
    // each variant carries the endpoint's real param schema
    for (const s of oneOf) {
      expect(s.properties.params.type).toBe("object");
      expect(s.properties.endpoint.const).toMatch(/^motionfield\//);
    }
  });

  it("documents every v1 path plus the webhook events", () => {
    for (const p of [
      "/api/v1/models",
      "/api/v1/jobs",
      "/api/v1/jobs/{id}",
      "/api/v1/jobs/{id}/cancel",
      "/api/v1/jobs/{id}/result",
      "/api/v1/uploads",
      "/api/v1/estimate",
      "/api/v1/me",
      "/api/v1/system",
      "/api/v1/skills",
      "/api/v1/skills/{slug}",
      "/api/v1/capabilities",
      "/api/v1/openapi.json",
    ]) expect(doc.paths[p], p).toBeTruthy();

    // the list operation shares the POST path - both must exist
    expect(doc.paths["/api/v1/jobs"].get?.responses?.["200"]).toBeTruthy();
    expect(doc.paths["/api/v1/jobs"].post?.responses?.["202"]).toBeTruthy();

    for (const t of ["job.completed", "job.failed", "job.nsfw", "job.canceled"]) {
      const op = doc.webhooks?.[t]?.post;
      expect(op, t).toBeTruthy();
      const sig = op.parameters.find((h: any) => h.name === "X-MotionField-Signature");
      expect(sig?.required).toBe(true);
    }
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    for (const s of ["Job", "JobCreated", "JobList", "Me", "SystemInfo",
                     "SkillSummary", "SkillDetail", "Capabilities", "Error"])
      expect(doc.components.schemas[s], s).toBeTruthy();
  });
});
