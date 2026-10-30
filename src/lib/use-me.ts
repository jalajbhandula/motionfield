"use client";
import { useEffect, useState } from "react";

export type Me = {
  user: { id: string; email: string; name: string | null };
  plan?: { name?: string };
} | null;

/** Who's signed in - `undefined` while loading, `null` when logged out.
 *  One cheap /api/me call per mounted page; used for the "log in to
 *  upload/generate" banner so a logged-out user finds out before they hit
 *  a dead control, not after. */
export function useMe(): Me | undefined {
  const [me, setMe] = useState<Me | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then(async (r) => (r.ok ? ((await r.json()) as NonNullable<Me>) : null))
      .then((d) => { if (live) setMe(d); })
      .catch(() => { if (live) setMe(null); });
    return () => { live = false; };
  }, []);
  return me;
}
