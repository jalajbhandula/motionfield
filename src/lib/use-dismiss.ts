"use client";
import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** One popover open at a time, app-wide: opening any popover that uses this
 *  hook closes every other one. Outside press and Esc close it too. Attach
 *  the returned ref to the element wrapping both the trigger and the panel. */
const EVT = "of:popover-open";

export function useDismiss<T extends HTMLElement>(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  const ref = useRef<T>(null);
  const id = useId();
  useEffect(() => {
    const onOther = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) setOpen(false); };
    window.addEventListener(EVT, onOther);
    return () => window.removeEventListener(EVT, onOther);
  }, [id, setOpen]);
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(EVT, { detail: id }));
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, setOpen, id]);
  return ref;
}

/** Which way a popover should open from its trigger: down unless there's
 *  not enough room under it (e.g. a composer docked at the bottom). */
export function useDropUp(ref: { current: HTMLElement | null }, open: boolean, need = 240): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setUp(window.innerHeight - r.bottom < need && r.top > window.innerHeight - r.bottom);
  }, [open, ref, need]);
  return up;
}

/** For a group that manages its own several menus (the header): tells every
 *  other popover to close while any of the group's menus is open, and runs
 *  `closeAll` when some other popover opens. */
export function usePopoverGroup(anyOpen: boolean, closeAll: () => void) {
  const id = useId();
  const close = useRef(closeAll);
  close.current = closeAll;
  useEffect(() => {
    const onOther = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) close.current(); };
    window.addEventListener(EVT, onOther);
    return () => window.removeEventListener(EVT, onOther);
  }, [id]);
  useEffect(() => { if (anyOpen) window.dispatchEvent(new CustomEvent(EVT, { detail: id })); }, [anyOpen, id]);
}
