"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

type Project = { id: string; slug: string; title: string; description: string | null; coverUrl: string | null; visibility: string; updatedAt: string };

export default function Projects() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");

  useEffect(() => { if (!isPending && !session?.user) router.push("/login?next=/projects"); }, [isPending, session]);
  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((d) => setProjects(d.projects ?? [])).catch(() => {});
  }, []);

  async function create() {
    const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title || "Untitled project" }) });
    const d = await r.json();
    if (d.project) router.push(`/projects/${d.project.id}`);
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold">Projects</h1>
        <div className="flex gap-2">
          <input className="input w-56" placeholder="New project title…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <button className="btn btn-primary" onClick={create}>New project</button>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="panel overflow-hidden transition-colors hover:border-[var(--color-accent)]">
            <div className="poster-gradient h-36" style={{ ["--h" as string]: (p.title.length * 41) % 360 }}>
              {p.coverUrl && <img src={p.coverUrl} className="h-full w-full object-cover" />}
            </div>
            <div className="p-4">
              <div className="font-semibold">{p.title}</div>
              <div className="mt-0.5 text-xs text-[var(--color-dim)]">{p.visibility} · updated {new Date(p.updatedAt).toLocaleDateString()}</div>
            </div>
          </Link>
        ))}
      </div>
      {projects.length === 0 && <div className="mt-8 rounded-2xl border border-dashed border-[var(--color-border)] p-16 text-center text-[var(--color-dim)]">No projects yet.</div>}
    </div>
  );
}
