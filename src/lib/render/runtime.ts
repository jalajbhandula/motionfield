import type * as THREE_T from "three";
import { Font } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import type { EaseName, GlyphStagger, Keyframe, SceneLayer, SceneSpec } from "./spec";
import { CAPTION_MARGIN_RATIO, CAPTION_SIZE_RATIO } from "@/lib/captions/types";
import { getRenderFont } from "./font";

/**
 * Deterministic three.js runtime for SceneSpec v1.
 *
 *   const handle = buildScene(spec, THREE, canvas);
 *   await handle.ready;
 *   await handle.renderAt(1.0);          // pure f(spec, params, t)
 *
 * Determinism rules honored here:
 * - no Math.random - all stochastic values come from a mulberry32 PRNG seeded
 *   per layer by hash(spec.seed, layer.id), so rebuilding a layer reproduces
 *   the same particle layout
 * - no wall clock - everything animates from the `t` argument only
 * - renderer pixel ratio pinned to 1 and preserveDrawingBuffer on, so
 *   canvas.toDataURL() after renderAt() yields the exact frame buffer
 */

type Three = typeof THREE_T;
type Vec3 = [number, number, number];

export interface RenderHandle {
  /** resolves once fonts/textures are loaded and the scene graph is built */
  ready: Promise<void>;
  /** render the frame at t seconds - serialized internally */
  renderAt(tSeconds: number): Promise<void>;
  /** set param values by id; applied on top of keyframes at next renderAt */
  setParams(values: Record<string, number>): void;
  dispose(): void;
}

export const EASING: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  // damped cosine - overshoots ~20% mid-flight, settles exactly on endpoints
  spring: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6.5 * t) * Math.cos(4 * Math.PI * t)),
};

/** mulberry32 - tiny stable PRNG; same seed → same stream on every machine. */
export function makePrng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a - stable string hash for per-layer seeds. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const layerSeed = (seed: number, id: string) => ((seed ^ hashStr(id)) >>> 0) || 1;

const TAU = Math.PI * 2;
const HUE_SAT = 0.7;
const HUE_LIGHT = 0.55;
/** props that change geometry/layout and force a rebuild of the layer mesh */
const REBUILD_PROPS = new Set([
  "text", "size", "width", "height", "depth", "radius", "count",
  "align", "weight", "letterSpacing", "image", "doubleSided", "segments",
  "bevelSize", "curveSegments", "cornerRadius", "points",
]);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3;

type MaterialLike = THREE_T.MeshStandardMaterial | THREE_T.MeshBasicMaterial | THREE_T.PointsMaterial;

/** the fields paintMaterial/applyPath need - LayerRt and GlyphRt both qualify */
interface PropHost {
  propVals: Record<string, unknown>;
  matBase: Map<MaterialLike, THREE_T.Color>;
}

interface GlyphRt extends PropHost {
  obj: THREE_T.Object3D;
  mats: MaterialLike[];
  basePos: Vec3;
  baseRot: Vec3;
  baseScale: Vec3;
  /** staggered-keyframe time offset (seconds) */
  delay: number;
}

interface ParticleRt {
  attr: THREE_T.BufferAttribute;
  base: Float32Array;
  phase: Float32Array;
}

interface LayerRt extends PropHost {
  spec: SceneLayer;
  /** outer object carrying transform + keyframed paths */
  obj: THREE_T.Object3D;
  /** materials affected by color/hue/opacity/metalness/roughness */
  mats: MaterialLike[];
  /** propVals snapshot the current inner geometry was built with */
  builtProps: Record<string, unknown>;
  basePos: Vec3;
  baseRot: Vec3;
  baseScale: Vec3;
  needsRebuild: boolean;
  /** disposes + recreates inner geometry from current propVals */
  rebuild(): void;
  particles?: ParticleRt;
  /** line layers: geometry + segment count for the progress draw-range */
  line?: { geo: THREE_T.BufferGeometry; segs: number };
  /** text3d per-glyph runtime (staggered keyframes) */
  glyphs?: GlyphRt[];
  /** spec.props.stagger was set - keyframes route per-glyph */
  staggered?: boolean;
  /** local-space left edge + width for the reveal clip plane */
  revealBox?: { x0: number; w: number };
  /** screen-space layer runtime (captions/hud): canvas texture + redraw fn */
  overlay?: OverlayRt;
  children: LayerRt[];
}

type CaptionWord = { text: string; start: number; end: number };
type CueRt = { start: number; end: number; words: { w: CaptionWord; gi: number }[] };

interface OverlayRt {
  kind: "captions" | "hud";
  cv: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE_T.CanvasTexture;
  /** captions: word groups resolved at build time */
  cues?: CueRt[];
  /** captions: global word indexes that punch */
  punchSet?: Set<number>;
}

/* ---------- captions ---------- */

/** default cue grouping - mirrors src/lib/captions/group.ts semantics (that
 *  lib is server-only; the renderer keeps its own copy so the browser bundle
 *  never touches fs/spawn). */
function groupCues(
  words: CaptionWord[],
  maxChars: number,
  maxLines: number,
  maxCue = 3.5,
  breakGap = 0.35,
): CueRt[] {
  const cues: CueRt[] = [];
  let cur: { w: CaptionWord; gi: number }[] = [];
  let chars = 0;
  const cap = maxChars * maxLines;
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].w.start, end: cur[cur.length - 1].w.end, words: cur });
    cur = [];
    chars = 0;
  };
  for (let gi = 0; gi < words.length; gi++) {
    const w = words[gi];
    const add = w.text.length + (cur.length ? 1 : 0);
    if (cur.length && (
      w.start - cur[cur.length - 1].w.end > breakGap
      || w.end - cur[0].w.start > maxCue
      || chars + add > cap
    )) flush();
    cur.push({ w, gi });
    chars += add;
  }
  flush();
  return cues;
}

