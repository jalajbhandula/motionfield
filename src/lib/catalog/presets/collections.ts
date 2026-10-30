/**
 * presets/collections.ts - curated hubs grouping presets by job-to-be-done.
 *
 *  Each spec may join one collection via spec.collection. The pages render a
 *  collection as a hub row and a filter chip; both list only the collection's
 *  currently-visible members (the verify gate in schema.ts decides). A
 *  collection with no visible members renders an honest empty note instead
 *  of pretending its entries exist.
 */
import { allSpecs, specVisible, loadVerifyRecords, type PresetSpec, type VerifyRecord } from "./schema";

export interface CollectionDef {
  id: string;
  /** ledger row this collection covers */
  ledger: `OF-${string}`;
  label: string;
  blurb: string;
}

export const COLLECTIONS: readonly CollectionDef[] = [
  { id: "photo-edits", ledger: "OF-0071", label: "Edit a photo",
    blurb: "Instruction-driven edits on your own photo - outfits, light, framing, retouch." },
  { id: "restyle", ledger: "OF-0072", label: "Restyle a clip",
    blurb: "Depth-controlled regrades of finished footage - composition and timing survive." },
  { id: "camera", ledger: "OF-0076", label: "Camera moves",
    blurb: "Trajectory-driven camera moves on a still - prompt-guided until the rig lands." },
  { id: "swap", ledger: "OF-0077", label: "Swap & place",
    blurb: "Composite your media into new footage - lead swaps, product placement." },
  { id: "looks", ledger: "OF-0078", label: "Looks",
    blurb: "Identity looks for image generation - pending a real look executor." },
  { id: "ads", ledger: "OF-0130", label: "Make an ad",
    blurb: "Prompt-to-asset tools for product marketing - posters, memes, link-to-ad." },
  { id: "post", ledger: "OF-0131", label: "Post layers",
    blurb: "Conditioning layers that ride on a generation job - negatives and grade hints." },
] as const;

export type CollectionId = (typeof COLLECTIONS)[number]["id"];
export const collectionById = (id: string) => COLLECTIONS.find((c) => c.id === id);

/** every spec assigned to a collection */
export const collectionMembers = (id: string): readonly PresetSpec[] =>
  allSpecs().filter((s) => s.collection === id);

/** the members a page may show right now */
export const collectionVisible = (id: string, records?: Record<string, VerifyRecord>): PresetSpec[] =>
  collectionMembers(id).filter((s) => specVisible(s, records ?? loadVerifyRecords()));

/** chips worth rendering - a collection offers a chip only when it has ≥1
 *  visible member in this page's catalog (or anywhere, for hub pages). */
export function collectionChips(catalogs?: readonly PresetSpec["catalog"][],
  records = loadVerifyRecords()): { collection: CollectionDef; members: PresetSpec[] }[] {
  return COLLECTIONS.map((c) => ({
    collection: c,
    members: collectionVisible(c.id, records)
      .filter((s) => !catalogs || catalogs.includes(s.catalog)),
  })).filter((x) => x.members.length > 0);
}
