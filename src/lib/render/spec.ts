import { z } from "zod";
import { SPEC_LIMITS } from "./limits";

/**
 * SceneSpec v1 - the declarative JSON format that drives the deterministic
 * three.js renderer (src/lib/render/runtime.ts). Everything a rendered frame
 * needs lives in the spec: renderAt(t) is a pure function of (spec, params, t).
 *
 * Units & conventions:
 * - positions/rotations/scales are three.js scene units; rotation is radians.
 * - keyframe `t` is seconds (clamped to [0, duration] at render time).
 * - layer animatable paths: position[.x|.y|.z], rotation[.x|.y|.z],
 *   scale[.x|.y|.z] (scalar scale = uniform), opacity, color, hue, props.<name>.
 * - `hue` (0-360) is a numeric color driver: when a material prop named `hue`
 *   is set it overrides `color` with HSL(hue, 70%, 55%) - lets numeric params
 *   drive accent colors.
 * - param bind: "<layerId>.<animatablePath>" - params win over keyframes.
 * - `captions`/`hud` layers paint on canvas textures in a screen-space pass
 *   over the 3D frame; `background.transparent` keeps their alpha; `post`
 *   names ffmpeg-side overlays the exporter applies (mono/flash/glow).
 */

export const SCENE_SPEC_VERSION = 1;

const idStr = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "id must start with a letter; letters/digits/_/- only");
const colorStr = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "color must be #rgb/#rrggbb/#rrggbbaa");
const vec3 = z.tuple([z.number(), z.number(), z.number()]).describe("[x,y,z]");
const opacity01 = z.number().min(0).max(1);
const factor01 = z.number().min(0).max(1);
const hueProp = z.number().min(0).max(360);

const EASES = ["linear", "easeInOut", "easeOut", "spring"] as const;
export type EaseName = (typeof EASES)[number];
const easeSchema = z.enum(EASES);

/** path root -> allowed sub-paths (undefined = leaf only) */
const PATH_ROOTS = ["position", "rotation", "scale", "opacity", "color", "hue", "props"] as const;
const animPath = z.string().regex(
  /^(position|rotation|scale|opacity|color|hue|props)(\.[A-Za-z][A-Za-z0-9_]*)?$/,
  "path must be position|rotation|scale|opacity|color|hue|props.<name>",
);

const keyframeSchema = z.strictObject({
  t: z.number().min(0),
  path: animPath,
  value: z.union([z.number(), vec3, colorStr]),
  ease: easeSchema.optional(), // defaults to "linear" at render time
});
export type Keyframe = z.infer<typeof keyframeSchema>;

const transformSchema = z.strictObject({
  position: vec3.optional(),
  rotation: vec3.optional(), // euler radians
  scale: z.union([z.number(), vec3]).optional(), // scalar = uniform
});
export type Transform = z.infer<typeof transformSchema>;

const materialProps = {
  color: colorStr.optional(),
  hue: hueProp.optional(),
  metalness: factor01.optional(),
  roughness: factor01.optional(),
  opacity: opacity01.optional(),
};

const textProps = z.strictObject({
  text: z.string().min(1).max(500),
  size: z.number().positive().max(2000),
  depth: z.number().min(0).max(500).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  weight: z.number().min(100).max(900).optional(),
  letterSpacing: z.number().optional(),
  reveal: factor01.optional(), // 0-1 left-to-right wipe (clip plane at render time)
  ...materialProps,
});

/** Extruded 3D type - per-glyph TextGeometry in Space Grotesk (see runtime). */
const staggerSchema = z.strictObject({
  delay: z.number().min(0).max(10), // seconds offset between glyphs
  from: z.enum(["start", "center", "end"]).optional(), // default "start"
});
export type GlyphStagger = z.infer<typeof staggerSchema>;

const text3dProps = z.strictObject({
  text: z.string().min(1).max(200),
  size: z.number().positive().max(2000),
  depth: z.number().min(0).max(500), // extrusion depth; 0 = flat faces only
  bevelSize: z.number().min(0).max(200).optional(),
  curveSegments: z.number().int().min(1).max(12).optional(),
  letterSpacing: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  stagger: staggerSchema.optional(),
  reveal: factor01.optional(),
  ...materialProps,
});