/** wrap a cue's words into ≤maxLines lines of ≤maxChars characters */
function wrapCue(words: { w: CaptionWord; gi: number }[], maxChars: number, maxLines: number): { w: CaptionWord; gi: number }[][] {
  const lines: { w: CaptionWord; gi: number }[][] = [[]];
  let len = 0;
  for (const it of words) {
    const add = it.w.text.length + (lines[lines.length - 1].length ? 1 : 0);
    if (lines[lines.length - 1].length && len + add > maxChars && lines.length < maxLines) {
      lines.push([it]);
      len = it.w.text.length;
    } else {
      lines[lines.length - 1].push(it);
      len += add;
    }
  }
  // a line that still overflows gets its tail pushed up (grouping caps the
  // total, so this only ever balances two long lines)
  return lines;
}

const popSpring = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.exp(-6.5 * u) * Math.cos(4 * Math.PI * u));
/** punch-pop: spikes to ~1.5× then settles to 1 - pure f(age in seconds).
 *  x is the word's age: BEFORE its start it renders at rest scale (1), so a
 *  punch word never vanishes on the frame exactly at its start. */
const punchPulse = (x: number) => (x < 0 ? 1 : 1 + 0.5 * Math.exp(-3 * x) * Math.cos(2 * Math.PI * x));

