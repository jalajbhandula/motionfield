/**
 * Demo shot list — the single source of truth for what the capture pass
 * drives, what goes on the timeline, and what the e2e checks. Every step is
 * a tiny `do`-primitive so the same file keeps working when UI selectors
 * move: fix the step here, not inside a bespoke script.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findEndpoint } from "../../src/lib/catalog/video-models";
import { endpointLicense } from "../../src/lib/catalog/license-gate";
import { WORKFLOW_LICENSES } from "../../src/lib/catalog/licenses.generated";
import { REPO } from "./util";

/* ----------------------------- schemas -------------------------------- */

export const selectorSchema = z.strictObject({
  testid: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  css: z.string().min(1).optional(),
  nth: z.number().int().min(0).optional(),
}).refine((s) => !!(s.testid || s.text || s.role || s.css),
  { message: "a step selector needs testid, text, role or css" });
export type Sel = z.infer<typeof selectorSchema>;

export const stepSchema = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("goto"), route: z.string().optional() }),
  z.strictObject({ do: z.literal("click"), sel: selectorSchema }),
  z.strictObject({ do: z.literal("fill"), sel: selectorSchema, value: z.string().min(1).max(2000) }),
  z.strictObject({ do: z.literal("check"), sel: selectorSchema, on: z.boolean().default(true) }),
  z.strictObject({ do: z.literal("select"), sel: selectorSchema, value: z.string().min(1) }),
  z.strictObject({ do: z.literal("upload"), sel: selectorSchema, fixture: z.enum(["clip", "face"]) }),
  z.strictObject({ do: z.literal("waitFor"), sel: selectorSchema, timeout_s: z.number().positive().max(600).default(60) }),
  z.strictObject({ do: z.literal("scroll"), sel: selectorSchema }),
  z.strictObject({ do: z.literal("settle"), ms: z.number().int().min(0).max(60_000) }),
]);
export type Step = z.infer<typeof stepSchema>;

export const shotSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  title: z.string().min(3).max(90),
  /** route the shot starts on — the first step may `goto` elsewhere */
  route: z.string().regex(/^\/[a-zA-Z0-9/._?=-]*$/),
  steps: z.array(stepSchema).min(1),
  /** seconds of final video this shot may occupy — assemble trims to this */
  budget_s: z.number().positive().max(60),
  /** required shots fail the assemble; optional gaps land as cards */
  required: z.boolean(),
  /** mac = on-box weights · gpu = BYO remote ComfyUI (cloud-recommended, untested) */
  source: z.enum(["mac", "gpu"]),
  /** catalog endpoint ids this shot showcases — badges are resolved from
   *  catalog license data at load time, never typed by hand */
  endpoints: z.array(z.string()).default([]),
  /** also show the demo-brain badge from profile.json */
  brain: z.boolean().optional(),
});
export type Shot = z.infer<typeof shotSchema>;

const t = (text: string): Sel => ({ text });
const id = (testid: string): Sel => ({ testid });
const css = (s: string): Sel => ({ css: s });
const role = (r: string, text?: string): Sel => ({ role: r, text });

/* ----------------------------- the shots ------------------------------ */

