/** Catalog data model - models, workflows, param schemas, provider mappings.
 *  The studio UIs are driven entirely by this registry. */

export type ParamType =
  | "text" | "textarea" | "prompt"
  | "number" | "integer" | "slider"
  | "select" | "boolean"
  | "image" | "images" | "video" | "audio" | "media"
  | "multishots";

export interface ParamField {
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  enum?: readonly (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  description?: string;
  maxItems?: number;
  minItems?: number;
  accepts?: string; // mime hint
  group?: string;
  /** duration gate (seconds) on a media param - createJob probes the owned
   *  /files/ file before charging; the upload fails 400/404 pre-charge */
  minSeconds?: number;
  maxSeconds?: number;
}

export type JobKind =
  | "image" | "video" | "audio" | "edit" | "upscale"
  | "character" | "v2v" | "avatar" | "threed";

export interface ComfyMap {
  /** file in /workflows */
  workflow: string;
  /** param-dependent workflow pick - wins over `workflow` when it returns a
   *  name (e.g. camera_path choosing the conditioning backend) */
  workflowFor?: (params: Record<string, unknown>) => string | undefined;
  /** map job params -> node-input placeholders */
  map?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** host-side post on the finished outputs - returns the spec stored on
   *  job meta; the provider applies it to each video output before assets
   *  land (Director's body-look + palette grade). Server-only: stripped by
   *  clientWorkflow with the rest of `providers`. */
  post?: (params: Record<string, unknown>) => Promise<PostSpec | null>;
  /** param whose select values switch `workflowFor` - attachLicenses exposes
   *  the per-value license (the director's backend pick: ltx → restricted)
   *  so pickers badge each choice before submission. */
  variantParam?: { name: string; values: readonly string[] };
}

/** Shape a ComfyMap.post hook returns - stored on job meta (providerMeta.post). */
export interface PostSpec {
  /** body id the look came from (Director's camera body), for the record */
  body?: string;
  /** palette id the .cube was built for, for the record */
  palette?: string;
}

export interface ProviderMap {
  comfy?: ComfyMap;
  /** server-side recipe pipeline - multi-stage generation driven by src/lib/generation/recipe.ts */
  recipe?: { name: string };
}

/** Endpoint license class. "permissive-terms" sits between open and
 *  restricted - the license allows the use but carries specific terms the
 *  app must honor (attribution/notice), so it surfaces in the Licenses page
 *  without needing the restricted opt-in. Components may additionally carry
 *  "banned-known" - a known licensing violation that still runs (server
 *  warning + audit list) while another workstream replaces it. */
export type LicenseClass = "open" | "permissive-terms" | "restricted" | "banned";
export type ComponentClass = LicenseClass | "banned-known";

/** worstClass ordering - larger wins. "banned-known" is not a LicenseClass:
 *  worstClass maps it to "open" (it runs with a warning). */
export const LICENSE_CLASS_ORDER = {
  open: 0,
  "permissive-terms": 1,
  restricted: 2,
  banned: 3,
} as const satisfies Record<LicenseClass, number>;

export interface LicenseComponent {
  name: string;
  license: string;          // e.g. "Apache-2.0", "MIT", "Open RAIL-M"
  url: string;              // upstream license/model page
  class: ComponentClass;
  /** optional note surfaced in the licenses UI (e.g. replacement notices) */
  notice?: string;
}

export interface LicenseInfo {
  class: LicenseClass;
  components: LicenseComponent[];
}

export interface WorkflowDef {
  id: string;               // "text-to-video"
  label: string;            // "Text to video"
  endpointId: string;       // public API path, e.g. "motionfield/ltx-video/text-to-video"
  kind: JobKind;
  params: ParamField[];
  /** credit cost calculator */
  cost: (p: Record<string, unknown>) => number;
  providers: ProviderMap;
  /** set for weights too heavy for a typical local box - UI warns instead of failing silently (e.g. "Comfy Cloud or a CUDA GPU recommended - ~29 GB of weights") */
  heavy?: string;
  /** v2v graphs sized only by placeholders: names the source-video param so
   *  createJob fills width/height/frames from its probe when the caller did
   *  not. Without it the 16:9 5 s@25 fps defaults (1280x736x129) outlast a
   *  short clip and VACE renders the missing tail as a grey plate. */
  sourceGeometry?: { param: string; maxLong?: number; maxFrames?: number };
  /** derive `end_image_url` from the first frame for a named camera move
   *  (see lib/camera-keyframe) when the caller gave no end frame. */
  cameraKeyframe?: { image: string; move: string };
  /** resolved from licenses.generated via the workflow's bundled graph (recipe
   *  endpoints resolve params-dependently - this carries the default resolution) */
  license?: LicenseInfo;
  /** per-param-value license variants (explainer: motion_model) - attached by
   *  attachLicenses so pickers can badge each choice before submission */
  licenseVariants?: { param: string; byValue: Record<string, LicenseInfo> };
  /** set when the workflow's graph consumes a trajectory spec - only then may
   *  the picker promise executed camera motion. unset: picks are prompt-guided
   *  (the stack only reaches the prompt). */
  executesTrajectory?: boolean;
  /** workflow-owned param gate - returns an error string or null. Runs in
   *  createJob after coerce/required checks (before the licence gate and any
   *  charge) and again inside the provider's submit before media uploads, so
   *  a param the graph can't honour is refused before it is charged or sent.
   *  It may normalise params in place (e.g. a stack string → "a+b"). */
  validate?: (params: Record<string, unknown>) => string | null;
  /** set (by clientWorkflow) when the endpoint is listed in coming-soon.ts */
  comingSoon?: string;
}

export interface ModelDef {
  id: string;               // "ltx-video"
  label: string;            // "LTX-Video"
  vendor: string;
  kind: JobKind;
  description: string;
  tags?: string[];
  workflows: WorkflowDef[];
  /** minimum plan tier required (0=free,1=basic,2=pro,3=max) */
  minPlanTier?: number;
}

export interface PresetDef {
  id: string;               // slug
  title: string;
  description: string;
  kind: "motion" | "effect" | "style" | "palette" | "mixed-media";
  category?: string;
  /** extra params merged into the job when preset is applied */
  apply: Record<string, unknown>;
  /** prompt fragment appended to user prompt */
  promptFragment?: string;
  /** which video workflows accept this preset */
  modelHint?: string;
  inputRequired?: "image" | "video" | "none" | "any";
  credits?: number;
  posterHue?: number;       // deterministic poster gradient hue
  poster?: string;          // verified preview media (/examples/<cat>/<id>.webp|mp4)
}

export interface PlanDef {
  id: string;
  name: string;
  monthlyPrice: number;     // USD
  annualMonthlyPrice: number;
  creditsPerMonth: number;
  parallelVideo: number;
  parallelImage: number;
  tier: number;             // 0 free,1 basic,2 pro,3 max,4 scale/team
  features: string[];
  unlimitedModels?: string[];
  freeGens?: Record<string, number>;
  seats?: string;
}
