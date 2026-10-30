"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Ban, Clapperboard, Download, Hourglass, Maximize2, Music, RotateCcw, Sparkles, TriangleAlert, X } from "lucide-react";
import type { PresetDef } from "@/lib/catalog/types";
import type { ClientModel, ClientWorkflow } from "@/lib/catalog/serialize";
import { LicenseBadge } from "./LicenseBadge";
import { ErrNote } from "./ErrNote";
import { uploadFile, userError, userErrorFrom, type UserError } from "@/lib/user-error";
import { TrajectoryPicker } from "./TrajectoryPicker";
import { LightDome } from "./LightDome";
import { EmotionWheel } from "./EmotionWheel";
import { presetTrajectories, trajectoryOf, isCoreTrajectory } from "@/lib/catalog/presets/trajectories";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { useDismiss } from "@/lib/use-dismiss";
import {
  DIRECTOR_LENS_IDS, DIRECTOR_SENSORS, DIRECTOR_APERTURE_IDS, DIRECTOR_BODIES,
  DIRECTOR_ERAS, DIRECTOR_GENRES, DIRECTOR_PACING,
} from "@/lib/catalog/presets/director";
import { resolveMoves, isDirectorMove } from "@/lib/camera/moves";
import { useSession } from "@/lib/auth-client";

/** Director - scene-first composer:
 *  workspace sidebar · type tabs · setup dropdowns (auto) · @-mention
 *  scene box · model/param pills · GENERATE with credit cost · feed. */

type Job = {
  id: string; status: string; progress: number; error: string | null;
  outputs: { assetId: string; type: string; url: string; width?: number; height?: number }[];
  prompt: string | null; modelId: string; endpointId: string; costCredits: string; createdAt: string;
  presetId: string | null; presetKind: string | null;
  params?: Record<string, unknown> | null;
};
type Element_ = { id: string; name: string; category: string; images?: string[] };

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", in_progress: "Generating", completed: "Done", failed: "Failed", nsfw: "Moderated", canceled: "Canceled",
};

const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "21:9"];

