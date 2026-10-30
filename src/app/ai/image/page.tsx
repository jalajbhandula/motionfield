import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { clientModels } from "@/lib/catalog/serialize";
import { STYLE_PRESETS, MOTION_PRESETS, EFFECT_PRESETS } from "@/lib/catalog/presets";
import { Studio } from "@/components/studio";
import { getSessionUser } from "@/lib/profiles";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Suspense } from "react";

export const metadata = { title: "Image Studio" };

export default async function ImageStudio() {
  const s = await getSessionUser().catch(() => null);
  // Character refs come from `elements` (kind=person rows carry category
  // "character") - the legacy `characters` table is not a character source.
  // There's no e2e seed path for elements rows, so this selector is not
  // covered by an end-to-end spec.
  let elements: { id: string; name: string; category: string }[] = [];
  if (s) {
    const db = await getDb();
    const els = await db.select().from(schema.elements).where(eq(schema.elements.userId, s.user.id)).limit(50);
    elements = els.map((e: typeof schema.elements.$inferSelect) => ({ id: e.id, name: e.name, category: e.category }));
  }
  return (
    <Suspense>
      <Studio kind="image" models={clientModels(IMAGE_MODELS)} presets={STYLE_PRESETS} elements={elements} />
    </Suspense>
  );
}
