import type { LicenseInfo } from "@/lib/catalog/types";

/** Endpoint license chip - green open / amber restricted (opt-in) / red
 *  blocked / neutral unknown. `license` comes from WorkflowDef.license
 *  (attached at catalog build); a missing license means unverified - the
 *  server gate still fails closed, the chip just says so neutrally. */
export function LicenseBadge({ license }: { license?: LicenseInfo | null }) {
  if (!license) {
    return (
      <span
        className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel2)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-dim)]"
        title="No license info - unverified; the gate refuses this endpoint">
        Unverified
      </span>
    );
  }
  if (license.class === "open") {
    const names = license.components.length
      ? [...new Set(license.components.map((c) => c.license))].join(" + ")
      : "open";
    return (
      <span
        className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400"
        title={license.components.map((c) => `${c.name}: ${c.license}`).join("\n") || undefined}>
        Open · {names}
      </span>
    );
  }
  if (license.class === "permissive-terms") {
    const notices = license.components
      .filter((c) => c.class === "permissive-terms")
      .map((c) => (c.notice ? `${c.name}: ${c.notice}` : `${c.name}: ${c.license}`))
      .join("\n");
    return (
      <span
        className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400"
        title={notices || "Permissive licence with attribution terms - no opt-in needed"}>
        Open · terms
      </span>
    );
  }
  if (license.class === "restricted") {
    const names = [...new Set(license.components.filter((c) => c.class === "restricted").map((c) => c.license))].join(" + ");
    return (
      <a
        href="/settings/licenses"
        className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20"
        title={`${names} - enable at /settings/licenses`}>
        Restricted · opt-in
      </a>
    );
  }
  const names = [...new Set(license.components.filter((c) => c.class === "banned").map((c) => c.license))].join(" + ");
  return (
    <span
      className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400"
      title={`${names || "banned"} - this endpoint cannot run`}>
      Blocked
    </span>
  );
}