const SHOTS_RAW: unknown[] = [
  {
    id: "person-swap",
    title: "PersonSwap — your consented face, our clip",
    route: "/person-swap",
    budget_s: 11,
    required: true,
    source: "mac",
    endpoints: ["motionfield/person-swap/v1.0"],
    steps: [
      { do: "check", sel: css("#person-swap-consent") },
      { do: "upload", sel: css('input[type="file"][accept="video/*"]'), fixture: "clip" },
      { do: "waitFor", sel: { text: "generation window" }, timeout_s: 30 },
      { do: "select", sel: css("select"), value: "480p" },
      { do: "upload", sel: css('input[type="file"][accept="image/*"]'), fixture: "face" },
      { do: "settle", ms: 600 },
      { do: "click", sel: t("Run draft preview") },
      { do: "waitFor", sel: { text: "Approve - run the full render" }, timeout_s: 300 },
      { do: "click", sel: t("Approve - run the full render") },
      { do: "waitFor", sel: { text: "Source ↔ swapped" }, timeout_s: 300 },
      { do: "settle", ms: 1500 },
    ],
  },
  {
    id: "director",
    title: "Director — a scene line into a planned shot",
    route: "/generate",
    budget_s: 16,
    required: true,
    source: "mac",
    endpoints: ["motionfield/director/generate"],
    steps: [
      { do: "click", sel: css('button:has(> span:first-child:text-is("Camera"))') },
      { do: "click", sel: role("button", "Dolly In") },
      { do: "fill", sel: css("textarea"), value: "A lone explorer crosses a neon-lit marsh at dusk — drone haze, volumetric glow" },
      { do: "settle", ms: 400 },
      { do: "click", sel: css('button:has-text("Generate")') },
      { do: "waitFor", sel: { css: '[data-job-status="completed"]', nth: 0 }, timeout_s: 240 },
      { do: "settle", ms: 1500 },
    ],
  },
  {
    id: "reshoot",
    title: "Re-shoot — same clip, new camera path",
    route: "/new-camera-move",
    budget_s: 11,
    required: true,
    source: "mac",
    endpoints: ["motionfield/reshoot/video"],
    steps: [
      { do: "upload", sel: css('input[type="file"][accept="video/*"]'), fixture: "clip" },
      { do: "waitFor", sel: id("probe-card"), timeout_s: 60 },
      { do: "click", sel: t("New path") },
      { do: "click", sel: role("button", "Arc Left") },
      { do: "settle", ms: 300 },
      { do: "click", sel: role("button", "Apply new camera move") },
      { do: "waitFor", sel: id("reshoot-output"), timeout_s: 240 },
      { do: "settle", ms: 1200 },
    ],
  },
  {
    id: "stage",
    title: "Stage — a 3D set, nodes and all",
    route: "/scene-3d",
    budget_s: 11,
    required: true,
    source: "mac",
    endpoints: [],
    steps: [
      { do: "click", sel: t("Empty scene") },
      { do: "waitFor", sel: id("stage-viewport"), timeout_s: 60 },
      { do: "settle", ms: 1500 },
      { do: "click", sel: t("+ Add node") },
      { do: "click", sel: role("menuitem", "Primitive · box") },
      { do: "settle", ms: 800 },
      { do: "click", sel: t("Apply move") },
      { do: "settle", ms: 1200 },
      { do: "click", sel: t("Export") },
      { do: "waitFor", sel: id("export-panel"), timeout_s: 10 },
      { do: "click", sel: t("Save GLB to library") },
      { do: "settle", ms: 1200 },
    ],
  },
  {
    id: "vfx",
    title: "VFX — restricted weights get an opt-in, not a dark pattern",
    route: "/generate",
    budget_s: 8,
    required: true,
    source: "mac",
    endpoints: ["motionfield/ltx-video/text-to-video", "motionfield/director/generate"],
    steps: [
      { do: "click", sel: t("Backend") },
      { do: "waitFor", sel: { text: "Restricted · opt-in" }, timeout_s: 20 },
      { do: "settle", ms: 2500 },
      { do: "click", sel: t("ltx") },
      { do: "settle", ms: 800 },
    ],
  },
  {
    id: "agent",
    title: "The brain — plan, approve, edit, re-run",
    route: "/ai-assistant",
    budget_s: 20,
    required: true,
    source: "mac",
    endpoints: [],
    brain: true,
    steps: [
      { do: "click", sel: id("planner-pick") },
      { do: "click", sel: t("Built-in") },
      { do: "fill", sel: css("form:has(button[title=\"Send\"]) textarea"), value: "make an image of a red kite over golden dunes, then animate it into a clip" },
      { do: "click", sel: css('button[title="Send"]') },
      { do: "waitFor", sel: { css: '[data-testid^="run-card-"]:not([data-testid="run-card-pending"])' }, timeout_s: 90 },
      { do: "waitFor", sel: { css: '[data-testid^="run-approve-"]' }, timeout_s: 120 },
      { do: "settle", ms: 800 },
      { do: "click", sel: { css: '[data-testid^="run-approve-"]' } },
      { do: "waitFor", sel: { css: '[data-testid="step-s2"][data-status="done"]' }, timeout_s: 300 },
      { do: "settle", ms: 800 },
      { do: "click", sel: { css: '[data-testid="step-s2"] > button' } },
      { do: "waitFor", sel: id("step-edit-s2"), timeout_s: 20 },
      { do: "click", sel: id("step-edit-s2") },
      { do: "fill", sel: id("step-param-s2-prompt"), value: "the kite wheeling over the dunes, golden hour" },
      { do: "click", sel: id("step-save-s2") },
      { do: "waitFor", sel: { css: '[data-testid^="run-approve-"]' }, timeout_s: 60 },
      { do: "click", sel: { css: '[data-testid^="run-approve-"]' } },
      { do: "waitFor", sel: { css: '[data-testid="step-s2"][data-status="done"]' }, timeout_s: 300 },
      { do: "settle", ms: 1200 },
    ],
  },
  {
    id: "cli",
    title: "The CLI — same surface, one line",
    route: "/docs/cli",
    budget_s: 5,
    required: true,
    source: "mac",
    endpoints: ["motionfield/z-image-turbo/text-to-image"],
    steps: [
      { do: "settle", ms: 1200 },
      { do: "waitFor", sel: { text: "stage list" }, timeout_s: 20 },
      { do: "scroll", sel: { text: "stage list" } },
      { do: "settle", ms: 2200 },
    ],
  },
  {
    id: "mcp",
    title: "MCP — the whole app is a tool server",
    route: "/mcp",
    budget_s: 5,
    required: true,
    source: "mac",
    endpoints: [],
    brain: true,
    steps: [
      { do: "settle", ms: 600 },
      { do: "waitFor", sel: { css: '[data-testid^="mcp-snippet-"]', nth: 0 }, timeout_s: 20 },
      { do: "scroll", sel: { css: '[data-testid^="mcp-snippet-"]', nth: 0 } },
      { do: "settle", ms: 1800 },
    ],
  },
  {
    id: "motion",
    title: "Motion graphics — spec → real rendered MP4",
    route: "/motion-graphics",
    budget_s: 12,
    required: true,
    source: "mac",
    endpoints: ["motionfield/motion-render/mp4"],
    steps: [
      { do: "waitFor", sel: { text: "Presentation" }, timeout_s: 90 },
      { do: "click", sel: t("Presentation") },
      { do: "waitFor", sel: { text: "Use template" }, timeout_s: 90 },
      { do: "click", sel: t("Use template") },
      { do: "waitFor", sel: { text: "Render MP4" }, timeout_s: 60 },
      { do: "settle", ms: 1500 },
      { do: "click", sel: t("Render MP4") },
      { do: "waitFor", sel: { css: "video" }, timeout_s: 300 },
      { do: "settle", ms: 1500 },
    ],
  },
];

