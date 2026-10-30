import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { VIDEO_MODELS } from "@/lib/catalog/video-models";
import { COMPARE_MODES, compareCandidates, type CompareCandidate, type CompareMode } from "@/lib/compare";
import { getSessionUser } from "@/lib/profiles";
import { exampleFor } from "@/lib/examples";
import { comingSoonReason } from "@/lib/catalog/coming-soon";
import CompareStudio from "./compare-studio";

export const metadata: Metadata = { title: "Compare models" };

/** /compare - one prompt, 2-4 local models, side by side. */
export default async function ComparePage() {
  await connection();
  const s = await getSessionUser().catch(() => null);
  const models = [...IMAGE_MODELS, ...VIDEO_MODELS];
  const candidates = Object.fromEntries(
    (Object.keys(COMPARE_MODES) as CompareMode[]).map((m) => [m, compareCandidates(models, m).map((c): CompareCandidate => {
      const ex = exampleFor(c.id);
      const thumb = ex && (ex.kind === "image" || ex.kind === "video") ? { url: ex.media, kind: ex.kind } : undefined;
      return { ...c, thumb, unavailable: comingSoonReason(c.id) };
    })]),
  ) as Record<CompareMode, CompareCandidate[]>;
  return (
    <Suspense>
      <CompareStudio candidates={candidates} authed={!!s} />
    </Suspense>
  );
}
