/**
 * [OF-0498] Deterministic-surface license audit - every endpoint the skills,
 * INTENTS fallback, fallback plan, or canvas palette can submit must be
 * runnable and open-classed; banned-known components are only tolerated on
 * the explicit PENDING_V4 allowlist (the 3 MuseTalk endpoints).
 * [OF-0411] UGC-class skills are explicitly silent.
 */
import { describe, it, expect } from "vitest";
import { SKILLS } from "@/lib/catalog/skills";
import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { CANVAS_NODES, INTENTS, PENDING_V4, fallbackPlanSteps } from "@/lib/agent-defaults";

type Entry = { source: string; endpointId: string; params: Record<string, unknown> };

function* entries(): Generator<Entry> {
  for (const s of SKILLS) {
    for (const step of s.steps("a brief for testing", {}))
      yield { source: `skill ${s.id} → ${step.label}`, endpointId: step.endpoint, params: step.params };
  }
  for (const i of INTENTS)
    yield { source: `intent ${i.label}`, endpointId: i.endpoint, params: i.params };
  for (const step of fallbackPlanSteps("a video of a product"))
    yield { source: `fallback ${step.step}`, endpointId: step.endpoint, params: step.params };
  for (const [type, endpointId] of Object.entries(CANVAS_NODES))
    yield { source: `canvas node ${type}`, endpointId, params: {} };
}

describe("[OF-0498] deterministic defaults: licenses", () => {
  it("every surfaced endpoint exists and is not restricted/banned", () => {
    let count = 0;
    for (const e of entries()) {
      count++;
      const found = findEndpoint(e.endpointId);
      expect(found, `${e.source}: unknown endpoint ${e.endpointId}`).toBeTruthy();
      const lic = endpointLicense(found!.workflow, e.params);
      expect(lic.class, `${e.source}: ${e.endpointId} resolves to license class "${lic.class}"`)
        .not.toMatch(/restricted|banned/);
    }
    expect(count).toBeGreaterThan(30); // sanity - the audit actually ran over the surfaces
  });

  it("banned-known components appear only inside the PENDING_V4 allowlist", () => {
    for (const e of entries()) {
      const found = findEndpoint(e.endpointId)!;
      const lic = endpointLicense(found.workflow, e.params);
      const banned = lic.components.filter((c) => c.class === "banned-known");
      if (banned.length)
        expect(PENDING_V4.has(e.endpointId),
          `${e.source} (${e.endpointId}) carries banned-known: ${banned.map((c) => c.name).join(", ")}`)
          .toBe(true);
    }
  });
});

describe("[OF-0411] UGC-class skills are explicitly silent", () => {
  for (const id of ["ugc-ad", "product-review-clip"]) {
    it(`${id} is named "(silent)" and its blurb ends "no voice"`, () => {
      const s = SKILLS.find((x) => x.id === id);
      expect(s, `skill ${id} missing`).toBeTruthy();
      expect(s!.name).toMatch(/\(silent\)$/);
      expect(s!.blurb).toMatch(/no voice$/);
      expect(JSON.stringify(s!.steps("b", {}))).not.toMatch(/piece-to-camera/);
    });
  }
});
