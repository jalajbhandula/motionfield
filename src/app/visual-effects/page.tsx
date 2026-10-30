import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicenseFor } from "@/lib/catalog/licenses";
import { VFX_PRESETS, vfxPresetVerified } from "@/lib/catalog/presets/vfx-lab";
import VfxClient from "./vfx-client";

export const metadata = { title: "Visual Effects" };

/** Server wrapper - endpoint licenses and preset verification resolve on
 *  the server (the verify file + payload hashes live there); the client gets
 *  the full grid with each preset's verified flag. */
export default function VfxLabPage() {
  const plate = findEndpoint("motionfield/ltx-video/vfx-lab-plate");
  const image = findEndpoint("motionfield/ltx-video/vfx-lab-image");
  const alt = findEndpoint("motionfield/wan-vace/vfx-lab-alt");
  const presets = VFX_PRESETS.map((p) => ({
    id: p.id, label: p.label, blurb: p.blurb, family: p.family,
    defaults: p.defaults, target: !!p.target, verified: vfxPresetVerified(p.id),
  }));
  return (
    <VfxClient
      licenses={{
        plate: plate ? endpointLicenseFor(plate.workflow, {}) : null,
        image: image ? endpointLicenseFor(image.workflow, {}) : null,
        alt: alt ? endpointLicenseFor(alt.workflow, {}) : null,
      }}
      presets={presets}
    />
  );
}
