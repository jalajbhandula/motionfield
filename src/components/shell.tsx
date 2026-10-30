"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { NAV_ENTRIES, type NavEntry } from "@/lib/nav";
import { NAV_GROUP_ORDER, navMeta } from "@/lib/nav-meta";
import { Bell } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { usePopoverGroup } from "@/lib/use-dismiss";
import { Chevron, NavGlyph } from "@/components/nav-icons";

type Me = {
  user: { id: string; email: string; name: string } | null;
  profile: { handle: string | null; displayName: string | null; credits: string; planId: string; avatarUrl: string | null } | null;
  plan: { name: string } | null;
};

/** Close when focus leaves the whole dropdown wrapper (trigger + panel). */
const blurOut = (close: () => void) => (e: React.FocusEvent) => {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
};

/** Hover intent: a short delay before opening (so sweeping across the bar
 *  doesn't flash menus), a longer one before closing, and a switch delay when
 *  another menu is open - a diagonal move from a trigger into its wide panel
 *  crosses neighbouring triggers, and reaching the panel within the delay
 *  cancels the switch. */
const OPEN_DELAY_MS = 70;
const SWITCH_DELAY_MS = 160;
const CLOSE_DELAY_MS = 220;
/** Entries with more children than this get the wide grouped panel. */
const MEGA_MIN_ITEMS = 6;

function GpuStatus() {
  const [status, setStatus] = useState<{ label: string; detail: string; gpu: string } | null>(null);
  useEffect(() => {
    fetch("/api/setup-status")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus({ gpu: "not_connected", label: "GPU not connected", detail: "Could not check the GPU." }));
  }, []);
  if (!status) return null;
  const dot = status.gpu === "connected" ? "bg-emerald-400" : status.gpu === "not_used" ? "bg-amber-300" : "bg-white/35";
  return (
    <span title={status.detail} data-testid="gpu-status" data-gpu={status.gpu}
      className="hidden items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-[var(--color-dim)] md:inline-flex">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status.label}
    </span>
  );
}

const readyChildren = (item: NavEntry) => (item.children ?? []).filter((c) => c.ready);

/** Arrow keys move focus between the menu's items. */
function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
    : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next].focus();
}

