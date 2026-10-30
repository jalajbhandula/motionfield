import { z } from "zod";
import { chatJson } from "@/lib/llm/index";
import {
  ASPECTS,
  ASPECT_SIZE,
  DEFAULT_RENDER_CAM,
  MANNEQUIN_POSES,
  PRIMITIVE_SHAPES,
  defaultEnv,
  makeNode,
  newNodeId,
  stageSceneSchema,
  NODE_KINDS,
  type Aspect,
  type StageNode,
  type StageScene,
} from "./scene";
import { SENSORS, type SensorName } from "@/lib/camera/lens";
import { applyMoveToCamera, matchStageMoveId } from "./moves";
import type { StageKey } from "./scene";

/**
 * Prompt → scene draft via the per-user "writer" route. The LLM emits a
 * compact draft (flat nodes, sparse fields); draftToScene fills ids, kind
 * defaults and the scene envelope, guarantees one isRender camera, then the
 * full stage schema validates. Anything else is a parse failure - chatJson's
 * repair turn gets one shot, then the route surfaces the error.
 */

const v3 = z.tuple([z.number(), z.number(), z.number()]);

// a model node can only reference an owned /files/….glb the writer can't
// know - so drafts never emit "model" (users add models in the editor)
const draftNode = z.strictObject({
  kind: z.enum(NODE_KINDS.filter((k) => k !== "model") as [typeof NODE_KINDS[number], ...typeof NODE_KINDS[number][]]),
  name: z.string().min(1).max(60),
  pos: v3.optional(),
  rot: v3.optional(),
  scale: v3.optional(),
  parent: z.string().optional(),          // parent by NAME - resolved after id assign
  prompt: z.string().max(300).optional(),
  shape: z.enum(PRIMITIVE_SHAPES).optional(),
  size: v3.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  pose: z.enum(MANNEQUIN_POSES).optional(),
  height: z.number().min(0.5).max(2.5).optional(),
  light: z.enum(["sun", "point", "spot"]).optional(),
  intensity: z.number().min(0).max(50).optional(),
  angle: z.number().min(1).max(89).optional(),
  range: z.number().min(0).max(200).optional(),
  focalMm: z.number().min(8).max(300).optional(),
  sensor: z.enum(Object.keys(SENSORS) as [string, ...string[]]).optional(),
  lookAt: z.string().optional(),          // by NAME - resolved after id assign
  move: z.string().min(1).max(64).optional(),       // catalog move name/id, fuzzy-matched
  moveStrength: z.number().min(0.25).max(2).optional(),
  keys: z.array(z.strictObject({                  // sparse camera keys - t is seconds
    t: z.number().min(0),
    pos: v3.optional(),
    rot: v3.optional(),                            // [pitch,yaw,roll] degrees
    focalMm: z.number().min(8).max(300).optional(),
  })).min(2).max(24).optional(),
  path: z.strictObject({                          // explicit spline - world points + seconds
    points: z.array(v3).min(2).max(64),
    times: z.array(z.number().min(0)).min(2).max(64),
  }).optional(),
});

export const stageDraftSchema = z.strictObject({
  title: z.string().min(1).max(80),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  ambient: z.number().min(0).max(2).optional(),
  sun: z.number().min(0).max(5).optional(),
  nodes: z.array(draftNode).min(1).max(40),
});
export type StageDraft = z.infer<typeof stageDraftSchema>;

