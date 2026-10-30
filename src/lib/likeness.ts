/** Likeness consent - which endpoints consume a person's identity and which
 *  param carries it. Each listed workflow declares an unticked-by-default
 *  `likeness_consent` boolean (it never reaches a graph placeholder - the
 *  declaration exists purely for this check) and a `validate` built by
 *  `likenessConsentCheck`, so createJob 400s "likeness consent required"
 *  everywhere a job can be submitted (UI, REST, v1, MCP, CLI). Client-side
 *  the same map drives the disabled-until-ticked upload controls.
 */

export const LIKENESS_CONSENT_PARAM = "likeness_consent";

/** the unticked-by-default box, declared right above each identity upload.
 *  It never reaches a graph placeholder - it exists only so createJob's
 *  validate can require it server-side. */
export const LIKENESS_CONSENT_FIELD = {
  name: LIKENESS_CONSENT_PARAM,
  label: "I have the right to use this person's likeness",
  type: "boolean" as const,
  description: "Required - the reference re-renders a real person. Unticked submissions are rejected (docs/POLICY.md).",
} as const;

/** endpoint → params that carry a person's likeness */
export const LIKENESS_PARAMS: Record<string, readonly string[]> = {
  "motionfield/wan-vace/character-swap": ["image_urls"],
  "motionfield/wan-vace/motion-transfer": ["image_urls"],
  "motionfield/wan-animate/character-swap": ["image_urls"],
  "motionfield/re-edit/v1.0": ["image_urls"],
  "motionfield/musetalk/talking-portrait": ["image_url"],
  "motionfield/musetalk/talking-portrait-ltx": ["image_url"],
  "motionfield/musetalk/portrait-says": ["image_url"],
  "motionfield/musetalk/portrait-says-ltx": ["image_url"],
  // lip-sync re-renders the mouth of the real person in the source video -
  // the video itself is the identity upload
  "motionfield/musetalk/lip-sync-video": ["video_url"],
  "motionfield/wan-s2v/talking-portrait": ["image_url"],
  // person-swap - the source clip (the person being swapped or re-staged) AND the
  // identity refs are both likeness inputs; consent covers the whole job
  "motionfield/person-swap/v1.0": ["video_url", "image_urls"],
  // s7b photo face swap - the source photo IS a person, and the identity
  // photo is whose face goes in; consent covers both uploads
  "motionfield/flux2-klein-4b/face-edit": ["image_url", "image_urls"],
  // dub clones the speaker's voice and re-syncs their mouth - the clip is
  // both the voice and the face
  "motionfield/dub/v1": ["video_url"],
};

/** ReCut's subject refs carry a likeness on every flow except restyle:
 *  character-swap puts them in the shots and motion-transfer re-renders the
 *  supplied subject performing the reference's motion - both run the gated
 *  VACE endpoints behind the recipe. Only restyle touches no identity. */
const RE_EDIT_UNGATED_FLOW = "restyle";

const hasValue = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";

/** does this submission touch a person's likeness - an identity param with
 *  a value? `flow` may be absent (the re-edit default is character-swap). */
export function needsLikenessConsent(endpointId: string, params: Record<string, unknown>): boolean {
  if (endpointId === "motionfield/re-edit/v1.0" && params.flow === RE_EDIT_UNGATED_FLOW) return false;
  return (LIKENESS_PARAMS[endpointId] ?? []).some((n) => hasValue(params[n]));
}

/** the params the studio must keep disabled until the box is ticked - for
 *  the re-edit endpoint that means image_urls on every flow but restyle */
export function likenessIdentityParams(endpointId: string, params: Record<string, unknown> = {}): readonly string[] {
  if (endpointId === "motionfield/re-edit/v1.0" && params.flow === RE_EDIT_UNGATED_FLOW) return [];
  return LIKENESS_PARAMS[endpointId] ?? [];
}

/** workflow `validate` builder - 400s "likeness consent required" unless the
 *  caller explicitly ticked the box. Only a real boolean true counts: the
 *  checkbox is off by default and stringy values coerce to false upstream. */
export function likenessConsentCheck(endpointId: string) {
  return (params: Record<string, unknown>): string | null =>
    needsLikenessConsent(endpointId, params) && params[LIKENESS_CONSENT_PARAM] !== true
      ? "likeness consent required"
      : null;
}