const shotListSchema = z.array(shotSchema)
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const s of arr) {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate shot id ${s.id}` });
      seen.add(s.id);
    }
  });

let cached: Shot[] | null = null;
export function shots(): Shot[] {
  if (!cached) cached = shotListSchema.parse(SHOTS_RAW);
  return cached;
}

export function shot(id: string): Shot | undefined {
  return shots().find((s) => s.id === id);
}

/* ------------------------------ badges -------------------------------- */

export interface Badge { name: string; license: string; endpoint: string | null }

/**
 * Licenses are pulled from the catalog — the badge text the video shows is
 * the same text /settings/licenses shows, and a license rename flips the
 * demo (the e2e pins that).
 */
export function badgesForEndpoints(endpointIds: readonly string[]): Badge[] {
  const out: Badge[] = [];
  for (const ep of endpointIds) {
    const hit = findEndpoint(ep);
    if (!hit) throw new Error(`shot names unknown catalog endpoint ${ep}`);
    const lic = hit.workflow.license ?? endpointLicense(hit.workflow);
    if (!lic) throw new Error(`endpoint ${ep} carries no license`);
    const licenses = [...new Set(lic.components.map((c) => c.license))].join(" + ");
    out.push({ name: hit.model.label, license: licenses, endpoint: ep });
  }
  return out;
}

export function badgesFor(shot: Shot, brain?: Badge): Badge[] {
  const out = badgesForEndpoints(shot.endpoints);
  if (shot.brain && brain) out.push(brain);
  return out;
}

/** The MotionField Comfy node pack component — pulled out of generated
 *  license data (it's a declared component of our workflows), not typed. */
export function nodePackBadge(): Badge {
  for (const lic of Object.values(WORKFLOW_LICENSES))
    for (const c of lic.components)
      if (c.name.startsWith("MotionField node pack"))
        return { name: "MotionField node pack", license: c.license, endpoint: null };
  throw new Error("MotionField node pack component missing from generated licenses");
}

/* --------------------------- node name list --------------------------- */

/** Real Comfy class names registered by comfy-nodes/motionfield_nodes —
 *  parsed out of each module's NODE_CLASS_MAPPINGS dict (not bare string
 *  matches — module constants like OF_DWPOSE_DIR aren't node classes). */
export function nodeClassNames(): string[] {
  const dir = path.join(REPO, "comfy-nodes", "motionfield_nodes");
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!ent.name.startsWith("__")) walk(p); continue; }
      if (!ent.name.endsWith(".py")) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const mm of src.matchAll(/NODE_CLASS_MAPPINGS\s*=\s*\{([^}]*)\}/gs))
        for (const m of mm[1].matchAll(/"([A-Za-z0-9_]+)"\s*:/g))
          if (m[1].startsWith("OF_")) names.add(m[1]);
    }
  };
  walk(dir);
  return [...names].sort();
}

/** The card spec files ship under scripts/demo/cards/. */
export const CARDS_DIR = path.join(REPO, "scripts", "demo", "cards");
export const CARD_IDS = ["title", "outro", "credits"] as const;
export type CardId = (typeof CARD_IDS)[number];
