import { z } from "zod";
import { sql } from "@/db";
import type { NormalizedStep } from "./plan";
import { effortDiffers } from "./modes";

/**
 * Run estimation - credits from each step's catalog cost function (validated
 * params, same values the eventual job is charged on), ETA from the median
 * duration of the endpoint's last 20 completed jobs. ETA is honestly null
 * when an endpoint has no history - the UI shows "unknown", not a guess.
 */

const ETA_SAMPLES = 20;

/** The median-of-durations query - exported so an in-transaction estimate can
 *  run it through the tx's own query fn (a second connection inside the
 *  advisory-lock transaction would deadlock on the single-connection engine). */
export const MEDIAN_SQL =
  `SELECT EXTRACT(EPOCH FROM (completed_at - started_at))::float8 AS s
     FROM jobs
    WHERE endpoint_id = $1 AND status = 'completed'
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT $2`;

/** Median over raw second samples - null when there's no history. */
export function medianOf(xs: number[]): number | null {
  const vals = xs.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = vals.length >> 1;
  return Math.round(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
}

/** Credits under which a run may start without an explicit approve.
 *  RUN_AUTO_APPROVE_MAX_CREDITS is the spec name; RUN_AUTO_APPROVE_CAP stays
 *  as a legacy alias. Fails closed - a missing, non-numeric or negative
 *  value falls back to 5 rather than auto-approving everything (NaN would
 *  make `total > cap` always false). */
const capRaw = process.env.RUN_AUTO_APPROVE_MAX_CREDITS ?? process.env.RUN_AUTO_APPROVE_CAP;
const capNum = Number(capRaw ?? 5);
export const AUTO_APPROVE_CAP_CREDITS = Number.isFinite(capNum) && capNum >= 0 ? capNum : 5;

export async function medianSeconds(endpointId: string): Promise<number | null> {
  const rows = await sql<{ s: number }>(MEDIAN_SQL, [endpointId, ETA_SAMPLES]);
  return medianOf(rows.map((r) => Number(r.s)));
}

/** medianSeconds through a transaction's own query fn - a nested sql() call
 *  inside tx() would queue behind the transaction on the embedded engine. */
export async function medianSecondsTx(
  q: (query: string, params?: unknown[]) => Promise<unknown[]>,
  endpointId: string,
): Promise<number | null> {
  const rows = z.array(z.looseObject({ s: z.unknown() })).parse(await q(MEDIAN_SQL, [endpointId, ETA_SAMPLES]));
  return medianOf(rows.map((r) => Number(r.s)));
}

export interface RunEstimate {
  total: number;
  /** Sum of per-step medians, or null when any step's ETA is unknown. */
  etaSeconds: number | null;
  perStep: { stepId: string; cost: number; etaSeconds: number | null }[];
}

export async function estimateSteps(
  steps: NormalizedStep[],
  opts: { median?: (endpointId: string) => Promise<number | null> } = {},
): Promise<RunEstimate> {
  const med = opts.median ?? medianSeconds;
  const perStep = await Promise.all(steps.map(async (s) => {
    // the endpoint median only describes default-spec jobs - a step whose
    // effort knobs differ gets no borrowed number (honest "unknown")
    const eta = await med(s.endpointId);
    return {
      stepId: s.stepId,
      cost: s.cost,
      etaSeconds: eta != null && s.workflow && effortDiffers(s.workflow, s.params) ? null : eta,
    };
  }));
  const total = perStep.reduce((a, b) => a + b.cost, 0);
  const known = perStep.every((s) => s.etaSeconds != null);
  return {
    total,
    etaSeconds: known ? perStep.reduce((a, b) => a + (b.etaSeconds ?? 0), 0) : null,
    perStep,
  };
}
