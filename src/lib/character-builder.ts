/**
 * Character Builder - a guided path from a description to a saved, consistent
 * character: four Z-Image Turbo candidates → pick one → a FLUX.2 klein
 * identity set (angles, expressions, outfits, scenes) edited from that face
 * → saved as a character @ref that Character Studio, Agent and every
 * reference-taking model can use.
 */

export const CANDIDATE_ENDPOINT = "motionfield/z-image-turbo/text-to-image";
export const SHOT_ENDPOINT = "motionfield/flux2-klein/edit";
export const MAX_SET = 10; // refs hold up to 10 images

export type CharacterStyle = { id: string; label: string; lead: string; finish: string };

export const CHARACTER_STYLES: CharacterStyle[] = [
  { id: "photo", label: "Photo", lead: "Studio portrait photograph of", finish: "natural skin texture, 85mm lens, soft even key light, sharp focus" },
  { id: "cinematic", label: "Cinematic", lead: "Cinematic film still, portrait of", finish: "anamorphic lens, subtle film grain, moody soft light, shallow depth of field" },
  { id: "3d", label: "3D character", lead: "Stylised 3D animated character portrait of", finish: "feature-animation render, soft global illumination, expressive features" },
  { id: "anime", label: "Anime", lead: "Anime illustration, character portrait of", finish: "clean line art, cel shading, vibrant but soft colours" },
  { id: "painted", label: "Painted", lead: "Painterly digital portrait of", finish: "visible brushwork, rich colour, gallery-quality illustration" },
];

export type CharacterDraft = { description: string; style: string; outfit?: string };

export function styleOf(id: string): CharacterStyle {
  return CHARACTER_STYLES.find((s) => s.id === id) ?? CHARACTER_STYLES[0];
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The text-to-image prompt for the four starting faces. */
export function candidatePrompt(d: CharacterDraft): string {
  const s = styleOf(d.style);
  const outfit = d.outfit?.trim() ? `, wearing ${clean(d.outfit, 160)}` : "";
  return `${s.lead} ${clean(d.description, 600)}${outfit}. Head and shoulders, facing the camera, calm neutral expression, ` +
    `plain light grey backdrop, ${s.finish}.`;
}

export type IdentityShot = { id: string; label: string; ask: string; needsOutfit?: boolean };

/** The identity set - the picked face is shot 0 ("front"); these are edited from it. */
export const IDENTITY_SHOTS: IdentityShot[] = [
  { id: "three-quarter", label: "¾ left", ask: "Head-and-shoulders portrait with the head turned three-quarters to the left, eyes to the camera, same plain grey backdrop" },
  { id: "profile", label: "Profile", ask: "Clean side profile portrait facing right, same plain grey backdrop" },
  { id: "smile", label: "Smile", ask: "Head-and-shoulders portrait laughing with a natural open smile, same plain grey backdrop" },
  { id: "full-body", label: "Full body", ask: "Full-body shot standing in a relaxed pose, head to shoes in frame, plain grey studio backdrop", needsOutfit: true },
  { id: "casual", label: "Casual", ask: "Waist-up portrait wearing a different, casual outfit - a plain t-shirt under an open overshirt - same plain grey backdrop" },
  { id: "street", label: "Street", ask: "Candid waist-up photo walking on a city street at golden hour, background softly out of focus", needsOutfit: true },
  { id: "close-up", label: "Close-up", ask: "Tight close-up of the face lit by soft window light, crisp detail in the eyes" },
  { id: "night", label: "Night", ask: "Waist-up portrait at night under warm neon signs, rain-slick street bokeh behind", needsOutfit: true },
];

/** klein edit instruction for one identity shot, anchored on the picked face. */
export function shotPrompt(d: CharacterDraft, shot: IdentityShot): string {
  const s = styleOf(d.style);
  const outfit = shot.needsOutfit
    ? d.outfit?.trim() ? ` Wearing ${clean(d.outfit, 160)}.` : " Wearing an outfit that suits them."
    : "";
  return `The same person as in the reference image - identical face, facial structure, hair, skin tone and eye colour, same age. ` +
    `${shot.ask}.${outfit} Keep the ${s.label.toLowerCase()} look: ${s.finish}.`;
}

/** Ref names are slugs; offer one from the character's name. */
export function refName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export const DESCRIPTION_IDEAS = [
  "a woman in her late twenties with short copper hair, freckles and green eyes, warm confident smile lines",
  "a man in his sixties with a neat white beard, deep laugh lines and round tortoiseshell glasses",
  "a young non-binary skater with a bleached buzz cut, a silver nose ring and bright hazel eyes",
  "a woman in her forties with long black braids, high cheekbones and a calm, direct gaze",
  "a lanky teenage inventor with messy brown curls, a gap-toothed grin and grease on one cheek",
];
