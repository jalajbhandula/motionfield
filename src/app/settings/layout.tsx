"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Profile", href: "/settings" },
  { label: "API keys", href: "/settings/keys" },
  { label: "Models & LLMs", href: "/settings/models" },
  { label: "Licenses", href: "/settings/licenses" },
] as const;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-8 md:grid-cols-[220px_1fr]">
      <nav className="space-y-1">
        <h1 className="font-display mb-3 text-xl font-bold">Settings</h1>
        {TABS.map((t) => (
          <Link key={t.href} href={t.href}
            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${pathname === t.href ? "bg-[var(--color-panel2)] text-white" : "text-[var(--color-dim)] hover:text-white"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
