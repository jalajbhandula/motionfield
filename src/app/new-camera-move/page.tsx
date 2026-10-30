import { MOTION_PRESETS } from "@/lib/catalog/presets";
import ReShootClient from "./reshoot-client";

export const metadata = { title: "New Camera Move" };

/** Server wrapper - the picker rows are the motion presets; the client
 *  filters them to what the re-shoot endpoint actually executes. */
export default function ReShootPage() {
  return <ReShootClient presets={MOTION_PRESETS} />;
}
