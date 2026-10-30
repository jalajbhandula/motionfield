import { json } from "@/lib/api";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { VIDEO_MODELS, AUDIO_MODELS } from "@/lib/catalog/video-models";
import { MOTION_PRESETS, EFFECT_PRESETS, STYLE_PRESETS, COLOR_PALETTES, APPS } from "@/lib/catalog/presets";
import { allSpecs, specById, specVisible, loadVerifyRecords } from "@/lib/catalog/presets/schema";
import { PLANS, TOP_UP_PACKS, BOOST_PACKS } from "@/lib/catalog/plans";

export const runtime = "nodejs";

export async function GET() {
  // additive: the verification-gated preset ids clients may offer - raw
  // preset lists stay for shape compat; pickers filter by this set
  const records = loadVerifyRecords();
  return json({
    models: { image: IMAGE_MODELS, video: VIDEO_MODELS, audio: AUDIO_MODELS },
    presets: { motion: MOTION_PRESETS, effects: EFFECT_PRESETS, styles: STYLE_PRESETS },
    presets_visible: allSpecs().filter((s) => specVisible(s, records)).map((s) => s.id),
    palettes: COLOR_PALETTES,
    // only verified app tiles - a hidden app is never advertised
    apps: APPS.filter((a) => { const s = specById(a.slug); return s && specVisible(s, records); }),
    plans: PLANS,
    topUps: TOP_UP_PACKS,
    boosts: BOOST_PACKS,
  });
}
