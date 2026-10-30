import { z } from "zod";
import { SENSORS } from "@/lib/camera/lens";
import { filesPathSchema } from "@/lib/render/spec";

/**
 * Stage scene document v1 - the grey-box blocking format the /scene-3d editor
 * writes and the writer LLM produces. Distinct from SceneSpec (the render
 * format): a scene is metres/degrees world-space blocking, not a render list.
 *
 *   meta  {title, duration s (1-60, default 15), fps 24|30,
 *          aspect 16:9|9:16|1:1|4:3|3:4|21:9, renderSize {w,h}}
 *   env   {background #rrggbb, ambient 0-2, sun {intensity 0-5, direction}}
 *   nodes ≤300, each {id, name, parent?, transform{pos m, rot deg, scale},
 *                     keys?[{t,path,value,ease}], prompt?} + a kind payload
 *         kinds: primitive|mannequin|light|camera|model
 *
 * Camera-node convention: transform.rot is [pitch, yaw, roll] degrees in the
 * trajectory engine's world frame (+x right, +y up, +z forward) - NOT a
 * three.js XYZ euler. Other nodes' rot IS an XYZ euler (three.js order).
 * Camera props.path is a world-space Catmull-Rom spline; lookAt is a node id;
 * exactly one camera carries isRender at a time.
 */

export const STAGE_SCENE_VERSION = 1;
export const MAX_SCENE_BYTES = 256 * 1024;
export const MAX_SCENE_NODES = 300;

export const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** default render resolution per aspect - editable afterwards */
export const ASPECT_SIZE: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  "3:4": { w: 1080, h: 1440 },
  "21:9": { w: 2560, h: 1080 },
};

export const PRIMITIVE_SHAPES = ["box", "sphere", "pyramid", "cylinder", "capsule", "plane"] as const;
/** the pose library - joint-rotation data lives in mannequin.ts's POSES;
 *  every id here must resolve there (the builder falls back to "stand") */
export const MANNEQUIN_POSES = [
  "stand", "stand-relaxed",
  "walk", "walk-contact", "walk-passing", "run",
  "point", "wave", "arms-crossed", "look-back",
  "sit", "sit-floor", "kneel", "crouch", "lie-down",
  "fight-stance", "bow", "carry", "push", "think",
  "reach-up", "cheer", "superhero", "dance", "jump", "climb",
] as const;
export type MannequinPose = (typeof MANNEQUIN_POSES)[number];
export type PrimitiveShape = (typeof PRIMITIVE_SHAPES)[number];
export type LightKind = (typeof LIGHT_KINDS)[number];
export const LIGHT_KINDS = ["sun", "point", "spot"] as const;
export const NODE_KINDS = ["primitive", "mannequin", "light", "camera", "model"] as const;
const SENSOR_NAMES = Object.keys(SENSORS) as [string, ...string[]];
export const SENSORS_LIST = Object.keys(SENSORS);

const idStr = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "id must start with a letter; letters/digits/_/- only");
export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof vec3>;
export const colorHex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb");
export const easeSchema = z.enum(["linear", "easeInOut", "easeOut", "spring"]);
export type EaseName = z.infer<typeof easeSchema>;

/** per-kind animatable prop whitelist - key paths outside this never parse */
const KEYABLE_PROPS: Record<(typeof NODE_KINDS)[number], Set<string>> = {
  primitive: new Set(["size", "color"]),
  mannequin: new Set(["height"]),
  light: new Set(["color", "intensity", "angle", "range"]),
  camera: new Set(["focalMm"]),
  model: new Set(),
};
const KEY_PATH = /^(transform\.(pos|rot|scale)|props\.[A-Za-z][A-Za-z0-9_]*)$/;

export const keySchema = z.strictObject({
  t: z.number().min(0),
  path: z.string().regex(KEY_PATH, "key path must be transform.pos|rot|scale or props.<name>"),
  value: z.union([z.number(), vec3, colorHex]),
  ease: easeSchema.optional(), // defaults to linear at sample time
});
export type StageKey = z.infer<typeof keySchema>;

