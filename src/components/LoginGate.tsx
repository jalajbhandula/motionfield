"use client";
import Link from "next/link";
import { useMe } from "@/lib/use-me";

/** Slim banner for tool surfaces: while logged out, uploads 401 and jobs
 *  refuse - say so before the user discovers it by clicking. Renders
 *  nothing while loading or once signed in. */
export function LoginGate({ children }: { children?: React.ReactNode }) {
  const me = useMe();
  if (me !== null) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm">
      <span className="text-[var(--color-dim)]">
        {children ?? "You're browsing logged out - uploads and generation need an account."}
      </span>
      <Link href="/login" className="btn btn-primary btn-sm shrink-0">Log in</Link>
    </div>
  );
}