export const STAGE_WRITER_SYSTEM = `You write scene-blocking drafts for a grey-box 3D stage editor.

Reply with ONLY a JSON object: {"title": string, "background": "#rrggbb"?, "ambient": 0-2?, "sun": 0-5?, "nodes": [...]}.

Each node: {"kind","name","pos"?:[x,y,z metres],"rot"?:[rx,ry,rz degrees],"scale"?:[sx,sy,sz],"parent"?: name of an earlier node,"prompt"?: short note,"shape"?,"size"?:[w,h,d],"color"?:"#rrggbb","pose"?,"height"?,"light"?,"intensity"?,"angle"?,"range"?,"focalMm"?,"sensor"?,"lookAt"?: name}.

kinds:
- "primitive" - shape one of ${PRIMITIVE_SHAPES.join("|")}; size is bounding dims in metres; "plane" is horizontal ground.
- "mannequin" - a stock figure; pose one of ${MANNEQUIN_POSES.join("|")}; height 0.5-2.5 m.
- "light" - light: "sun"|"point"|"spot"; plus color/intensity/angle (spot cone deg)/range (m, 0 = unlimited).
- "camera" - a shot camera; "focalMm" 8-300 on sensor (${Object.keys(SENSORS).join("|")}); "lookAt" aims it at a named node. Include exactly one camera - it becomes the render camera. Camera rot is [pitch,yaw,roll] degrees (0,0,0 = looking +z, y up).

Camera motion - give the shot a move whenever the brief implies one ("the camera pushes in", "orbit", "crane up"):
- "move": a catalog move name - dolly-in, dolly-out, truck-left, truck-right, pan-left, pan-right, tilt-up, tilt-down, arc-left-45, arc-right-45, orbit-360, crane-up, crane-down, pedestal-up, pedestal-down, zoom-in, zoom-out, handheld (fuzzy-matched, e.g. "push in" resolves to dolly-in).
- "moveStrength": 0.25-2, subtlety of the move (default 1).
- "keys": sparse camera keyframes [{"t":seconds,"pos"?,"rot"?,"focalMm"?},…] - use when the move needs custom framing beats.
- "path": explicit spline {"points":[[x,y,z],…],"times":[s,…]} - the most exact control; prefer "move" or "keys" first.

Blocking rules: the floor is y=0; stage left is −x; metres, not pixels. Place 3-12 nodes - a scene is a readable arrangement, not a crowd. Keep the subject near the origin and aim the camera at it (use lookAt).`;

export interface StageBrief {
  prompt: string;
  duration?: number;
  fps?: 24 | 30;
  aspect?: Aspect;
  /** vision-read ref descriptions, already owner-checked upstream */
  refs?: { url: string; description?: string }[];
}

export function stageWriterMessages(brief: StageBrief) {
  const refLines = (brief.refs ?? []).map((r, i) =>
    `  ref ${i + 1}: ${r.url}${r.description ? ` - ${r.description}` : " (not previewed)"}`);
  const user = [
    `Scene prompt: ${brief.prompt}`,
    `Duration: ${brief.duration ?? 15}s at ${brief.fps ?? 24}fps, aspect ${brief.aspect ?? "16:9"}.`,
    refLines.length ? `Reference images:\n${refLines.join("\n")}` : "",
    "Return the JSON scene draft.",
  ].filter(Boolean).join("\n");
  return [
    { role: "system" as const, content: STAGE_WRITER_SYSTEM },
    { role: "user" as const, content: user },
  ];
}

