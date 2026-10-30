"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

type Me = {
  user: { id: string; email: string; name: string };
  profile: {
    handle: string | null; displayName: string | null; bio: string | null; avatarUrl: string | null;
    planId: string; planRenewsAt: string | null; credits: string; boostSlots: number;
    autoPublish: boolean; specialty: string | null; studio: string | null; location: string | null;
    links: Record<string, string>; onboarded: boolean;
  };
  plan: { id: string; name: string; parallelVideo: number; parallelImage: number };
};

type Ledger = { id: string; delta: string; kind: string; note: string | null; createdAt: string; balanceAfter: string };

const SECTIONS = [
  ["profile", "Personal Profile"],
  ["subscription", "Subscription"],
  ["usage", "Usage"],
  ["promocode", "Promocode"],
  ["members", "Members"],
] as const;

export default function Settings() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<string>("profile");
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [promo, setPromo] = useState("");

  useEffect(() => { if (!isPending && !session?.user) router.push("/login?next=/me/settings"); }, [isPending, session]);
  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => { setMe(d); setForm(d.profile ?? {}); }).catch(() => {});
    fetch("/api/me/ledger").then((r) => r.json()).then((d) => setLedger(d.entries ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    const h = location.hash.slice(1);
    if (SECTIONS.some(([id]) => id === h)) setTab(h);
    if (new URLSearchParams(location.search).get("checkout") === "success") setMsg("Payment complete - plan updated.");
  }, []);

  async function save() {
    const r = await fetch("/api/me/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const d = await r.json();
    setMsg(r.ok ? "Saved." : d.error ?? "failed");
  }

  async function redeem() {
    const r = await fetch("/api/promocode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: promo }) });
    const d = await r.json();
    setMsg(r.ok ? `Redeemed: +${d.credits} credits${d.plan ? ` + ${d.plan} plan` : ""}` : d.error ?? "invalid code");
  }

  if (!me?.profile) return <div className="p-16 text-center text-[var(--color-dim)]">Loading…</div>;
  const p = me.profile;

  return (
    <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-8 md:grid-cols-[220px_1fr]">
      <nav className="space-y-1">
        <h1 className="font-display mb-3 text-xl font-bold">Manage account</h1>
        {SECTIONS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${tab === id ? "bg-[var(--color-panel2)] text-white" : "text-[var(--color-dim)] hover:text-white"}`}>{label}</button>
        ))}
      </nav>
      <div>
        {msg && <p className="mb-4 rounded-lg border border-[var(--color-accent)]/40 bg-[rgba(212,255,63,.08)] px-4 py-2 text-sm">{msg}</p>}

        {tab === "profile" && (
          <div className="panel max-w-xl space-y-4 p-5">
            <h2 className="font-semibold">Personal profile</h2>
            <Field label="Handle (@)"><input className="input" value={String(form.handle ?? "")} onChange={(e) => setForm({ ...form, handle: e.target.value })} /></Field>
            <Field label="Display name"><input className="input" value={String(form.displayName ?? "")} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
            <Field label="Bio"><textarea className="input" value={String(form.bio ?? "")} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Specialty"><input className="input" value={String(form.specialty ?? "")} onChange={(e) => setForm({ ...form, specialty: e.target.value })} /></Field>
              <Field label="Studio"><input className="input" value={String(form.studio ?? "")} onChange={(e) => setForm({ ...form, studio: e.target.value })} /></Field>
              <Field label="Location"><input className="input" value={String(form.location ?? "")} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
            </div>
            <Field label="Social links (JSON - instagram, youtube, tiktok, x, discord, website)">
              <input className="input" defaultValue={JSON.stringify(p.links ?? {})} onBlur={(e) => { try { setForm({ ...form, links: JSON.parse(e.target.value) }); } catch {} }} />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={!!form.autoPublish} onChange={(e) => setForm({ ...form, autoPublish: e.target.checked })} className="accent-[var(--color-accent)]" />
              Auto-publish new generations to community
            </label>
            <button className="btn btn-primary" onClick={save}>Save changes</button>
            <div className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-faint)]">
              Account deletion: contact support - data is retained 30 days before permanent removal.
            </div>
          </div>
        )}

        {tab === "subscription" && (
          <div className="panel max-w-xl space-y-4 p-5">
            <h2 className="font-semibold">Subscription</h2>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-2xl font-bold">{me.plan.name}</div>
                <div className="text-sm text-[var(--color-dim)]">{p.planRenewsAt ? `Renews ${new Date(p.planRenewsAt).toLocaleDateString()}` : "No active subscription"}</div>
              </div>
              <div className="text-right">
                <div className="font-display text-2xl font-bold text-[var(--color-accent)]">{Math.round(Number(p.credits))}</div>
                <div className="text-xs text-[var(--color-dim)]">credits</div>
              </div>
            </div>
            <div className="flex gap-2">
              <a href="/pricing" className="btn btn-primary btn-sm">Change plan</a>
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                const r = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "portal" }) });
                const d = await r.json();
                if (d.url) location.href = d.url; else setMsg("Stripe not configured - self-serve portal unavailable in dev mode.");
              }}>Manage billing ↗</button>
              {p.planId !== "free" && <button className="btn btn-ghost btn-sm text-[var(--color-danger)]" onClick={() => fetch("/api/billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel_plan" }) }).then(() => location.reload())}>Cancel plan</button>}
            </div>
            <div className="border-t border-[var(--color-border)] pt-4">
              <h3 className="text-sm font-semibold">Unlimited models</h3>
              <p className="mt-1 text-xs text-[var(--color-dim)]">{(me.plan as unknown as { unlimitedModels?: string[] }).unlimitedModels?.join(", ") || "None on this plan - upgrade for unlimited generation on select models."}</p>
            </div>
          </div>
        )}

        {tab === "usage" && (
          <div className="panel max-w-2xl p-5" id="usage">
            <h2 className="font-semibold">Usage</h2>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div className="panel p-3"><div className="font-display text-xl font-bold">{Math.round(Number(p.credits))}</div><div className="text-xs text-[var(--color-dim)]">Balance</div></div>
              <div className="panel p-3"><div className="font-display text-xl font-bold">+{p.boostSlots}</div><div className="text-xs text-[var(--color-dim)]">Boost slots</div></div>
              <div className="panel p-3"><div className="font-display text-xl font-bold">{me.plan.parallelVideo + p.boostSlots}</div><div className="text-xs text-[var(--color-dim)]">Parallel limit</div></div>
            </div>
            <a href="/pricing#topup" className="btn btn-ghost btn-sm mt-4">Buy boost credits</a>
            <h3 className="mt-6 mb-2 text-sm font-semibold">Credit ledger</h3>
            <div className="max-h-96 space-y-1 overflow-y-auto">
              {ledger.map((l) => (
                <div key={l.id} className="flex items-center justify-between rounded-lg bg-[var(--color-panel2)] px-3 py-2 text-xs">
                  <span className="text-[var(--color-dim)]">{l.note ?? l.kind}</span>
                  <span className={Number(l.delta) >= 0 ? "text-[var(--color-accent)]" : "text-white"}>{Number(l.delta) >= 0 ? "+" : ""}{Number(l.delta)}</span>
                  <span className="text-[var(--color-faint)]">{new Date(l.createdAt).toLocaleDateString()}</span>
                </div>
              ))}
              {ledger.length === 0 && <p className="text-xs text-[var(--color-faint)]">No transactions yet.</p>}
            </div>
          </div>
        )}

        {tab === "promocode" && (
          <div className="panel max-w-xl space-y-4 p-5">
            <h2 className="font-semibold">Promocode</h2>
            <p className="text-sm text-[var(--color-dim)]">Enter a code for bonus credits or plan upgrades.</p>
            <div className="flex gap-2">
              <input className="input uppercase" placeholder="MOTIONFIELD-XXXX" value={promo} onChange={(e) => setPromo(e.target.value)} />
              <button className="btn btn-primary" onClick={redeem}>Redeem</button>
            </div>
          </div>
        )}

        {tab === "members" && (
          <div className="panel max-w-xl space-y-4 p-5">
            <h2 className="font-semibold">Members</h2>
            <p className="text-sm text-[var(--color-dim)]">Team workspaces with pooled credits, roles (owner/admin/member), groups, and spend controls are available on Team & Scale plans.</p>
            <a href="/pricing" className="btn btn-primary btn-sm">Upgrade to Team</a>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium text-[var(--color-dim)]">{label}</span>{children}</label>;
}
