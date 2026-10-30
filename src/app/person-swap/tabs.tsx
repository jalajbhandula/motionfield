/** Mode tabs across the three PersonSwap surfaces - Person, Object, Restyle. */
export function PersonSwapTabs({ active }: { active: "person" | "object" | "restyle" }) {
  const tabs = [
    { id: "person", href: "/person-swap", label: "Person", blurb: "Identity swap on a clip" },
    { id: "object", href: "/object-swap", label: "Object", blurb: "Replace a picked object" },
    { id: "restyle", href: "/restyle", label: "Restyle", blurb: "Re-render the look" },
  ] as const;
  return (
    <div className="mt-4 flex gap-2" role="tablist" aria-label="Swap mode">
      {tabs.map((t) => (
        <a key={t.id} href={t.href} role="tab" aria-selected={active === t.id}
          className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm transition
            ${active === t.id
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-border)] text-[var(--color-dim)]"}`}>
          <div className="font-medium">{t.label}</div>
          <div className="text-xs opacity-80">{t.blurb}</div>
        </a>
      ))}
    </div>
  );
}
