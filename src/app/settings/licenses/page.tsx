import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/profiles";
import { ALL_MODELS } from "@/lib/catalog/video-models";
import { endpointLicenseFor, LICENSE_VERSION, PACK_LICENSES, worstClass } from "@/lib/catalog/licenses";
import type { LicenseComponent } from "@/lib/catalog/types";
import { LicenseManager, type EndpointLicenseRow } from "./license-manager";

export const metadata = { title: "Licenses" };

export default async function LicensesPage() {
  const s = await getSessionUser().catch(() => null);
  if (!s) redirect(`/login?next=${encodeURIComponent("/settings/licenses")}`);

  const db = await getDb();
  const [row] = await db.select().from(schema.licenseOptins)
    .where(eq(schema.licenseOptins.userId, s.user.id)).limit(1);

  // Worst-case resolution per endpoint: the explainer's license depends on
  // params.motion_model - evaluate its restricted choice so the row shows up.
  const endpoints: EndpointLicenseRow[] = ALL_MODELS
    .flatMap((m) => m.workflows.map((w) => ({ m, w })))
    .map(({ m, w }) => ({ m, w, lic: endpointLicenseFor(w, { motion_model: "ltx" }) }))
    .filter((r) => r.lic.class === "restricted" || r.lic.class === "banned")
    .map(({ m, w, lic }) => ({
      endpointId: w.endpointId,
      model: m.label,
      workflow: w.label,
      cls: lic.class as "restricted" | "banned",
      components: lic.components,
    }));

  const seen = new Map<string, LicenseComponent>();
  for (const m of ALL_MODELS)
    for (const w of m.workflows)
      for (const c of endpointLicenseFor(w).components)
        if (c.class === "banned-known" && !seen.has(c.name)) seen.set(c.name, c);
  const bannedKnown = [...seen.values()];

  // optional weight packs (3D etc.) - no shipped workflow reaches them, but
  // the restricted ones still need the same opt-in story surfaced.
  const packs = PACK_LICENSES.map((p) => ({
    id: p.id, label: p.label, cls: worstClass(p.components), components: p.components,
  }));

  return (
    <div className="max-w-2xl space-y-3">
      <h2 className="font-semibold">Licenses</h2>
      <p className="text-sm text-[var(--color-dim)]">
        Every endpoint lists the licenses of the weights and components it runs. Restricted licenses need a per-user opt-in; blocked components can never run.
      </p>
      <LicenseManager
        endpoints={endpoints}
        packs={packs}
        bannedKnown={bannedKnown}
        optedIn={row?.version === LICENSE_VERSION}
        storedVersion={row?.version ?? null}
        currentVersion={LICENSE_VERSION}
      />
    </div>
  );
}