function Drop({ label, value, options, onChange, badgeFor }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; badgeFor?: (option: string) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLDivElement>(open, setOpen);
  return (
    <div className="relative" ref={wrap}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)]">
        <span className="text-[var(--color-dim)]">{label}</span>
        <span className="font-semibold">{value}</span>
        <span className="text-[var(--color-dim)]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-30 max-h-64 w-56 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl">
          {options.map((o) => (
            <button key={o} type="button" onClick={() => { onChange(o); setOpen(false); }}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-panel2)] ${o === value ? "text-[var(--color-accent)]" : ""}`}>
              <span>{o}</span>{badgeFor?.(o)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DirectorStudio({ models, presets, paletteOptions, elements, optIn }: {
  models: ClientModel[]; presets: PresetDef[]; paletteOptions?: readonly string[]; elements?: Element_[];
  /** the user's restricted-licence opt-in - gated param values hide until it */
  optIn?: boolean;
}) {
  const sp = useSearchParams();
  const router = useRouter();
  const [modelId, setModelId] = useState(sp.get("model") ?? models[0]?.id);
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const [wfId, setWfId] = useState(model?.workflows[0]?.id);
  const wf: ClientWorkflow | undefined = model?.workflows.find((w) => w.id === wfId) ?? model?.workflows[0];

  const { data: authSession } = useSession();
  const [scene, setScene] = useState("");
  const [filmSetup, setFilmSetup] = useState("Auto");
  const [camera, setCamera] = useState("Auto");
  const [palette, setPalette] = useState("Auto");
  const [quality, setQuality] = useState("1080p");
  const [aspect, setAspect] = useState("16:9");
  const [duration, setDuration] = useState("5s");
  const [batch, setBatch] = useState(1);
  const [refs, setRefs] = useState<Element_[]>([]);
  const [mention, setMention] = useState<{ at: number; q: string } | null>(null);
  // director controls - every one reaches a real consumer on the endpoint
  const [backend, setBackend] = useState("auto");
  const [customMove, setCustomMove] = useState("");
  const [strength, setStrength] = useState(1);
  const [distance, setDistance] = useState(4);
  const [lens, setLens] = useState("standard-35");
  const [sensor, setSensor] = useState("full_frame");
  const [aperture, setAperture] = useState("f8");
  const [body, setBody] = useState("modern");
  const [era, setEra] = useState("");
  const [genre, setGenre] = useState("");
  const [pacing, setPacing] = useState("");
  const [emotion, setEmotion] = useState<{ emotion: string; intensity: string } | null>(null);
  const [lights, setLights] = useState("");
  const [showStyle, setShowStyle] = useState(false);
  const [addSound, setAddSound] = useState(false);

  const [startFrame, setStartFrame] = useState("");
  const [upBusy, setUpBusy] = useState(false);

  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [viewer, setViewer] = useState<LightboxItem | null>(null);
  const pollRef = useRef<Record<string, boolean>>({});
  /** director job id → its chained video→sfx job state ("queued" | job id |
   *  an honest failure note) - set once so a repoll never refires */
  const sfxRef = useRef<Record<string, string>>({});
  /** the enhancer's rewrite, parked for the user's accept/dismiss */
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setWfId(model?.workflows[0]?.id); }, [modelId]);
  useEffect(() => {
    const recreate = sp.get("recreate"); if (recreate) setScene(recreate);
    const m = sp.get("model"); if (m) setModelId(m);
  }, []);

  useEffect(() => {
    if (!wf) return;
    const t = setTimeout(() => {
      fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint_id: wf.endpointId, params: buildParams() }) })
        .then((r) => r.json()).then((d) => setCost(d.credits ?? null)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [wf?.endpointId, scene, quality, aspect, duration, filmSetup, camera, palette, refs, startFrame, backend, customMove, lens, sensor, aperture, body, era, genre, pacing, emotion, lights, strength, distance]);

  const styleOf = useMemo(() => presets.find((p) => p.kind === "style" && p.title === filmSetup), [filmSetup, presets]);
  // the style select lists real verified style presets by title - the old
  // hard-coded FILM_SETUPS matched none of them (a dead control)
  const styleOptions = useMemo(
    () => ["Auto", ...presets.filter((p) => p.kind === "style").map((p) => p.title)],
    [presets]);
  const cameraOf = useMemo(() => presets.find((p) => p.title === camera), [camera, presets]);
  /** The selected workflow's declared params drive which setup pills show -
   *  a camera endpoint needs a start frame, has no resolution select, and
   *  only accepts its own aspect/duration enums. */
  const needsStart = !!wf?.params?.some((f) => f.name === "image_url" && f.required);
  /** the start-frame upload shows whenever the endpoint consumes one - the
   *  director's is optional (a keyframe renders when it's empty) */
  const hasStartParam = !!wf?.params?.some((f) => f.name === "image_url");
  const param = (n: string) => wf?.params?.find((f) => f.name === n);
  const isDirector = !!param("camera_lens") && !!param("backend");
  /** what the typed move will do - the same resolution the server runs:
   *  executable stack, or a prompt clause ("prompt-guided" chip) */
  const moveResolution = useMemo(() => {
    const typed = customMove.trim();
    if (!typed) return null;
    return resolveMoves(typed);
  }, [customMove]);
  /** backend select values minus the restricted ones - ltx stays out of the
   *  dropdown until the licence opt-in, then shows with its restricted badge
   *  (same gate the model picker runs on whole models). */
  const backendOptions = useMemo(() => {
    const vals = (param("backend")?.enum ?? ["wan-vace"]).map(String);
    if (optIn) return vals;
    return vals.filter((v) => {
      const cls = wf?.licenseVariants?.byValue?.[v]?.class;
      return cls !== "restricted" && cls !== "banned";
    });
  }, [wf, optIn]);
  const aspectOpts = (param("aspect_ratio")?.enum ?? ASPECTS).map(String);
  const resOpts = param("resolution")?.enum?.map(String) ?? null;
  const durOpts = (param("duration")?.enum ?? [5, 10, 15]).map((d) => `${d}s`);

  // snap stale setup values when the endpoint changes - model switches can
  // keep the workflow id (Lens and CameraRig are both "image-to-video") while
  // the endpoint, its enums and what it executes all change
  useEffect(() => {
    if (!aspectOpts.includes(aspect)) setAspect(aspectOpts[0] ?? "16:9");
    if (resOpts && !resOpts.includes(quality)) setQuality(resOpts[0]);
    // land on the endpoint's own declared default (camera-rig opens at 3s) -
    // only fall back to the enum pick when no usable default is declared
    const durDefault = param("duration")?.default;
    const durDefaultS = durDefault === undefined || durDefault === null ? undefined : `${durDefault}s`;
    if (durDefaultS && durOpts.includes(durDefaultS)) setDuration(durDefaultS);
    else if (!durOpts.includes(duration)) setDuration(durOpts[Math.min(2, durOpts.length - 1)] ?? "5s");
    // an executing endpoint only honours its runnable stacks - a pick made
    // on a prompt-guided model (or a no-stack preset) snaps back to
    // Auto/Static rather than showing a label the submit would replace with
    // locked-off. The Director is exempt: its picker sells unrunnable stacks
    // as "prompt-guided" rows, so the pick stands.
    if (wf?.executesTrajectory && !isDirector) {
      const stack = cameraOf ? presetTrajectories(cameraOf) : [];
      if (!stack.length || !stack.every(isCoreTrajectory)) setCamera("Auto");
    }
  }, [wf?.endpointId]);
  const presetById = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  /** endpoint_id → whether that workflow executes a trajectory spec; a move
   *  label on a job from any other endpoint is prompt-guided, not executed. */
  const endpointExec = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const mo of models) for (const w of mo.workflows) m.set(w.endpointId, !!w.executesTrajectory);
    return m;
  }, [models]);
  /** The move label stored with a job - params.moves ("a+b") is the contract;
   *  a legacy params.trajectory array and the preset's stack are fallbacks. */
  const moveLabel = (j: Job) => {
    const rawMoves = j.params?.moves;
    const rawTraj = j.params?.trajectory;
    const ids = (typeof rawMoves === "string" ? rawMoves.split("+")
      : Array.isArray(rawMoves) ? rawMoves
      : Array.isArray(rawTraj) ? rawTraj : []).filter((x): x is string => typeof x === "string" && !!x);
    const p = j.presetId ? presetById.get(j.presetId) : undefined;
    const use = ids.length ? ids : p ? presetTrajectories(p) : [];
    return use.map((id) => trajectoryOf(id)?.label ?? id).join(" + ") || null;
  };

  function onScene(v: string) {
    setScene(v);
    const caret = taRef.current?.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = before.match(/@([\w-]*)$/);
    setMention(m ? { at: caret - m[0].length, q: m[1] } : null);
  }

  function pickMention(e: Element_) {
    if (!mention) return;
    const caret = taRef.current?.selectionStart ?? scene.length;
    const next = scene.slice(0, mention.at) + "@" + e.name + " " + scene.slice(caret);
    setScene(next); setMention(null);
    if (!refs.find((r) => r.id === e.id)) setRefs((r) => [...r, e]);
  }

  const mentionList = (elements ?? []).filter((e) => !mention || e.name.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6);

  function buildParams(): Record<string, unknown> {
    const p: Record<string, unknown> = { prompt: scene };
    if (startFrame) p.image_url = startFrame;
    if (aspect !== "16:9") p.aspect_ratio = aspect;
    if (resOpts) p.resolution = quality;
    p.duration = parseInt(duration);
    if (palette !== "Auto") p.color_palette = palette.toLowerCase().replace(/ /g, "-");
    // element refs → their images feed VACE's reference conditioning (≤3 used)
    // - interleave one image per element per round so the first 3 come from
    // different elements (the "one per @element" the label promises)
    const refImgs: string[] = [];
    const perEl = refs.map((r) => r.images ?? []);
    for (let i = 0; refImgs.length < 50 && perEl.some((imgs) => i < imgs.length); i++)
      for (const imgs of perEl) if (i < imgs.length && refImgs.length < 50) refImgs.push(imgs[i]);
    if (refImgs.length) p.image_urls = refImgs;
    // director controls - only sent when the endpoint declares them
    const has = (n: string) => !!wf?.params?.some((f) => f.name === n);
    if (has("backend")) p.backend = backend;
    if (has("add_sound") && addSound) p.add_sound = true;
    if (has("strength") && strength !== 1) p.strength = strength;
    if (has("distance") && distance !== 4) p.distance = distance;
    if (has("camera_lens") && lens !== "standard-35") p.camera_lens = lens;
    if (has("camera_sensor") && sensor !== "full_frame") p.camera_sensor = sensor;
    if (has("camera_aperture") && aperture !== "f8") p.camera_aperture = aperture;
    if (has("camera_body") && body !== "modern") p.camera_body = body;
    if (has("era") && era) p.era = era;
    if (has("genre") && genre) p.genre = genre;
    if (has("pacing") && pacing) p.pacing = pacing;
    if (has("emotion") && emotion) { p.emotion = emotion.emotion; p.emotion_intensity = emotion.intensity; }
    if (has("lights") && lights) p.lights = lights;
    // moves: a typed phrase wins over the picker stack - it goes out as
    // params.moves and the server resolves executable vs prompt-guided. On
    // the Director a picked stack goes out verbatim too - its resolver
    // splits runnable ids from prompt-guided ones the same way.
    if (wf?.executesTrajectory || has("moves")) {
      const stack = cameraOf ? presetTrajectories(cameraOf) : [];
      p.moves = customMove.trim()
        ? customMove.trim()
        // a zero-stack pick (POV) still names a move - its title rides out as
        // the typed phrase so the "steers the prompt" label stays truthful
        : isDirector ? (stack.length ? stack.join("+") : cameraOf?.title ?? "locked-off")
        : stack.length && stack.every(isCoreTrajectory) ? stack.join("+") : "locked-off";
    }
    return p;
  }

  async function submit() {
    if (!wf || busy || (needsStart ? !startFrame : !scene.trim())) return;
    setBusy(true); setError(null);
    // on an executing endpoint the move goes out as params.moves - a motion
    // preset_id would also merge its prompt fragment, double-driving the shot
    const preset = wf.executesTrajectory
      ? { preset_id: styleOf?.id ?? null, preset_kind: styleOf ? "style" : null }
      : { preset_id: cameraOf?.id ?? styleOf?.id ?? null, preset_kind: cameraOf ? "motion" : styleOf ? "style" : null };
    try {
      for (let i = 0; i < batch; i++) {
        const params = buildParams();
        // takes 1-4 get their own seeds so each card is reproducible
        if (params.seed === undefined) params.seed = Math.floor(Math.random() * 2147483647);
        const r = await fetch("/api/jobs", {
          method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ endpoint_id: wf.endpointId, params, ...preset }),
        });
        const d = await r.json();
        if (!r.ok) { setError(userError(r.status, d.error || "failed")); if (r.status === 401) router.push(`/login?next=${location.pathname}`); return; }
        setJobs((j) => [d.job, ...j]); pollJob(d.job.id);
      }
    } finally { setBusy(false); }
  }

  /** the director's sound toggle chains one video→sfx job per finished take -
   *  the recipe re-checks ownership server-side; its NEEDS_LLM envelope lands
   *  on the card as the honest failure note */
  async function chainSound(j: Job) {
    sfxRef.current[j.id] = "queued";
    try {
      const r = await fetch("/api/audio-mix/video-sfx", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ video_url: j.outputs[0].url, prompt: j.prompt ?? undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        sfxRef.current[j.id] = d?.code === "NEEDS_LLM"
          ? "needs a vision model - Settings → Models & LLMs"
          : `failed: ${d.error ?? r.status}`;
      } else {
        sfxRef.current[j.id] = d.job.id;
        setJobs((js) => (js.some((x) => x.id === d.job.id) ? js : [d.job, ...js]));
        pollJob(d.job.id);
      }
    } catch {
      sfxRef.current[j.id] = "failed to queue";
    }
    setJobs((js) => [...js]); // re-render for the sfx caption
  }

  async function enhance() {
    const prompt = scene.trim();
    if (!prompt || enhancing) return;
    setEnhancing(true); setError(null);
    try {
      const r = await fetch("/api/director/enhance", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, moves: buildParams().moves }),
      });
      const d = await r.json();
      if (!r.ok) setError(userError(r.status, d.error || "enhance failed"));
      else if (typeof d.prompt === "string" && d.prompt.trim()) setEnhanced(d.prompt.trim());
    } catch { setError("enhance failed"); }
    finally { setEnhancing(false); }
  }

  function pollJob(id: string) {
    if (pollRef.current[id]) return; pollRef.current[id] = true;
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`);
      const { job } = await r.json();
      setJobs((js) => js.map((j) => (j.id === id ? job : j)));
      if (["queued", "in_progress"].includes(job.status)) setTimeout(tick, 1200);
      else {
        delete pollRef.current[id];
        if (job.status === "completed" && job.params?.add_sound === true && job.outputs?.[0]?.type === "video" && !sfxRef.current[job.id])
          void chainSound(job);
      }
    };
    tick();
  }

  useEffect(() => {
    fetch("/api/jobs?limit=10").then((r) => r.json()).then((d) => {
      const mine = (d.jobs ?? []) as Job[];
      setJobs((j) => [...mine.filter((m) => !j.some((x) => x.id === m.id)), ...j]);
      mine.filter((m) => ["queued", "in_progress"].includes(m.status)).forEach((m) => pollJob(m.id));
    }).catch(() => {});
  }, []);

  const sidebar = (
    <aside className="hidden w-[210px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] md:flex" style={{ height: "calc(100vh - 56px)" }}>
      <div className="flex items-center gap-2 px-4 pt-4 text-sm font-semibold">
        <Clapperboard size={15} className="text-[var(--color-fg)]" />
        Camera Control
      </div>
      <Link href="/" className="mx-3 mt-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--color-dim)] hover:bg-[var(--color-panel2)]">MotionField</Link>
      <nav className="mt-2 space-y-0.5 px-3 text-sm text-[var(--color-dim)]">
        {[["Home", "/generate"], ["My elements", "/characters"], ["My favorites", "/assets?fav=1"], ["Community", "/community"]].map(([l, h]) => (
          <Link key={l} href={h} className="block rounded-lg px-2.5 py-1.5 hover:bg-[var(--color-panel2)] hover:text-[var(--color-fg)]">{l}</Link>
        ))}
        <div className="flex items-center justify-between px-2.5 pt-3 text-xs font-semibold text-[var(--color-dim)]">
          Projects <Link href="/projects" className="rounded-md bg-[var(--color-panel2)] px-1.5 py-0.5 text-[10px] font-bold normal-case">New project</Link>
        </div>
      </nav>
      <div className="flex-1" />
      <div className="flex items-center justify-between border-t border-[var(--color-line)] px-4 py-2.5 text-xs">
        <Link href="/pricing" className="flex items-center gap-1.5">Pricing</Link>
        {authSession?.user ? (
          <Link href="/me/settings" className="truncate text-[var(--color-fg)] hover:text-[var(--color-accent)]"
            title={authSession.user.email ?? "account"}>
            {authSession.user.name || authSession.user.email}
          </Link>
        ) : (
          <Link href={`/login?next=${encodeURIComponent("/generate")}`} className="text-[var(--color-dim)] hover:text-[var(--color-fg)]">Log in</Link>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex">
      {sidebar}
      <div className="min-w-0 flex-1 overflow-y-auto px-5 pb-16" style={{ height: "calc(100vh - 56px)" }}>
        {/* setup row */}
        <div className="mt-4 flex flex-wrap items-center gap-1">
          {styleOptions.length > 1 && (
            <Drop label="Style" value={filmSetup} options={styleOptions} onChange={setFilmSetup} />
          )}
          <TrajectoryPicker label="Camera" value={camera} presets={presets} onChange={setCamera}
            executes={!!wf?.executesTrajectory}
            execMove={isDirector ? isDirectorMove : isCoreTrajectory}
            guidedOk={isDirector} />
          {isDirector && (
            <input value={customMove} onChange={(e) => setCustomMove(e.target.value)}
              placeholder="or type a move - executes on the rig, else prompt-guided"
              className="w-64 rounded-lg border border-[var(--color-line)] bg-transparent px-2 py-1 text-xs outline-none placeholder:text-[var(--color-faint)]" />
          )}
          {moveResolution?.executed.map((id) => (
            <span key={id} className="rounded-md bg-[var(--color-panel2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-fg)]"
              title="Parses to a catalog move - executes on the camera rig">
              {trajectoryOf(id)?.label ?? id}
            </span>
          ))}
          {moveResolution?.guided && (
            <span className="rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-dim)]"
              title={`"${moveResolution.guided}" can't run on the camera rig - it steers the prompt instead`}>
              {moveResolution.executed.length ? "partly prompt-guided" : "prompt-guided"}
            </span>
          )}
          <Drop label="Color palette" value={palette} options={["Auto", ...(paletteOptions ?? []).map((p) => p.replace(/-/g, " "))]} onChange={setPalette} />
          {isDirector && (
            <button type="button" onClick={() => setShowStyle((s) => !s)}
              className={`rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)] ${showStyle ? "text-[var(--color-accent)]" : "text-[var(--color-dim)]"}`}>
              Style &amp; lights ▾
            </button>
          )}
        </div>

        {/* director row - camera rig + backend + look (only on the director) */}
        {isDirector && (
          <div className="mt-2 flex flex-wrap items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1.5">
            <Drop label="Backend" value={backend}
              options={backendOptions}
              badgeFor={(v) => (
                <>
                  <LicenseBadge license={wf?.licenseVariants?.byValue?.[v]} />
                  {v === "wan-fun" && (
                    <span
                      className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel2)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-dim)]"
                      title="Cloud-recommended - untested on this machine (clip_vision_h absent); auto routing never picks it locally">
                      untested
                    </span>
                  )}
                </>
              )}
              onChange={setBackend} />
            <Drop label="Lens" value={lens} options={DIRECTOR_LENS_IDS} onChange={setLens} />
            <Drop label="Sensor" value={sensor} options={DIRECTOR_SENSORS} onChange={setSensor} />
            <Drop label="Aperture" value={aperture} options={DIRECTOR_APERTURE_IDS} onChange={setAperture} />
            <Drop label="Body" value={body} options={DIRECTOR_BODIES} onChange={setBody} />
            <button type="button" onClick={() => setAddSound((s) => !s)}
              title="After the shot lands, a chained video→sfx job mixes sound under it - tagged post-mix, needs a vision model in Settings"
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)] ${addSound ? "text-[var(--color-text)]" : "text-[var(--color-dim)]"}`}>
              <Music size={12} /> Sound {addSound ? "on" : "off"}
            </button>
            <label className="flex items-center gap-1.5 px-1 text-xs text-[var(--color-dim)]"
              title="Subject distance in metres - depth scale + focus">
              dist
              <input type="number" min={0.5} max={50} step={0.5} value={distance}
                onChange={(e) => setDistance(Number(e.target.value) || 4)}
                className="w-14 rounded bg-transparent text-[var(--color-fg)] outline-none" />
            </label>
            <label className="flex items-center gap-1.5 px-1 text-xs text-[var(--color-dim)]"
              title="Trajectory strength">
              ×
              <input type="range" min={0.25} max={2} step={0.05} value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                className="w-16 accent-neutral-300" />
              <span className="w-7 text-[var(--color-fg)]">{strength.toFixed(2)}</span>
            </label>
          </div>
        )}

        {/* style & lights panel - prompt-style picks + the two domes */}
        {isDirector && showStyle && (
          <div className="mt-2 flex flex-wrap items-start gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1">
              <Drop label="Era" value={era || "auto"} options={["auto", ...DIRECTOR_ERAS]} onChange={(v) => setEra(v === "auto" ? "" : v)} />
              <Drop label="Genre" value={genre || "auto"} options={["auto", ...DIRECTOR_GENRES]} onChange={(v) => setGenre(v === "auto" ? "" : v)} />
              <Drop label="Pacing" value={pacing || "auto"} options={["auto", ...DIRECTOR_PACING]} onChange={(v) => setPacing(v === "auto" ? "" : v)} />
              <span className="px-1 text-[9px] text-[var(--color-dim)]" title="steers the prompt only - not a structural control">prompt-style</span>
            </div>
            <EmotionWheel value={emotion} onChange={setEmotion} />
            <LightDome value={lights} onChange={setLights} />
          </div>
        )}

        {/* scene composer */}
        <div className="relative mt-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel2)] p-3">
          <textarea ref={taRef} value={scene} onChange={(e) => onScene(e.target.value)} rows={3}
            placeholder="Describe your scene - use @ to add characters & locations"
            className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-[var(--color-dim)]" />
          <button type="button" onClick={enhance} disabled={enhancing || !scene.trim()}
            title="Rewrite the scene as a director-style shot prompt (Settings → Models & LLMs · enhancer task) - you approve the rewrite before it replaces your text"
            className="absolute bottom-2.5 right-2.5 rounded-lg px-2 py-1 text-xs text-[var(--color-dim)] hover:bg-[var(--color-panel)] disabled:opacity-40">
            {enhancing ? "Enhancing…" : <><Sparkles size={11} className="mr-1 inline-block" /> Enhance</>}
          </button>
          {enhanced && (
            <div className="mt-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2.5">
              <p className="text-xs text-[var(--color-fg)]" data-enhanced-draft>{enhanced}</p>
              <div className="mt-1.5 flex gap-1.5">
                <button type="button" className="btn btn-sm bg-[var(--color-text)] px-2.5 text-xs font-semibold text-black"
                  onClick={() => { setScene(enhanced); setEnhanced(null); }}>Use this</button>
                <button type="button" className="btn btn-sm bg-black/20 px-2.5 text-xs"
                  onClick={() => setEnhanced(null)}>Dismiss</button>
              </div>
            </div>
          )}
          {mention && mentionList.length > 0 && (
            <div className="absolute left-3 top-full z-30 mt-1 w-64 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 shadow-xl">
              {mentionList.map((e) => (
                <button key={e.id} type="button" onMouseDown={(ev) => { ev.preventDefault(); pickMention(e); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-panel2)]">
                  <span className="text-[var(--color-dim)]">@</span>{e.name}
                  <span className="ml-auto text-[10px] text-[var(--color-faint)]">{e.category}</span>
                </button>
              ))}
            </div>
          )}
          {refs.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {refs.map((r) => (
                <span key={r.id} className="flex items-center gap-1 rounded-md bg-[var(--color-line)] px-2 py-0.5 text-[10px]">
                  @{r.name}
                  <button onClick={() => setRefs((x) => x.filter((y) => y.id !== r.id))} className="text-[var(--color-dim)] hover:text-red-300"><X size={10} /></button>
                </span>
              ))}
              <span className="px-1 text-[10px] text-[var(--color-dim)]">Up to 50 - we pick the best few (one per @element, max 3)</span>
            </div>
          )}
        </div>

        {/* model + params + generate */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Drop label="" value={model?.label ?? "Model"} options={models.map((m) => m.label)}
            badgeFor={(l) => { const m = models.find((x) => x.label === l); return m ? <LicenseBadge license={m.workflows[0]?.license} /> : null; }}
            onChange={(l) => setModelId(models.find((m) => m.label === l)?.id ?? modelId)} />
          <LicenseBadge license={wf?.license} />
          {hasStartParam && (
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)]"
              title={needsStart ? "Start frame - required for this endpoint" : "Start frame - optional: a keyframe renders the first frame when empty"}>
              {startFrame
                ? <img src={startFrame} className="h-5 w-9 rounded object-cover" alt="start frame" />
                : <span className="text-[var(--color-dim)]">Start frame</span>}
              <span className="font-semibold">{upBusy ? "…" : startFrame ? "replace" : "choose…"}</span>
              <input type="file" accept="image/*" className="hidden" disabled={upBusy}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setUpBusy(true);
                  try {
                    setStartFrame((await uploadFile(f)).url);
                  } catch (err) { setError(userErrorFrom(err)); } finally { setUpBusy(false); e.target.value = ""; }
                }} />
            </label>
          )}
          {resOpts && <Drop label="" value={quality} options={resOpts} onChange={setQuality} />}
          <Drop label="" value={aspect} options={aspectOpts} onChange={setAspect} />
          <Drop label="" value={duration} options={durOpts} onChange={setDuration} />
          <div className="relative">
            <button type="button" onClick={() => setBatch((b) => (b % 4) + 1)} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-[var(--color-panel2)]">
              <span className="font-semibold">{batch}/4</span>
            </button>
          </div>
          <div className="flex-1" />
          <button onClick={submit} disabled={busy || (needsStart ? !startFrame : !scene.trim())} className="btn btn-primary px-6 text-sm font-bold disabled:opacity-40">
            {busy ? "Generating…" : `Generate${cost != null ? ` · ${Math.ceil(cost)}` : ""}`}
          </button>
        </div>
        <ErrNote err={error} className="mt-3" />

        {/* explore feed */}
        <div className="mb-3 mt-10 text-xs font-semibold text-[var(--color-dim)]">Explore</div>
        {jobs.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed border-[var(--color-line)] text-center">
            <div>
              <Clapperboard size={32} className="mx-auto text-[var(--color-faint)]" />
              <p className="mt-2 text-sm text-[var(--color-dim)]">Describe the scene you imagine…</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {jobs.map((j) => (
              <div key={j.id} className="media-tile aspect-video" data-job-status={j.status}>
                {j.status === "completed" && j.outputs?.[0] ? (
                  <div className="relative">
                    {j.outputs[0].type === "video" ? <video src={j.outputs[0].url} controls autoPlay loop muted playsInline className="w-full" /> : (
                      <button type="button" className="block w-full cursor-zoom-in" onClick={() => setViewer({ url: j.outputs[0].url, type: j.outputs[0].type, label: j.prompt ?? undefined })} title="Open fullscreen">
                        <img src={j.outputs[0].url} className="w-full" />
                      </button>
                    )}
                    <button type="button" title="Open fullscreen" onClick={() => setViewer({ url: j.outputs[0].url, type: j.outputs[0].type, label: j.prompt ?? undefined })}
                      className="absolute bottom-2 right-2 rounded-md bg-black/60 p-1.5 text-white/80 backdrop-blur-sm hover:bg-black/80 hover:text-white">
                      <Maximize2 size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="grid h-full place-items-center">
                    <div className="text-center">
                      <div>
                        {j.status === "failed" ? <TriangleAlert size={26} className="mx-auto text-[var(--color-danger)]" />
                          : j.status === "canceled" || j.status === "nsfw" ? <Ban size={26} className="mx-auto text-[var(--color-dim)]" />
                          : <Hourglass size={24} className="mx-auto text-[var(--color-dim)]" />}
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-dim)]">{STATUS_LABEL[j.status]}{j.status === "in_progress" && j.progress ? ` · ${j.progress}%` : ""}</p>
                      {j.status === "failed" && j.error && <p className="mt-1 px-3 text-[11px] text-[var(--color-danger)]">{j.error}</p>}
                    </div>
                  </div>
                )}
                <div className="hover-ui flex flex-col justify-between p-2">
                  <div className="flex justify-end gap-1">
                    {["queued", "in_progress"].includes(j.status) && (
                      <button className="btn btn-sm bg-black/60 hover:bg-black" onClick={() => fetch(`/api/jobs/${j.id}/cancel`, { method: "POST" }).then(() => pollJob(j.id))}>Cancel</button>
                    )}
                  </div>
                  <div>
                    <p className="line-clamp-2 text-xs text-white/90">{j.prompt || j.modelId}</p>
                    {moveLabel(j) && (
                      <p className="mt-0.5 text-[10px] text-white/60">⎈ {moveLabel(j)}{endpointExec.get(j.endpointId) ? "" : " · prompt-guided"}</p>
                    )}
                    {typeof j.params?.seed === "number" && (
                      <p className="mt-0.5 text-[10px] text-white/40">seed {j.params.seed}</p>
                    )}
                    {sfxRef.current[j.id] && (
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-white/60"><Music size={10} /> sound: {sfxRef.current[j.id] === "queued" ? "mixing…" : sfxRef.current[j.id]}</p>
                    )}
                    {j.status === "completed" && j.outputs?.[0] && (
                      <div className="mt-1 flex gap-1">
                        <a className="btn btn-sm bg-black/60 hover:bg-black" href={j.outputs[0].url} download><Download size={12} className="mr-1 inline-block" /> Save</a>
                        <button className="btn btn-sm bg-black/60 hover:bg-black" onClick={() => { setScene(j.prompt ?? ""); window.scrollTo({ top: 0, behavior: "smooth" }); }}><RotateCcw size={12} className="mr-1 inline-block" /> Recreate</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Lightbox item={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
