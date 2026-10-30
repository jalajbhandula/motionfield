import { z } from "zod";
import {
  ASPECT_SIZE,
  cameraPathSchema,
  defaultCamera,
  defaultLight,
  defaultMannequin,
  defaultPrimitive,
  keySchema,
  newNodeId,
  stageEnvSchema,
  stageMetaSchema,
  stageSceneSchema,
  transformSchema,
  NODE_KINDS,
  type StageNode,
  type StageScene,
} from "../scene";
// circular-by-design: moves.ts borrows StageOpError from this module; both
// sides only dereference the binding inside function bodies, so the ESM
// cycle never reads an uninitialized export
import { applyMoveToCamera, matchStageMoveId } from "../moves";

/**
 * Stage ops - the edit vocabulary the prompt route speaks. The writer LLM
 * returns {ops:[…]}; applyOps validates each op against a per-kind path
 * whitelist, applies them to a clone, then re-validates the whole scene -
 * an op that would corrupt the document fails 400 with the scene untouched.
 *
 * `update` writes a whitelisted `path` (never a free-form pointer - so
 * "__proto__"/"constructor"/"prototype" segments can't smuggle writes).
 */

export class StageOpError extends Error {
  name = "StageOpError";
}

const idStr = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

/** the node shape an `add` op carries - id/transform/props may be sparse,
 *  defaults fill in before the scene is re-validated */
const draftNode = z.strictObject({
  id: idStr.optional(),
  name: z.string().min(1).max(80).optional(),
  parent: idStr.nullish(),
  kind: z.enum(NODE_KINDS),
  transform: transformSchema.partial().optional(),
  keys: z.array(keySchema).optional(),
  prompt: z.string().max(2000).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

export const stageOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), node: draftNode }),
  z.strictObject({ op: z.literal("update"), id: idStr, path: z.string().min(1).max(80), value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), id: idStr }),
  z.strictObject({ op: z.literal("set_camera_path"), id: idStr, path: cameraPathSchema.nullable() }),
  z.strictObject({
    op: z.literal("apply_move"),
    id: idStr,
    move: z.string().min(1).max(64),
    strength: z.number().min(0.25).max(2).optional(),
    duration_s: z.number().min(0.1).max(120).optional(),
    seed: z.number().int().min(0).optional(),
  }),
  z.strictObject({ op: z.literal("set_keys"), id: idStr, keys: z.array(keySchema) }),
  z.strictObject({
    op: z.literal("set_env"),
    env: stageEnvSchema.partial().extend({ sun: stageEnvSchema.shape.sun.partial().optional() }),
  }),
  z.strictObject({
    op: z.literal("set_meta"),
    meta: stageMetaSchema.partial(),
  }),
]);
export type StageOp = z.infer<typeof stageOpSchema>;

export const stageOpsResponseSchema = z.strictObject({
  ops: z.array(stageOpSchema).max(200),
});

/* ---------- update-path whitelist ---------- */

const BASE_PATHS = new Set(["name", "prompt", "parent", "transform.pos", "transform.rot", "transform.scale"]);
const PROP_PATHS: Record<string, Set<string>> = {
  primitive: new Set(["props.size", "props.color"]),
  mannequin: new Set(["props.pose", "props.height"]),
  light: new Set(["props.color", "props.intensity", "props.angle", "props.range"]),
  camera: new Set(["props.focalMm", "props.sensor", "props.lookAt", "props.isRender"]),
  model: new Set(["props.src"]),
};

function allowedPaths(node: StageNode): Set<string> {
  return new Set([...BASE_PATHS, ...(PROP_PATHS[node.kind] ?? [])]);
}

/** a path segment that could write outside the intended object graph */
const FORBIDDEN_SEG = /(^|\.)(__proto__|constructor|prototype)(\.|$)/;

function setPath(node: StageNode, path: string, value: unknown): void {
  if (FORBIDDEN_SEG.test(path)) throw new StageOpError(`forbidden path "${path}"`);
  const rec = node as unknown as Record<string, unknown>;
  switch (path) {
    case "name": rec.name = value; return;
    case "prompt": rec.prompt = value; return;
    case "parent": {
      if (value === null) { delete rec.parent; return; }
      rec.parent = value;
      return;
    }
    default: break;
  }
  const seg = path.split(".");
  if (seg[0] === "transform") {
    (rec.transform as Record<string, unknown>)[seg[1]] = value;
    return;
  }
  if (seg[0] === "props") {
    (rec.props as Record<string, unknown>)[seg[1]] = value;
    return;
  }
  throw new StageOpError(`forbidden path "${path}"`);
}

/** props defaults per kind so an LLM `add` can omit them */
function draftDefaults(kind: StageNode["kind"], props: Record<string, unknown> | undefined): Record<string, unknown> {
  const base =
    kind === "primitive" ? defaultPrimitive(String(props?.shape ?? "box") as never)
    : kind === "mannequin" ? defaultMannequin()
    : kind === "light" ? defaultLight(String(props?.light ?? "point") as never)
    : kind === "camera" ? defaultCamera()
    : { src: "" };
  return { ...base, ...(props ?? {}) };
}