export const transformSchema = z.strictObject({
  pos: vec3,       // metres
  rot: vec3,       // degrees - XYZ euler; camera nodes use [pitch,yaw,roll]
  scale: vec3,
});
export type StageTransform = z.infer<typeof transformSchema>;

export const cameraPathSchema = z.strictObject({
  points: z.array(vec3).min(2).max(64),   // world-space Catmull-Rom control points
  times: z.array(z.number().min(0)),       // seconds, sorted, same length as points
}).refine((p) => p.times.length === p.points.length, { message: "times must match points" })
  .refine((p) => p.times.every((t, i) => i === 0 || t > p.times[i - 1]), { message: "times must be increasing" });
export type CameraPath = z.infer<typeof cameraPathSchema>;

/* ---------- kind payloads (stored under a uniform `props` object) ---------- */

const primitiveProps = z.strictObject({
  shape: z.enum(PRIMITIVE_SHAPES),
  size: vec3,                                  // bounding dims, metres
  color: colorHex,
});
const mannequinProps = z.strictObject({
  pose: z.enum(MANNEQUIN_POSES),
  height: z.number().min(0.5).max(2.5),        // metres
});
const lightProps = z.strictObject({
  light: z.enum(LIGHT_KINDS),
  color: colorHex,
  intensity: z.number().min(0).max(50),
  angle: z.number().min(1).max(89),            // spot cone, degrees
  range: z.number().min(0).max(200),           // point/spot falloff, m; 0 = unlimited
});
const cameraProps = z.strictObject({
  focalMm: z.number().min(8).max(300),
  sensor: z.enum(SENSOR_NAMES),
  path: cameraPathSchema.optional(),
  lookAt: idStr.optional(),                    // aim at this node's position
  isRender: z.boolean(),
});
const modelProps = z.strictObject({
  src: filesPathSchema.regex(/\.glb$/i, "model src must be a /files/….glb"),
});

const nodeBase = {
  id: idStr,
  name: z.string().min(1).max(80),
  parent: idStr.optional(),
  transform: transformSchema,
  keys: z.array(keySchema).max(8192).optional(),
  /** per-object prompt text, kept for the s5 render pass */
  prompt: z.string().max(2000).optional(),
};

export const stageNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...nodeBase, kind: z.literal("primitive"), props: primitiveProps }),
  z.strictObject({ ...nodeBase, kind: z.literal("mannequin"), props: mannequinProps }),
  z.strictObject({ ...nodeBase, kind: z.literal("light"), props: lightProps }),
  z.strictObject({ ...nodeBase, kind: z.literal("camera"), props: cameraProps }),
  z.strictObject({ ...nodeBase, kind: z.literal("model"), props: modelProps }),
]);
export type StageNode = z.infer<typeof stageNodeSchema>;
export type StageCameraNode = Extract<StageNode, { kind: "camera" }>;

export const stageMetaSchema = z.strictObject({
  title: z.string().min(1).max(120),
  duration: z.number().min(1).max(60),         // seconds
  fps: z.union([z.literal(24), z.literal(30)]),
  aspect: z.enum(ASPECTS),
  renderSize: z.strictObject({
    w: z.number().int().min(64).max(4096),
    h: z.number().int().min(64).max(4096),
  }),
});
export type StageMeta = z.infer<typeof stageMetaSchema>;

export const stageEnvSchema = z.strictObject({
  background: colorHex,
  ambient: z.number().min(0).max(2),           // ambient-light intensity
  sun: z.strictObject({
    intensity: z.number().min(0).max(5),
    direction: vec3,                           // direction TO the scene, metres vector
  }),
});
export type StageEnv = z.infer<typeof stageEnvSchema>;

