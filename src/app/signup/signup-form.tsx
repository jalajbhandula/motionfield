"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn, signUp } from "@/lib/auth-client";
import { safeNext } from "@/app/login/safe-next";

export function SignupForm({ providers }: { providers: string[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(sp.get("next"), "/onboarding");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await signUp.email({ email, password, name });
    if (res.error) { setError(res.error.message ?? "sign up failed"); setBusy(false); return; }
    router.push(next); router.refresh();
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="panel w-full max-w-sm p-6">
        <Link href="/" className="font-display text-xl font-bold">Motion<span className="text-[var(--color-accent)]">Field</span></Link>
        <h1 className="mt-4 text-lg font-semibold">Create your account</h1>
        <p className="mb-5 text-sm text-[var(--color-dim)]">50 free credits on signup · 10 more daily on the free plan.</p>

        {providers.length > 0 && (
          <>
            <div className={`grid gap-2 ${providers.length === 1 ? "grid-cols-1" : providers.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
              {providers.map((p) => (
                <button key={p} onClick={() => signIn.social({ provider: p as "google", callbackURL: next })}
                  className="btn btn-ghost btn-sm capitalize">{p}</button>
              ))}
            </div>
            <div className="my-4 flex items-center gap-3 text-xs text-[var(--color-faint)]"><span className="h-px flex-1 bg-[var(--color-border)]" />or with email<span className="h-px flex-1 bg-[var(--color-border)]" /></div>
          </>
        )}

        <form onSubmit={submit} className="space-y-3">
          <input className="input" required placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="email" required placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" required minLength={8} placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Get 50 credits →"}</button>
        </form>
        <p className="mt-4 text-center text-sm text-[var(--color-dim)]">
          Have an account? <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-[var(--color-accent)]">Log in</Link>
        </p>
      </div>
    </div>
  );
}
