import type { ModelDef } from "../types";
import { finish } from "../video/params";
import { DUB_ENDPOINT, DUB_LANGUAGES, DUB_MAX_SECONDS, dubParamsSchema } from "../../dub";
import { LIKENESS_CONSENT_FIELD as likenessConsent, likenessConsentCheck } from "../../likeness";

/** Dub - one job: English talking clip → another language, same voice, lips re-synced. */
export const DUB: ModelDef = {
  id: "dub", label: "Dub & Translate", vendor: "MotionField · whisper.cpp · Kokoro · Chatterbox · MuseTalk", kind: "v2v",
  description: "Re-voice an English talking clip in Spanish, French, Italian, Portuguese, Hindi, Japanese or Mandarin - transcribed, translated by your local LLM, spoken natively and converted to the speaker's own voice, with the lips re-synced.",
  tags: ["dub", "translate", "voice", "lip-sync"],
  workflows: [
    {
      id: "v1", label: "Dub a clip", endpointId: DUB_ENDPOINT, kind: "v2v",
      params: [
        { ...likenessConsent, label: "I have the right to use this person's voice and likeness" },
        { name: "video_url", label: "Talking clip", type: "video", required: true, minSeconds: 1, maxSeconds: DUB_MAX_SECONDS, description: "English speech, one main speaker, face visible for lip-sync. Up to 2 minutes." },
        { name: "language", label: "Dub into", type: "select", required: true, default: "es", enum: DUB_LANGUAGES.map((l) => l.id) },
        { name: "voice", label: "Base voice", type: "select", default: "auto", enum: ["auto", "female", "male"],
          description: "The native voice we convert to the speaker's timbre - auto picks from their pitch." },
        { name: "lipsync", label: "Re-sync lips", type: "boolean", default: true },
        { name: "original_volume", label: "Keep original audio", type: "slider", default: 0, min: 0, max: 0.5, step: 0.05,
          description: "0 replaces the soundtrack; higher keeps the original quietly underneath." },
        finish,
      ],
      cost: () => 12,
      validate: (p) => {
        const consent = likenessConsentCheck(DUB_ENDPOINT)(p);
        if (consent) return consent;
        const r = dubParamsSchema.safeParse(p);
        return r.success ? null : `${r.error.issues[0]?.path.join(".") || "params"}: ${r.error.issues[0]?.message}`;
      },
      providers: { recipe: { name: "dub" } },
    },
  ],
};
