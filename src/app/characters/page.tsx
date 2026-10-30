"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { ErrNote } from "@/components/ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";

type Char = { id: string; name: string; status: string; thumbnailUrl: string | null; modelVersion: string };
type Ref = { id: string; name: string; category: string; kind: string | null; images: string[] };

const REF_CATEGORIES = ["character", "environment", "prop"] as const;
const REF_KINDS = ["person", "outfit", "prop", "place"] as const;

export default function Characters() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [chars, setChars] = useState<Char[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("character");
  const [kind, setKind] = useState<string>("person");
  // one row of chips: category drives the ref class; `kind` refines a
  // character (person/outfit/prop/place) and is implied for the rest
  const pickCategory = (c: string) => {
    setCategory(c);
    setKind(c === "environment" ? "place" : c === "prop" ? "prop" : kind === "place" ? "person" : kind);
  };
  const [desc, setDesc] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<UserError | string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!isPending && !session?.user) router.push("/login?next=/characters"); }, [isPending, session]);
  const load = () => fetch("/api/characters").then((r) => r.json()).then((d) => { setChars(d.characters ?? []); setRefs(d.refs ?? []); }).catch(() => {});
  useEffect(() => { void load(); }, []);

  const needsConsent = kind === "person" || category === "character";

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    for (const f of Array.from(e.target.files ?? [])) {
      try {
        const d = await uploadFile(f);
        setImages((i) => [...i, d.url]);
      } catch (x) { setMsg(userErrorFrom(x)); }
    }
    e.target.value = "";
  }

  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/refs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, kind, description: desc, images, likeness_consent: consent }) });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) setMsg(userError(r.status, d.error ?? "failed"));
    else { setMsg(`Ref @${d.ref.name} created.`); setName(""); setImages([]); setConsent(false); load(); }
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8">
      <h1 className="font-display text-3xl font-bold">Characters & Refs</h1>
      <p className="text-[var(--color-dim)]">Reference-based characters - saved from your own photos, no model training. Reusable @refs too.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_420px]">
        <div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {chars.map((c) => (
              <div key={c.id} className="panel overflow-hidden">
                <div className="aspect-square bg-[var(--color-panel2)]">
                  {c.thumbnailUrl && <img src={c.thumbnailUrl} className="h-full w-full object-cover" />}
                </div>
                <div className="p-3">
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-xs text-[var(--color-dim)]">{c.modelVersion} · <span className={c.status === "completed" ? "text-[var(--color-accent)]" : ""}>{c.status}</span></div>
                </div>
              </div>
            ))}
            {refs.map((e) => (
              <div key={e.id} className="panel overflow-hidden">
                <div className="aspect-square bg-[var(--color-panel2)]">{e.images[0] && <img src={e.images[0]} className="h-full w-full object-cover" />}</div>
                <div className="p-3">
                  <div className="font-semibold">@{e.name}</div>
                  <div className="text-xs text-[var(--color-dim)]">{e.category}{e.kind ? ` · ${e.kind}` : ""}</div>
                </div>
              </div>
            ))}
          </div>
          {chars.length === 0 && refs.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-12 text-center text-[var(--color-dim)]">No characters or refs yet - create your first on the right.</div>
          )}
        </div>

        <div className="panel h-fit space-y-4 p-5">
          <h2 className="font-semibold">Create ref</h2>
          <p className="text-xs text-[var(--color-faint)]">Named references usable as @name in prompts - character, environment, or prop. Characters are reference-based - no training.</p>
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="space-y-2">
            <div className="flex gap-1.5">{REF_CATEGORIES.map((c) => <button key={c} onClick={() => pickCategory(c)} className={`chip capitalize ${category === c ? "chip-on" : ""}`}>{c}</button>)}</div>
            {category === "character" && (
              <div className="flex gap-1.5">{REF_KINDS.map((k) => <button key={k} onClick={() => setKind(k)} className={`chip capitalize ${kind === k ? "chip-on" : ""}`}>{k}</button>)}</div>
            )}
          </div>
          <input className="input" placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          {needsConsent && (
            <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-dim)]">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>I have the right to use this person&apos;s likeness</span>
            </label>
          )}
          <label className={`grid min-h-28 place-items-center rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm ${needsConsent && !consent ? "cursor-not-allowed opacity-40" : "cursor-pointer text-[var(--color-dim)] hover:border-[var(--color-accent)]"}`}>
            + Add photos ({images.length}){needsConsent && !consent ? " - tick the consent box first" : ""}
            <input type="file" accept="image/*" multiple className="hidden" disabled={needsConsent && !consent} onChange={upload} />
          </label>
          {images.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {images.map((u, i) => <div key={i} className="media-tile h-12 w-12"><img src={u} /></div>)}
            </div>
          )}
          {typeof msg === "string" && <p className="text-sm text-[var(--color-dim)]">{msg}</p>}
          <ErrNote err={typeof msg === "object" ? msg : null} />
          <button className="btn btn-primary w-full" disabled={busy || !name || images.length === 0 || (needsConsent && !consent)} onClick={save}>
            {busy ? "Working…" : "Create ref"}
          </button>
        </div>
      </div>
    </div>
  );
}
