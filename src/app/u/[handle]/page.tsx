import { sql } from "@/db";
import Link from "next/link";
import { ShotsGrid } from "./shots-grid";

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const [profile] = await sql<{
    user_id: string; handle: string; display_name: string | null; bio: string | null;
    avatar_url: string | null; specialty: string | null; location: string | null;
  }>(`SELECT user_id, handle, display_name, bio, avatar_url, specialty, location FROM profiles WHERE handle = $1`, [handle]);

  if (!profile) return <div className="p-16 text-center text-[var(--color-dim)]">Profile not found.</div>;

  const projects = await sql<{ id: string; slug: string; title: string; cover_url: string | null }>(
    `SELECT id, slug, title, cover_url FROM projects WHERE user_id = $1 AND visibility = 'public' ORDER BY created_at DESC`, [profile.user_id]);
  const jobs = await sql<{ id: string; kind: string; outputs: { url: string; type: string }[]; prompt: string | null; likes_count: number }>(
    `SELECT id, kind, outputs, prompt, likes_count FROM jobs WHERE user_id = $1 AND visibility = 'public' AND status = 'completed' ORDER BY created_at DESC LIMIT 60`, [profile.user_id]);
  const [{ n: followers }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM follows WHERE following_id = $1`, [profile.user_id]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10">
      <div className="flex items-center gap-5">
        <div className="grid h-20 w-20 place-items-center rounded-full bg-[var(--color-panel2)] text-2xl font-bold">
          {profile.avatar_url ? <img src={profile.avatar_url} className="h-20 w-20 rounded-full object-cover" /> : (profile.display_name ?? profile.handle)[0]?.toUpperCase()}
        </div>
        <div>
          <h1 className="font-display text-2xl font-bold">{profile.display_name ?? profile.handle}</h1>
          <p className="text-sm text-[var(--color-dim)]">@{profile.handle}{profile.specialty ? ` · ${profile.specialty}` : ""}{profile.location ? ` · ${profile.location}` : ""}</p>
          {profile.bio && <p className="mt-1 max-w-xl text-sm text-[var(--color-dim)]">{profile.bio}</p>}
          <p className="mt-1 text-xs text-[var(--color-faint)]">{followers} followers</p>
        </div>
      </div>

      {projects.length > 0 && (
        <>
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">Projects</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {projects.map((p) => (
              <Link key={p.id} href={`/u/${profile.handle}/projects/${p.slug}`} className="panel overflow-hidden hover:border-[var(--color-accent)]">
                <div className="poster-gradient h-28" style={{ ["--h" as string]: (p.title.length * 31) % 360 }}>{p.cover_url && <img src={p.cover_url} className="h-full w-full object-cover" />}</div>
                <div className="p-3 font-semibold">{p.title}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-[var(--color-dim)]">Published shots</h2>
      <ShotsGrid jobs={jobs} />
      {jobs.length === 0 && <div className="mt-6 rounded-2xl border border-dashed border-[var(--color-border)] p-12 text-center text-[var(--color-dim)]">Nothing published yet.</div>}
    </div>
  );
}