function MenuItem({ c, active, onPick, asMenuItem = true }: { c: NavEntry; active: boolean; onPick: () => void; asMenuItem?: boolean }) {
  const m = navMeta(c.href);
  return (
    <Link href={c.href} role={asMenuItem ? "menuitem" : undefined} onClick={onPick}
      className={`group flex items-start gap-3 rounded-xl px-2.5 py-2 outline-none transition-colors focus-visible:bg-[var(--color-panel2)] ${
        active ? "bg-[var(--color-panel2)]" : "hover:bg-[var(--color-panel2)]"}`}>
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center transition-colors ${
        active ? "text-[var(--color-text)]" : "text-[var(--color-faint)] group-hover:text-[var(--color-text)]"}`}>
        <NavGlyph name={m.icon} className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-medium ${active ? "text-[var(--color-text)]" : "text-[var(--color-text)]"}`}>{c.label}</span>
        {m.desc && <span className="block text-[12px] leading-snug text-[var(--color-faint)] group-hover:text-[var(--color-dim)]">{m.desc}</span>}
      </span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === "/login" || pathname === "/signup" || pathname === "/onboarding";
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState<string | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<{ id: string; title: string; readAt: string | null; href: string | null; createdAt: string }[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // hover-intent timers + a mirror of navOpen readable inside them
  const navOpenRef = useRef<string | null>(null);
  navOpenRef.current = navOpen;
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimers = () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); };
  useEffect(() => clearTimers, []);
  const hoverIn = (label: string) => {
    clearTimers();
    if (navOpenRef.current === label) return;
    openTimer.current = setTimeout(() => setNavOpen(label), navOpenRef.current ? SWITCH_DELAY_MS : OPEN_DELAY_MS);
  };
  // leaving any trigger/panel schedules a close of whatever is open; entering
  // any trigger/panel (hoverIn) cancels it
  const hoverOut = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setNavOpen(null), CLOSE_DELAY_MS);
  };
  const openAndFocusFirst = (label: string, wrapper: HTMLElement | null) => {
    clearTimers();
    setNavOpen(label);
    requestAnimationFrame(() => wrapper?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  };

  useEffect(() => {
    if (!session?.user) { setMe(null); return; }
    fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => {});
    fetch("/api/notifications").then((r) => r.json()).then((d) => setNotifs(d.notifications ?? [])).catch(() => {});
    const t = setInterval(() => {
      fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [session?.user?.id]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) { setMenuOpen(false); setNotifOpen(false); } };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  // header menus join the app-wide one-popover-at-a-time rule; the account
  // and notification panels also close on a press outside the header
  usePopoverGroup(!!navOpen || menuOpen || notifOpen, () => { clearTimeout(openTimer.current); setNavOpen(null); setMenuOpen(false); setNotifOpen(false); });
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen && !notifOpen) return;
    const onDown = (e: MouseEvent) => { if (!headerRef.current?.contains(e.target as Node)) { setMenuOpen(false); setNotifOpen(false); } };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, notifOpen]);
  // a menu opened by hover has no focus inside the header, so Escape is
  // also caught at the document while one is open
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { clearTimeout(openTimer.current); setNavOpen(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // any open menu folds on navigation
  useEffect(() => { setNavOpen(null); setMenuOpen(false); setNotifOpen(false); setMobileOpen(false); }, [pathname]);

  const onHeaderKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { clearTimers(); setNavOpen(null); setMenuOpen(false); setNotifOpen(false); setMobileOpen(false); }
  };

  if (bare) return <>{children}</>;

  const credits = me?.profile ? Math.round(Number(me.profile.credits)) : null;
  const unread = notifs.filter((n) => !n.readAt).length;

  return (
    <div className="min-h-screen flex flex-col">
      <header ref={headerRef} className="sticky top-0 z-50 border-b border-[var(--color-border)] bg-[rgba(10,10,11,.85)] backdrop-blur-md" onKeyDown={onHeaderKey}>
        <div className="relative mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-display text-lg font-bold tracking-tight">
            <BrandMark size={24} />
            <span>Motion<span className="text-[var(--color-accent)]">Field</span></span>
          </Link>
          <nav className="hidden flex-1 items-center gap-0.5 px-2 md:flex" aria-label="Main">
            {NAV_ENTRIES.filter((item) => item.ready).map((item) => {
              const kids = readyChildren(item);
              const open = kids.length > 0 && navOpen === item.label;
              const mega = kids.length > MEGA_MIN_ITEMS;
              const here = pathname === item.href || kids.some((c) => c.href === pathname);
              const pick = () => { clearTimers(); setNavOpen(null); };
              return (
                // the wrapper spans the full bar height, so the panel (top-full)
                // starts exactly where the wrapper ends - no gap to fall through
                <div key={item.href + item.label} className={`${mega ? "" : "relative"} flex h-14 items-center`}
                  onMouseEnter={() => kids.length && hoverIn(item.label)}
                  onMouseLeave={() => kids.length && hoverOut()}
                  onBlur={blurOut(() => navOpenRef.current === item.label && setNavOpen(null))}>
                  <Link href={item.href}
                    aria-haspopup={kids.length ? "menu" : undefined}
                    aria-expanded={kids.length ? open : undefined}
                    onFocus={() => { if (kids.length) { clearTimers(); setNavOpen(item.label); } }}
                    onClick={() => { if (kids.length) { clearTimers(); setNavOpen(item.label); } }}
                    onKeyDown={(e) => {
                      if (!kids.length) return;
                      if (e.key === "ArrowDown") { e.preventDefault(); openAndFocusFirst(item.label, e.currentTarget.parentElement); }
                    }}
                    className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors ${
                      open || here ? "bg-[var(--color-panel2)] text-[var(--color-text)]" : "text-[var(--color-dim)] hover:text-[var(--color-text)]"}`}>
                    {item.label}
                    {kids.length > 0 && <Chevron open={open} className="h-3 w-3 opacity-70" />}
                  </Link>
                  {open && (mega ? (
                    <div className="pointer-events-none absolute inset-x-0 top-full z-50 flex justify-center px-4">
                      <div role="menu" aria-label={`${item.label} menu`} onKeyDown={menuKeys}
                        className="menu-in pointer-events-auto grid w-full max-w-[860px] grid-cols-4 gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
                        {NAV_GROUP_ORDER.map((g) => {
                          const inGroup = kids.filter((c) => navMeta(c.href).group === g);
                          if (!inGroup.length) return null;
                          return (
                            <div key={g} className="min-w-0">
                              <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-[var(--color-faint)]">{g}</div>
                              {inGroup.map((c) => <MenuItem key={c.href + c.label} c={c} active={pathname === c.href} onPick={pick} />)}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div role="menu" aria-label={`${item.label} menu`} onKeyDown={menuKeys}
                      className="menu-in absolute left-0 top-full z-50 w-72 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-[0_24px_60px_rgba(0,0,0,.55)]">
                      {kids.map((c) => <MenuItem key={c.href + c.label} c={c} active={pathname === c.href} onPick={pick} />)}
                    </div>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="flex-1 md:hidden" />
          {/* wrapper carries md:hidden - .btn's unlayered display rule would beat the utility */}
          <div className="md:hidden">
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Open menu"
              aria-expanded={mobileOpen} aria-controls="mobile-nav" onClick={() => setMobileOpen((v) => !v)}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d={mobileOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2 shrink-0" ref={menuRef}>
            <GpuStatus />
            {me?.profile ? (
              <>
                <Link href="/pricing" className="chip transition-colors hover:bg-[var(--color-raised)]" title="Credits">
                  <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-accent)]" />
                  {credits} <span className="hidden sm:inline">credits</span>
                </Link>
                <div className="relative" onBlur={blurOut(() => setNotifOpen(false))}>
                  <button className="btn-ghost btn btn-sm relative" aria-label="Notifications"
                    aria-haspopup="menu" aria-expanded={notifOpen}
                    onClick={() => { setNotifOpen(!notifOpen); setMenuOpen(false); }}>
                    <Bell size={15} />{unread > 0 && <span className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-[var(--color-accent)] text-[10px] text-black font-bold grid place-items-center px-1">{unread}</span>}
                  </button>
                  {notifOpen && (
                    <div role="menu" aria-label="Notifications menu"
                      className="absolute right-0 top-10 w-80 panel p-2 shadow-2xl z-50 max-h-96 overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1">
                        <span className="text-xs font-semibold text-[var(--color-dim)]">NOTIFICATIONS</span>
                        <button role="menuitem" className="text-xs text-[var(--color-dim)] hover:text-white" onClick={() => fetch("/api/notifications", { method: "PATCH" }).then(() => setNotifs(notifs.map(n => ({ ...n, readAt: "x" }))))}>Mark all read</button>
                      </div>
                      {notifs.length === 0 && <p className="text-sm text-[var(--color-faint)] p-3">No notifications yet.</p>}
                      {notifs.map((n) => (
                        <Link key={n.id} href={n.href ?? "#"} role="menuitem" onClick={() => setNotifOpen(false)}
                          className={`block rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-panel2)] ${n.readAt ? "opacity-50" : ""}`}>
                          {n.title}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative" onBlur={blurOut(() => setMenuOpen(false))}>
                  <button onClick={() => { setMenuOpen(!menuOpen); setNotifOpen(false); }}
                    aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Account menu"
                    className="h-8 w-8 rounded-full bg-[var(--color-panel2)] border border-[var(--color-border)] grid place-items-center text-xs font-bold uppercase">
                    {me.profile.avatarUrl ? <img src={me.profile.avatarUrl} className="h-8 w-8 rounded-full object-cover" /> : (me.profile.displayName ?? "U")[0]}
                  </button>
                  {menuOpen && (
                    <div role="menu" aria-label="Account menu"
                      className="absolute right-0 top-10 w-56 panel p-2 shadow-2xl z-50">
                      <div className="px-3 py-2 border-b border-[var(--color-border)] mb-1">
                        <div className="text-sm font-semibold">{me.profile.displayName ?? me.user?.email}</div>
                        <div className="text-xs text-[var(--color-dim)]">{me.plan?.name} plan · {credits} credits</div>
                      </div>
                      {[
                        ["View profile", `/u/${me.profile.handle}`],
                        ["Assets", "/assets"],
                        ["History", "/history"],
                        ["Projects", "/projects"],
                        ["Characters", "/characters"],
                        ["Top-up credits", "/pricing#topup"],
                        ["Boost speed", "/me/settings#usage"],
                        ["Models & LLMs", "/settings/models"],
                        ["Manage account", "/me/settings"],
                      ].map(([l, h]) => (
                        <Link key={h} href={h} role="menuitem" onClick={() => setMenuOpen(false)}
                          className="block rounded-lg px-3 py-2 text-sm text-[var(--color-dim)] hover:bg-[var(--color-panel2)] hover:text-white">{l}</Link>
                      ))}
                      <button role="menuitem" className="w-full text-left rounded-lg px-3 py-2 text-sm text-[var(--color-danger)] hover:bg-[var(--color-panel2)]"
                        onClick={async () => { await signOut(); router.push("/"); router.refresh(); }}>
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link href="/login" className="btn btn-ghost btn-sm">Log in</Link>
                <Link href="/signup" className="btn btn-primary btn-sm">Sign up</Link>
              </>
            )}
          </div>
        </div>
        {mobileOpen && (
          <div id="mobile-nav" className="menu-in max-h-[calc(100vh-57px)] overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-panel)] px-3 pb-4 pt-2 md:hidden">
            {NAV_ENTRIES.filter((item) => item.ready).map((item) => {
              const kids = readyChildren(item);
              return (
                <div key={item.href + item.label} className="border-b border-[var(--color-border)] py-2 last:border-0">
                  <Link href={item.href} onClick={() => setMobileOpen(false)}
                    className={`block rounded-lg px-2.5 py-2 text-[14px] font-semibold ${pathname === item.href ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
                    {item.label}
                  </Link>
                  {kids.length > 0 && (
                    <div className="grid gap-0.5 sm:grid-cols-2">
                      {kids.map((c) => <MenuItem key={c.href + c.label} c={c} active={pathname === c.href} asMenuItem={false} onPick={() => setMobileOpen(false)} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