/** draft → validated scene: ids assigned, name refs resolved, defaults filled */
export function draftToScene(draft: StageDraft, opts: { duration?: number; fps?: 24 | 30; aspect?: Aspect }): StageScene {
  const aspect = opts.aspect ?? "16:9";
  const taken = new Set<string>();
  const byName = new Map<string, string>();
  const nodes: StageNode[] = [];

  for (const d of draft.nodes) {
    const id = newNodeId(taken);
    taken.add(id);
    byName.set(d.name, id);
    const transform = {
      pos: (d.pos ?? [0, 0, 0]) as [number, number, number],
      rot: (d.rot ?? [0, 0, 0]) as [number, number, number],
      scale: (d.scale ?? [1, 1, 1]) as [number, number, number],
    };
    const common = { id, name: d.name, transform, ...(d.prompt ? { prompt: d.prompt } : {}) };
    let node: StageNode;
    switch (d.kind) {
      case "primitive":
        node = makeNode("primitive", { ...common, props: { shape: d.shape ?? "box", size: d.size ?? [1, 1, 1], color: d.color ?? "#8b93a3" } });
        break;
      case "mannequin":
        node = makeNode("mannequin", { ...common, props: { pose: d.pose ?? "stand", height: d.height ?? 1.7 } });
        break;
      case "light":
        node = makeNode("light", { ...common, props: { light: d.light ?? "point", color: d.color ?? "#ffffff", intensity: d.intensity ?? 8, angle: d.angle ?? 30, range: d.range ?? 0 } });
        break;
      case "camera": {
        const props: Extract<StageNode, { kind: "camera" }>["props"] = {
          focalMm: d.focalMm ?? 35,
          sensor: (d.sensor ?? "full_frame") as SensorName,
          isRender: false,
        };
        if (d.path && d.path.times.length === d.path.points.length
          && d.path.times.every((t, i) => i === 0 || t > d.path!.times[i - 1])) {
          props.path = d.path;
        }
        node = makeNode("camera", { ...common, props });
        if (d.keys?.length) {
          const ks: StageKey[] = [];
          for (const k of d.keys) {
            if (k.pos) ks.push({ t: k.t, path: "transform.pos", value: k.pos });
            if (k.rot) ks.push({ t: k.t, path: "transform.rot", value: k.rot });
            if (k.focalMm) ks.push({ t: k.t, path: "props.focalMm", value: k.focalMm });
          }
          node.keys = ks;
        }
        break;
      }
      default:
        throw new Error(`unexpected draft kind ${(d as { kind: string }).kind}`);
    }
    nodes.push(node);
  }

  // name → id resolution for parent/lookAt (unknown names simply drop)
  for (let i = 0; i < draft.nodes.length; i++) {
    const d = draft.nodes[i];
    const n = nodes[i];
    if (d.parent) {
      const pid = byName.get(d.parent);
      if (pid && pid !== n.id) n.parent = pid;
    }
    if (d.kind === "camera" && d.lookAt) {
      const tid = byName.get(d.lookAt);
      if (tid) (n as Extract<StageNode, { kind: "camera" }>).props.lookAt = tid;
    }
  }

  // exactly one render camera - first camera wins, or one is created
  const cams = nodes.filter((n): n is Extract<StageNode, { kind: "camera" }> => n.kind === "camera");
  if (cams.length) cams[0].props.isRender = true;
  else {
    nodes.push(makeNode("camera", {
      id: newNodeId(taken),
      name: "Camera",
      transform: { pos: [...DEFAULT_RENDER_CAM.pos], rot: [...DEFAULT_RENDER_CAM.rot], scale: [1, 1, 1] },
      props: { focalMm: 35, sensor: "full_frame" as SensorName, isRender: true },
    }));
  }

  const env = defaultEnv();
  if (draft.background) env.background = draft.background;
  if (draft.ambient !== undefined) env.ambient = draft.ambient;
  if (draft.sun !== undefined) env.sun.intensity = draft.sun;

  const scene = stageSceneSchema.parse({
    version: 1,
    meta: {
      title: draft.title.slice(0, 80),
      duration: opts.duration ?? 15,
      fps: opts.fps ?? 24,
      aspect,
      renderSize: { ...ASPECT_SIZE[aspect] },
    },
    env,
    nodes,
  });

  // catalog moves bake into the camera's keys - the same code path the
  // editor's Apply button and the apply_move op take. An unmatched name is
  // ignored (the writer was told the catalog; a hallucinated one is a
  // no-op rather than a failed draft).
  draft.nodes.forEach((d, i) => {
    if (d.kind !== "camera" || !d.move) return;
    const moveId = matchStageMoveId(d.move);
    if (moveId) applyMoveToCamera(scene, nodes[i].id, moveId, { strength: d.moveStrength ?? 1 });
  });

  return scene;
}

/** one writer round trip → a validated scene (throws on hard failure) */
export async function writeStageScene(brief: StageBrief, opts: { userId?: string; signal?: AbortSignal } = {}): Promise<StageScene> {
  const { data } = await chatJson("writer", stageDraftSchema, {
    messages: stageWriterMessages(brief),
    temperature: 0.5,
    think: false,
    signal: opts.signal,
  }, { userId: opts.userId });
  return draftToScene(data, { duration: brief.duration, fps: brief.fps, aspect: brief.aspect });
}
