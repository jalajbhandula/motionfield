"use client";
import { useId, useMemo, useState } from "react";
import type { PresetDef } from "@/lib/catalog/types";
import { useDismiss } from "@/lib/use-dismiss";
import { TRAJECTORY_GROUPS, TRAJECTORY_GROUP_LABELS, presetGroup, presetTrajectories, trajectoryOf, isCoreTrajectory, honestNote } from "@/lib/catalog/presets/trajectories";
import { isOrbitMove } from "@/lib/camera/trajectory";

/** Orbit stacks execute on the pose-only endpoint but the swing barely
 *  reaches the video - rows carrying one get a visible "partial" chip plus
 *  this note instead of being sold as full orbits. */
const ORBIT_PARTIAL_NOTE = "orbit moves barely reach the video on this model yet - expect a near-static background";

/** Motion-preset picker - presets grouped by their trajectory's group
 *  (basic / cinematic / energetic / lens / time / transition). When the
 *  selected workflow doesn't execute trajectories (executes=false), every row
 *  is labelled "prompt-guided" and the stack lives in the tooltip - the chips
 *  would promise motion that never reaches the render. On an executing
 *  workflow, rows whose stack carries a rig-mode id (or no stack at all) are
 *  disabled outright - the endpoint would refuse them - unless `guidedOk`
 *  (the Director) makes them selectable "prompt-guided" rows instead; a stack
 *  that mixes runnable and unrunnable ids stays selectable with a "partly
 *  prompt-guided" chip and the runnable ids still show as executed chips;
 *  core rows show their honest notes under the title and orbit rows
 *  additionally carry a "partial" chip because the move reads weak on this
 *  model. "Auto" there is a locked-off shot, so it reads "Static". */
