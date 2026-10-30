import { z } from "zod";
import { ok, toolError, type ToolDef } from "../../registry.mts";

/** Stage - the /api/stage 3D-scene surface (a capability, not a catalog
 *  endpoint). Scenes are owned: a foreign or missing id is the API's
 *  not_found. Writes carry optimistic concurrency - apply/restore need the
 *  head rev you last read; a stale one is stale_revision + head_rev. */

const Action = z.enum(["list", "create", "get", "inspect", "apply", "revisions", "revision", "restore"]);

const Input = z.object({
  action: Action.describe("which Stage call to make"),
  id: z.string().optional()
    .describe("the scene uuid - required for get/inspect/apply/revisions/revision/restore"),
  // create
  prompt: z.string().optional()
    .describe("create - a scene brief for the writer (needs a configured LLM; use empty:true without one)"),
  empty: z.boolean().optional()
    .describe("create - mint the default camera+ground scene, no LLM"),
  refs: z.array(z.string()).optional()
    .describe("create - /files/ image urls you own, handed to the writer"),
  duration: z.number().optional().describe("create - scene duration in seconds"),
  aspect: z.string().optional().describe("create - aspect ratio (e.g. '16:9')"),
  fps: z.number().optional().describe("create - frames per second"),
  // inspect
  view: z.enum(["meta", "tree", "shots", "physics", "problems"]).optional()
    .describe("inspect - which report (tree = the readable scene summary)"),
  rev: z.number().int().min(1).optional()
    .describe("inspect|revision - read this stored revision instead of head"),
  // apply / restore
  base_revision: z.number().int().min(1).optional()
    .describe("apply|restore - the rev you last saw; a stale one is stale_revision carrying head_rev"),
  ops: z.array(z.record(z.string(), z.unknown())).optional()
    .describe("apply - the typed ops to run (1-200). Op shapes: " +
      "{op:'add',node} · {op:'update',id,path,value} · {op:'remove',id} · " +
      "{op:'set_camera_path',id,path|null} · " +
      "{op:'apply_move',id,move,strength?,duration_s?,seed?} - bakes a catalog camera " +
      "move onto the camera ('dolly-in','truck-left','pan-right','orbit-left-45'," +
      "'crane-up','zoom-in','handheld-subtle',…; fuzzy names like 'push in' match) · " +
      "{op:'set_keys',id,keys:[{t,path:'transform.pos|transform.rot|props.<name>',value}]} · " +
      "{op:'set_env',env} · {op:'set_meta',meta} · {op:'rename',id,name} · {op:'reparent',id,parent}"),
  selection: z.string().optional()
    .describe("apply - a node id the ops are scoped to"),
  idempotency_key: z.string().optional()
    .describe("apply - dedupes retries ([A-Za-z0-9_-]{1,128}); a reused key with a different body is idempotency_mismatch"),
  dry_run: z.boolean().optional()
    .describe("apply - validate the ops and return the resulting scene WITHOUT writing a revision"),
});

export default {
  name: "stage",
  toolset: "3d",
  capability: "stage",
  description:
    "Stage scenes - the /api/stage 3D surface. list/create your scenes, " +
    "get a scene head, inspect a view (meta/tree/shots/physics/problems), " +
    "apply typed ops under optimistic concurrency, read revision history, " +
    "and restore an old revision onto a new head. apply/restore need " +
    "base_revision - a stale one answers stale_revision + head_rev; apply " +
    "takes an optional idempotency_key (reuse with a different body → " +
    "idempotency_mismatch).",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    const needsId = a.action !== "list" && a.action !== "create";
    if (needsId && a.id === undefined)
      return toolError("invalid_params", `${a.action} needs id - a scene uuid`);
    switch (a.action) {
      case "list":
        return ok({ scenes: await ctx.client.stageList() });
      case "create": {
        if (a.empty !== true && a.prompt === undefined)
          return toolError("invalid_params",
            "create needs {empty:true} for the default scene or {prompt} for the writer");
        return ok(await ctx.client.stageCreate({
          ...(a.empty ? { empty: true } : {}),
          ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a.refs !== undefined ? { refs: a.refs } : {}),
          ...(a.duration !== undefined ? { duration: a.duration } : {}),
          ...(a.aspect !== undefined ? { aspect: a.aspect } : {}),
          ...(a.fps !== undefined ? { fps: a.fps } : {}),
        }));
      }
      case "get":
        return ok(await ctx.client.stageGet(a.id!));
      case "inspect":
        return ok(await ctx.client.stageInspect(a.id!, a.view ?? "tree", a.rev));
      case "apply": {
        if (a.base_revision === undefined)
          return toolError("invalid_params", "apply needs base_revision - the rev you last saw (get/inspect first)");
        if (!a.ops?.length)
          return toolError("invalid_params", "apply needs ops - 1-200 typed ops");
        return ok(await ctx.client.stageApplyOps(a.id!, {
          baseRevision: a.base_revision,
          ops: a.ops,
          ...(a.selection !== undefined ? { selection: a.selection } : {}),
          ...(a.idempotency_key !== undefined ? { idempotencyKey: a.idempotency_key } : {}),
          ...(a.dry_run === true ? { dryRun: true } : {}),
        }));
      }
      case "revisions":
        return ok({ revisions: await ctx.client.stageRevisions(a.id!) });
      case "revision":
        if (a.rev === undefined)
          return toolError("invalid_params", "revision needs rev - the stored revision number");
        return ok(await ctx.client.stageRevision(a.id!, a.rev));
      case "restore": {
        if (a.rev === undefined)
          return toolError("invalid_params", "restore needs rev - the stored revision to restore");
        if (a.base_revision === undefined)
          return toolError("invalid_params", "restore needs base_revision - the rev you last saw");
        return ok(await ctx.client.stageRestore(a.id!, a.rev, a.base_revision));
      }
    }
  },
} satisfies ToolDef;
