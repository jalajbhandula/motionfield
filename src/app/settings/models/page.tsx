import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/profiles";
import { ModelsPanel } from "./models-panel";

export const metadata = { title: "Models & LLMs" };

export default async function ModelsPage() {
  const s = await getSessionUser().catch(() => null);
  if (!s) redirect(`/login?next=${encodeURIComponent("/settings/models")}`);
  return <ModelsPanel />;
}
