/**
 * Catalog snapshot - pins every exported catalog value to stable JSON so the
 * per-domain file split (F0b) is provably behavior-free.
 *
 * Regenerate: UPDATE_CATALOG_SNAPSHOT=1 npx vitest run tests/unit/ws3-catalog-snapshot.test.ts
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { VIDEO_MODELS, AUDIO_MODELS, ALL_MODELS, findEndpoint, findModel, findWorkflow } from "@/lib/catalog/video-models";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import {
  MOTION_PRESETS, EFFECT_PRESETS, STYLE_PRESETS, MIXED_MEDIA_PRESETS, ALL_PRESETS,
  COLOR_PALETTES, APPS, findPreset,
} from "@/lib/catalog/presets";
import { SKILLS, SKILL_CATEGORIES, skillById } from "@/lib/catalog/skills";
import { PLANS, TOP_UP_PACKS, BOOST_PACKS, DAILY_FREE_CREDITS, planById } from "@/lib/catalog/plans";
import * as SERIALIZE from "@/lib/catalog/serialize";

/** Deterministic shape: sorted keys, functions as markers. `license` fields are
 *  stripped - they're attached after this snapshot and covered by ws3-licenses. */
function stabilize(v: unknown): unknown {
  if (typeof v === "function") return { $fn: v.name || "anonymous" };
  if (Array.isArray(v)) return v.map(stabilize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === "license") continue;
      out[k] = stabilize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

const SNAPSHOT = {
  VIDEO_MODELS,
  AUDIO_MODELS,
  IMAGE_MODELS,
  ALL_MODELS,
  MOTION_PRESETS,
  EFFECT_PRESETS,
  STYLE_PRESETS,
  MIXED_MEDIA_PRESETS,
  ALL_PRESETS,
  COLOR_PALETTES,
  APPS,
  SKILLS,
  SKILL_CATEGORIES,
  PLANS,
  TOP_UP_PACKS,
  BOOST_PACKS,
  DAILY_FREE_CREDITS,
  // lookup helpers - pin their resolution, not just the data
  lookups: {
    findEndpoint_ltx_t2v: findEndpoint("motionfield/ltx-video/text-to-video"),
    findEndpoint_explainer: findEndpoint("motionfield/explainer/video"),
    findModel_vace: findModel("wan-vace"),
    findWorkflow_zimage: findWorkflow("z-image-turbo", "text-to-image"),
    findPreset_motion: findPreset("motion", "dolly-in"),
    findPreset_style: findPreset("style", "film-noir"),
    planById_pro: planById("pro"),
    skillById_explain: skillById("explain"),
  },
  serializeModule: SERIALIZE,
};

const FIXTURE = path.join(__dirname, "..", "fixtures", "catalog-snapshot.json");

describe("catalog snapshot", () => {
  it("every exported catalog value matches the committed snapshot", async () => {
    const current = stabilize(SNAPSHOT);
    if (process.env.UPDATE_CATALOG_SNAPSHOT === "1") {
      await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
      await fs.writeFile(FIXTURE, JSON.stringify(current, null, 2) + "\n");
    }
    const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8"));
    expect(current).toEqual(fixture);
  });
});
