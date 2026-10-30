import { AUDIO_MODELS } from "@/lib/catalog/video-models";
import { clientModels } from "@/lib/catalog/serialize";
import { Studio } from "@/components/studio";
import { Suspense } from "react";

export const metadata = { title: "Audio Studio" };

export default function AudioStudio() {
  return (
    <Suspense>
      <Studio kind="audio" models={clientModels(AUDIO_MODELS)} presets={[]} />
    </Suspense>
  );
}
