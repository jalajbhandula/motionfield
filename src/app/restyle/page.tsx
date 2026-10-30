import { visibleRestyleSpecs } from "@/lib/catalog/presets/schema";
import "@/lib/catalog/presets"; // registration side-effects - all catalogs + the s5b restyle specs
import RestyleClient, { type RestylePreset } from "./restyle-client";

export const metadata = { title: "Video Restyle" };
export const dynamic = "force-dynamic"; // verify records land on disk between builds

/** Server wrapper - the grid is exactly the currently-verified restyle
 *  specs (the same gate POST /api/jobs enforces on preset_id), and the
 *  count the client shows is the real number. */
export default function PersonSwapRestylePage() {
  const presets: RestylePreset[] = visibleRestyleSpecs().map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description ?? "",
  }));
  return <RestyleClient presets={presets} />;
}
