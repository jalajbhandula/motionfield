import { VIDEO_MODELS } from "@/lib/catalog/video-models";
import { clientModels } from "@/lib/catalog/serialize";
import { MOTION_PRESETS, STYLE_PRESETS, COLOR_PALETTES } from "@/lib/catalog/presets";
import { specById, visibleSpecIds } from "@/lib/catalog/presets/schema";
import { DirectorStudio } from "@/components/cinema";
import { getSessionUser } from "@/lib/profiles";
import { currentOptIn } from "@/lib/runs/endpoints";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { needsOptIn } from "@/lib/catalog/licenses";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Suspense } from "react";

export const metadata = { title: "Camera Control" };

export default async function DirectorPage() {
  const s = await getSessionUser().catch(() => null);
  const optIn = s ? await currentOptIn(s.user.id) : false;
  let elements: { id: string; name: string; category: string; images: string[] }[] = [];
  if (s) {
    const db = await getDb();
    const els = await db.select().from(schema.elements).where(eq(schema.elements.userId, s.user.id)).limit(50);
    elements = els.map((e: typeof schema.elements.$inferSelect) => ({
      id: e.id, name: e.name, category: e.category,
      images: Array.isArray(e.images) ? (e.images as unknown[]).filter((x): x is string => typeof x === "string") : [],
    }));
  }
  // restricted models only appear once the user has opted in at
  // Settings → Licenses - the open default is always Director · Wan VACE
  const ORDER = ["director", "ltx-video", "wan-2-1", "lens", "camera-rig"];
  const models = ORDER
    .map((id) => VIDEO_MODELS.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .filter((m) => optIn || m.workflows.every((w) => !needsOptIn(endpointLicense(w).class)));
  // the camera picker lists WS3's motion catalog as-is (their own gate);
  // only the look picker stays on the verify gate - its executor is pending
  const visible = visibleSpecIds(STYLE_PRESETS.map((p) => specById(p.id)).filter((s): s is NonNullable<typeof s> => !!s));
  const presets = [...MOTION_PRESETS, ...STYLE_PRESETS.filter((p) => visible.has(p.id))];
  return (
    <Suspense>
      <DirectorStudio models={clientModels(models)} presets={presets} paletteOptions={COLOR_PALETTES} elements={elements} optIn={optIn} />
    </Suspense>
  );
}
