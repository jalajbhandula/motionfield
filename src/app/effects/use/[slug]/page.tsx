import { notFound } from "next/navigation";
import { EFFECT_PRESETS } from "@/lib/catalog/presets";
import { specById, specVisible } from "@/lib/catalog/presets/schema";
import { VIDEO_MODELS } from "@/lib/catalog/video-models";
import { Studio } from "@/components/studio";
import { clientModel } from "@/lib/catalog/serialize";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function UseEffect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const effect = EFFECT_PRESETS.find((e) => e.id === slug);
  const spec = specById(slug);
  // hidden or unverified presets are not usable - the deep link 404s
  if (!effect || !spec || spec.catalog !== "effect" || !specVisible(spec)) notFound();

  // effects run on the workflow their mechanism declares (wan-vace i2v for
  // edit_recipe/post; vace-restyle for restyle) unless a hint says otherwise
  const model = VIDEO_MODELS.find((m) => m.id === (effect.modelHint ?? "wan-vace"))!;
  return (
    <div>
      <div className="border-b border-[var(--color-border)] px-4 py-6">
        <div className="mx-auto max-w-[1600px]">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">Effect</p>
          <h1 className="font-display mt-1 text-3xl font-bold">{effect.title}</h1>
          <p className="mt-1 max-w-2xl text-[var(--color-dim)]">{effect.description} · {effect.credits ?? 49} credits</p>
        </div>
      </div>
      <Suspense>
        <EffectStudio effectId={effect.id} modelId={model.id} />
      </Suspense>
    </div>
  );
}

function EffectStudio({ effectId, modelId }: { effectId: string; modelId: string }) {
  return <Studio kind="video" models={[clientModel(VIDEO_MODELS.find((m) => m.id === modelId)!)]} presets={EFFECT_PRESETS} fixedPreset={effectId} fixedModel={modelId} />;
}
