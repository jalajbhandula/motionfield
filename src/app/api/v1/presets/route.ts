import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { ALL_PRESETS } from "@/lib/catalog/presets";
import { endpointLicense, hasCurrentOptIn } from "@/lib/catalog/license-gate";
import { findModel } from "@/lib/catalog/video-models";

export const runtime = "nodejs";

const Query = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
});

/** A preset that names a restricted-weight model in `modelHint` is itself
 *  restricted - hidden from the list until the caller has a current opt-in
 *  row. A hint that doesn't resolve to any open workflow counts as
 *  restricted (fail-safe). */
function presetRestricted(modelHint: string | undefined): boolean {
  if (!modelHint) return false;
  const model = findModel(modelHint);
  if (!model || !model.workflows.length) return true;
  return model.workflows.every((w) => endpointLicense(w).class !== "open");
}

function presetShape(p: (typeof ALL_PRESETS)[number]) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description,
    category: p.category ?? null,
    credits: p.credits ?? null,
    input_required: p.inputRequired ?? "none",
    model_hint: p.modelHint ?? null,
    apply: p.apply,
    prompt_fragment: p.promptFragment ?? null,
  };
}

/** GET /api/v1/presets?kind= - the merged preset catalog. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    const q = Query.safeParse({ kind: req.nextUrl.searchParams.get("kind") ?? undefined });
    if (!q.success) return v1error("bad_request", "kind must be a slug (motion|effect|style|palette|mixed-media)", 400);
    const optin = await hasCurrentOptIn(auth.userId);
    const presets = ALL_PRESETS
      .filter((p) => (!q.data.kind || p.kind === q.data.kind))
      .filter((p) => optin || !presetRestricted(p.modelHint))
      .map(presetShape);
    return v1json({ presets });
  } catch (e) {
    return v1err(e);
  }
}
