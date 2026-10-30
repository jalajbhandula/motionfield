import { cameraAt, quatFromCameraDeg, worldOf } from "./sample";
import type { Aspect, StageNode, StageScene, Vec3 } from "./scene";

/**
 * Stage → video render plan - the pure-math half shared by the editor's
 * Render dialog, the stage-render recipe, and the e2e checks. Everything
 * derives from the scene document + the request (start, duration); there is
 * no three.js here so the dialog, the recipe, and a test can never disagree.
 */

export const STAGE_RENDER_FPS = 16;
export const STAGE_WINDOW_MAX = 81; // VACE generates ≤81 latent frames per pass
export const STAGE_OVERLAP = 8;     // continuation context window n≥1 re-renders
export const STAGE_MAX_WINDOWS = 2; // the local Mac build's ceiling
export const STAGE_MAX_FRAMES =
  STAGE_MAX_WINDOWS * STAGE_WINDOW_MAX - (STAGE_MAX_WINDOWS - 1) * STAGE_OVERLAP; // 154
export const STAGE_MAX_DURATION_S = STAGE_MAX_FRAMES / STAGE_RENDER_FPS;       // 9.5625 s
export const STAGE_PROMPT_MAX = 800;
export const STAGE_STEPS = 30;

/** 480p-class generation dims per scene aspect - every dim divisible by 16. */
export const STAGE_RENDER_SIZE: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 832, h: 480 },
  "9:16": { w: 480, h: 832 },
  "1:1": { w: 480, h: 480 },
  "4:3": { w: 640, h: 480 },
  "3:4": { w: 480, h: 640 },
  "21:9": { w: 1120, h: 480 },
};

export function stageRenderSize(aspect: Aspect): { w: number; h: number } {
  return { ...STAGE_RENDER_SIZE[aspect] };
}

/** frame count for `durationS` at 16 fps - always 4n+1, min 5 */
export function stageFrameCount(durationS: number): number {
  const raw = Math.max(5, Math.round(durationS * STAGE_RENDER_FPS));
  return 1 + 4 * Math.round((raw - 1) / 4);
}

const ceil4n1 = (n: number) => 1 + 4 * Math.ceil(Math.max(4, n - 1) / 4);

export interface StageWindow { len: number; overlap: number }

/** Window layout for `frames` (a 4n+1 count): a single ≤81-frame window, or
 *  two balanced ones with an 8-frame continuation - window 2 re-renders
 *  window 1's last 8 frames as context and the join trims them back off.
 *  Balanced rather than front-loaded: the per-window latent count bounds both
 *  wall time and the VAE decode's peak memory, so an 85-frame request runs
 *  [49,45] instead of a maximal [81,…] first window. [] when the request
 *  needs more than the two-window ceiling. */
export function stageWindows(frames: number): StageWindow[] {
  if (frames <= STAGE_WINDOW_MAX) return [{ len: frames, overlap: 0 }];
  if (frames > STAGE_MAX_FRAMES) return [];
  const gen = frames + STAGE_OVERLAP;
  const w1 = ceil4n1(gen / 2);
  const w2 = ceil4n1(gen - w1);
  return [{ len: w1, overlap: 0 }, { len: w2, overlap: STAGE_OVERLAP }];
}

/** frames a two-window run actually yields (≥ the request - the join trims) */
export function joinedFrames(windows: StageWindow[]): number {
  return windows.reduce((n, w) => n + w.len - w.overlap, 0);
}

/* ---------- camera projection (same frame three.js renders in) ---------- */

type Quat = readonly [number, number, number, number];

/** quatRotV - copy of sample.ts's private helper (kept private there) */
function qRot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [
    v[0] + 2 * (y * cz - z * cy),
    v[1] + 2 * (z * cx - x * cz),
    v[2] + 2 * (x * cy - y * cx),
  ];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface CamPose { pos: Vec3; yaw: number; pitch: number; roll: number; fov: number }

/** trajectory-frame camera basis: +z forward (the cameraAt convention) */
export function cameraBasis(cam: Pick<CamPose, "yaw" | "pitch" | "roll">): { right: Vec3; up: Vec3; fwd: Vec3 } {
  const q = quatFromCameraDeg([cam.pitch, cam.yaw, cam.roll]);
  return { right: qRot(q, [1, 0, 0]), up: qRot(q, [0, 1, 0]), fwd: qRot(q, [0, 0, 1]) };
}

/** world point → pixel coords in a w×h frame, or null when behind the camera.
 *  cam.fov is HORIZONTAL degrees - the trajectory/lens convention. */