function findNode(scene: StageScene, id: string): StageNode {
  const n = scene.nodes.find((x) => x.id === id);
  if (!n) throw new StageOpError(`node "${id}" doesn't exist`);
  return n;
}

/**
 * Apply ops to a clone of `scene`; returns the validated result.
 * opts.selection scopes every op to that node (and nodes it `add`s under it):
 * an op that reaches outside the selection throws StageOpError.
 */
export function applyOps(scene: StageScene, ops: StageOp[], opts: { selection?: string } = {}): StageScene {
  const next = JSON.parse(JSON.stringify(scene)) as StageScene;
  const sel = opts.selection;

  const guardSel = (id: string | undefined, op: string) => {
    if (sel && id !== sel) throw new StageOpError(`"${op}" targets "${id}" - selection is "${sel}"`);
  };

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const taken = new Set(next.nodes.map((n) => n.id));
        const draft = op.node;
        const parent = sel ? (draft.parent ?? sel) : draft.parent ?? undefined;
        if (sel && draft.parent && draft.parent !== sel) {
          throw new StageOpError(`"add" parents "${draft.parent}" - selection is "${sel}"`);
        }
        const node: StageNode = {
          id: draft.id ?? newNodeId(taken),
          name: draft.name ?? `${draft.kind} node`,
          ...(parent ? { parent } : {}),
          transform: {
            pos: draft.transform?.pos ?? [0, 0, 0],
            rot: draft.transform?.rot ?? [0, 0, 0],
            scale: draft.transform?.scale ?? [1, 1, 1],
          },
          ...(draft.keys ? { keys: draft.keys } : {}),
          ...(draft.prompt ? { prompt: draft.prompt } : {}),
          kind: draft.kind,
          props: draftDefaults(draft.kind, draft.props),
        } as StageNode;
        next.nodes.push(node);
        break;
      }
      case "update": {
        guardSel(op.id, "update");
        const node = findNode(next, op.id);
        if (!allowedPaths(node).has(op.path)) {
          throw new StageOpError(`"${op.path}" is not editable on a ${node.kind}`);
        }
        setPath(node, op.path, op.value);
        break;
      }
      case "remove": {
        guardSel(op.id, "remove");
        const node = findNode(next, op.id);
        const i = next.nodes.indexOf(node);
        next.nodes.splice(i, 1);
        // children re-root to the removed node's parent rather than dangling
        for (const n of next.nodes) if (n.parent === node.id) n.parent = node.parent;
        // dead lookAt refs clear rather than fail validation
        for (const n of next.nodes) {
          if (n.kind === "camera" && n.props.lookAt === node.id) delete n.props.lookAt;
        }
        break;
      }
      case "set_camera_path": {
        guardSel(op.id, "set_camera_path");
        const node = findNode(next, op.id);
        if (node.kind !== "camera") throw new StageOpError(`"${op.id}" is not a camera`);
        if (op.path === null) delete node.props.path;
        else node.props.path = op.path;
        break;
      }
      case "apply_move": {
        guardSel(op.id, "apply_move");
        const node = findNode(next, op.id);
        if (node.kind !== "camera") throw new StageOpError(`"${op.id}" is not a camera`);
        // bakes the catalog move into the camera's keys - the same edit the
        // editor's "Apply move" button runs, so sampling stays identical
        const moveId = matchStageMoveId(op.move) ?? op.move;
        applyMoveToCamera(next, op.id, moveId, { strength: op.strength ?? 1, seed: op.seed ?? 0, durationS: op.duration_s });
        break;
      }
      case "set_keys": {
        guardSel(op.id, "set_keys");
        findNode(next, op.id).keys = op.keys;
        break;
      }
      case "set_env": {
        if (sel) throw new StageOpError(`"set_env" is scene-global - selection is "${sel}"`);
        const { sun, ...rest } = op.env;
        Object.assign(next.env, rest);
        if (sun) Object.assign(next.env.sun, sun);
        break;
      }
      case "set_meta": {
        if (sel) throw new StageOpError(`"set_meta" is scene-global - selection is "${sel}"`);
        const { aspect, renderSize, ...rest } = op.meta;
        Object.assign(next.meta, rest);
        if (aspect) {
          next.meta.aspect = aspect;
          // aspect change without an explicit renderSize re-derives it
          next.meta.renderSize = renderSize ?? { ...ASPECT_SIZE[aspect] };
        } else if (renderSize) {
          next.meta.renderSize = renderSize;
        }
        break;
      }
    }
  }

  const parsed = stageSceneSchema.safeParse(next);
  if (!parsed.success) {
    throw new StageOpError(parsed.error.issues[0]?.message ?? "ops produced an invalid scene");
  }
  return parsed.data;
}
