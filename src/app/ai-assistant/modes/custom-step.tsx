"use client";
import { useState } from "react";
import { z } from "zod";

/**
 * Custom-mode step controls - the per-step model picker and effort select.
 * Both go through the step edit API (POST steps/:stepId with rev) - never a
 * client-side only override - so a pick is a revisioned spec change that
 * resets the step and everything downstream before it re-runs.
 */

export const ModelOptionV = z.looseObject({
  endpoint_id: z.string(), label: z.string(),
  restricted: z.boolean().default(false), heavy: z.boolean().default(false),
});
export type ModelOption = z.infer<typeof ModelOptionV>;

export const EFFORT_LABEL: Record<string, string> = {
  draft: "draft", standard: "standard", high: "high",
};

export function StepModeControls({
  stepId, rev, endpointId, endpointLabel, modelChoice, effort, options, editable,
  onEdit,
}: {
  stepId: string;
  rev: number;
  endpointId: string;
  /** label for the step's current endpoint (model label or the id) */
  endpointLabel: string;
  /** the user's explicit pick - null while the planner's choice stands */
  modelChoice: string | null;
  effort: string | null;
  options: ModelOption[];
  editable: boolean;
  /** step edit call - returns the server's error text, null on success */
  onEdit: (edit: { endpoint_id?: string; effort?: string; rev: number }) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!editable) return null;
  const selCls = "rounded-md border border-[var(--color-line)] bg-[var(--color-panel2)] px-1.5 py-0.5 text-[10px]";

  const pick = async (edit: { endpoint_id?: string; effort?: string }) => {
    setBusy(true);
    const e = await onEdit({ ...edit, rev });
    setErr(e);
    setBusy(false);
  };

  return (
    <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5 pl-8" data-testid={`step-custom-${stepId}`}>
      <select
        className={selCls}
        value={endpointId}
        disabled={busy}
        data-testid={`step-model-${stepId}`}
        title={modelChoice ? "picked model" : "planner's model - pick to change"}
        onChange={(e) => { const v = e.target.value; if (v !== endpointId) void pick({ endpoint_id: v }); }}
      >
        <option value={endpointId}>{endpointLabel}</option>
        {options.map((o) => (
          <option key={o.endpoint_id} value={o.endpoint_id}>
            {o.label}{o.restricted ? " · restricted" : ""}
          </option>
        ))}
      </select>
      <select
        className={selCls}
        value={effort ?? ""}
        disabled={busy}
        data-testid={`step-effort-${stepId}`}
        title="effort - draft is cheapest, high leans on the endpoint's top settings; 'current settings' keeps the spec as-is"
        onChange={(e) => { const v = e.target.value; if (v && v !== effort) void pick({ effort: v }); }}
      >
        {effort === null && <option value="">current settings</option>}
        {Object.entries(EFFORT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {busy && <span className="text-[10px] text-[var(--color-dim)]">…</span>}
      {err && <span className="text-[10px] text-red-300" data-testid={`step-custom-err-${stepId}`}>{err}</span>}
    </div>
  );
}