export function TrajectoryPicker({ label, value, presets, onChange, executes, execMove = isCoreTrajectory, guidedOk = false, hideDisabled = false }: {
  label: string;
  /** the selected preset title, or "Auto" */
  value: string;
  presets: readonly PresetDef[];
  onChange: (title: string) => void;
  /** whether the selected workflow runs the stack end-to-end */
  executes?: boolean;
  /** which move ids this endpoint executes - the Director's rig also runs
   *  the focus pull (isDirectorMove); default is the pose-only core set */
  execMove?: (id: string) => boolean;
  /** executing endpoint that prompt-guides what it can't run - unrunnable
   *  stacks become selectable "prompt-guided" rows, not disabled */
  guidedOk?: boolean;
  /** executing endpoint that can't use a row at all hides it outright -
   *  re-shoot's picker never lists stacks it would only refuse */
  hideDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLDivElement>(open, setOpen);
  const uid = useId();
  const groups = useMemo(() => {
    const motion = presets.filter((p) => p.kind === "motion");
    const by = new Map<string, PresetDef[]>();
    for (const p of motion) {
      const g = presetGroup(p);
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(p);
    }
    return TRAJECTORY_GROUPS.filter((g) => by.has(g))
      .map((g) => ({ group: g, items: by.get(g)! }))
      // the same condition that renders a row disabled below - with
      // hideDisabled the row (and its emptied group) simply isn't listed
      .map(({ group, items }) => ({
        group,
        items: hideDisabled && executes && !guidedOk
          ? items.filter((p) => { const s = presetTrajectories(p); return s.length > 0 && s.every(execMove); })
          : items,
      }))
      .filter(({ items }) => items.length > 0);
  }, [presets, hideDisabled, executes, guidedOk, execMove]);

  const shown = executes && value === "Auto" ? "Static" : value;
  return (
    <div className="relative" ref={wrap}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)]">
        <span className="text-[var(--color-dim)]">{label}</span>
        <span className="font-semibold">{shown}</span>
        <span className="text-[var(--color-dim)]">▾</span>
      </button>
      {open && (
        <div data-testid="traj-picker-pop"
          className="absolute left-0 top-8 z-30 max-h-72 w-64 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl">
          <button type="button" onClick={() => { onChange("Auto"); setOpen(false); }}
            aria-label={executes ? "Static" : "Auto"} aria-describedby={executes ? `${uid}-auto` : undefined}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-panel2)] ${value === "Auto" ? "text-[var(--color-accent)]" : ""}`}>
            <span>{executes ? "Static" : "Auto"}</span>
            {executes && <span id={`${uid}-auto`} className="text-[9px] text-[var(--color-dim)]">locked-off</span>}
          </button>
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div data-trajectory-group={group}
                className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-dim)]">
                {TRAJECTORY_GROUP_LABELS[group]}
              </div>
              {items.map((p) => {
                const stack = presetTrajectories(p);
                const execIds = stack.filter(execMove);
                const guidedIds = stack.filter((id) => !execMove(id));
                const rig = guidedIds.length > 0;
                // a stack that mixes runnable + unrunnable ids is still
                // pickable on a prompt-guiding endpoint - the runnable part
                // executes, the rest steers the prompt
                const mixed = !!executes && guidedOk && rig && execIds.length > 0;
                const guided = !!executes && guidedOk && !mixed && (rig || stack.length === 0);
                const disabled = !!executes && !guidedOk && (rig || stack.length === 0);
                const reason = mixed
                  ? `partly prompt-guided - ${guidedIds.map((id) => trajectoryOf(id)?.label ?? id).join(" + ")} steer${guidedIds.length === 1 ? "s" : ""} the prompt`
                  : guided
                    ? (rig ? "can't run on this rig - steers the prompt" : "no camera path - steers the prompt")
                    : (rig ? "not on this model - needs rig modes" : "no camera path");
                const partial = !!executes && !disabled && !guided && !mixed && stack.some(isOrbitMove);
                const notes = executes && !disabled && !guided && !mixed
                  ? [...(partial ? [ORBIT_PARTIAL_NOTE] : []),
                     ...new Set(stack.map((id) => honestNote(id, "image")).filter((x): x is string => !!x))]
                  : [];
                const tip = disabled || guided || mixed
                  ? `${p.description} - ${reason}${stack.length ? ` (${stack.map((id) => trajectoryOf(id)?.label ?? id).join(" + ")})` : ""}`
                  : !executes && stack.length
                    ? `${p.description} - ${stack.map((id) => trajectoryOf(id)?.label ?? id).join(" + ")}`
                    : p.description;
                const descId = `${uid}-${p.id}`;
                return (
                  <button key={p.id} type="button" disabled={disabled}
                    onClick={() => { onChange(p.title); setOpen(false); }}
                    title={tip}
                    aria-label={p.title}
                    aria-describedby={disabled ? `${descId}-why` : `${descId}-why ${descId}-chips`}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${disabled ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--color-panel2)]"} ${p.title === value ? "text-[var(--color-accent)]" : ""}`}>
                    <span className="flex min-w-0 flex-col">
                      <span>{p.title}</span>
                      <span id={`${descId}-why`} className="flex flex-col">
                        {(disabled || guided || mixed) && <span className="text-[9px] text-[var(--color-dim)]">{reason}</span>}
                        {notes.map((n) => <span key={n} className="text-[9px] text-[var(--color-dim)]">{n}</span>)}
                      </span>
                    </span>
                    {!disabled && (
                      <span id={`${descId}-chips`} className="flex max-w-[62%] shrink-0 flex-wrap items-center justify-end gap-1">
                        {(!executes || stack.length === 0 || rig) && !mixed && (
                          <span className="rounded-full border border-[var(--color-line)] px-1.5 py-px text-[9px] text-[var(--color-dim)]">prompt-guided</span>
                        )}
                        {mixed && (
                          <span className="rounded-full border border-[var(--color-line)] px-1.5 py-px text-[9px] text-[var(--color-dim)]">partly prompt-guided</span>
                        )}
                        {partial && (
                          <>
                            <span className="rounded-full border border-[var(--color-line)] px-1.5 py-px text-[9px] text-[var(--color-dim)]">partial</span>
                            <span className="rounded-full border border-[var(--color-line)] px-1.5 py-px text-[9px] text-[var(--color-dim)]">cloud-recommended</span>
                          </>
                        )}
                        {executes && !guided && (mixed ? execIds : stack).map((id) => {
                          const t = trajectoryOf(id);
                          return (
                            <span key={id}
                              title={mixed && !execMove(id) ? reason : (t?.honest_note ?? t?.mechanism)}
                              className="rounded-full bg-[var(--color-panel2)] px-1.5 py-px text-[9px] text-[var(--color-dim)]">
                              {t?.label ?? id}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
