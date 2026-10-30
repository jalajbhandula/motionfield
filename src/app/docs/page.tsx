import Link from "next/link";

export const metadata = { title: "Documentation" };

const dim = "text-sm leading-6 text-[var(--color-dim)]";

const CARDS: { href: string; title: string; desc: string }[] = [
  {
    href: "/docs/api",
    title: "API reference",
    desc: "The /api/v1 surface - keys, jobs, uploads, refs, runs, webhooks - with curl examples for every route.",
  },
  {
    href: "/mcp",
    title: "MCP",
    desc: "motionfield-mcp - the v1 API as an MCP stdio server. Install steps and per-client config snippets.",
  },
  {
    href: "/docs/cli",
    title: "CLI",
    desc: "The motionfield terminal program - install, login, generate, uploads, runs, keys.",
  },
  {
    href: "/plugins",
    title: "Plugins",
    desc: "The Chrome extension and the Blender add-on - real artifacts in this repo, with install steps.",
  },
];

/** Docs index - links to the four doc surfaces that exist in this build. */
export default function Docs() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--color-dim)]">Docs</div>
        <h1 className="font-display text-3xl font-bold">Documentation</h1>
        <p className={dim}>
          The reference surfaces that exist in this build - the v1 API, the MCP server,
          the CLI and the plugins.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Link key={c.href} href={c.href} className="panel block space-y-2 p-5 hover:border-[var(--color-accent)]">
            <div className="text-base font-semibold">{c.title}</div>
            <p className={dim}>{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
