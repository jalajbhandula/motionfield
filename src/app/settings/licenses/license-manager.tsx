"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, userError } from "@/lib/user-error";

export type EndpointLicenseRow = {
  endpointId: string;
  model: string;
  workflow: string;
  cls: "restricted" | "banned";
  components: { name: string; license: string; url: string; class: string; notice?: string }[];
};

/** Settings → Licenses client: the "Allow restricted models" switch +
 *  confirm dialog + revoke, driven by /api/licenses/opt-in. */
export type LicensePackRow = {
  id: string;
  label: string;
  cls: "open" | "permissive-terms" | "restricted" | "banned";
  components: { name: string; license: string; url: string; class: string; notice?: string }[];
};

export function LicenseManager({ endpoints, packs, bannedKnown, optedIn, storedVersion, currentVersion }: {
  endpoints: EndpointLicenseRow[];
  packs: LicensePackRow[];
  bannedKnown: { name: string; license: string; url: string; notice?: string }[];
  optedIn: boolean;
  storedVersion: string | null;
  currentVersion: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(optedIn);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restrictedLicenses = [...new Map(
    endpoints.flatMap((e) => e.components)
      .filter((c) => c.class === "restricted")
      .map((c) => [c.license, c]),
  ).values()];
  const unverified = endpoints.flatMap((e) => e.components).filter((c) => c.license === "unlisted").length;

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirming(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  async function post() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/licenses/opt-in", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      if (!r.ok) throw new ApiError(userError(r.status, (await r.json().catch(() => ({}))).error));
      setOn(true); setConfirming(false); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/licenses/opt-in", { method: "DELETE" });
      if (!r.ok) throw new ApiError(userError(r.status, (await r.json().catch(() => ({}))).error));
      setOn(false); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <label className="panel flex items-center justify-between gap-4 p-4">
        <span>
          <span className="block text-sm font-semibold">Allow restricted models</span>
          <span className="mt-0.5 block text-xs text-[var(--color-dim)]">
            {on
              ? `Opted in - license terms ${currentVersion} accepted.`
              : "Restricted endpoints refuse jobs until you accept their licenses. Generation through MotionField stays fully local; enabling only unlocks these endpoints."}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={on} disabled={busy}
          onClick={() => (on ? void revoke() : setConfirming(true))}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-500" : "bg-[var(--color-line)]"}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
        </button>
      </label>
      {storedVersion && !on && (
        <p className="text-xs text-[var(--color-dim)]">
          Your previous opt-in ({storedVersion}) no longer applies - the license set changed to {currentVersion}; confirm again to re-enable.
        </p>
      )}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="panel divide-y divide-[var(--color-line)]">
        {endpoints.map((e) => (
          <div key={e.endpointId} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="text-sm font-semibold">{e.model}</span>
                <span className="ml-2 text-xs text-[var(--color-dim)]">{e.workflow}</span>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                e.cls === "banned"
                  ? "border-red-500/40 bg-red-500/10 text-red-400"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-400"}`}>
                {e.cls === "banned" ? "Blocked" : "Restricted · opt-in"}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-[var(--color-faint)]">{e.endpointId}</div>
            <ul className="mt-2 space-y-1 text-xs">
              {e.components.map((c) => (
                <li key={c.name} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[var(--color-fg)]">{c.name}</span>
                  {c.url
                    ? <a href={c.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{c.license}</a>
                    : <span className="text-[var(--color-dim)]">{c.license}</span>}
                  <span className={`${c.class === "banned" ? "text-red-400" : c.class === "banned-known" ? "text-amber-400" : "text-[var(--color-dim)]"}`}>{c.class}</span>
                  {c.notice && <span className="text-[var(--color-dim)]">- {c.notice}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!endpoints.length && (
          <p className="p-4 text-sm text-[var(--color-dim)]">Every endpoint is fully open - nothing needs an opt-in.</p>
        )}
      </div>

      {packs.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-dim)]">Weight packs</h3>
          <p className="mt-1 text-xs text-[var(--color-dim)]">
            Optional packs (3D generation etc.) - not wired to an endpoint yet; restricted ones inherit the same opt-in.
          </p>
          <div className="panel mt-2 divide-y divide-[var(--color-line)]">
            {packs.map((p) => (
              <div key={p.id} className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">{p.label}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    p.cls === "banned"
                      ? "border-red-500/40 bg-red-500/10 text-red-400"
                      : p.cls === "restricted"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"}`}>
                    {p.cls === "banned" ? "Blocked" : p.cls === "restricted" ? "Restricted · opt-in" : p.cls === "permissive-terms" ? "Open · attribution" : "Open"}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-xs">
                  {p.components.map((c) => (
                    <li key={c.name} className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[var(--color-fg)]">{c.name}</span>
                      {c.url
                        ? <a href={c.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{c.license}</a>
                        : <span className="text-[var(--color-dim)]">{c.license}</span>}
                      <span className={`${c.class === "banned" ? "text-red-400" : c.class === "restricted" ? "text-amber-400" : c.class === "banned-known" ? "text-amber-400" : "text-[var(--color-dim)]"}`}>{c.class}</span>
                      {c.notice && <span className="text-[var(--color-dim)]">- {c.notice}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {bannedKnown.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-dim)]">Known issues being replaced</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {bannedKnown.map((c) => (
              <li key={c.name} className="flex flex-wrap items-baseline gap-2">
                <span>{c.name}</span>
                {c.url
                  ? <a href={c.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{c.license}</a>
                  : <span className="text-[var(--color-dim)]">{c.license}</span>}
                {c.notice && <span className="text-[var(--color-dim)]">- {c.notice}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="panel w-full max-w-md space-y-4 p-5">
            <h3 className="font-semibold">Allow restricted models?</h3>
            <p className="text-sm text-[var(--color-dim)]">
              Some endpoints run weights with use-restricted licenses. Review each license before enabling - you are responsible for how you use their output.
            </p>
            <ul className="space-y-1 text-sm">
              {restrictedLicenses.map((c) => (
                <li key={c.name} className="flex flex-wrap items-baseline gap-2">
                  <span>{c.name}</span>
                  {c.url
                    ? <a href={c.url} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{c.license}</a>
                    : <span className="text-[var(--color-dim)]">{c.license}</span>}
                </li>
              ))}
            </ul>
            {unverified > 0 && (
              <p className="text-xs text-[var(--color-dim)]">
                {unverified} unlisted weight{unverified === 1 ? "" : "s"} - treated as restricted until verified.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={post} disabled={busy}>
                {busy ? "Saving…" : "I accept - enable restricted models"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
