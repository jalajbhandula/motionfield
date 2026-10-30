/**
 * ws4 catalog honesty guard - the contract behind every visible preset:
 *  1. every catalog preset/app id owns exactly one PresetSpec with a real
 *     mechanism, declared inputs and a verification contract
 *  2. mechanisms resolve to real endpoints/graphs/trajectory ids; a visible
 *     spec never defaults to a restricted or banned endpoint
 *  3. hidden entries carry a reason and are never verify-visible
 *  4. the verify-file gate + combination rules (trajectory/post/composite
 *     only) as resolveParams enforces them
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "@/lib/catalog/presets/effects";
import "@/lib/catalog/presets/styles";
import "@/lib/catalog/presets/apps";
import "@/lib/catalog/presets/person-swap";
import {
  allSpecs, specById, specVisible, mechanismHash,
  COMBINABLE_KINDS, specCombinable,
  type PresetSpec, type VerifyRecord,
} from "@/lib/catalog/presets/schema";
import { APPS } from "@/lib/catalog/presets/apps";
import { EFFECT_PRESETS } from "@/lib/catalog/presets/effects";
import { STYLE_PRESETS } from "@/lib/catalog/presets/styles";
import { MOTION_PRESETS, TRAJECTORIES } from "@/lib/catalog/presets/trajectories";
import { findEndpoint } from "@/lib/catalog/video-models";
import { ENDPOINT_GRAPHS, WORKFLOW_LICENSES } from "@/lib/catalog/licenses.generated";
import { resolveParams, JobError } from "@/lib/jobs";

const endpointOf = (s: PresetSpec) => ("endpoint" in s.mechanism ? s.mechanism.endpoint : null);
const TRAJECTORY_IDS = new Set(TRAJECTORIES.map((t) => t.id));

describe("ws4 catalog honesty", () => {
  it("every catalog preset owns exactly one spec with a real mechanism", () => {
    const ids = allSpecs().map((s) => s.id);
    expect(new Set(ids).size, "spec ids must be unique across catalogs").toBe(ids.length);

    for (const slug of [...APPS.map((a) => a.slug), ...EFFECT_PRESETS.map((p) => p.id),
      ...STYLE_PRESETS.map((p) => p.id), ...MOTION_PRESETS.map((p) => p.id)]) {
      const spec = specById(slug);
      expect(spec, `no spec covers ${slug}`).toBeDefined();
      expect(spec!.inputs.length, `${slug} declares inputs`).toBeGreaterThan(0);
      expect(spec!.mechanism, `${slug} has a mechanism`).toBeTruthy();
      expect(spec!.verify.checker, `${slug} names a checker`).toBeTruthy();
    }
  });

  it("every mechanism resolves to a real executor - and a visible spec never rides a restricted endpoint", () => {
    for (const s of allSpecs()) {
      const ep = endpointOf(s);
      if (ep) {
        const hit = findEndpoint(ep);
        expect(hit, `${s.id}: endpoint ${ep} not in the catalog`).toBeTruthy();
        const graph = ENDPOINT_GRAPHS[ep];
        if (hit!.workflow.providers?.comfy)
          expect(graph && existsSync(path.join("workflows", graph)), `${s.id}: no workflow file for ${ep}`).toBeTruthy();
        if (graph && WORKFLOW_LICENSES[graph] && !s.hidden)
          expect(WORKFLOW_LICENSES[graph].class, `${s.id}: ${ep} is ${WORKFLOW_LICENSES[graph].class}`).toBe("open");
      }
      if (s.mechanism.kind === "trajectory")
        for (const id of s.mechanism.ids)
          expect(TRAJECTORY_IDS.has(id), `${s.id}: unknown trajectory ${id}`).toBe(true);
      if (s.mechanism.kind === "post") {
        // post params must be declared inputs on the host i2v endpoint
        const host = findEndpoint("motionfield/wan-vace/image-to-video")!.workflow;
        const names = new Set(host.params.map((p) => p.name));
        for (const k of Object.keys(s.mechanism.params))
          expect(names.has(k), `${s.id}: post param ${k} is not a real input`).toBe(true);
      }
      if (!s.hidden) {
        const f = s.verify.fixture;
        if (f) expect(existsSync(path.join("tests/fixtures/verify", f)), `${s.id}: missing fixture ${f}`).toBe(true);
      }
    }
  });

  it("hidden entries carry a reason and are never verify-visible", () => {
    const hidden = allSpecs().filter((s) => s.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const s of hidden) {
      expect(s.hidden!.reason.length, `${s.id} needs a hidden reason`).toBeGreaterThan(10);
      // even a fabricated verified record can't un-hide it
      const fake: VerifyRecord = { mechanism_hash: mechanismHash(s), status: "verified" };
      expect(specVisible(s, { [s.id]: fake }), `${s.id} must stay invisible`).toBe(false);
    }
    // the named hidden set - styles, keyframe VFX and the no-executor apps
    for (const id of ["outfit-try-on", "transitions", "shot-coverage",
      "scatter-to-ash", "rift-gate", "cinder-burst", "flash-frost", "general", "neon-noir"])
      expect(specById(id)?.hidden, `${id} should be hidden`).toBeTruthy();
  });

  it("the gate: verified+unhidden is visible; stale hash isn't; only trajectory/post/composite combine", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "of-verify-"));
    const file = path.join(tmp, "verify.json");
    const good = (id: string): VerifyRecord => ({ mechanism_hash: mechanismHash(specById(id)!), status: "verified" });
    writeFileSync(file, JSON.stringify({ records: {
      "dolly-in": good("dolly-in"), "candid-take": good("candid-take"),
      "comic-panel": good("comic-panel"),
      "marble-gold": { mechanism_hash: "stale", status: "verified" },
    } }));
    const prev = process.env.PRESET_VERIFY_FILE;
    process.env.PRESET_VERIFY_FILE = file;
    try {
      // combinable pair merges - trajectory + post is legal
      const out = resolveParams({ prompt: "a dancer", motion_preset: "dolly-in", effect_preset: "candid-take" });
      expect(out.trajectory).toBeTruthy();
      expect(out.negative_prompt).toBeTruthy();
      expect(String(out.prompt)).toContain("mid-gesture");

      // exclusive mechanism in the mix → 400
      expect(() => resolveParams({ prompt: "x", motion_preset: "dolly-in", preset_id: "comic-panel" }))
        .toThrowError(JobError);
      // hidden → 400
      expect(() => resolveParams({ prompt: "x", preset_id: "flash-frost" })).toThrowError(JobError);
      // unverified → 400
      expect(() => resolveParams({ prompt: "x", preset_id: "weightless" })).toThrowError(JobError);
      // stale hash → invisible + unusable
      expect(specVisible(specById("marble-gold")!)).toBe(false);
      expect(() => resolveParams({ prompt: "x", preset_id: "marble-gold" })).toThrowError(JobError);
      // unknown id → 400
      expect(() => resolveParams({ prompt: "x", preset_id: "nope-not-real" })).toThrowError(JobError);
      // combinable flag is honest
      expect(specCombinable(specById("dolly-in")!)).toBe(true);
      expect(COMBINABLE_KINDS.has("restyle")).toBe(false);
    } finally {
      process.env.PRESET_VERIFY_FILE = prev;
    }
  });
});
