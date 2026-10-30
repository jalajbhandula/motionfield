"use client";
import Link from "next/link";
import type { UserError } from "@/lib/user-error";

/** The one place error text becomes pixels. Accepts a UserError or a bare
 *  string (defensive: the raw "unauthorized" still renders as the login
 *  prompt). */
export function ErrNote({ err, className }: {
  err: UserError | string | null | undefined;
  className?: string;
}) {
  if (!err) return null;
  const e: UserError =
    typeof err === "string"
      ? err === "unauthorized"
        ? { message: "You're not logged in - log in to upload files and run jobs.",
            status: 401, action: { label: "Log in", href: "/login" } }
        : { message: err }
      : err;
  return (
    <div role="alert"
      className={`rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 ${className ?? ""}`}>
      {e.message}
      {e.action && (
        <>
          {" "}
          <Link href={e.action.href}
            className="font-medium text-[var(--color-accent)] underline underline-offset-2">
            {e.action.label} →
          </Link>
        </>
      )}
    </div>
  );
}