export function buildScene(
  spec: SceneSpec,
  THREE: Three,
  canvas: HTMLCanvasElement,
  opts: { fontUrl?: string; fontFamily?: string } = {},
): RenderHandle {
  const fontUrl = opts.fontUrl ?? "/fonts/space-grotesk.ttf";
  const fontFamily = opts.fontFamily ?? "OF Render";
  const paramValues = new Map<string, number>();
  const layers: LayerRt[] = [];
  let font3d: Font | null = null;
  /** URL → texture cache: images load once during `ready`, rebuilds reuse them */
  const texCache = new Map<string, THREE_T.Texture>();

  const transparentBg = "transparent" in spec.background;
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, alpha: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  renderer.localClippingEnabled = true; // text/text3d `reveal` clip planes
  if (transparentBg) renderer.setClearAlpha(0); // PNG frames keep real alpha

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(spec.camera.fov ?? 50, spec.width / spec.height, 0.1, 100000);

  /* Screen-space overlay pass: captions/hud layers draw to canvas textures
   * composited after the 3D frame (autoClear off). Ortho cam is y-up pixel
   * space, so canvas (0,0) lands top-left. */
  const overlayScene = new THREE.Scene();
  const overlayCam = new THREE.OrthographicCamera(0, spec.width, spec.height, 0, -1000, 1000);
  let overlayUsed = false;
  const isOverlay = (l: SceneLayer) => l.type === "captions" || l.type === "hud";

  // fixed lighting rig - deterministic, flat enough for motion graphics
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(400, 600, 800);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.35);
  fill.position.set(-500, -250, -350);
  scene.add(fill);

  /* ---------- background ---------- */
  const disposables: { dispose(): void }[] = [];
  if (transparentBg) {
    scene.background = null; // alpha-0 clear - the overlay keeps real alpha
  } else if ("color" in spec.background) {
    scene.background = new THREE.Color(spec.background.color);
  } else if ("gradient" in spec.background) {
    const [c1, c2, angleDeg] = spec.background.gradient;
    const bg = document.createElement("canvas");
    bg.width = spec.width;
    bg.height = spec.height;
    const g = bg.getContext("2d")!;
    const rad = (angleDeg * Math.PI) / 180;
    // CSS-style "to <angle>" direction: 0deg = upward, 90deg = rightward
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const half = (Math.abs(spec.width * dx) + Math.abs(spec.height * dy)) / 2;
    const cx = spec.width / 2;
    const cy = spec.height / 2;
    const grad = g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    g.fillStyle = grad;
    g.fillRect(0, 0, spec.width, spec.height);
    const tex = new THREE.CanvasTexture(bg);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    disposables.push(tex);
  }

  /* ---------- materials ---------- */
  function stdMat(): THREE_T.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial();
    m.metalness = 0.25;
    m.roughness = 0.6;
    return m;
  }

  function paintMaterial(h: PropHost, m: MaterialLike) {
    const p = h.propVals;
    if (m.userData.noTint) {
      // overlay layers bake per-word colors into their canvas - the texture
      // stays untinted (white), only opacity applies through paintMaterial
    } else if (typeof p.hue === "number") {
      m.color.setHSL((((p.hue % 360) + 360) % 360) / 360, HUE_SAT, HUE_LIGHT);
    } else if (typeof p.color === "string") {
      m.color.set(p.color);
    } else {
      const base = h.matBase.get(m);
      if (base) m.color.copy(base);
    }
    // per-material shade factor - text3d side walls read as a darker pass
    const shade = (m.userData.shade as number | undefined) ?? 1;
    if (shade !== 1) m.color.multiplyScalar(shade);
    const op = typeof p.opacity === "number" ? clamp01(p.opacity) : 1;
    m.opacity = op;
    // kt = "keep transparent": text faces/particles rely on texture alpha
    m.transparent = op < 1 || m.userData.kt === true;
    if (m instanceof THREE.MeshStandardMaterial) {
      if (typeof p.metalness === "number") m.metalness = p.metalness;
      if (typeof p.roughness === "number") m.roughness = p.roughness;
    }
    m.needsUpdate = true;
  }

  /* ---------- text ---------- */
  const TEXT_DENSITY = 4; // canvas px per scene unit

  function drawTextCanvas(rt: LayerRt): { tex: THREE_T.CanvasTexture; wUnits: number; hUnits: number } {
    const p = rt.propVals;
    const text = String(p.text ?? "");
    const size = Number(p.size) || 64;
    const weight = Math.min(700, Math.max(300, Number(p.weight ?? 600)));
    const px = Math.max(8, Math.round(size * TEXT_DENSITY));
    const font = `${weight} ${px}px "${fontFamily}", sans-serif`;
    const cv = document.createElement("canvas");
    const g = cv.getContext("2d")!;
    g.font = font;
    if (typeof p.letterSpacing === "number" && "letterSpacing" in g) {
      (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${p.letterSpacing * TEXT_DENSITY}px`;
    }
    const metrics = g.measureText(text);
    const padX = px * 0.35;
    const padY = px * 0.3;
    // resizing resets ctx state - set font/spacing again on the same ctx
    cv.width = Math.max(2, Math.ceil(metrics.width + padX * 2));
    cv.height = Math.max(2, Math.ceil(px * 1.35 + padY * 2));
    g.font = font;
    if (typeof p.letterSpacing === "number" && "letterSpacing" in g) {
      (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${p.letterSpacing * TEXT_DENSITY}px`;
    }
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff"; // tinted by material color - keeps color/hue live
    const align = p.align === "left" || p.align === "right" ? p.align : "center";
    g.textAlign = align;
    const x = align === "center" ? cv.width / 2 : align === "left" ? padX : cv.width - padX;
    g.fillText(text, x, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, wUnits: cv.width / TEXT_DENSITY, hUnits: cv.height / TEXT_DENSITY };
  }

  /* ---------- text3d ---------- */
  /** pen advance per glyph slot - from the font's own advance widths. */
  function glyphAdvances(text: string, size: number, letterSpacing: number): number[] {
    const font = font3d;
    if (!font) return [];
    const scale = size / font.data.resolution;
    return Array.from(text).map((ch) => {
      const g = font.data.glyphs[ch];
      return (g ? g.ha * scale : size * 0.3) + letterSpacing;
    });
  }

  function staggerDelays(n: number, st: GlyphStagger | undefined): number[] {
    if (!st || n === 0) return new Array(n).fill(0);
    const d = st.delay;
    if (st.from === "end") return Array.from({ length: n }, (_, i) => (n - 1 - i) * d);
    if (st.from === "center") return Array.from({ length: n }, (_, i) => Math.abs(i - (n - 1) / 2) * d);
    return Array.from({ length: n }, (_, i) => i * d);
  }

  function buildText3d(rt: LayerRt) {
    const font = font3d;
    if (!font) throw new Error(`text3d layer "${rt.spec.id}": font not loaded`);
    const p = rt.propVals;
    const text = String(p.text ?? "");
    const size = Number(p.size) || 64;
    const depth = Math.max(0, Number(p.depth ?? 10));
    const bevel = Math.max(0, Number(p.bevelSize ?? 0));
    const letterSpacing = Number(p.letterSpacing ?? 0);
    const chars = Array.from(text);
    const advances = glyphAdvances(text, size, letterSpacing);
    const total = advances.reduce((a, b) => a + b, 0) - (chars.length ? letterSpacing : 0);
    const align = p.align === "left" || p.align === "right" ? p.align : "center";
    const penStart = align === "left" ? 0 : align === "right" ? -total : -total / 2;
    rt.revealBox = { x0: penStart, w: Math.max(1, total) };

    const delays = staggerDelays(chars.length, p.stagger as GlyphStagger | undefined);
    rt.staggered = p.stagger != null;
    const glyphs: GlyphRt[] = [];
    rt.glyphs = glyphs;
    let pen = penStart;
    chars.forEach((ch, i) => {
      const g: GlyphRt = {
        obj: new THREE.Group(),
        mats: [],
        matBase: new Map(),
        propVals: { ...p },
        basePos: [pen, 0, 0],
        baseRot: [0, 0, 0],
        baseScale: [1, 1, 1],
        delay: delays[i],
      };
      g.obj.position.set(pen, 0, 0);
      pen += advances[i];
      if (ch !== " " && font.data.glyphs[ch]) {
        const front = stdMat();
        const side = stdMat();
        side.userData.shade = 0.55;
        trackMat(rt, front);
        trackMat(rt, side);
        trackMat(g, front);
        trackMat(g, side);
        const geo = new TextGeometry(ch, {
          font, size, depth,
          bevelEnabled: bevel > 0,
          bevelThickness: bevel,
          bevelSize: bevel,
          curveSegments: Math.min(12, Math.max(1, Math.trunc(Number(p.curveSegments ?? 6)))),
        });
        // visually center each glyph horizontally within its advance slot
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        if (bb) geo.translate(-((bb.min.x + bb.max.x) / 2 - (advances[i] - letterSpacing) / 2), 0, 0);
        g.obj.add(new THREE.Mesh(geo, [front, side]));
      }
      rt.obj.add(g.obj);
      glyphs.push(g);
    });
    for (const g of glyphs) for (const m of g.mats) paintMaterial(g, m);
  }

  /* ---------- line (draw-on ribbon) ---------- */
  function buildRibbon(rt: LayerRt) {
    const p = rt.propVals;
    const pts = p.points as Vec3[];
    const w = Math.max(0.5, Number(p.width) || 4) / 2;
    const n = pts.length;
    const pos = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dy = next[1] - prev[1];
      const dz = next[2] - prev[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len;
      // 2D ribbon facing +z: normal in screen plane
      const nx = -dy * w;
      const ny = dx * w;
      pos.set([pts[i][0] + nx, pts[i][1] + ny, pts[i][2]], i * 6);
      pos.set([pts[i][0] - nx, pts[i][1] - ny, pts[i][2]], i * 6 + 3);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial();
    mat.side = THREE.DoubleSide;
    trackMat(rt, mat);
    paintMaterial(rt, mat);
    rt.obj.add(new THREE.Mesh(geo, mat));
    rt.line = { geo, segs: n - 1 };
  }

  /* ---------- layer construction ---------- */
  function disposeInner(rt: LayerRt) {
    for (const c of [...rt.obj.children]) {
      rt.obj.remove(c);
      c.traverse((n) => {
        const mesh = n as THREE_T.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const m of mats) {
          const tex = (m as THREE_T.MeshStandardMaterial).map;
          // shared cached textures survive rebuilds; only per-build maps die
          if (tex && !tex.userData.ofShared) tex.dispose();
          m.dispose();
        }
      });
    }
    rt.mats = [];
    rt.matBase.clear();
    rt.particles = undefined;
    rt.line = undefined;
    rt.glyphs = undefined;
    rt.revealBox = undefined;
    rt.overlay = undefined;
  }

  function trackMat(h: PropHost & { mats: MaterialLike[] }, m: MaterialLike, baseColor?: number) {
    if (baseColor !== undefined) m.color.set(baseColor);
    h.mats.push(m);
    h.matBase.set(m, m.color.clone());
  }

  /** build the inner mesh/points for a layer from rt.propVals */
  function buildInner(rt: LayerRt) {
    disposeInner(rt);
    rt.builtProps = { ...rt.propVals };
    const l = rt.spec;
    const p = rt.propVals;
    // per-layer deterministic stream - a rebuild replays the same layout (A1)
    const rng = makePrng(layerSeed(spec.seed, l.id));

    if (l.type === "text") {
      const { tex, wUnits, hUnits } = drawTextCanvas(rt);
      rt.revealBox = { x0: -wUnits / 2, w: wUnits };
      const depth = Number(p.depth ?? 0);
      // flat type is unlit - the face passes the spec color through verbatim
      // (extrusion sides stay lit so depth still reads)
      const face = new THREE.MeshBasicMaterial();
      face.map = tex;
      face.userData.kt = true;
      const side = stdMat();
      trackMat(rt, face);
      trackMat(rt, side, 0x1a1a22);
      paintMaterial(rt, face);
      paintMaterial(rt, side);
      let mesh: THREE_T.Mesh;
      if (depth > 0) {
        // box material order: +x -x +y -y +z(front) -z
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(wUnits, hUnits, depth),
          [side, side, side, side, face, side],
        );
      } else {
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(wUnits, hUnits), face);
      }
      rt.obj.add(mesh);
    } else if (l.type === "text3d") {
      buildText3d(rt);
    } else if (l.type === "line") {
      buildRibbon(rt);
    } else if (l.type === "plane") {
      const mat = stdMat();
      if (p.doubleSided) mat.side = THREE.DoubleSide;
      trackMat(rt, mat);
      const w = Number(p.width) || 1;
      const h = Number(p.height) || 1;
      const radius = Math.min(Number(p.cornerRadius ?? 0), w / 2, h / 2);
      let geo: THREE_T.BufferGeometry;
      if (radius > 0) {
        const s = new THREE.Shape();
        const x = -w / 2;
        const y = -h / 2;
        s.moveTo(x + radius, y);
        s.lineTo(x + w - radius, y);
        s.absarc(x + w - radius, y + radius, radius, -Math.PI / 2, 0, false);
        s.lineTo(x + w, y + h - radius);
        s.absarc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2, false);
        s.lineTo(x + radius, y + h);
        s.absarc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI, false);
        s.lineTo(x, y + radius);
        s.absarc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5, false);
        const sg = new THREE.ShapeGeometry(s, Math.max(2, Math.round(radius / 4)));
        // ShapeGeometry uvs are shape-space - normalize to 0-1 so images map right
        sg.computeBoundingBox();
        const bb = sg.boundingBox!;
        const uv = sg.getAttribute("uv") as THREE_T.BufferAttribute;
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, (uv.getX(i) - bb.min.x) / w, (uv.getY(i) - bb.min.y) / h);
        }
        geo = sg;
      } else {
        geo = new THREE.PlaneGeometry(w, h);
      }
      const mesh = new THREE.Mesh(geo, mat);
      rt.obj.add(mesh);
      if (typeof p.image === "string" && p.image) {
        const t = texCache.get(p.image);
        if (t) { mat.map = t; mat.needsUpdate = true; }
      }
      paintMaterial(rt, mat);
    } else if (l.type === "box") {
      const mat = stdMat();
      trackMat(rt, mat);
      paintMaterial(rt, mat);
      rt.obj.add(new THREE.Mesh(
        new THREE.BoxGeometry(Number(p.width) || 1, Number(p.height) || 1, Number(p.depth) || 1),
        mat,
      ));
    } else if (l.type === "sphere") {
      const mat = stdMat();
      trackMat(rt, mat);
      paintMaterial(rt, mat);
      const seg = Math.min(128, Math.max(4, Math.trunc(Number(p.segments ?? 48))));
      rt.obj.add(new THREE.Mesh(new THREE.SphereGeometry(Number(p.radius) || 1, seg, Math.max(3, seg >> 1)), mat));
    } else if (l.type === "particles") {
      const count = Math.max(1, Math.trunc(Number(p.count) || 1));
      const radius = Number(p.radius) || 100;
      const base = new Float32Array(count * 3);
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        // uniform-ish point in a sphere via the layer's seeded stream
        const u = rng() * 2 - 1;
        const th = rng() * TAU;
        const r = radius * Math.cbrt(rng());
        const s = Math.sqrt(1 - u * u);
        base[i * 3] = r * s * Math.cos(th);
        base[i * 3 + 1] = r * s * Math.sin(th);
        base[i * 3 + 2] = r * u;
        phase[i] = rng();
      }
      const geo = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(base.slice(), 3);
      geo.setAttribute("position", attr);
      const mat = new THREE.PointsMaterial({
        size: Number(p.size) || 4,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
      });
      mat.userData.kt = true;
      trackMat(rt, mat);
      paintMaterial(rt, mat);
      rt.obj.add(new THREE.Points(geo, mat));
      rt.particles = { attr, base, phase };
    } else if (l.type === "captions") {
      const p = rt.propVals;
      const cv = document.createElement("canvas");
      cv.width = spec.width;
      cv.height = spec.height;
      const g = cv.getContext("2d")!;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      });
      mat.userData.kt = true;
      mat.userData.noTint = true; // word colors are baked into the canvas
      trackMat(rt, mat, 0xffffff);
      paintMaterial(rt, mat);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.height), mat);
      mesh.position.set(spec.width / 2, spec.height / 2, 0);
      rt.obj.add(mesh);
      rt.overlay = {
        kind: "captions", cv, g, tex,
        cues: groupCues(
          (p.words as CaptionWord[]) ?? [],
          Math.trunc(Number(p.maxChars) || 32),
          Math.trunc(Number(p.lines) || 2),
        ),
        // punch indexes come straight off the narrowed captions layer
        punchSet: new Set(l.props.punch ?? []),
      };
      drawCaptions(rt, 0);
    } else if (l.type === "hud") {
      const p = rt.propVals;
      const s = Math.max(40, Number(p.size) || 180);
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(s);
      cv.height = Math.ceil(s * 1.36); // dial + readout strip
      const g = cv.getContext("2d")!;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      });
      mat.userData.kt = true;
      mat.userData.noTint = true;
      trackMat(rt, mat, 0xffffff);
      paintMaterial(rt, mat);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(cv.width, cv.height), mat);
      positionHud(mesh, String(p.anchor ?? "topRight"), cv.width, cv.height);
      rt.obj.add(mesh);
      rt.overlay = { kind: "hud", cv, g, tex };
      drawHud(rt, 0);
    } else if (l.type === "group") {
      for (const child of l.props.children) {
        const cr = buildLayer(child);
        rt.children.push(cr);
        rt.obj.add(cr.obj);
      }
    }
  }

  function buildLayer(l: SceneLayer): LayerRt {
    const rt: LayerRt = {
      spec: l,
      obj: new THREE.Group(),
      mats: [],
      matBase: new Map(),
      propVals: { ...l.props },
      builtProps: {},
      basePos: (l.transform?.position ?? [0, 0, 0]) as Vec3,
      baseRot: (l.transform?.rotation ?? [0, 0, 0]) as Vec3,
      baseScale: (() => {
        const s = l.transform?.scale;
        if (typeof s === "number") return [s, s, s] as Vec3;
        return (s ?? [1, 1, 1]) as Vec3;
      })(),
      needsRebuild: false,
      rebuild() { rt.needsRebuild = false; buildInner(rt); },
      children: [],
    };
    rt.obj.name = l.id;
    rt.obj.position.set(...rt.basePos);
    rt.obj.rotation.set(...rt.baseRot);
    rt.obj.scale.set(...rt.baseScale);
    buildInner(rt);
    return rt;
  }

  /* ---------- screen-space overlay draw ---------- */

  /** propVals → CSS color for overlay text (hue wins over color, like materials) */
  function cssColorOf(p: Record<string, unknown>, fallback: string): string {
    if (typeof p.hue === "number") {
      const h = (((p.hue % 360) + 360) % 360) / 360;
      return `hsl(${Math.round(h * 360)}, ${Math.round(HUE_SAT * 100)}%, ${Math.round(HUE_LIGHT * 100)}%)`;
    }
    return typeof p.color === "string" ? p.color : fallback;
  }

  function positionHud(mesh: THREE_T.Mesh, anchor: string, cw: number, ch: number) {
    const m = 16;
    const W = spec.width;
    const H = spec.height;
    const x = anchor === "topRight" || anchor === "bottomRight" ? W - m - cw / 2 : m + cw / 2;
    const y = anchor === "topLeft" || anchor === "topRight" ? H - m - ch / 2 : m + ch / 2;
    mesh.position.set(x, y, 0);
  }

  /** draw the cue active at tc onto the layer's canvas - pure f(t) */
  function drawCaptions(rt: LayerRt, tc: number) {
    const o = rt.overlay;
    if (!o || o.kind !== "captions" || !o.cues) return;
    const { cv, g, tex } = o;
    const W = cv.width;
    const H = cv.height;
    g.clearRect(0, 0, W, H);
    const p = rt.propVals;
    const cue = o.cues.find((c) => tc >= c.start - 1e-9 && tc < c.end);
    if (cue) {
      const size = Math.max(8, Number(p.size) || Math.round(H * CAPTION_SIZE_RATIO));
      const style = typeof p.style === "string" ? p.style : "karaoke";
      const up = p.uppercase === true;
      const glow = clamp01(Number(p.glow) || 0);
      const outline = Math.max(0, Number(p.outline) || 0);
      const maxChars = Math.trunc(Number(p.maxChars) || 32);
      const maxLines = Math.trunc(Number(p.lines) || 2);
      const weight = 700;
      g.font = `${weight} ${size}px "${fontFamily}", sans-serif`;
      g.textBaseline = "middle";
      g.textAlign = "left";
      const base = cssColorOf(p, "#ffffff");
      const hi = typeof p.highlightColor === "string"
        ? p.highlightColor
        : (typeof p.hue === "number" ? `hsl(${(((p.hue % 360) + 360) % 360)}, 85%, 62%)` : "#ffd34d");
      const lines = wrapCue(cue.words, maxChars, maxLines);
      const lineH = size * 1.28;
      const blockH = lines.length * lineH;
      const margin = Number(p.marginBottom ?? Math.round(H * CAPTION_MARGIN_RATIO));
      const anchor = typeof p.anchor === "string" ? p.anchor : "bottom";
      const y0 = anchor === "top" ? margin : anchor === "center" ? (H - blockH) / 2 : H - margin - blockH;
      const spaceW = g.measureText(" ").width || size * 0.28;
      const wordW = (t: string) => g.measureText(up ? t.toUpperCase() : t).width;

      for (let li = 0; li < lines.length; li++) {
        const ws = lines[li];
        const totalW = ws.reduce((a, it) => a + wordW(it.w.text), 0) + spaceW * (ws.length - 1);
        let x = (W - totalW) / 2;
        const yc = y0 + li * lineH + lineH / 2;
        for (const it of ws) {
          const w = it.w;
          const text = up ? w.text.toUpperCase() : w.text;
          const width = wordW(w.text);
          let scale = 1;
          let fill = base;
          let blur = glow * size * 0.9;
          if (style === "pop") {
            scale = popSpring((tc - w.start) / 0.18);
            if (scale <= 0) { x += width + spaceW; continue; }
          } else if (style === "punch") {
            if (o.punchSet?.has(it.gi) && tc >= w.start) {
              scale = punchPulse(tc - w.start);
              // the punched word lands its highlight with the spring -
              // non-punch words keep the base color
              fill = hi;
              blur = Math.max(blur, glow * size * 1.4 + (scale - 1) * size * 1.2);
            }
          } else { // karaoke
            fill = w.start <= tc ? hi : base;
          }
          g.save();
          g.translate(x + width / 2, yc);
          g.scale(scale, scale);
          if (blur > 0.5) {
            g.shadowColor = fill;
            g.shadowBlur = blur;
          }
          if (outline > 0) {
            g.lineWidth = outline;
            g.strokeStyle = "rgba(0,0,0,0.85)";
            g.lineJoin = "round";
            g.strokeText(text, -width / 2, 0);
          }
          g.fillStyle = fill;
          g.fillText(text, -width / 2, 0);
          g.restore();
          x += width + spaceW;
        }
      }
    }
    tex.needsUpdate = true;
  }

  /** speedometer dial + needle + readout - pure f(t) over props.value */
  function drawHud(rt: LayerRt, tc: number) {
    const o = rt.overlay;
    if (!o || o.kind !== "hud") return;
    void tc;
    const { cv, g, tex } = o;
    const p = rt.propVals;
    const s = cv.width;
    g.clearRect(0, 0, cv.width, cv.height);
    const max = Math.max(1e-9, Number(p.max) || 100);
    const value = Math.min(Math.max(0, Number(p.value) || 0), max);
    const frac = value / max;
    const unit = typeof p.unit === "string" ? p.unit : "";
    const accent = cssColorOf(p, "#4cc9ff");
    const cx = s / 2;
    const cy = s / 2;
    const r = s * 0.4;
    const a0 = (135 * Math.PI) / 180; // 0 at bottom-left (canvas y-down)
    const sweep = (270 * Math.PI) / 180;
    // face
    g.beginPath();
    g.arc(cx, cy, s * 0.47, 0, TAU);
    g.fillStyle = "rgba(8,10,14,0.55)";
    g.fill();
    // track + value arcs
    g.lineCap = "round";
    g.lineWidth = s * 0.06;
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + sweep);
    g.strokeStyle = "rgba(255,255,255,0.16)";
    g.stroke();
    if (frac > 0) {
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + sweep * frac);
      g.strokeStyle = accent;
      g.stroke();
    }
    // ticks
    g.lineWidth = Math.max(1, s * 0.012);
    g.strokeStyle = "rgba(255,255,255,0.45)";
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (sweep * i) / 8;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - s * 0.055), cy + Math.sin(a) * (r - s * 0.055));
      g.lineTo(cx + Math.cos(a) * (r + s * 0.02), cy + Math.sin(a) * (r + s * 0.02));
      g.stroke();
    }
    // needle
    const na = a0 + sweep * frac;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(na) * (r - s * 0.09), cy + Math.sin(na) * (r - s * 0.09));
    g.lineWidth = s * 0.045;
    g.strokeStyle = "#f4f6fb";
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, s * 0.055, 0, TAU);
    g.fillStyle = accent;
    g.fill();
    // readout
    const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(value < 10 ? 1 : 0);
    g.font = `600 ${Math.round(s * 0.16)}px "${fontFamily}", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillStyle = "#f4f6fb";
    g.fillText(`${shown}${unit ? ` ${unit}` : ""}`, cx, s * 1.02);
    tex.needsUpdate = true;
  }

  /** redraw every overlay layer's canvas for time tc */
  function paintOverlays(tc: number) {
    eachLayer((rt) => {
      if (!rt.overlay) return;
      if (rt.overlay.kind === "captions") drawCaptions(rt, tc);
      else drawHud(rt, tc);
      // reposition the HUD quad if `anchor` is being animated
      if (rt.overlay.kind === "hud") {
        const mesh = rt.obj.children[0] as THREE_T.Mesh | undefined;
        if (mesh) positionHud(mesh, String(rt.propVals.anchor ?? "topRight"), rt.overlay.cv.width, rt.overlay.cv.height);
      }
    });
  }

  /* ---------- path resolution ---------- */
  function eachLayer(fn: (rt: LayerRt) => void) {
    const walk = (rt: LayerRt) => { fn(rt); rt.children.forEach(walk); };
    layers.forEach(walk);
  }

  function applyPath(h: PropHost & { obj: THREE_T.Object3D }, path: string, value: number | Vec3 | string, rt?: LayerRt) {
    const [root, sub] = path.split(".");
    const obj = h.obj;
    if (root === "position" || root === "rotation" || root === "scale") {
      const target = root === "position" ? obj.position : root === "rotation" ? obj.rotation : obj.scale;
      if (sub === "x" || sub === "y" || sub === "z") {
        if (typeof value === "number") target[sub] = value;
      } else if (isVec3(value)) {
        target.set(value[0], value[1], value[2]);
      } else if (typeof value === "number") {
        target.set(value, value, value); // scalar = uniform
      }
      return;
    }
    if (root === "opacity") {
      if (typeof value === "number") {
        h.propVals.opacity = value;
        for (const m of (h as GlyphRt | LayerRt).mats) paintMaterial(h, m);
      }
      return;
    }
    if (root === "color") {
      if (typeof value === "string") {
        h.propVals.color = value;
        // repaint (not m.color.set) so text3d side walls keep their shade (A12)
        for (const m of (h as GlyphRt | LayerRt).mats) paintMaterial(h, m);
      }
      return;
    }
    if (root === "hue") {
      if (typeof value === "number") {
        h.propVals.hue = value;
        for (const m of (h as GlyphRt | LayerRt).mats) paintMaterial(h, m);
      }
      return;
    }
    if (root === "props" && sub) {
      h.propVals[sub] = value;
      if (sub === "color" || sub === "hue" || sub === "opacity" || sub === "metalness" || sub === "roughness") {
        for (const m of (h as GlyphRt | LayerRt).mats) paintMaterial(h, m);
      } else if (rt && REBUILD_PROPS.has(sub) && value !== rt.builtProps[sub]) {
        // only a changed geometry prop marks the layer for rebuild (A2)
        rt.needsRebuild = true;
      }
      // remaining props (speed, drift, progress, reveal, value…) are read
      // live in renderAt - no rebuild
    }
  }

  /* ---------- keyframe sampling ---------- */
  const kfIndex = new Map<LayerRt, Map<string, Keyframe[]>>();
  function indexKeyframes(rt: LayerRt) {
    const byPath = new Map<string, Keyframe[]>();
    for (const kf of rt.spec.keyframes ?? []) {
      const arr = byPath.get(kf.path) ?? [];
      arr.push(kf);
      byPath.set(kf.path, arr);
    }
    for (const arr of byPath.values()) arr.sort((a, b) => a.t - b.t);
    kfIndex.set(rt, byPath);
    rt.children.forEach(indexKeyframes);
  }

  function sampleTrack(track: Keyframe[], t: number): number | Vec3 | string | undefined {
    if (!track.length) return undefined;
    if (t <= track[0].t) return track[0].value;
    const last = track[track.length - 1];
    if (t >= last.t) return last.value;
    for (let i = 1; i < track.length; i++) {
      const k1 = track[i];
      if (t > k1.t) continue;
      const k0 = track[i - 1];
      const u = (t - k0.t) / (k1.t - k0.t);
      const e = EASING[k1.ease ?? "linear"](u);
      const a = k0.value;
      const b = k1.value;
      if (typeof a === "number" && typeof b === "number") return a + (b - a) * e;
      if (isVec3(a) && isVec3(b)) {
        return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
      }
      return e < 1 ? a : b; // strings (colors) step at segment end
    }
    return last.value;
  }

  /* ---------- camera ---------- */
  const camKfs = [...spec.camera.keyframes].sort((a, b) => a.t - b.t);
  function applyCamera(t: number) {
    let p: Vec3;
    let tg: Vec3;
    if (t <= camKfs[0].t) {
      p = camKfs[0].position; tg = camKfs[0].target;
    } else if (t >= camKfs[camKfs.length - 1].t) {
      p = camKfs[camKfs.length - 1].position; tg = camKfs[camKfs.length - 1].target;
    } else {
      p = camKfs[camKfs.length - 1].position; tg = camKfs[camKfs.length - 1].target;
      for (let i = 1; i < camKfs.length; i++) {
        if (t > camKfs[i].t) continue;
        const k0 = camKfs[i - 1];
        const k1 = camKfs[i];
        const e = EASING.easeInOut((t - k0.t) / (k1.t - k0.t));
        p = [
          k0.position[0] + (k1.position[0] - k0.position[0]) * e,
          k0.position[1] + (k1.position[1] - k0.position[1]) * e,
          k0.position[2] + (k1.position[2] - k0.position[2]) * e,
        ];
        tg = [
          k0.target[0] + (k1.target[0] - k0.target[0]) * e,
          k0.target[1] + (k1.target[1] - k0.target[1]) * e,
          k0.target[2] + (k1.target[2] - k0.target[2]) * e,
        ];
        break;
      }
    }
    camera.position.set(p[0], p[1], p[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(tg[0], tg[1], tg[2]);
  }

  /* ---------- param bindings ---------- */
  type Binding = { rt: LayerRt; path: string };
  const bindings: { paramId: string; binding: Binding }[] = [];
  function resolveBindings() {
    const byId = new Map<string, LayerRt>();
    eachLayer((rt) => byId.set(rt.spec.id, rt));
    for (const p of spec.params ?? []) {
      const dot = p.bind.indexOf(".");
      const rt = byId.get(p.bind.slice(0, dot));
      if (rt) bindings.push({ paramId: p.id, binding: { rt, path: p.bind.slice(dot + 1) } });
      if (!(paramValues.has(p.id))) paramValues.set(p.id, p.default);
    }
  }

  /* ---------- init (fonts + textures) ---------- */
  let buildErr: Error | null = null;
  const ready = (async () => {
    const needFontFace: string[] = [];
    const need3d: string[] = [];
    const imgUrls = new Set<string>();
    const scan = (ls: SceneLayer[]) => ls.forEach((l) => {
      if (l.type === "text" || l.type === "captions" || l.type === "hud") needFontFace.push(l.id);
      if (l.type === "text3d") need3d.push(l.id);
      if (l.type === "plane" && l.props.image) imgUrls.add(l.props.image);
      if (l.type === "group") scan(l.props.children);
    });
    scan(spec.layers);

    const loaders: Promise<unknown>[] = [];
    if (needFontFace.length && typeof FontFace !== "undefined") {
      loaders.push((async () => {
        try {
          const face = new FontFace(fontFamily, `url("${fontUrl}")`, { weight: "300 700" });
          const loaded = await face.load();
          document.fonts.add(loaded);
        } catch (e) {
          console.warn(`render: font load failed (${fontUrl}) - falling back to sans-serif`, e);
        }
      })());
    }
    if (need3d.length) {
      loaders.push(getRenderFont(fontUrl).then((f) => { font3d = f; }));
    }
    for (const url of imgUrls) {
      loaders.push(
        new THREE.TextureLoader().loadAsync(url).then((t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.userData.ofShared = true;
          texCache.set(url, t);
        }).catch((e) => console.warn(`render: image load failed (${url})`, e)),
      );
    }
    if (loaders.length) await Promise.all(loaders);

    for (const l of spec.layers) {
      const rt = buildLayer(l);
      layers.push(rt);
      if (isOverlay(l)) {
        overlayScene.add(rt.obj);
        overlayUsed = true;
      } else {
        scene.add(rt.obj);
      }
    }
    layers.forEach(indexKeyframes);
    resolveBindings();
  })().catch((e) => {
    buildErr = e instanceof Error ? e : new Error(String(e));
    throw buildErr;
  });

  /* ---------- reveal clip planes ---------- */
  const clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  function applyReveal(rt: LayerRt) {
    const reveal = rt.propVals.reveal;
    if (typeof reveal !== "number" || !rt.revealBox) {
      for (const m of rt.mats) m.clippingPlanes = null;
      return;
    }
    const r = clamp01(reveal);
    // local-space plane: keep x <= x0 + r*w → world space via the object matrix
    const x = rt.revealBox.x0 + r * rt.revealBox.w;
    rt.obj.updateWorldMatrix(true, false);
    clipPlane.normal.set(1, 0, 0);
    clipPlane.constant = -x;
    const world = new THREE.Plane().copy(clipPlane).applyMatrix4(rt.obj.matrixWorld);
    for (const m of rt.mats) m.clippingPlanes = r >= 1 ? null : [world];
  }

  /* ---------- render ---------- */
  let renderChain: Promise<void> = Promise.resolve();

  function renderFrame(t: number) {
    const tc = Math.min(Math.max(t, 0), Math.max(spec.duration, 0));
    applyCamera(tc);
    const walk = (rt: LayerRt) => {
      // reset to base state - renderAt is a pure function of t
      rt.obj.position.set(...rt.basePos);
      rt.obj.rotation.set(...rt.baseRot);
      rt.obj.scale.set(...rt.baseScale);
      rt.propVals = { ...rt.spec.props };
      paintAll(rt);
      const tracks = kfIndex.get(rt);
      if (rt.staggered && rt.glyphs?.length) {
        // staggered text3d: transform/material keyframes play per glyph, each
        // offset by its stagger delay; geometry props still hit the whole layer
        for (const g of rt.glyphs) {
          g.obj.position.set(...g.basePos);
          g.obj.rotation.set(...g.baseRot);
          g.obj.scale.set(...g.baseScale);
          g.propVals = { ...rt.propVals };
        }
        for (const [path, track] of tracks ?? []) {
          if (path.startsWith("props.")) {
            const v = sampleTrack(track, tc);
            if (v !== undefined) applyPath(rt, path, v, rt);
            continue;
          }
          for (const g of rt.glyphs) {
            const v = sampleTrack(track, Math.max(0, tc - g.delay));
            if (v !== undefined) applyPath(g, path, v);
          }
        }
      } else {
        for (const [path, track] of tracks ?? []) {
          const v = sampleTrack(track, tc);
          if (v !== undefined) applyPath(rt, path, v, rt);
        }
      }
      rt.children.forEach(walk);
    };
    layers.forEach(walk);
    // params win over keyframes
    for (const { paramId, binding } of bindings) {
      const v = paramValues.get(paramId);
      if (v !== undefined) applyPath(binding.rt, binding.path, v, binding.rt);
    }
    // geometry-affecting prop writes trigger one rebuild after all writes
    eachLayer((rt) => {
      if (!rt.needsRebuild) {
        for (const k of Object.keys(rt.propVals)) {
          if (REBUILD_PROPS.has(k) && rt.propVals[k] !== rt.builtProps[k]) { rt.needsRebuild = true; break; }
        }
      }
      if (rt.needsRebuild) {
        rt.rebuild();
        // A rebuild replaces every glyph object - the main pass animated the
        // OLD glyphs, so fresh ones would sit at rest for one frame. Replay
        // this layer's per-glyph keyframe pass (props.* are already baked into
        // propVals) and its non-props param bindings so the frame is identical
        // to a settled render at the same t.
        if (rt.staggered && rt.glyphs?.length) {
          for (const [path, track] of kfIndex.get(rt) ?? []) {
            if (path.startsWith("props.")) continue;
            for (const g of rt.glyphs) {
              const v = sampleTrack(track, Math.max(0, tc - g.delay));
              if (v !== undefined) applyPath(g, path, v);
            }
          }
          for (const { paramId, binding } of bindings) {
            if (binding.rt !== rt || binding.path.startsWith("props.")) continue;
            const v = paramValues.get(paramId);
            if (v !== undefined) applyPath(rt, binding.path, v, rt);
          }
        }
      }
      applyReveal(rt); // (re)arm the clip plane on whatever mats exist now
    });
    // particle drift - deterministic f(seed, t); uses the clamped time (A4)
    eachLayer((rt) => {
      const pt = rt.particles;
      if (!pt) return;
      const speed = Number(rt.propVals.speed ?? 0.15);
      const drift = Number(rt.propVals.drift ?? 12);
      const pos = pt.attr.array as Float32Array;
      for (let i = 0; i < pt.phase.length; i++) {
        const ph = pt.phase[i];
        pos[i * 3] = pt.base[i * 3] + Math.cos(TAU * (tc * speed * 0.63 + ph * 1.71)) * drift * 0.6;
        pos[i * 3 + 1] = pt.base[i * 3 + 1] + Math.sin(TAU * (tc * speed + ph)) * drift;
        pos[i * 3 + 2] = pt.base[i * 3 + 2] + Math.sin(TAU * (tc * speed * 0.41 + ph * 2.13)) * drift * 0.4;
      }
      pt.attr.needsUpdate = true;
    });
    // line draw-on progress - index draw range, no rebuild
    eachLayer((rt) => {
      if (!rt.line) return;
      const prog = clamp01(Number(rt.propVals.progress ?? 1));
      rt.line.geo.setDrawRange(0, Math.round(prog * rt.line.segs) * 6);
    });
    // screen-space pass - captions/hud canvases redraw per frame, then
    // composite over the 3D frame without clearing it
    if (overlayUsed) paintOverlays(tc);
    renderer.render(scene, camera);
    if (overlayUsed) {
      renderer.autoClear = false;
      renderer.render(overlayScene, overlayCam);
      renderer.autoClear = true;
    }
  }

  function paintAll(rt: LayerRt) {
    for (const m of rt.mats) paintMaterial(rt, m);
  }

  return {
    ready,
    setParams(values: Record<string, number>) {
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "number" && Number.isFinite(v)) paramValues.set(k, v);
      }
    },
    renderAt(tSeconds: number) {
      const p = renderChain.then(async () => {
        await ready;
        if (buildErr) throw buildErr;
        renderFrame(tSeconds);
      });
      // keep the chain alive after a failed frame so later renderAt calls work
      renderChain = p.catch(() => {});
      return p;
    },
    dispose() {
      eachLayer(disposeInner);
      for (const t of texCache.values()) t.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