const sceneShape = z.strictObject({
  version: z.literal(STAGE_SCENE_VERSION),
  meta: stageMetaSchema,
  env: stageEnvSchema,
  nodes: z.array(stageNodeSchema).max(MAX_SCENE_NODES),
});

export type StageScene = z.infer<typeof sceneShape>;

function keyable(node: StageNode, path: string): boolean {
  if (path.startsWith("transform.")) return true;
  const prop = path.slice("props.".length);
  return KEYABLE_PROPS[node.kind].has(prop);
}

/** structural checks the flat schema can't express */
function refineScene(s: StageScene, ctx: z.RefinementCtx) {
  const ids = new Map<string, StageNode>();
  for (const n of s.nodes) {
    if (ids.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id "${n.id}"` });
    ids.set(n.id, n);
  }
  // parents exist, no self-parent, no cycles
  for (const n of s.nodes) {
    if (n.parent === n.id) ctx.addIssue({ code: "custom", message: `"${n.id}" parents itself` });
    if (n.parent && !ids.has(n.parent)) ctx.addIssue({ code: "custom", message: `"${n.id}": parent "${n.parent}" doesn't exist` });
  }
  for (const n of s.nodes) {
    const seen = new Set<string>();
    let cur = n.parent;
    while (cur) {
      if (cur === n.id || seen.has(cur)) {
        ctx.addIssue({ code: "custom", message: `parent cycle through "${n.id}"` });
        break;
      }
      seen.add(cur);
      cur = ids.get(cur)?.parent;
    }
    // key-path whitelist per kind
    for (const k of n.keys ?? []) {
      if (!keyable(n, k.path)) {
        ctx.addIssue({ code: "custom", message: `"${n.id}": "${k.path}" is not an animatable path for a ${n.kind}` });
      }
    }
    if (n.kind === "camera" && n.props.lookAt && !ids.has(n.props.lookAt)) {
      ctx.addIssue({ code: "custom", message: `"${n.id}": lookAt "${n.props.lookAt}" doesn't exist` });
    }
  }
  const renderCams = s.nodes.filter((n) => n.kind === "camera" && n.props.isRender);
  if (renderCams.length !== 1) {
    ctx.addIssue({ code: "custom", message: `exactly one camera must be isRender (have ${renderCams.length})` });
  }
}

export const stageSceneSchema = sceneShape.superRefine(refineScene);

export function parseStageScene(raw: unknown): StageScene {
  return stageSceneSchema.parse(raw);
}

/** serialized-size guard - the stored document must stay under 256 KB.
 *  TextEncoder, not Buffer: this runs in the browser too. */
export function assertSceneFits(scene: StageScene): void {
  const bytes = new TextEncoder().encode(JSON.stringify(scene)).byteLength;
  if (bytes > MAX_SCENE_BYTES) throw new Error(`scene is ${(bytes / 1024).toFixed(1)} KB (max ${MAX_SCENE_BYTES / 1024} KB)`);
}

/* ---------- factories ---------- */

export function newNodeId(taken: Set<string>): string {
  for (;;) {
    const id = `n_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    if (!taken.has(id)) return id;
  }
}

const t0 = (): StageTransform => ({ pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });

export function defaultPrimitive(shape: (typeof PRIMITIVE_SHAPES)[number]): Extract<StageNode, { kind: "primitive" }>["props"] {
  return { shape, size: [1, 1, 1], color: "#8b93a3" };
}
export function defaultMannequin(): Extract<StageNode, { kind: "mannequin" }>["props"] {
  return { pose: "stand", height: 1.7 };
}
export function defaultLight(light: (typeof LIGHT_KINDS)[number]): Extract<StageNode, { kind: "light" }>["props"] {
  return { light, color: "#ffffff", intensity: light === "sun" ? 2.5 : 8, angle: 30, range: 0 };
}
export function defaultCamera(): Extract<StageNode, { kind: "camera" }>["props"] {
  return { focalMm: 35, sensor: "full_frame", isRender: false };
}
export function defaultModel(src: string): Extract<StageNode, { kind: "model" }>["props"] {
  return { src };
}

const KIND_LABEL: Record<(typeof NODE_KINDS)[number], string> = {
  primitive: "Primitive", mannequin: "Mannequin", light: "Light", camera: "Camera", model: "Model",
};

/** a ready-to-use node: id + defaults filled, valid against stageNodeSchema */
export function makeNode(
  kind: (typeof NODE_KINDS)[number],
  opts: { id: string; name?: string; props?: Partial<StageNode["props"]> } & Partial<Omit<StageNode, "kind" | "props">>,
): StageNode {
  const { id, name, props, ...rest } = opts;
  const base = { id, name: name ?? `${KIND_LABEL[kind]} ${id.slice(-4)}`, transform: t0(), ...rest };
  switch (kind) {
    case "primitive": return { ...base, kind, props: { ...defaultPrimitive("box"), ...props } } as StageNode;
    case "mannequin": return { ...base, kind, props: { ...defaultMannequin(), ...props } } as StageNode;
    case "light": return { ...base, kind, props: { ...defaultLight("point"), ...props } } as StageNode;
    case "camera": return { ...base, kind, props: { ...defaultCamera(), ...props } } as StageNode;
    case "model": return { ...base, kind, props: props as Extract<StageNode, { kind: "model" }>["props"] } as StageNode;
  }
}

export function defaultEnv(): StageEnv {
  return { background: "#101318", ambient: 0.6, sun: { intensity: 2.5, direction: [-0.5, -1, -0.6] } };
}

/** The shared default render-camera pose (pos metres, rot [pitch,yaw,roll]
 *  deg - 0,0,0 aims +z). emptyScene, the writer's no-camera fallback and
 *  the exporter's no-camera spec all build from this one constant so a
 *  fresh scene always opens aimed at the stage. Eye-level ~1.5 m with a
 *  mild down-tilt: the horizon sits in the upper third and a standing
 *  subject at the origin reads as a medium shot. */
export const DEFAULT_RENDER_CAM: { pos: Vec3; rot: Vec3 } = {
  pos: [0, 1.5, 6],
  rot: [-6, 180, 0],
};

/** the "empty scene" - a render camera, a sun, a ground plane */
export function emptyScene(opts: { title?: string; duration?: number; fps?: 24 | 30; aspect?: Aspect } = {}): StageScene {
  const aspect = opts.aspect ?? "16:9";
  const cam = makeNode("camera", {
    id: "cam_main",
    name: "Camera",
    transform: { pos: [...DEFAULT_RENDER_CAM.pos], rot: [...DEFAULT_RENDER_CAM.rot], scale: [1, 1, 1] },
    props: { focalMm: 35, sensor: "full_frame", isRender: true },
  });
  const sun = makeNode("light", {
    id: "light_sun",
    name: "Sun",
    props: defaultLight("sun"),
  });
  const ground = makeNode("primitive", {
    id: "ground",
    name: "Ground",
    transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
    props: { shape: "plane", size: [24, 1, 24], color: "#232833" },
  });
  return stageSceneSchema.parse({
    version: STAGE_SCENE_VERSION,
    meta: {
      title: opts.title ?? "Untitled scene",
      duration: opts.duration ?? 15,
      fps: opts.fps ?? 24,
      aspect,
      renderSize: { ...ASPECT_SIZE[aspect] },
    },
    env: defaultEnv(),
    nodes: [ground, cam, sun],
  });
}

export function renderCamera(scene: StageScene): StageCameraNode | undefined {
  return scene.nodes.find((n): n is StageCameraNode => n.kind === "camera" && n.props.isRender)
    ?? scene.nodes.find((n): n is StageCameraNode => n.kind === "camera");
}

export function nodeById(scene: StageScene, id: string): StageNode | undefined {
  return scene.nodes.find((n) => n.id === id);
}