/** same-origin /files/… path or an inline raster - nothing else may be fetched.
 *  Path segments are [A-Za-z0-9._-] with at least one non-dot char each, so
 *  "..", "%", "\", "?", "#" and empty segments never parse (A5). */
const filesPath = /^\/files\/(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(?:\/(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))*$/;
export const filesPathSchema = z.string().regex(
  filesPath,
  "path must be /files/<segment>[/<segment>…] - letters/digits/._- only",
);
const imageSrc = z.string().max(2_000_000).refine(
  (v) => filesPathSchema.safeParse(v).success || /^data:image\/(png|jpeg|webp)(;base64)?,/.test(v),
  "image must be a same-origin /files/… path or data:image/(png|jpeg|webp)",
);

const planeProps = z.strictObject({
  width: z.number().positive().max(20000),
  height: z.number().positive().max(20000),
  image: imageSrc.optional(),
  doubleSided: z.boolean().optional(),
  cornerRadius: z.number().min(0).max(10000).optional(), // rounded-rect shape
  ...materialProps,
});

/** draw-on stroke: `progress` 0-1 trims the ribbon via the index draw range. */
const lineProps = z.strictObject({
  points: z.array(vec3).min(2).max(512),
  width: z.number().positive().max(500),
  progress: factor01.optional(),
  ...materialProps,
});

const boxProps = z.strictObject({
  width: z.number().positive().max(20000),
  height: z.number().positive().max(20000),
  depth: z.number().positive().max(20000),
  ...materialProps,
});

const sphereProps = z.strictObject({
  radius: z.number().positive().max(10000),
  segments: z.number().int().min(4).max(128).optional(),
  ...materialProps,
});

const particlesProps = z.strictObject({
  count: z.number().int().min(1).max(20000),
  radius: z.number().positive().max(20000), // spawn-sphere radius
  size: z.number().positive().max(200),
  speed: z.number().min(0).max(10).optional(), // drift cycles per second
  drift: z.number().min(0).max(500).optional(), // sway amplitude in units
  ...materialProps,
});

/* ---------- screen-space layers (drawn on canvas textures over the frame) */

/** one ASR/script word: text + [start,end) seconds */
const wordSchema = z.strictObject({
  text: z.string().min(1).max(200),
  start: z.number().min(0).max(86400),
  end: z.number().min(0).max(86400),
});

/** Kinetic captions - the cue active at t shows; karaoke highlights the live
 *  word, pop springs each word in at its start, punch springs emphasised
 *  words. Rendered screen-space (drawn to a canvas texture each frame). */
const captionsProps = z.strictObject({
  words: z.array(wordSchema).min(1).max(2000),
  style: z.enum(["karaoke", "pop", "punch"]).optional(), // default karaoke
  maxChars: z.number().int().min(4).max(120).optional(), // chars per caption line (default 32)
  lines: z.union([z.literal(1), z.literal(2)]).optional(), // max caption lines (default 2)
  size: z.number().min(4).max(400).optional(), // px - default scales with frame height
  highlightColor: colorStr.optional(), // karaoke/punch active word
  anchor: z.enum(["bottom", "center", "top"]).optional(), // default bottom
  uppercase: z.boolean().optional(),
  glow: factor01.optional(), // 0-1 → shadowBlur behind text
  outline: z.number().min(0).max(40).optional(), // stroke width px
  marginBottom: z.number().min(0).max(2000).optional(), // px lift for anchor=bottom
  /** word indexes (into words[]) that punch - spring + glow on entry */
  punch: z.array(z.number().int().min(0).max(1999)).max(500).optional(),
  ...materialProps, // color/hue drive the base word color
});

/** Speedometer HUD - dial arc + needle + numeric readout on a canvas texture. */
const hudProps = z.strictObject({
  value: z.number().min(0).max(1_000_000).optional(), // current reading (keyframe/bind props.value)
  max: z.number().positive().max(1_000_000).optional(), // full-scale (default 100)
  unit: z.string().max(12).optional(),
  anchor: z.enum(["topLeft", "topRight", "bottomLeft", "bottomRight"]).optional(), // default topRight
  size: z.number().min(40).max(1000).optional(), // dial diameter px (default 180)
  ...materialProps,
});

export interface LayerBase {
  id: string;
  transform?: Transform;
  keyframes?: Keyframe[];
}
export interface TextLayer extends LayerBase { type: "text"; props: z.infer<typeof textProps> }
export interface Text3DLayer extends LayerBase { type: "text3d"; props: z.infer<typeof text3dProps> }
export interface PlaneLayer extends LayerBase { type: "plane"; props: z.infer<typeof planeProps> }
export interface LineLayer extends LayerBase { type: "line"; props: z.infer<typeof lineProps> }
export interface BoxLayer extends LayerBase { type: "box"; props: z.infer<typeof boxProps> }
export interface SphereLayer extends LayerBase { type: "sphere"; props: z.infer<typeof sphereProps> }
export interface ParticlesLayer extends LayerBase { type: "particles"; props: z.infer<typeof particlesProps> }
export interface CaptionsLayer extends LayerBase { type: "captions"; props: z.infer<typeof captionsProps> }
export interface HudLayer extends LayerBase { type: "hud"; props: z.infer<typeof hudProps> }
export interface GroupLayer extends LayerBase { type: "group"; props: { children: SceneLayer[] } }
export type SceneLayer = TextLayer | Text3DLayer | PlaneLayer | LineLayer | BoxLayer | SphereLayer | ParticlesLayer | CaptionsLayer | HudLayer | GroupLayer;
export type LayerType = SceneLayer["type"];

export const layerSchema: z.ZodType<SceneLayer> = z.discriminatedUnion("type", [
  z.strictObject({ id: idStr, type: z.literal("text"), props: textProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("text3d"), props: text3dProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("plane"), props: planeProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("line"), props: lineProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("box"), props: boxProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("sphere"), props: sphereProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("particles"), props: particlesProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("captions"), props: captionsProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({ id: idStr, type: z.literal("hud"), props: hudProps, transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional() }),
  z.strictObject({
    id: idStr, type: z.literal("group"), transform: transformSchema.optional(), keyframes: z.array(keyframeSchema).optional(),
    props: z.strictObject({ children: z.array(z.lazy(() => layerSchema)) }),
  }),
]);

export const backgroundSchema = z.union([
  z.strictObject({ color: colorStr }),
  z.strictObject({ gradient: z.tuple([colorStr, colorStr, z.number()]) }), // [from, to, angleDeg]
  z.strictObject({ transparent: z.literal(true) }), // alpha channel frames - for overlay exports
]);
export type SceneBackground = z.infer<typeof backgroundSchema>;

const cameraKeyframe = z.strictObject({ t: z.number().min(0), position: vec3, target: vec3 });
export const cameraSchema = z.strictObject({
  fov: z.number().min(10).max(140).optional(), // default 50
  keyframes: z.array(cameraKeyframe).min(1),
});
export type CameraSpec = z.infer<typeof cameraSchema>;

export const paramSchema = z.strictObject({
  id: idStr,
  label: z.string().min(1).max(80),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  default: z.number(),
  bind: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.[A-Za-z][A-Za-z0-9_.]*$/, "bind must be <layerId>.<path>"),
});
export type SpecParam = z.infer<typeof paramSchema>;

/** Hard caps - what the runtime/exporter can actually deliver. */
export { SPEC_LIMITS } from "./limits";

/**
 * Post overlays applied by the exporter's ffmpeg chain (never by the live
 * canvas - the preview approximates them with CSS filters):
 *   mono - desaturate during [t0,t1) windows (hue=s=0)
 *   flash - full-frame color flashes: `frames` frames starting at t
 *   glow - screen-blend a blurred copy during [t0,t1) (split→gblur→blend)
 */
const timeWindow = z.strictObject({ t0: z.number().min(0), t1: z.number().min(0) });
export const postSchema = z.strictObject({
  mono: z.array(timeWindow).max(64).optional(),
  flash: z.array(z.strictObject({ t: z.number().min(0), frames: z.number().int().min(1).max(6), color: colorStr.optional() })).max(64).optional(),
  glow: z.array(timeWindow.extend({ strength: factor01, color: colorStr.optional() })).max(64).optional(),
});
export type SpecPost = z.infer<typeof postSchema>;

const specObject = z.strictObject({
  version: z.literal(SCENE_SPEC_VERSION),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  fps: z.number().min(1).max(120),
  duration: z.number().min(0.1).max(600),
  seed: z.number().int().min(0).max(0xffffffff),
  background: backgroundSchema,
  camera: cameraSchema,
  layers: z.array(layerSchema).max(SPEC_LIMITS.maxLayers),
  params: z.array(paramSchema).max(SPEC_LIMITS.maxParams).optional(),
  post: postSchema.optional(),
});

export type SceneSpec = Omit<z.infer<typeof specObject>, "layers" | "background" | "camera" | "params"> & {
  background: SceneBackground;
  camera: CameraSpec;
  layers: SceneLayer[];
  params?: SpecParam[];
};

/** Collect layers depth-first; also returns the first duplicate id found. */
function indexLayers(layers: SceneLayer[], into = new Map<string, SceneLayer>()): { map: Map<string, SceneLayer>; dup: string | null } {
  let dup: string | null = null;
  const walk = (ls: SceneLayer[]) => {
    for (const l of ls) {
      if (into.has(l.id)) { dup ??= l.id; } else into.set(l.id, l);
      if (l.type === "group") walk(l.props.children);
    }
  };
  walk(layers);
  return { map: into, dup };
}

type PropKind = "number" | "string" | "other";

const PROPS_SHAPE_BY_TYPE: Partial<Record<LayerType, Record<string, z.ZodType>>> = {
  text: textProps.shape,
  text3d: text3dProps.shape,
  plane: planeProps.shape,
  line: lineProps.shape,
  box: boxProps.shape,
  sphere: sphereProps.shape,
  particles: particlesProps.shape,
  captions: captionsProps.shape,
  hud: hudProps.shape,
};

function kindOf(field: z.ZodType): PropKind {
  let d = (field as { def?: { type?: string; innerType?: z.ZodType } }).def;
  while (d?.innerType) d = (d.innerType as z.ZodType & { def?: typeof d }).def;
  if (d?.type === "number") return "number";
  if (d?.type === "string" || d?.type === "enum") return "string";
  return "other";
}

const propKindMemo = new Map<LayerType, Map<string, PropKind>>();
/** Is `name` a valid prop for this layer type, and is it numeric/string/other? */
function propKind(layer: SceneLayer, name: string): PropKind | null {
  let m = propKindMemo.get(layer.type);
  if (!m) {
    m = new Map();
    for (const [k, f] of Object.entries(PROPS_SHAPE_BY_TYPE[layer.type] ?? {})) m.set(k, kindOf(f));
    propKindMemo.set(layer.type, m);
  }
  return m.get(name) ?? null;
}

function checkPath(path: string, layer: SceneLayer | undefined, ctx: z.RefinementCtx, what: string, value?: unknown, isParam = false) {
  const [root, sub] = path.split(".");
  if (["position", "rotation", "scale"].includes(root) && sub && !["x", "y", "z"].includes(sub)) {
    ctx.addIssue({ code: "custom", message: `${what}: "${path}" - ${root} only takes .x/.y/.z` });
  }
  if (root === "color" && isParam) {
    ctx.addIssue({ code: "custom", message: `${what}: "color" is a string prop - bind "hue" instead for numeric control` });
  }
  if (root === "props" && layer) {
    if (!sub) {
      ctx.addIssue({ code: "custom", message: `${what}: "props" needs a prop name (props.<name>)` });
    } else if (layer.type === "group") {
      ctx.addIssue({ code: "custom", message: `${what}: groups have no animatable props - keyframe the children instead` });
    } else {
      // validate against the type's prop schema - optional props may be
      // keyframed/bound without being declared on the layer
      const kind = propKind(layer, sub);
      if (kind === null) {
        ctx.addIssue({ code: "custom", message: `${what}: layer "${layer.id}" has no prop "${sub}"` });
      } else if (kind === "other") {
        ctx.addIssue({ code: "custom", message: `${what}: prop "${sub}" is not a numeric or string value` });
      } else if (kind === "string") {
        if (isParam) ctx.addIssue({ code: "custom", message: `${what}: prop "${sub}" is a string - params are numeric` });
        else if (value !== undefined && typeof value !== "string") ctx.addIssue({ code: "custom", message: `${what}: prop "${sub}" takes a string value` });
      } else if (value !== undefined && typeof value !== "number") {
        ctx.addIssue({ code: "custom", message: `${what}: prop "${sub}" takes a numeric value` });
      }
    }
  }
  if (value !== undefined) {
    // string keyframe values are only legal on "color" (or a string-typed
    // props.<name>, handled above) - a string on position.x/scale/… must fail
    if (typeof value === "string") {
      if (root === "color") return;
      if (root === "props") return; // props string kinds were checked above
      ctx.addIssue({ code: "custom", message: `${what}: "${path}" takes a number${sub || ["position", "rotation", "scale"].includes(root) ? " or [x,y,z]" : ""}, not a string` });
      return;
    }
    if (["opacity", "hue"].includes(root) && typeof value !== "number") {
      ctx.addIssue({ code: "custom", message: `${what}: "${root}" takes a numeric value` });
    }
    if (root === "color") {
      ctx.addIssue({ code: "custom", message: `${what}: "color" takes a "#rrggbb" string` });
    }
  }
}

/**
 * Cross-reference + structural-budget checks shared by the full spec schema
 * and the LLM draft schema (generate.ts). The draft has no frame fields, so
 * the pixel/frame budgets stay in sceneSpecSchema - everything the model can
 * get wrong (binds, duplicate ids, keyframe paths, layer/particle budgets)
 * lives here where its repair round can see it.
 */
export function checkSceneRefs(
  draft: { layers: SceneLayer[]; params?: SpecParam[] },
  ctx: z.RefinementCtx,
): void {
  {
    let total = 0;
    let particles = 0;
    let overDepth = false;
    const walk = (ls: SceneLayer[], depth: number) => {
      for (const l of ls) {
        total++;
        if (l.type === "particles") particles += l.props.count;
        // screen-space layers only work top-level - inside a group they'd be
        // built into the 3D scene and never redrawn
        if (depth > 1 && (l.type === "captions" || l.type === "hud")) {
          ctx.addIssue({ code: "custom", message: `layer "${l.id}": ${l.type} is a screen-space overlay - it must be a top-level layer, not nested in a group` });
        }
        if (l.type === "group") {
          if (depth > SPEC_LIMITS.maxGroupDepth) overDepth = true;
          walk(l.props.children, depth + 1);
        }
      }
    };
    walk(draft.layers, 1);
    if (total > SPEC_LIMITS.maxLayers) {
      ctx.addIssue({ code: "custom", message: `${total} layers exceeds the ${SPEC_LIMITS.maxLayers}-layer budget (nested children count)` });
    }
    if (particles > SPEC_LIMITS.maxParticles) {
      ctx.addIssue({ code: "custom", message: `${particles} particles exceeds the ${SPEC_LIMITS.maxParticles} budget` });
    }
    if (overDepth) {
      ctx.addIssue({ code: "custom", message: `group nesting exceeds depth ${SPEC_LIMITS.maxGroupDepth}` });
    }
  }

  const { map, dup } = indexLayers(draft.layers);
  if (dup) ctx.addIssue({ code: "custom", message: `duplicate layer id "${dup}"` });

  const paramIds = new Set<string>();
  for (const p of draft.params ?? []) {
    if (paramIds.has(p.id)) ctx.addIssue({ code: "custom", message: `duplicate param id "${p.id}"` });
    paramIds.add(p.id);
    if (!(p.min < p.max)) ctx.addIssue({ code: "custom", message: `param "${p.id}": min must be < max` });
    if (p.default < p.min || p.default > p.max) ctx.addIssue({ code: "custom", message: `param "${p.id}": default outside [min,max]` });
    if (p.step > p.max - p.min) ctx.addIssue({ code: "custom", message: `param "${p.id}": step larger than range` });
    const dot = p.bind.indexOf(".");
    const layerId = p.bind.slice(0, dot);
    const path = p.bind.slice(dot + 1);
    const layer = map.get(layerId);
    if (!layer) {
      ctx.addIssue({ code: "custom", message: `param "${p.id}" binds unknown layer "${layerId}"` });
      continue;
    }
    // the bind path is a single animatable path - "props.x.y" or
    // "position.x.y" would silently drop trailing segments at render time
    if (!animPath.safeParse(path).success) {
      ctx.addIssue({ code: "custom", message: `param "${p.id}" bind path "${path}" must be position|rotation|scale|opacity|color|hue|props.<name>` });
      continue;
    }
    checkPath(path, layer, ctx, `param "${p.id}"`, undefined, true);
  }

  const walkKfs = (ls: SceneLayer[]) => {
    for (const l of ls) {
      for (const kf of l.keyframes ?? []) checkPath(kf.path, l, ctx, `layer "${l.id}" keyframe`, kf.value);
      if (l.type === "captions") {
        const ws = l.props.words;
        for (let i = 0; i < ws.length; i++) {
          if (!(ws[i].end > ws[i].start)) ctx.addIssue({ code: "custom", message: `captions "${l.id}": word ${i} ("${ws[i].text}") end must be after start` });
          if (i > 0 && ws[i].start < ws[i - 1].start - 1e-9) ctx.addIssue({ code: "custom", message: `captions "${l.id}": words must be in start order (word ${i})` });
        }
        for (const idx of l.props.punch ?? []) {
          if (idx >= ws.length) ctx.addIssue({ code: "custom", message: `captions "${l.id}": punch index ${idx} has no word` });
        }
      }
      if (l.type === "group") walkKfs(l.props.children);
    }
  };
  walkKfs(draft.layers);
}

export const sceneSpecSchema: z.ZodType<SceneSpec> = specObject.superRefine((spec, ctx) => {
  /* --- frame budgets (drafts carry no frame fields - checked here only) --- */
  const longEdge = Math.max(spec.width, spec.height);
  if (longEdge > SPEC_LIMITS.maxEdge) {
    ctx.addIssue({ code: "custom", message: `long edge ${longEdge}px exceeds ${SPEC_LIMITS.maxEdge}px (up to 4K)` });
  }
  if (spec.width * spec.height > SPEC_LIMITS.maxPixels) {
    ctx.addIssue({ code: "custom", message: `${spec.width}×${spec.height} exceeds the ${SPEC_LIMITS.maxPixels}-pixel budget (3840×2160)` });
  }
  if (Math.round(spec.duration * spec.fps) > SPEC_LIMITS.maxFrames) {
    ctx.addIssue({ code: "custom", message: `round(duration×fps) = ${Math.round(spec.duration * spec.fps)} exceeds ${SPEC_LIMITS.maxFrames} frames` });
  }
  for (const w of [...(spec.post?.mono ?? []), ...(spec.post?.glow ?? [])]) {
    if (!(w.t1 > w.t0)) ctx.addIssue({ code: "custom", message: "post window t1 must be after t0" });
  }
  checkSceneRefs(spec, ctx);
}) as z.ZodType<SceneSpec>;

/** Parse a SceneSpec - throws Error with all issues joined by "; ". */
export function parseSceneSpec(input: unknown): SceneSpec {
  const r = sceneSpecSchema.safeParse(input);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid scene spec: ${msg}`);
  }
  return r.data;
}

export function safeParseSceneSpec(input: unknown): { ok: true; spec: SceneSpec } | { ok: false; error: string } {
  try {
    return { ok: true, spec: parseSceneSpec(input) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
