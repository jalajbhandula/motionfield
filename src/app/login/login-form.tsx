"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "@/lib/auth-client";
import { safeNext } from "./safe-next";

export function LoginForm({ providers }: { providers: string[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(sp.get("next"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await signIn.email({ email, password });
    if (res.error) { setError(res.error.message ?? "sign in failed"); setBusy(false); return; }
    router.push(next); router.refresh();
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="panel w-full max-w-sm p-6">
        <Link href="/" className="font-display text-xl font-bold">Motion<span className="text-[var(--color-accent)]">Field</span></Link>
        <h1 className="mt-4 text-lg font-semibold">Welcome back</h1>
        <p className="mb-5 text-sm text-[var(--color-dim)]">Log in to keep creating.</p>

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
          <input className="input" type="email" required placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        </form>
        <p className="mt-4 text-center text-sm text-[var(--color-dim)]">
          New here? <Link href={`/signup?next=${encodeURIComponent(next)}`} className="text-[var(--color-accent)]">Create account - get 50 credits</Link>
        </p>
      </div>
    </div>
  );
}
