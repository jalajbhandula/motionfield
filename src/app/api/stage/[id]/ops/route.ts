import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { JobError } from "@/lib/jobs";
import { readCappedText } from "@/lib/render/body";
import {
  MAX_SCENE_BYTES, assertSceneFits, stageSceneSchema, type StageScene,
} from "@/lib/stage/scene";
import { unownedModelSrcs } from "@/lib/stage/refs";
import { applyOps, stageOpSchema, StageOpError } from "@/lib/stage/ops";
import { stageApiUser, loadOwnScene, sceneIdSchema } from "@/lib/stage/api";
import { commitSceneRevision } from "@/lib/stage/revisions";
import {
  decideOpReplay, hashOpBody, isValidOpKey, lookupOpKey, storeOpKey,
} from "@/lib/stage/idempotency";

export const runtime = "nodejs";

const idemMismatch = () => json(
  { error: "Idempotency-Key was already used with a different request", code: "IDEMPOTENCY_MISMATCH" },
  422,
);

const OpsBody = z.strictObject({
  base_revision: z.number().int().min(1),
  ops: z.array(stageOpSchema).min(1).max(200),
  selection: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).nullable().optional(),
  dry_run: z.boolean().optional(),
});

/**
 * POST /api/stage/:id/ops - typed ops straight at a scene, no LLM anywhere
 * in the path. Optimistic concurrency on base_revision; optional
 * Idempotency-Key replays byte-identical retries for 24 h and 422s on a
 * key/body mismatch so clients can safely retry.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!sceneIdSchema.safeParse(id).success) throw new JobError("not found", 404);
    const auth = await stageApiUser(req);

    const keyHeader = req.headers.get("idempotency-key");
    if (keyHeader !== null && !isValidOpKey(keyHeader)) {
      throw new JobError("invalid Idempotency-Key (1-128 chars of [A-Za-z0-9_-])", 400);
    }
    const raw = await readCappedText(req, MAX_SCENE_BYTES + 4 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new JobError("invalid JSON body", 400); }
    const parsed = OpsBody.safeParse(payload);
    if (!parsed.success) throw new JobError("invalid body - expected { base_revision, ops[], selection? }", 400);
    const body = parsed.data;
    const bodyHash = hashOpBody(raw);

    const row = await loadOwnScene(auth.userId, id);
    if (!row) throw new JobError("not found", 404);

    if (keyHeader) {
      const stored = await lookupOpKey(auth.userId, keyHeader);
      const verdict = decideOpReplay(stored, id, bodyHash);
      if (verdict === "replay") return json(stored!.response, stored!.status);
      if (verdict === "mismatch") return idemMismatch();
    }

    // pre-flight the optimistic check before doing the work - the commit
    // helper re-checks under the row lock either way
    if (row.revision !== body.base_revision) {
      return json({ error: "stale base_revision", head_revision: row.revision }, 409);
    }
    let scene: StageScene;
    try { scene = stageSceneSchema.parse(row.scene); }
    catch { throw new JobError("stored scene is invalid - contact support", 500); }
    if (body.selection && !scene.nodes.some((n) => n.id === body.selection)) {
      throw new JobError(`selection "${body.selection}" not found`, 400);
    }
    let next: StageScene;
    try { next = applyOps(scene, body.ops, { selection: body.selection ?? undefined }); }
    catch (e) {
      if (e instanceof StageOpError) throw new JobError(`invalid op: ${e.message}`, 400);
      throw e;
    }
    try { assertSceneFits(next); } catch (e) {
      throw new JobError((e as Error).message, 400);
    }
    // same rule PUT and prompt enforce: uploads OR assets the caller owns
    const bad = await unownedModelSrcs(next, auth.userId);
    if (bad.length) throw new JobError(`model src isn't one of your files: ${bad[0]}`, 404);

    // a dry run validates exactly like a real call but writes nothing -
    // agents probe edits this way before committing a revision
    if (body.dry_run) {
      return json({ dry_run: true, revision: row.revision, scene: next }, 200);
    }

    const commit = await commitSceneRevision(id, auth.userId, {
      baseRevision: body.base_revision,
      scene: next,
      source: "ops",
    });
    const out = !commit.ok && commit.head === -1
      ? { status: 404, body: { error: "not found" } } // the scene vanished mid-request
      : commit.ok
        ? { status: 200, body: { revision: commit.revision, scene: next } }
        : { status: 409, body: { error: "stale base_revision", head_revision: commit.head } };

    if (keyHeader && (out.status === 200 || out.status === 409)) {
      const r = await storeOpKey(auth.userId, keyHeader, id, bodyHash, out.status, out.body);
      if ("raced" in r && r.raced) {
        const verdict = decideOpReplay(r.raced, id, bodyHash);
        if (verdict === "replay") return json(r.raced.response, r.raced.status);
        return idemMismatch();
      }
    }
    return json(out.body, out.status);
  } catch (e) {
    return err(e);
  }
}
