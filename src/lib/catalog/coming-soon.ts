/** Endpoints that did not pass a real GPU run before release. They stay in
 *  the catalog (so docs and graphs ship) but the studio shows them as
 *  "Coming soon" and createJob refuses them - nothing broken is offered as
 *  working. Value = the honest one-line reason shown to the user. */
export const COMING_SOON: Record<string, string> = {
  "motionfield/character/generate": "Being retuned - the local VACE 1.3B generator does not reliably follow the requested scene. Use Character multi-ref HD meanwhile.",
  "motionfield/explainer/video": "Awaiting a full generation recheck after the caption export timing fix.",
  "motionfield/re-edit/v1.0": "Being retuned - the swap pass lets the pose skeleton bleed into the shot.",
  "motionfield/draw-to-video/v1.0": "Being retuned - the local VACE 1.3B model does not reliably paint what you draw where you drew it yet.",
};

/** OF_ENABLE_UNVERIFIED=1 lifts the gate - for self-hosters who verified a
 *  workflow on their own GPU (and for the unit suite, which exercises every
 *  route). */
export function comingSoonReason(endpointId: string): string | undefined {
  if (process.env.OF_ENABLE_UNVERIFIED === "1" || process.env.NEXT_PUBLIC_OF_ENABLE_UNVERIFIED === "1") return undefined;
  return COMING_SOON[endpointId];
}
