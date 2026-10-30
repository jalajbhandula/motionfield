import { NextRequest, NextResponse } from "next/server";
import { err, json, requireApiUser } from "@/lib/api";
import { hostedMode } from "@/lib/llm/offline";
import { userOffline } from "@/lib/llm/settings";
import { currentOptIn } from "@/lib/runs/endpoints";
import type { LicenceVerdict } from "./guards";

/**
 * The gate every /api/models/hub route runs first, in this order:
 *   1. a session - requireApiUser throws JobError("unauthorized") → 401
 *   2. hosted mode → 403 "not available in hosted mode"
 *   3. the user's Offline toggle (env or saved pref) → refused before any
 *      HF call ever leaves the machine
 */

export class HubHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HubHttpError";
  }
}

export function hubErr(e: unknown): NextResponse {
  if (e instanceof HubHttpError) return json({ error: e.message }, e.status);
  return err(e);
}

export async function hubUser(req: NextRequest, opts: { offlineOk?: boolean } = {}): Promise<{ id: string }> {
  const { user } = await requireApiUser(req);
  if (hostedMode()) {
    throw new HubHttpError("the Hugging Face hub is not available in hosted mode", 403);
  }
  // reads and local ops (list rows, cancel) need no network - Offline only
  // bars the actions that would touch HF (inspect, start, pull)
  if (!opts.offlineOk && await userOffline(user.id)) {
    throw new HubHttpError("Offline mode is on - downloads need the network", 403);
  }
  return user;
}

/** Is the caller allowed to act on this verdict right now? open and
 *  permissive-terms always; restricted needs the current licence opt-in;
 *  refused never. Used by both the inspect payload and the action routes. */
export async function verdictAllowed(userId: string, v: LicenceVerdict): Promise<boolean> {
  if (v.cls === "open" || v.cls === "permissive-terms") return true;
  if (v.cls === "restricted") return currentOptIn(userId);
  return false;
}

/** Action routes re-check the verdict server-side - a class from the client
 *  is never trusted. */
export async function assertVerdictAllowed(userId: string, v: LicenceVerdict): Promise<void> {
  if (!(await verdictAllowed(userId, v))) throw new HubHttpError(v.reason, 403);
}