export function projectPoint(
  cam: CamPose, w: number, h: number, p: Vec3,
): { x: number; y: number; z: number } | null {
  const { right, up, fwd } = cameraBasis(cam);
  const v: Vec3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  const z = dot(v, fwd);
  if (z <= 1e-4) return null;
  const x = dot(v, right) / z;
  const y = dot(v, up) / z;
  const th = Math.tan((cam.fov * Math.PI) / 360);
  const tv = th * (h / w);
  return { x: ((x / th + 1) / 2) * w, y: (1 - (y / tv + 1) / 2) * h, z };
}

/* ---------- frustum visibility ---------- */

/** kinds that produce image content - lights illuminate, cameras never render */
const CONTENT_KINDS = new Set<StageNode["kind"]>(["primitive", "mannequin", "model"]);

/** rough local-space half-extent - the same footprint inspect.ts uses */
function halfExtent(n: StageNode): Vec3 {
  if (n.kind === "primitive") {
    // a plane is flat - its size[1] slot is vestigial, not a half-height
    const th = n.props.shape === "plane" ? 0.005 : n.props.size[1] / 2;
    return [n.props.size[0] / 2, th, n.props.size[2] / 2];
  }
  if (n.kind === "mannequin") {
    const h = n.props.height;
    return [0.3 * h, h / 2, 0.3 * h];
  }
  return [0.5, 0.5, 0.5];
}

/** local-space bbox centre - mannequin origins are at the feet, so its box
 *  spans 0..height above pos rather than ±h/2 around it */
function boxCentre(n: StageNode): Vec3 {
  return n.kind === "mannequin" ? [0, n.props.height / 2, 0] : [0, 0, 0];
}

/** the node's 8 bounding corners in world space at t (worldOf pos/quat/scale) */
export function nodeCorners(scene: StageScene, n: StageNode, t: number): Vec3[] {
  const w = worldOf(scene, n.id, t);
  if (!w) return [];
  const he = halfExtent(n);
  const c = boxCentre(n);
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const l: Vec3 = [
      (c[0] + he[0] * sx) * w.scale[0],
      (c[1] + he[1] * sy) * w.scale[1],
      (c[2] + he[2] * sz) * w.scale[2],
    ];
    const r = qRot(w.quat, l);
    out.push([r[0] + w.pos[0], r[1] + w.pos[1], r[2] + w.pos[2]]);
  }
  return out;
}

export interface VisibleNode { node: StageNode; maxArea: number }

/** content nodes that touch the render-camera frustum at least once over the
 *  requested range - ordered by largest projected bounding rect (the hero
 *  first). Off-screen objects never reach the prompt. */
export function visibleObjects(
  scene: StageScene, startS: number, frames: number, w: number, h: number,
): VisibleNode[] {
  const step = Math.max(1, Math.floor(frames / 48));
  const out: VisibleNode[] = [];
  for (const n of scene.nodes) {
    if (!CONTENT_KINDS.has(n.kind)) continue;
    let maxArea = 0;
    for (let i = 0; i < frames; i += step) {
      const t = startS + i / STAGE_RENDER_FPS;
      const cam = cameraAt(scene, t);
      if (!cam) break;
      const pts = nodeCorners(scene, n, t)
        .map((p) => projectPoint(cam, w, h, p))
        .filter((p): p is NonNullable<typeof p> => p !== null);
      if (!pts.length) continue;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x1 = Math.min(w, Math.max(...xs)), x0 = Math.max(0, Math.min(...xs));
      const y1 = Math.min(h, Math.max(...ys)), y0 = Math.max(0, Math.min(...ys));
      if (x1 > x0 && y1 > y0) maxArea = Math.max(maxArea, (x1 - x0) * (y1 - y0));
    }
    if (maxArea > 0) out.push({ node: n, maxArea });
  }
  return out.sort((a, b) => b.maxArea - a.maxArea);
}

/* ---------- prompt ---------- */

const fmtV = (v: Vec3) => `[${v.map((n) => (Math.abs(n) < 0.005 ? 0 : +n.toFixed(1))).join(",")}]`;

/** one "Subject" spec clause per frustum-visible node - "name: per-object
 *  prompt" when the node carries one, bare name otherwise - ordered by
 *  screen presence (hero first). */
function sceneSpec(scene: StageScene, startS: number, frames: number, w: number, h: number) {
  const vis = visibleObjects(scene, startS, frames, w, h);
  const lines = vis.map(({ node }) =>
    node.prompt?.trim() ? `${node.name}: ${node.prompt.trim()}` : node.name);
  return { lines, names: vis.map(({ node }) => node.name) };
}

/** second-by-second timeline from the sampled camera + animated nodes -
 *  a "t=N: camera at …; name at …" line per whole second inside the
 *  window, capped so it can't eat the object spec. */
