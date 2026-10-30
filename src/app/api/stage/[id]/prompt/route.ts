import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { chatJson } from "@/lib/llm/index";
import { writerReady } from "@/lib/render/generate";
import { readCappedText } from "@/lib/render/body";
import { applyOps, stageOpsResponseSchema, StageOpError } from "@/lib/stage/ops";
import { assertSceneFits, parseStageScene, type StageScene } from "@/lib/stage/scene";
import { unownedModelSrcs } from "@/lib/stage/refs";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { commitSceneRevision } from "@/lib/stage/revisions";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

const NEEDS_LLM_BODY = {
  error: "no LLM configured - add a model in Settings → Models & LLMs, or set LLM_PROVIDER/LLM_MODEL",
  code: "NEEDS_LLM",
};

const MAX_BODY = 64 * 1024;

const promptSchema = z.strictObject({
  instruction: z.string().min(1).max(1000),
  /** scope the ops to this node id (and nodes added under it) */
  selection: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  base_revision: z.number().int().min(1),
});

const OPS_SYSTEM = `You edit a grey-box 3D stage scene by emitting ops. Reply with ONLY {"ops": [...]}.

The scene document has: meta {title, duration, fps, aspect, renderSize{w,h}}, env {background "#rrggbb", ambient 0-2, sun {intensity 0-5, direction [x,y,z]}}, nodes[] each {id, name, parent?, kind, transform {pos m, rot deg, scale}, keys?, prompt?}.

Ops (max 200):
- {"op":"add","node":{kind,name,pos?→transform.pos,…,"props":{…}}} - kinds: primitive {shape box|sphere|pyramid|cylinder|capsule|plane,size vec3,color}, mannequin {pose stand|walk|run|sit|point|arms-crossed,height}, light {light sun|point|spot,color,intensity,angle,range}, camera {focalMm,sensor,isRender,path?,lookAt?}, model {src /files/….glb}
- {"op":"update","id":"…","path":"…","value":…} - paths: name, prompt, parent, transform.pos|rot|scale, and per kind: props.size|color (primitive), props.pose|height (mannequin), props.color|intensity|angle|range (light), props.focalMm|sensor|lookAt|isRender (camera), props.src (model)
- {"op":"remove","id":"…"}
- {"op":"set_camera_path","id":"…","path":{points:[[x,y,z],…≥2],times:[…same length]}}
- {"op":"set_keys","id":"…","keys":[{t,path,value,ease?}]} - paths: transform.pos|rot|scale, props.<keyable>
- {"op":"set_env","env":{background?,ambient?,sun?{intensity?,direction?}}}
- {"op":"set_meta","meta":{title?,duration?,fps?,aspect?,renderSize?}}

Rules: id values come from the CURRENT SCENE below - invent none. Coordinates are metres, rotations degrees, the floor is y=0. A scoped (selected) node id is the only node your ops may touch.`;

/** POST /api/stage/:id/prompt - instruction → ops → validated scene bump. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await stageApiUser(req);
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) return json({ error: "not found" }, 404);

    let text: string;
    try {
      text = await readCappedText(req, MAX_BODY);
    } catch (e) {
      if (e instanceof JobError && e.status === 413) return json({ error: "body too large (max 64 KB)" }, 413);
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const body = promptSchema.safeParse(raw);
    if (!body.success) return json({ error: body.error.issues[0]?.message ?? "bad body" }, 400);
    const { instruction, selection, base_revision } = body.data;

    const row = await loadOwnScene(userId, id);
    if (!row) return json({ error: "not found" }, 404);

    if (!(await writerReady(userId))) return json(NEEDS_LLM_BODY, 503);
    if (row.revision !== base_revision) {
      return json({ error: "scene changed on the server - reload to continue", head_revision: row.revision }, 409);
    }

    let scene: StageScene;
    try {
      scene = parseStageScene(row.scene);
    } catch {
      return json({ error: "stored scene is invalid" }, 500);
    }
    if (selection && !scene.nodes.some((n) => n.id === selection)) {
      return json({ error: `selection "${selection}" doesn't exist` }, 400);
    }

    const selected = selection ? scene.nodes.find((n) => n.id === selection) : undefined;
    const userMsg = [
      `INSTRUCTION: ${instruction}`,
      selected ? `SELECTION: only node "${selected.id}" ("${selected.name}", ${selected.kind}) may be edited or removed; nodes you add must parent to it. Do not touch anything else.` : "",
      `CURRENT SCENE:\n${JSON.stringify(scene)}`,
      "Reply with the ops JSON only.",
    ].filter(Boolean).join("\n\n");

    const budget = AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]);
    let ops;
    try {
      const res = await chatJson("writer", stageOpsResponseSchema, {
        messages: [
          { role: "system", content: OPS_SYSTEM },
          { role: "user", content: userMsg },
        ],
        temperature: 0.3,
        think: false,
        signal: budget,
      }, { userId });
      ops = res.data.ops;
    } catch (e) {
      return json({ error: `scene writer failed: ${e instanceof Error ? e.message : e}` }, 502);
    }

    let next: StageScene;
    try {
      next = applyOps(scene, ops, { selection });
      assertSceneFits(next);
    } catch (e) {
      if (e instanceof StageOpError) return json({ error: e.message }, 400);
      return json({ error: `ops produced an invalid scene: ${e instanceof Error ? e.message : e}` }, 400);
    }
    // an op-added model may only source the caller's own /files/….glb
    const unowned = await unownedModelSrcs(next, userId);
    if (unowned.length) {
      return json({ error: `model src isn't one of your files: ${unowned[0]}` }, 404);
    }

    const commit = await commitSceneRevision(id, userId, {
      baseRevision: base_revision,
      scene: next,
      source: "prompt",
    });
    if (!commit.ok) {
      if (commit.head === -1) return json({ error: "not found" }, 404); // vanished mid-request
      return json({ error: "scene changed on the server - reload to continue", head_revision: commit.head }, 409);
    }
    return json({ id, revision: commit.revision, scene: next });
  } catch (e) {
    return err(e);
  }
}
