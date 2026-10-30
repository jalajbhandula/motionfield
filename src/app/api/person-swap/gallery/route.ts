import { NextRequest } from "next/server";
import path from "node:path";
import { json, err, requireApiUser } from "@/lib/api";
import { readPersonSwapGallery } from "@/lib/generation/recipes/person-swap";

export const runtime = "nodejs";

/**
 * GET /api/person-swap/gallery - the PersonSwap Quick picker list. Only VERIFIED
 * manifest entries are returned, and `count` is the real number of them -
 * an unverified entry stays hidden until its file lands and gets checked.
 */
export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const clips = (await readPersonSwapGallery())
      .filter((e) => e.verified === true)
      .map((e) => ({
        id: e.id,
        seconds: e.seconds,
        aspect: e.aspect,
        url: `/person-swap/gallery/${path.basename(e.file)}`,
        provenance: e.provenance ?? null,
      }));
    return json({ clips, count: clips.length });
  } catch (e) {
    return err(e);
  }
}
