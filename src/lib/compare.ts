import type { JobKind, LicenseClass, ModelDef } from "@/lib/catalog/types";

/**
 * Compare - one prompt (and optionally one image) fanned out over several
 * local models. Candidates come straight from the catalog: any workflow whose
 * required inputs are covered by what the Compare form collects. Jobs go
 * through the normal /api/jobs path, so credits, licence gates and the GPU
 * queue behave exactly as they do in the studios.
 */

export const COMPARE_MODES = {
  image: { label: "Text → image", kinds: ["image"], inputs: ["prompt"] },
  edit: { label: "Edit an image", kinds: ["edit"], inputs: ["prompt", "image_url"] },
  video: { label: "Text → video", kinds: ["video"], inputs: ["prompt"] },
  i2v: { label: "Image → video", kinds: ["video"], inputs: ["prompt", "image_url"] },
} as const satisfies Record<string, { label: string; kinds: readonly JobKind[]; inputs: readonly string[] }>;

export type CompareMode = keyof typeof COMPARE_MODES;
export const MAX_COMPARE = 4;

export type CompareCandidate = {
  /** endpoint id - unique per workflow */
  id: string;
  modelId: string;
  workflowId: string;
  kind: JobKind;
  model: string;
  workflow: string;
  vendor: string;
  heavy: string | null;
  license: LicenseClass | null;
  /** params this workflow accepts - the shared form only sends these */
  accepts: string[];
  aspects: string[];
  /** one plain line: what this pick is good at */
  hint: string;
  /** headline weights licence, e.g. "Apache-2.0" */
  licenseName: string | null;
  /** a real output of this workflow from public/examples (set by the page) */
  thumb?: { url: string; kind: "image" | "video" };
  /** set when the server refuses this endpoint (coming soon) - shown, not pickable */
  unavailable?: string;
};

/** Plain-language one-liners per endpoint; anything unlisted falls back to
 *  its weight class so every card says something true. */
const HINTS: Record<string, string> = {
  "motionfield/z-image-turbo/text-to-image": "Fast, photoreal, 8 steps",
  "motionfield/flux2-klein/text-to-image": "Fast, 4 steps, clean detail",
  "motionfield/z-image-turbo/img2img": "Fast restyle of the whole picture",
  "motionfield/flux2-klein/edit": "Fast instruction edits",
  "motionfield/qwen-image-edit/edit": "Best edit quality, needs a big GPU",
  "motionfield/ltx-video/text-to-video": "Fast, with generated sound",
  "motionfield/ltx-video/image-to-video": "Fast, with generated sound",
  "motionfield/lens/standard/text-to-video": "LTX-2.5 with a named camera move",
  "motionfield/lens/standard/image-to-video": "LTX-2.5 with a named camera move",
  "motionfield/wan-2.2/image-to-video": "Higher fidelity, slower",
  "motionfield/wan-2.2/a14b-t2v": "Best quality, cloud GPU tier",
  "motionfield/wan-2.2/a14b-i2v": "Best quality, cloud GPU tier",
  "motionfield/wan-2.1/text-to-video": "Light 1.3B open model",
  "motionfield/wan-2.1/image-to-video": "14B open model, needs a big GPU",
  "motionfield/wan-vace/image-to-video": "Light 1.3B open model",
  "motionfield/director/generate": "Directed camera rig on Wan VACE",
  "motionfield/ltx-video/vfx-keyframe": "Effects locked to the first frame",
  "motionfield/explainer/video": "Narrated explainer pipeline",
};

function hintFor(endpointId: string, heavy: string | null, tags: readonly string[] = []): string {
  if (HINTS[endpointId]) return HINTS[endpointId];
  if (heavy) return "Higher quality, needs a big GPU";
  return tags.includes("fast") ? "Fast" : "Runs on the local GPU";
}

export function compareCandidates(models: ModelDef[], mode: CompareMode): CompareCandidate[] {
  const spec = COMPARE_MODES[mode];
  const inputs: readonly string[] = spec.inputs;
  const out: CompareCandidate[] = [];
  for (const m of models) {
    for (const w of m.workflows) {
      if (!(spec.kinds as readonly JobKind[]).includes(w.kind)) continue;
      const required = w.params.filter((p) => p.required).map((p) => p.name);
      // exact input match: an i2v workflow doesn't belong in text → video
      if (!required.every((r) => inputs.includes(r))) continue;
      if (!inputs.every((i) => w.params.some((p) => p.name === i))) continue;
      const aspect = w.params.find((p) => p.name === "aspect_ratio");
      out.push({
        id: w.endpointId,
        modelId: m.id,
        workflowId: w.id,
        kind: w.kind,
        model: m.label,
        workflow: w.label,
        vendor: m.vendor,
        heavy: w.heavy ?? null,
        license: w.license?.class ?? null,
        accepts: w.params.map((p) => p.name),
        aspects: (aspect?.enum ?? []).map(String),
        hint: hintFor(w.endpointId, w.heavy ?? null, m.tags),
        licenseName: w.license?.components?.[0]?.license ?? null,
      });
    }
  }
  return out;
}

export type CompareShared = { prompt: string; image_url?: string | null; seed?: number | null; aspect_ratio?: string | null };

/** The shared form → one workflow's params: only fields it accepts, and an
 *  aspect only when the workflow offers that exact value. */
export function compareParams(c: Pick<CompareCandidate, "accepts" | "aspects">, s: CompareShared): Record<string, unknown> {
  const p: Record<string, unknown> = { prompt: s.prompt };
  if (s.image_url && c.accepts.includes("image_url")) p.image_url = s.image_url;
  if (s.seed != null && c.accepts.includes("seed")) p.seed = s.seed;
  if (s.aspect_ratio && c.aspects.includes(s.aspect_ratio)) p.aspect_ratio = s.aspect_ratio;
  return p;
}

/** Aspect values every picked candidate with an aspect control supports -
 *  candidates without one keep their own framing. */
export function commonAspects(cs: Pick<CompareCandidate, "aspects">[]): string[] {
  const withAspect = cs.filter((c) => c.aspects.length);
  if (!withAspect.length) return [];
  return withAspect[0].aspects.filter((a) => withAspect.every((c) => c.aspects.includes(a)));
}
