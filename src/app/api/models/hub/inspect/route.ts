import { NextRequest } from "next/server";
import { z } from "zod";
import { json } from "@/lib/api";
import { hubErr, hubUser, verdictAllowed } from "@/lib/model-hub/gate";
import { inspectRepo } from "@/lib/model-hub/hf";

export const runtime = "nodejs";

const Body = z.strictObject({
  repo: z.string().min(1).max(200),
  kind: z.enum(["weights", "gguf"]).default("weights"),
});

/** Look up a Hugging Face repo: card licence(s) at the pinned commit, the
 *  downloadable weight files, and the allow/refuse verdict. Refusals come
 *  back 200 with allowed:false + reason - the panel renders the reason and
 *  never enables the button. */
export async function POST(req: NextRequest) {
  try {
    const user = await hubUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "send {repo, kind:\"weights\"|\"gguf\"}" }, 400);
    const insp = await inspectRepo(parsed.data.repo, parsed.data.kind);
    const allowed = await verdictAllowed(user.id, insp.verdict);
    return json({
      repo: insp.repo,
      revision: insp.revision,
      kind: parsed.data.kind,
      licenseIds: insp.licenseIds,
      class: insp.verdict.cls,
      reason: insp.verdict.reason,
      allowed,
      optInRequired: insp.verdict.cls === "restricted" && !allowed,
      files: insp.files,
    });
  } catch (e) {
    return hubErr(e);
  }
}
