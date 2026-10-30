"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PLANS, TOP_UP_PACKS, BOOST_PACKS } from "@/lib/catalog/plans";
import { useSession } from "@/lib/auth-client";
import { userError } from "@/lib/user-error";

export default function Pricing() {
  const { data: session } = useSession();
  const router = useRouter();
  const [annual, setAnnual] = useState(true);
  const [planId, setPlanId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setPlanId(d.profile?.planId ?? null)).catch(() => {});
  }, []);

  async function act(action: string, payload: Record<string, unknown>) {
    if (!session?.user) { router.push(`/login?next=/pricing`); return; }
    const r = await fetch("/api/billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const d = await r.json();
    if (d.checkout_url) { location.href = d.checkout_url; return; }
    if (d.ok) { setMsg("Done - updated instantly (dev mode / no Stripe keys)."); router.refresh(); setPlanId(payload.plan_id as string ?? planId); }
    else setMsg(userError(r.status, d.error ?? "failed").message);
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold">Plans & credits</h1>
        <p className="mt-2 text-[var(--color-dim)]">Credits pay per generation · failed jobs auto-refund · daily free credits on the Free plan.</p>
        <div className="mt-5 inline-flex rounded-full border border-[var(--color-border)] p-1">
          {["Monthly", "Annual"].map((l, i) => (
            <button key={l} onClick={() => setAnnual(!!i)} className={`rounded-full px-5 py-1.5 text-sm font-medium ${annual === !!i ? "bg-[var(--color-accent)] text-black" : "text-[var(--color-dim)]"}`}>{l}{i ? " · save" : ""}</button>
          ))}
        </div>
      </div>
      {msg && <p className="mx-auto mt-4 w-fit rounded-lg border border-[var(--color-accent)]/40 bg-[rgba(212,255,63,.08)] px-4 py-2 text-sm">{msg}</p>}

      <div className="mt-10 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {PLANS.map((p) => (
          <div key={p.id} className={`panel flex flex-col p-5 ${planId === p.id ? "border-[var(--color-accent)]" : ""}`}>
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold">{p.name}</h3>
              {planId === p.id && <span className="chip chip-on text-[10px]">current</span>}
            </div>
            <div className="mt-3">
              <span className="font-display text-3xl font-bold">${annual ? p.annualMonthlyPrice : p.monthlyPrice}</span>
              <span className="text-sm text-[var(--color-dim)]">/mo{annual && p.monthlyPrice > 0 ? " · billed annually" : ""}</span>
            </div>
            {p.seats && <p className="mt-1 text-xs text-[var(--color-dim)]">{p.seats}</p>}
            <div className="mt-2 text-sm font-medium text-[var(--color-accent)]">{p.creditsPerMonth ? `${p.creditsPerMonth} credits/mo` : "Daily free credits"}</div>
            <ul className="mt-3 flex-1 space-y-1.5 text-xs text-[var(--color-dim)]">
              {p.features.map((f) => <li key={f} className="flex gap-1.5"><span className="text-[var(--color-accent)]">✓</span>{f}</li>)}
              <li className="flex gap-1.5"><span className="text-[var(--color-accent)]">✓</span>{p.parallelVideo} video / {p.parallelImage} image parallel jobs</li>
            </ul>
            <button onClick={() => act("subscribe", { plan_id: p.id, annual })}
              disabled={planId === p.id}
              className={`btn mt-4 w-full ${planId === p.id ? "btn-ghost" : "btn-primary"}`}>
              {planId === p.id ? "Current plan" : p.monthlyPrice === 0 ? "Free" : `Get ${p.name}`}
            </button>
          </div>
        ))}
      </div>

      {/* top-ups */}
      <div id="topup" className="mt-16 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-2xl font-bold">Credit top-ups</h2>
          <p className="mt-1 text-sm text-[var(--color-dim)]">One-time packs · 90-day validity.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {TOP_UP_PACKS.map((p) => (
              <button key={p.id} onClick={() => act("topup", { pack_id: p.id })} className="panel p-4 text-left transition-colors hover:border-[var(--color-accent)]">
                <div className="font-display text-2xl font-bold">{p.credits}<span className="text-sm text-[var(--color-dim)]"> credits</span></div>
                <div className="mt-1 text-sm text-[var(--color-dim)]">${p.price}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h2 className="font-display text-2xl font-bold">Concurrency boost</h2>
          <p className="mt-1 text-sm text-[var(--color-dim)]">More parallel slots + bonus credits (90 days).</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {BOOST_PACKS.map((b) => (
              <button key={b.id} onClick={() => act("boost", { boost_id: b.id })} className="panel p-4 text-left transition-colors hover:border-[var(--color-accent)]">
                <div className="font-display text-2xl font-bold">+{b.slots}<span className="text-sm text-[var(--color-dim)]"> parallel</span></div>
                <div className="mt-1 text-sm text-[var(--color-dim)]">${b.price} · +{b.credits} credits</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