function timelineLines(scene: StageScene, startS: number, frames: number): string[] {
  const dur = frames / STAGE_RENDER_FPS;
  const end = startS + dur;
  const marks: number[] = [];
  for (let s = Math.ceil(startS); s <= Math.floor(end + 1e-6); s++) marks.push(s);
  if (!marks.length || marks[marks.length - 1] !== end) marks.push(end); // sub-second shots: end only
  const movers = scene.nodes.filter((n) =>
    n.kind !== "camera" && n.kind !== "light" && (n.keys?.length ?? 0) > 0);
  const out: string[] = [];
  for (const s of marks.slice(0, 8)) {
    const cam = cameraAt(scene, Math.min(s, end));
    const bits: string[] = [];
    if (cam) bits.push(`cam ${fmtV(cam.pos)}`);
    for (const m of movers.slice(0, 4)) {
      const wp = worldOf(scene, m.id, Math.min(s, end));
      if (wp) bits.push(`${m.name} ${fmtV(wp.pos)}`);
    }
    if (bits.length) out.push(`t=${+s.toFixed(2)}s ${bits.join(", ")}`);
  }
  return out;
}

/** hard prohibitions - our own wording; what the blockout is NOT allowed
 *  to hallucinate past. Kept short: every token here costs spec tokens. */
const PROHIBITIONS =
  "only the listed subjects and set pieces; no extra people or props, no text, " +
  "no logos, no lens flare, no camera shake, no cuts";

/** The composed prompt a VACE window actually receives, built in fixed
 *  order: (1) the director's text - the creative intent -, (2) "Scene:" -
 *  the frustum-visible subjects and set, hero first, (3) "Shot:" - the
 *  second-by-second camera/subject timeline the control video drives,
 *  (4) "Only:" - prohibitions. The first previz frame rides alongside as
 *  the anchor image, so the prompt never has to redescribe the look - it
 *  just says what the blockout locks in. Whole clauses are dropped (never
 *  cut mid-word) to stay ≤ STAGE_PROMPT_MAX. */
export function composeRenderPrompt(
  scene: StageScene, userPrompt: string | undefined,
  startS: number, frames: number, w: number, h: number,
): { text: string; objects: string[] } {
  const spec = sceneSpec(scene, startS, frames, w, h);
  let text = "";
  const only = `Only: ${PROHIBITIONS}`;
  const add = (part: string, reserve = 0) => {
    const next = text ? `${text}. ${part}` : part;
    if (next.length + reserve > STAGE_PROMPT_MAX) return false;
    text = next;
    return true;
  };
  const intent = (userPrompt ?? "").trim();
  if (intent) add(intent);
  // scene items shed tail-first so the hero always survives the cap, and
  // the prohibitions always keep their room
  let objects: string[] = [];
  for (let n = spec.lines.length; n > 0; n--) {
    if (add(`Scene: ${spec.lines.slice(0, n).join("; ")}`, only.length + 2)) { objects = spec.names.slice(0, n); break; }
  }
  const tl = timelineLines(scene, startS, frames);
  if (tl.length) add(`Shot: ${tl.join("; ")}`, only.length + 2);
  add(only);
  return { text, objects };
}

/* ---------- depth near/far ---------- */

const RDEG = Math.PI / 180;

/** one near/far pair for the whole range - the depth pass can't re-normalize
 *  per frame or the same surface would crawl between frames. The range is a
 *  2nd-98th percentile stretch over every content corner's view-space depth:
 *  near = white in the control, far = black. Percentiles (not min/max) so a
 *  floor plane running to the horizon can't squeeze the subject into a thin
 *  dark band. */
export function depthRange(
  scene: StageScene, startS: number, frames: number,
): { near: number; far: number } {
  const ds: number[] = [];
  const step = Math.max(1, Math.floor(frames / 24));
  for (let i = 0; i < frames; i += step) {
    const cam = cameraAt(scene, startS + i / STAGE_RENDER_FPS);
    if (!cam) break;
    const cp = Math.cos(cam.pitch * RDEG);
    const f: Vec3 = [Math.sin(cam.yaw * RDEG) * cp, Math.sin(cam.pitch * RDEG), Math.cos(cam.yaw * RDEG) * cp];
    for (const n of scene.nodes) {
      if (!CONTENT_KINDS.has(n.kind)) continue;
      const cs = nodeCorners(scene, n, startS + i / STAGE_RENDER_FPS);
      for (const c of cs) {
        const d = (c[0] - cam.pos[0]) * f[0] + (c[1] - cam.pos[1]) * f[1] + (c[2] - cam.pos[2]) * f[2];
        if (d > 0.05) ds.push(d);
      }
    }
  }
  if (!ds.length) return { near: 0.1, far: 24 };
  ds.sort((a, b) => a - b);
  const pct = (p: number) => ds[Math.min(ds.length - 1, Math.max(0, Math.round(p * (ds.length - 1))))];
  const near = Math.max(0.05, pct(0.02) * 0.9);
  const far = Math.max(near + 0.5, pct(0.98) * 1.05);
  return { near, far };
}
