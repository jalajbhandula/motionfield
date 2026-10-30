import { sql } from "@/db";
import Link from "next/link";
import { Heart, RotateCcw } from "lucide-react";

export default async function PublicProject({ params }: { params: Promise<{ handle: string; slug: string }> }) {
  const { handle, slug } = await params;
  const [row] = await sql<{
    id: string; title: string; description: string | null; cover_url: string | null;
    likes_count: number; created_at: string; user_id: string; display_name: string | null; handle: string;
  }>(
    `SELECT pr.id, pr.title, pr.description, pr.cover_url, pr.likes_count, pr.created_at,
            p.user_id, p.display_name, p.handle
     FROM projects pr JOIN profiles p ON p.user_id = pr.user_id
     WHERE pr.slug = $1 AND p.handle = $2 AND pr.visibility = 'public'`, [slug, handle]);
  if (!row) return <div className="p-16 text-center text-[var(--color-dim)]">Project not found.</div>;

  const items = await sql<{ id: string; kind: string; url: string; prompt: string | null; endpoint_id: string | null }>(
    `SELECT id, kind, url, prompt, endpoint_id FROM assets WHERE project_id = $1 ORDER BY created_at`, [row.id]);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10">
      {row.cover_url && <div className="media-tile mb-8 h-64"><img src={row.cover_url} className="h-full w-full object-cover" /></div>}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold">{row.title}</h1>
          <p className="mt-1 text-[var(--color-dim)]">by <Link href={`/u/${row.handle}`} className="text-[var(--color-accent)]">@{row.handle}</Link> · {items.length} assets · <Heart size={12} className="inline-block" /> {row.likes_count}</p>
          {row.description && <p className="mt-3 max-w-2xl text-[var(--color-dim)]">{row.description}</p>}
        </div>
      </div>
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((a) => (
          <div key={a.id} className="media-tile">
            {a.kind === "video" ? <video src={a.url} controls muted playsInline className="w-full" /> : a.kind === "audio" ? <audio src={a.url} controls className="w-full p-3" /> : <img src={a.url} className="w-full" />}
            <div className="p-2">
              {a.prompt && <p className="line-clamp-2 text-[11px] text-[var(--color-dim)]">{a.prompt}</p>}
              {a.prompt && <Link className="btn btn-ghost btn-sm mt-1 !px-2 text-[11px]" href={`/ai/${a.kind === "video" ? "video" : "image"}?recreate=${encodeURIComponent(a.prompt)}`}><RotateCcw size={11} className="mr-1 inline-block" /> Recreate</Link>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
