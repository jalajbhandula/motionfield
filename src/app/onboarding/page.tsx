"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Image, Mic, Sparkles, User, Video } from "lucide-react";

const CHOICES = [
  { id: "video", label: "AI video", desc: "Text-to-video, image-to-video, camera moves", Icon: Video, href: "/ai/video" },
  { id: "image", label: "AI images", desc: "Portraits, products, styles", Icon: Image, href: "/ai/image" },
  { id: "effects", label: "Effects", desc: "One-click effects on footage you already have", Icon: Sparkles, href: "/effects" },
  { id: "cinema", label: "Camera Control", desc: "Directed shots with camera, light, era", Icon: Clapperboard, href: "/generate" },
  { id: "avatar", label: "Talking avatars", desc: "Lip-sync portraits to speech", Icon: Mic, href: "/audio" },
  { id: "influencer", label: "Characters", desc: "Build a consistent character", Icon: User, href: "/character-creator" },
];

export default function Onboarding() {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function finish() {
    await fetch("/api/me/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interests: picked, onboarded: true }) }).catch(() => {});
    const target = CHOICES.find((c) => c.id === picked[0]);
    router.push(target?.href ?? "/");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <p className="text-sm font-semibold text-[var(--color-accent)]">Step 1 of 1</p>
      <h1 className="font-display mt-2 text-3xl font-bold">What do you want to create?</h1>
      <p className="mt-2 text-[var(--color-dim)]">Pick any - we&apos;ll point you at the right studio. You got <b className="text-white">50 credits</b> on us.</p>
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {CHOICES.map((c) => (
          <button key={c.id} onClick={() => toggle(c.id)}
            className={`panel p-4 text-left transition-colors duration-200 ${picked.includes(c.id) ? "bg-[var(--color-raised)] ring-1 ring-[var(--color-text)]/30" : "hover:bg-[var(--color-panel2)]"}`}>
            <c.Icon size={24} strokeWidth={1.6} className={picked.includes(c.id) ? "text-[var(--color-text)]" : "text-[var(--color-dim)]"} />
            <div className="mt-2 font-semibold">{c.label}</div>
            <div className="text-xs text-[var(--color-dim)]">{c.desc}</div>
          </button>
        ))}
      </div>
      <div className="mt-8 flex gap-3">
        <button onClick={finish} className="btn btn-primary">{picked.length ? "Start creating →" : "Skip for now"}</button>
      </div>
    </div>
  );
}
