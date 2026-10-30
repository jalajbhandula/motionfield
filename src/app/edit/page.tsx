import { redirect } from "next/navigation";

export const metadata = { title: "Photo Edit" };

/** /edit - the photo-edit surface is the image studio at the klein face-edit
 *  flow. Deep links land here (/edit?params=…&preset=photo-face-swap) and the
 *  query carries through so the preset + prefills still apply. */
export default async function EditPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ model: "flux2-klein", flow: "face-edit" });
  for (const k of ["preset", "params", "recreate"]) {
    const v = sp[k];
    if (typeof v === "string") q.set(k, v);
  }
  redirect(`/ai/image?${q.toString()}`);
}
