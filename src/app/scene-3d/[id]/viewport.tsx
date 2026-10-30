"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildMannequin } from "@/lib/stage/mannequin";
import { cameraAt, quatFromCameraDeg, sampleProp, sampleScene, cameraAnglesFromQuat, pathPos, worldOf } from "@/lib/stage/sample";
import { hFov, type SensorName } from "@/lib/camera/lens";
import {
  renderCamera,
  type StageNode,
  type StageScene,
  type Vec3,
} from "@/lib/stage/scene";

/**
 * The stage viewport - three camera modes over one three.js scene:
 *   persp - orbit/zoom/pan editor camera
 *   top - orthographic plan view (XZ), pan+zoom only, path-point dragging
 *   cam - through the render camera, letterboxed to meta.renderSize
 *
 * Rendering is on-demand (a needsPaint flag + controls 'change' events);
 * while `playing` an rAF clock advances the playhead. preserveDrawingBuffer
 * is on so the canvas is a stable toDataURL target for tests.
 */

export type StageView = "persp" | "top" | "cam";
export type XformMode = "translate" | "rotate" | "scale";

export interface ViewportApi {
  paint(): void;
  canvas(): HTMLCanvasElement | null;
  /** CSS-px position of camera-path handle i on screen (null when absent) */
  handleScreenPos(i: number): { x: number; y: number } | null;
  /** CSS-px position of a node's origin on screen in the active view (null when absent) */
  objectScreenPos(id: string): { x: number; y: number } | null;
  /** CSS-px position of a WORLD point through the active view camera - the
   *  same projection objectScreenPos uses (inspect-accuracy checks) */
  screenPosAt(pos: Vec3): { x: number; y: number } | null;
  /** effective visibility in the last paint - node ids, "$path", "$handle:<i>" */
  drawn(id: string): boolean;
  /** the render camera at the playhead, offscreen at w×h - helpers/gizmos/grid
   *  hidden; the PNG blob is exactly w×h */
  renderStill(w: number, h: number): Promise<Blob | null>;
  /** the scene at the playhead as binary glTF - meshes incl. mannequins,
   *  cameras as glTF cameras, lights via KHR_lights_punctual, no helpers */
  exportGlb(): Promise<Blob | null>;
}

interface Props {
  scene: StageScene;
  timeRef: React.MutableRefObject<number>;
  playing: boolean;
  onTick(t: number): void;
  view: StageView;
  xform: XformMode;
  selection: string | null;
  onSelect(id: string | null): void;
  /** commit an undoable edit (fires once per gesture, not per pointer move) */
  onCommit(mut: (scene: StageScene) => void): void;
  /** transient preview edit during a drag - not undoable, not saved */
  onPreview(mut: (scene: StageScene) => void): void;
  register(api: ViewportApi): void;
}

const ACCENT = 0xd4ff3f;
const DEG = Math.PI / 180;

/* ---------- node → three object builders ---------- */

function primitiveMesh(n: Extract<StageNode, { kind: "primitive" }>): THREE.Object3D {
  const [w, h, d] = n.props.size;
  let geo: THREE.BufferGeometry;
  switch (n.props.shape) {
    case "box": geo = new THREE.BoxGeometry(w, h, d); break;
    case "sphere": geo = new THREE.SphereGeometry(Math.max(0.01, w / 2), 24, 18); break;
    case "pyramid": geo = new THREE.ConeGeometry(Math.max(0.01, w / 2), Math.max(0.01, h), 4); break;
    case "cylinder": geo = new THREE.CylinderGeometry(Math.max(0.01, w / 2), Math.max(0.01, w / 2), Math.max(0.01, h), 24); break;
    case "capsule": geo = new THREE.CapsuleGeometry(Math.max(0.01, w / 2), Math.max(0.01, h - w), 4, 12); break;
    case "plane": geo = new THREE.PlaneGeometry(Math.max(0.01, w), Math.max(0.01, d)); break;
  }
  const mat = new THREE.MeshStandardMaterial({ color: n.props.color, roughness: 0.9, metalness: 0.02 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = n.props.shape !== "plane";
  mesh.receiveShadow = true;
  if (n.props.shape === "plane") mesh.rotation.x = -Math.PI / 2; // lie flat in XZ
  return mesh;
}

function lightGizmo(n: Extract<StageNode, { kind: "light" }>): THREE.Object3D {
  const g = new THREE.Group();
  const { light, color, intensity, angle, range } = n.props;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 10),
    new THREE.MeshBasicMaterial({ color }),
  );
  g.add(bulb);
  if (light === "point") {
    g.add(new THREE.PointLight(color, intensity, range));
  } else if (light === "spot") {
    const spot = new THREE.SpotLight(color, intensity, range, angle * DEG, 0.4, 1);
    const tgt = new THREE.Object3D();
    tgt.position.set(0, -1, 0); // aims down the node's -Y… no: aim along -Z below
    tgt.position.set(0, 0, -3);
    g.add(tgt);
    spot.target = tgt;
    g.add(spot);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(Math.tan(angle * DEG) * 1.2, 1.2, 12, 1, true),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -0.6;
    cone.raycast = () => {}; // helper wireframe never wins a click pick
    g.add(cone);
  } else {
    // sun - direction arrow, light itself added at scene level would follow the node
    const sun = new THREE.DirectionalLight(color, intensity);
    const tgt = new THREE.Object3D();
    tgt.position.set(0, 0, -3);
    g.add(tgt);
    sun.target = tgt;
    g.add(sun);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 8), new THREE.MeshBasicMaterial({ color }));
    shaft.rotation.x = -Math.PI / 2;
    shaft.position.z = -0.5;
    shaft.raycast = () => {}; // helper indicator never wins a click pick
    g.add(shaft);
  }
  return g;
}

/** the Ry(π) between the trajectory frame (+z forward, cameraAt/worldOf)
 *  and three's -Z camera convention lives on the camera gizmo's inner -
 *  display-only, so nodes parented to a camera compose exactly like
 *  worldOf() and the xform commit reads the raw trajectory quat. */
function cameraGizmo(n: Extract<StageNode, { kind: "camera" }>, renderSize: { w: number; h: number }): THREE.Object3D {
  const g = new THREE.Group();
  g.quaternion.set(0, 1, 0, 0);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.2, 0.36),
    new THREE.MeshStandardMaterial({ color: n.props.isRender ? "#3c4350" : "#2a2f3a", roughness: 0.6, metalness: 0.3 }),
  );
  g.add(body);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, 0.14, 16),
    new THREE.MeshStandardMaterial({ color: "#171b22", roughness: 0.4, metalness: 0.5 }),
  );
  lens.rotation.x = -Math.PI / 2;
  lens.position.z = -0.25;
  g.add(lens);
  // frustum helper - a real PerspectiveCamera with the node's lens math
  const cam = new THREE.PerspectiveCamera(30, renderSize.w / renderSize.h, 0.1, 6);
  cam.position.z = 0; // helper draws forward -Z from the group origin
  const helper = new THREE.CameraHelper(cam);
  helper.name = "frustum";
  helper.raycast = () => {}; // helper lines never win a click pick
  g.add(helper);
  if (n.props.isRender) {
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: ACCENT }));
    badge.position.set(0, 0.13, 0.1);
    g.add(badge);
  }
  return g;
}

function modelPlaceholder(n: Extract<StageNode, { kind: "model" }>): THREE.Object3D {
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: "#5a6474", wireframe: true }),
  );
  box.name = "model-proxy";
  return box;
}

function buildInner(n: StageNode, scene: StageScene): THREE.Object3D {
  switch (n.kind) {
    case "primitive": return primitiveMesh(n);
    case "mannequin": return buildMannequin(THREE, n.props.pose, n.props.height);
    case "light": return lightGizmo(n);
    case "camera": return cameraGizmo(n, scene.meta.renderSize);
    case "model": return modelPlaceholder(n);
  }
}

/* ---------- component ---------- */

interface NodeObj { root: THREE.Group; inner: THREE.Object3D; json: string }

export default function Viewport(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const st = useRef<{
    renderer: THREE.WebGLRenderer;
    scene3d: THREE.Scene;
    persp: THREE.PerspectiveCamera;
    ortho: THREE.OrthographicCamera;
    camCam: THREE.PerspectiveCamera;
    orbit: OrbitControls;
    orbitTop: OrbitControls;
    xform: TransformControls;
    xHelper: THREE.Object3D;
    objects: Map<string, NodeObj>;
    pathLine: THREE.Line | null;
    handles: THREE.Mesh[];
    selBox: THREE.BoxHelper | null;
    grid: THREE.GridHelper;
    axes: THREE.AxesHelper;
    ambient: THREE.AmbientLight;
    sun: THREE.DirectionalLight;
    needsPaint: boolean;
    dragging: { kind: "xform" } | { kind: "handle"; index: number; orig: Vec3 } | null;
    lastT: number;
    gltf: GLTFLoader;
    camFrame: { x: number; y: number; w: number; h: number };
  } | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  /* ---------- mount ---------- */
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false; // grey-box speed over shadows
    renderer.domElement.className = "stage-canvas block h-full w-full";
    host.appendChild(renderer.domElement);

    const scene3d = new THREE.Scene();
    const grid = new THREE.GridHelper(48, 48, 0x2a2f3a, 0x1c212b);
    const axes = new THREE.AxesHelper(1.5);
    scene3d.add(grid, axes);

    const persp = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    persp.position.set(9, 7, 11);
    persp.lookAt(0, 1, 0);
    const ortho = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 300);
    ortho.position.set(0, 40, 0.001); // hair off-axis so OrbitControls' up works
    ortho.up.set(0, 0, -1);
    ortho.lookAt(0, 0, 0);
    const camCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 500);

    const orbit = new OrbitControls(persp, renderer.domElement);
    orbit.enableDamping = false;
    const orbitTop = new OrbitControls(ortho, renderer.domElement);
    orbitTop.enableDamping = false;
    orbitTop.enableRotate = false;
    orbitTop.screenSpacePanning = false;
    orbitTop.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    /* only the active view's OrbitControls listen - the inactive one must not
     * swallow drags (a cam-view drag was starting a persp orbit). xform drags
     * and path-handle grabs still suspend whichever is active. */
    const syncControls = () => {
      const view = propsRef.current.view;
      const free = !xform.dragging && !(st.current?.dragging?.kind === "handle" || downAt?.handle !== undefined);
      orbit.enabled = free && view === "persp";
      orbitTop.enabled = free && view === "top";
    };

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(5, 10, 6);
    scene3d.add(ambient, sun);

    const xform = new TransformControls(persp, renderer.domElement);
    xform.addEventListener("dragging-changed", (e) => {
      const on = Boolean(e.value);
      syncControls();
      if (!on && st.current?.dragging?.kind === "xform") {
        // commit the gesture into the node's base transform
        const s = st.current;
        const id = s && [...s.objects.entries()].find(([, o]) => o.root === xform.object)?.[0];
        if (id && xform.object) {
          const p = propsRef.current;
          const node = p.scene.nodes.find((n) => n.id === id);
          if (node) {
            p.onCommit((sc) => {
              const nn = sc.nodes.find((x) => x.id === id)!;
              nn.transform.pos = [xform.object.position.x, xform.object.position.y, xform.object.position.z].map((v) => Math.round(v * 1e4) / 1e4) as Vec3;
              if (nn.kind === "camera") {
                // the root quat is the trajectory frame outright - the view
                // flip sits on the gizmo inner, so no un-flip here
                const angles = cameraAnglesFromQuat([
                  xform.object.quaternion.x, xform.object.quaternion.y,
                  xform.object.quaternion.z, xform.object.quaternion.w,
                ]);
                nn.transform.rot = [Math.round(angles.pitch * 1e4) / 1e4, Math.round(angles.yaw * 1e4) / 1e4, Math.round(angles.roll * 1e4) / 1e4];
              } else {
                nn.transform.rot = [xform.object.rotation.x, xform.object.rotation.y, xform.object.rotation.z].map((v) => Math.round((v / DEG) * 1e4) / 1e4) as Vec3;
              }
              nn.transform.scale = [xform.object.scale.x, xform.object.scale.y, xform.object.scale.z].map((v) => Math.round(v * 1e4) / 1e4) as Vec3;
            });
          }
        }
        if (s) s.dragging = null;
      } else if (on && st.current) {
        st.current.dragging = { kind: "xform" };
      }
    });
    xform.addEventListener("objectChange", () => {
      if (st.current) st.current.needsPaint = true;
    });
    const xHelper = xform.getHelper ? xform.getHelper() : (xform as unknown as THREE.Object3D);
    scene3d.add(xHelper);

    st.current = {
      renderer, scene3d, persp, ortho, camCam, orbit, orbitTop, xform, xHelper,
      objects: new Map(), pathLine: null, handles: [], selBox: null,
      grid, axes,
      ambient, sun, needsPaint: true, dragging: null,
      lastT: performance.now(), gltf: new GLTFLoader(),
      camFrame: { x: 0, y: 0, w: 1, h: 1 },
    };

    /* pointer picking + path-handle dragging */
    const ray = new THREE.Raycaster();
    const ndc = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    let downAt: { x: number; y: number; handle?: number } | null = null;

    const activeCam = () => {
      const v = propsRef.current.view;
      return v === "top" ? st.current!.ortho : v === "cam" ? st.current!.camCam : st.current!.persp;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const s = st.current!;
      if (s.xform.dragging) return;
      ray.setFromCamera(ndc(e), activeCam());
      const hitHandle = ray.intersectObjects(s.handles, false).find((h) => h.object.visible);
      downAt = { x: e.clientX, y: e.clientY, handle: hitHandle ? hitHandle.object.userData.handleIndex : undefined };
      // a handle grab owns the pointer - don't let the orbit controls pan
      if (downAt.handle !== undefined) { orbit.enabled = false; orbitTop.enabled = false; }
    };
    const onMove = (e: PointerEvent) => {
      const s = st.current!;
      if (!downAt || downAt.handle === undefined) return;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4) return;
      // drag the path point on its own horizontal plane (Y stays; inspector edits Y)
      const cam = renderCamera(propsRef.current.scene);
      const idx = downAt.handle;
      if (!cam?.props.path || !cam.props.path.points[idx]) return;
      const y = cam.props.path.points[idx][1];
      ray.setFromCamera(ndc(e), activeCam());
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
      const pt = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, pt)) return;
      if (!s.dragging || s.dragging.kind !== "handle") {
        s.dragging = { kind: "handle", index: idx, orig: [...cam.props.path.points[idx]] as Vec3 };
      }
      propsRef.current.onPreview((sc) => {
        const c = sc.nodes.find((n): n is Extract<StageNode, { kind: "camera" }> => n.id === cam.id && n.kind === "camera");
        if (!c?.props.path) return;
        c.props.path.points[idx] = [Math.round(pt.x * 1000) / 1000, y, Math.round(pt.z * 1000) / 1000];
      });
      s.needsPaint = true;
    };
    const onUp = (e: PointerEvent) => {
      const s = st.current!;
      if (downAt?.handle !== undefined) {
        // a path-handle release commits the previewed position as one
        // undoable edit - and never falls through to click-select
        if (s.dragging?.kind === "handle") {
          const cam = renderCamera(propsRef.current.scene);
          const idx = downAt.handle;
          const final = cam?.props.path?.points[idx];
          if (cam && final) {
            propsRef.current.onCommit((sc) => {
              const c = sc.nodes.find((n): n is Extract<StageNode, { kind: "camera" }> => n.id === cam.id && n.kind === "camera");
              if (c?.props.path) c.props.path.points[idx] = [...final] as Vec3;
            });
          }
        }
        s.dragging = null;
        downAt = null;
        syncControls(); // hand the active view's control back, not both
        return;
      }
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4 && !s.xform.dragging) {
        // click-select - raycast everything, then skip hits whose object or
        // any ancestor is invisible (the render camera's inner in cam view)
        ray.setFromCamera(ndc(e), activeCam());
        const roots = [...s.objects.values()].map((o) => o.root);
        const hit = ray.intersectObjects(roots, true).find((h) => {
          for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
            if (!o.visible) return false;
          }
          return true;
        });
        let id: string | null = null;
        let o: THREE.Object3D | null = hit?.object ?? null;
        while (o) {
          const found = [...s.objects.entries()].find(([, no]) => no.root === o || no.inner === o);
          if (found) { id = found[0]; break; }
          o = o.parent;
        }
        propsRef.current.onSelect(id);
      }
      downAt = null;
      s.dragging = null;
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    orbit.addEventListener("change", () => { if (st.current) st.current.needsPaint = true; });
    orbitTop.addEventListener("change", () => { if (st.current) st.current.needsPaint = true; });

    const ro = new ResizeObserver(() => { if (st.current) st.current.needsPaint = true; });
    ro.observe(host);

    /* the render loop - paints on demand; advances the playhead while playing */
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = st.current!;
      const p = propsRef.current;
      const now = performance.now();
      const dt = (now - s.lastT) / 1000;
      s.lastT = now;
      if (p.playing) {
        const dur = p.scene.meta.duration;
        p.timeRef.current = (p.timeRef.current + dt) % Math.max(dur, 1e-6);
        p.onTick(p.timeRef.current);
        s.needsPaint = true;
      }
      if (!s.needsPaint) return;
      s.needsPaint = false;
      paintFrame();
    };
    loop();

    const toScreen = (obj: THREE.Object3D) => {
      const s = st.current!;
      const v = new THREE.Vector3();
      obj.getWorldPosition(v);
      const cam = propsRef.current.view === "top" ? s.ortho : propsRef.current.view === "cam" ? s.camCam : s.persp;
      v.project(cam);
      // outside the frustum in depth - behind the camera / past the far
      // plane (z>1) or closer than the near plane (z<-1) - is not a real
      // screen position
      if (v.z > 1 || v.z < -1) return null;
      const r = s.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
    props.register({
      paint: () => { if (st.current) { st.current.needsPaint = true; } },
      canvas: () => st.current?.renderer.domElement ?? null,
      handleScreenPos: (i: number) => {
        const s = st.current;
        const mesh = s?.handles.find((h) => h.userData.handleIndex === i);
        return s && mesh ? toScreen(mesh) : null;
      },
      objectScreenPos: (id: string) => {
        const s = st.current;
        const o = s?.objects.get(id);
        return s && o ? toScreen(o.root) : null;
      },
      screenPosAt: (pos: Vec3) => {
        const s = st.current;
        if (!s) return null;
        const v = new THREE.Vector3(...pos);
        const cam = propsRef.current.view === "top" ? s.ortho : propsRef.current.view === "cam" ? s.camCam : s.persp;
        v.project(cam);
        // same rule as toScreen - outside the frustum in depth is not a
        // position on screen
        if (v.z > 1 || v.z < -1) return null;
        const r = s.renderer.domElement.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
      drawn: (id: string) => {
        const s = st.current;
        if (!s) return false;
        let obj: THREE.Object3D | null = null;
        if (id === "$path") obj = s.pathLine;
        else if (id.startsWith("$handle:")) obj = s.handles.find((h) => h.userData.handleIndex === Number(id.slice(8))) ?? null;
        else obj = s.objects.get(id)?.inner ?? null;
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
          if (!o.visible) return false;
        }
        return obj !== null;
      },
      renderStill: async (w, h) => {
        const s = st.current;
        if (!s) return null;
        const p = propsRef.current;
        const { scene } = p;
        const t = p.timeRef.current;
        /* every editor aid hides for the frame - grid, axes, selection box,
         * path line + knot handles, the transform helper, camera gizmos
         * entirely (they are furniture, not scene content), and a light
         * gizmo's non-light visuals while the real light stays lit */
        const hidden: THREE.Object3D[] = [];
        const hide = (o: THREE.Object3D | null | undefined) => {
          if (o && o.visible) { o.visible = false; hidden.push(o); }
        };
        hide(s.grid); hide(s.axes); hide(s.selBox); hide(s.pathLine); hide(s.xHelper);
        for (const hd of s.handles) hide(hd);
        for (const n of scene.nodes) {
          const o = s.objects.get(n.id);
          if (!o) continue;
          if (n.kind === "camera") hide(o.inner);
          else if (n.kind === "light") {
            o.inner.traverse((c) => {
              if ((c as THREE.Mesh).isMesh || (c as THREE.Line).isLine || (c as THREE.LineSegments).isLineSegments) hide(c);
            });
          }
        }
        const el = s.renderer.domElement;
        let blob: Blob | null = null;
        try {
          const cam = new THREE.PerspectiveCamera(40, w / h, 0.05, 500);
          const pose = cameraAt(scene, t);
          if (pose) {
            cam.position.set(...pose.pos);
            const fy = Math.sin(pose.pitch * DEG);
            const fh = Math.cos(pose.pitch * DEG);
            const f = new THREE.Vector3(Math.sin(pose.yaw * DEG) * fh, fy, Math.cos(pose.yaw * DEG) * fh);
            cam.up.set(0, 1, 0).applyAxisAngle(f, -pose.roll * DEG);
            cam.lookAt(cam.position.clone().add(f));
            cam.fov = 2 * Math.atan(Math.tan((pose.fov / 2) * DEG) * (h / w)) / DEG;
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
          }
          s.renderer.setSize(w, h, false);
          s.renderer.setScissorTest(false);
          s.renderer.setViewport(0, 0, w, h);
          s.renderer.setClearColor(new THREE.Color(scene.env.background), 1);
          s.renderer.render(s.scene3d, cam);
          blob = await new Promise<Blob | null>((res) => el.toBlob(res, "image/png"));
        } finally {
          for (const o of hidden) o.visible = true;
          s.needsPaint = true; // next paint restores host size + letterbox state
        }
        return blob;
      },
      exportGlb: async () => {
        const s = st.current;
        if (!s) return null;
        const p = propsRef.current;
        const { scene } = p;
        const t = p.timeRef.current;
        const { w: rw, h: rh } = scene.meta.renderSize;
        const ex = new THREE.Scene();
        const flipY = new THREE.Quaternion(0, 1, 0, 0); // trajectory +z fwd → three -Z camera
        for (const n of scene.nodes) {
          if (n.kind === "camera") {
            const pose = cameraAt(scene, t, n.id);
            if (!pose) continue;
            const cam = new THREE.PerspectiveCamera(40, rw / rh, 0.05, 500);
            cam.name = n.name;
            cam.fov = 2 * Math.atan(Math.tan((pose.fov / 2) * DEG) * (rh / rw)) / DEG;
            cam.position.set(...pose.pos);
            const q = quatFromCameraDeg([pose.pitch, pose.yaw, pose.roll]);
            cam.quaternion.set(q[0], q[1], q[2], q[3]).multiply(flipY);
            cam.updateProjectionMatrix();
            ex.add(cam);
            continue;
          }
          const wpose = worldOf(scene, n.id, t);
          if (!wpose) continue;
          /* the world pose goes on the light/clone itself - a per-node holder
           * group would double the exported node count and push scenes well
           * under the editor's own cap over the server's 300-node limit */
          const pose = (o: THREE.Object3D) => {
            o.name = n.name;
            o.position.set(...wpose.pos);
            o.quaternion.set(...wpose.quat);
            o.scale.set(...wpose.scale);
          };
          if (n.kind === "light") {
            const lp = n.props;
            const light = lp.light === "point"
              ? new THREE.PointLight(lp.color, lp.intensity, lp.range)
              : lp.light === "spot"
                ? new THREE.SpotLight(lp.color, lp.intensity, lp.range, lp.angle * DEG, 0.4, 1)
                : new THREE.DirectionalLight(lp.color, lp.intensity);
            pose(light);
            ex.add(light);
            continue;
          }
          const o = s.objects.get(n.id);
          if (!o) continue;
          const clone = o.inner.clone(true);
          /* compose pose × the inner's own local TRS - a flat plane's -90° X
           * rotation (and a model's normalize scale) must survive the pose */
          new THREE.Matrix4()
            .compose(
              new THREE.Vector3(...wpose.pos),
              new THREE.Quaternion(...wpose.quat),
              new THREE.Vector3(...wpose.scale),
            )
            .multiply(new THREE.Matrix4().compose(clone.position, clone.quaternion, clone.scale))
            .decompose(clone.position, clone.quaternion, clone.scale);
          clone.name = n.name;
          ex.add(clone);
        }
        const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
        const buf = await new GLTFExporter().parseAsync(ex, { binary: true });
        return new Blob([buf as ArrayBuffer], { type: "model/gltf-binary" });
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      orbit.dispose(); orbitTop.dispose(); xform.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      st.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- scene → three sync ---------- */
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const { scene } = props;
    const seen = new Set<string>();
    for (const n of scene.nodes) {
      seen.add(n.id);
      const json = JSON.stringify({ k: n.kind, p: n.props, nm: n.name });
      let obj = s.objects.get(n.id);
      if (!obj) {
        obj = { root: new THREE.Group(), inner: buildInner(n, scene), json };
        obj.root.name = n.id;
        obj.root.add(obj.inner);
        obj.root.userData.nodeId = n.id;
        s.scene3d.add(obj.root);
        s.objects.set(n.id, obj);
      } else if (obj.json !== json) {
        obj.root.remove(obj.inner);
        obj.inner = buildInner(n, scene);
        obj.root.add(obj.inner);
        obj.json = json;
      }
      // model nodes: attempt the real GLB once per src
      if (n.kind === "model" && !(obj.root.userData.glbFor === n.props.src)) {
        obj.root.userData.glbFor = n.props.src;
        s.gltf.loadAsync(n.props.src).then((g) => {
          if (!s.objects.has(n.id)) return;
          const inner = obj.root.getObjectByName("model-proxy");
          if (inner) obj.root.remove(inner);
          const box = new THREE.Box3().setFromObject(g.scene);
          const size = box.getSize(new THREE.Vector3());
          const m = Math.max(size.x, size.y, size.z) || 1;
          g.scene.scale.setScalar(1 / m); // normalize to ~1 m then let transform scale
          g.scene.name = "model-proxy";
          g.scene.position.y = -box.min.y / m;
          obj.root.add(g.scene);
          s.needsPaint = true;
        }).catch(() => { /* placeholder stays */ });
      }
      // parenting - attach the root under its parent's root
      const parentObj = n.parent ? s.objects.get(n.parent) : undefined;
      const wanted = parentObj?.root ?? s.scene3d;
      if (obj.root.parent !== wanted) wanted.add(obj.root);
    }
    for (const [id, o] of s.objects) {
      // removeFromParent - a parented node's root sits under its parent's
      // root, so scene3d.remove() there is a no-op that leaves a frozen mesh
      if (!seen.has(id)) { o.root.removeFromParent(); s.objects.delete(id); }
    }

    // env
    s.scene3d.background = new THREE.Color(scene.env.background);
    s.ambient.intensity = scene.env.ambient;
    s.sun.intensity = scene.env.sun.intensity;
    const d = new THREE.Vector3(...scene.env.sun.direction).normalize();
    s.sun.position.copy(d.clone().multiplyScalar(-18));
    s.sun.target.position.set(0, 0, 0);

    // camera path line + handles for the render camera - drawn from
    // pathPos() samples so the line IS the cameraAt spline, not a
    // second implementation (three's own CatmullRomCurve3 drifts)
    if (s.pathLine) { s.scene3d.remove(s.pathLine); s.pathLine = null; }
    for (const h of s.handles) s.scene3d.remove(h);
    s.handles = [];
    const rc = renderCamera(scene);
    if (rc?.props.path) {
      const { times } = rc.props.path;
      const t0 = times[0], t1 = times[times.length - 1];
      const pts = Array.from(
        { length: 161 },
        (_, i) => new THREE.Vector3(...pathPos(rc.props.path!, t0 + ((t1 - t0) * i) / 160)),
      );
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ACCENT }));
      s.scene3d.add(line);
      s.pathLine = line;
      rc.props.path.points.forEach((p, i) => {
        const h = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 12, 10),
          new THREE.MeshBasicMaterial({ color: i === 0 ? 0xffffff : ACCENT }),
        );
        h.position.set(p[0], p[1], p[2]);
        h.userData.handleIndex = i;
        s.scene3d.add(h);
        s.handles.push(h);
      });
    }
    s.needsPaint = true;
  }, [props.scene]);

  /* ---------- selection → gizmo + box ---------- */
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    if (s.selBox) { s.scene3d.remove(s.selBox); s.selBox = null; }
    const sel = props.selection && s.objects.get(props.selection);
    if (sel) {
      if (props.view !== "cam") {
        s.xform.attach(sel.root);
        s.xform.enabled = true;
      } else {
        s.xform.detach();
      }
      s.selBox = new THREE.BoxHelper(sel.root, ACCENT);
      s.scene3d.add(s.selBox);
    } else {
      s.xform.detach();
    }
    s.needsPaint = true;
  }, [props.selection, props.view, props.scene]);

  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.xform.setMode(props.xform);
    s.needsPaint = true;
  }, [props.xform]);

  useEffect(() => {
    const s = st.current;
    if (!s) return;
    // exactly one OrbitControls is live - the active view's (cam has none)
    s.orbit.enabled = props.view === "persp" && !s.xform.dragging;
    s.orbitTop.enabled = props.view === "top" && !s.xform.dragging;
    s.needsPaint = true;
  }, [props.view]);

  /* ---------- the frame ---------- */
  const paintFrame = () => {
    const s = st.current;
    if (!s) return;
    const p = propsRef.current;
    const { scene } = p;
    const t = p.timeRef.current;
    const host = hostRef.current!;
    const w = host.clientWidth || 640, h = host.clientHeight || 400;
    if (s.renderer.domElement.width !== w || s.renderer.domElement.height !== h) {
      s.renderer.setSize(w, h, false);
    }

    // sampled transforms → object roots. Non-camera nodes take their local
    // TRS straight from sampleScene; cameras get a second pass driven by
    // cameraAt() so lookAt, paths and parenting aim the gizmo correctly.
    const sampled = sampleScene(scene, t);
    for (const n of scene.nodes) {
      if (n.kind === "camera") continue;
      const o = s.objects.get(n.id);
      const smp = sampled[n.id];
      if (!o || !smp) continue;
      if (s.xform.dragging && s.xform.object === o.root) continue; // gizmo owns it mid-drag
      o.root.position.set(...smp.pos);
      o.root.rotation.set(smp.rot[0] * DEG, smp.rot[1] * DEG, smp.rot[2] * DEG);
      o.root.scale.set(...smp.scale);
    }
    const pq = new THREE.Quaternion();
    for (const n of scene.nodes) {
      if (n.kind !== "camera") continue;
      const o = s.objects.get(n.id);
      const smp = sampled[n.id];
      if (!o || !smp) continue;
      if (s.xform.dragging && s.xform.object === o.root) continue;
      const pose = cameraAt(scene, t, n.id);
      // cameraAt resolves world space: keyed/base transform through parents,
      // path position + tangent aim, lookAt override. The root carries the
      // raw trajectory-frame quaternion (worldOf's value) - the -Z/+z view
      // flip is baked into the gizmo's inner, so children compose like
      // worldOf and TransformControls rotate the real frame.
      const wPos = pose ? pose.pos : smp.pos;
      const wq = quatFromCameraDeg(pose ? [pose.pitch, pose.yaw, pose.roll] : smp.rot);
      const dq = new THREE.Quaternion(wq[0], wq[1], wq[2], wq[3]);
      const parent = o.root.parent;
      if (parent && parent !== s.scene3d) {
        // root sits under the parent's root - bring the world pose home
        parent.updateWorldMatrix(true, false);
        o.root.position.copy(parent.worldToLocal(new THREE.Vector3(...wPos)));
        parent.getWorldQuaternion(pq);
        o.root.quaternion.copy(pq.invert().multiply(dq));
      } else {
        o.root.position.set(...wPos);
        o.root.quaternion.copy(dq);
      }
      o.root.scale.set(...smp.scale);
      // live prop refresh - focalMm keys drive the frustum helper
      const frustum = o.inner.getObjectByName("frustum") as THREE.CameraHelper | undefined;
      const cam3 = frustum?.camera as THREE.PerspectiveCamera | undefined;
      if (cam3) {
        const keyed = sampleProp(n, "focalMm", t);
        const mm = typeof keyed === "number" ? keyed : n.props.focalMm;
        const hf = hFov(mm, n.props.sensor as SensorName);
        const vf = 2 * Math.atan(Math.tan(hf / 2 * DEG) * (scene.meta.renderSize.h / scene.meta.renderSize.w)) / DEG;
        if (Math.abs(cam3.fov - vf) > 0.01) { cam3.fov = vf; cam3.updateProjectionMatrix(); frustum!.update(); }
      }
    }
    s.selBox?.update();

    let viewCam: THREE.Camera = s.persp;
    let letterboxed = false;
    if (p.view === "top") {
      viewCam = s.ortho;
      const aspect = w / h;
      const span = 9 / s.ortho.zoom;
      s.ortho.left = -span * aspect; s.ortho.right = span * aspect;
      s.ortho.top = span; s.ortho.bottom = -span;
      s.ortho.updateProjectionMatrix();
      s.xform.camera = s.ortho;
    } else if (p.view === "cam") {
      viewCam = s.camCam;
      letterboxed = true;
      const pose = cameraAt(scene, t);
      const { w: rw, h: rh } = scene.meta.renderSize;
      if (pose) {
        s.camCam.position.set(...pose.pos);
        const fy = Math.sin(pose.pitch * DEG);
        const fh = Math.cos(pose.pitch * DEG);
        const f = new THREE.Vector3(Math.sin(pose.yaw * DEG) * fh, fy, Math.cos(pose.yaw * DEG) * fh);
        s.camCam.up.set(0, 1, 0).applyAxisAngle(f, -pose.roll * DEG);
        s.camCam.lookAt(s.camCam.position.clone().add(f));
        const vfov = 2 * Math.atan(Math.tan((pose.fov / 2) * DEG) * (rh / rw)) / DEG;
        s.camCam.fov = vfov;
        s.camCam.aspect = rw / rh;
        s.camCam.updateProjectionMatrix();
      }
      s.xform.detach();
    } else {
      s.xform.camera = s.persp;
    }

    // through the render camera the camera's own gizmo would fill the frame -
    // hide its INNER only (root stays visible so mounted children still draw,
    // and a render-camera switch can never strand a hidden root). Recomputed
    // every paint: whichever camera is render now is the one that hides. The
    // path line/knot handles and editor helpers hide too; other views restore.
    const inCam = p.view === "cam";
    s.grid.visible = !inCam;
    s.axes.visible = !inCam;
    if (s.selBox) s.selBox.visible = !inCam;
    if (s.pathLine) s.pathLine.visible = !inCam;
    for (const h of s.handles) h.visible = !inCam;
    const rc = renderCamera(scene);
    for (const n of scene.nodes) {
      if (n.kind !== "camera") continue;
      const o = s.objects.get(n.id);
      if (!o) continue;
      o.root.visible = true;
      o.inner.visible = !(inCam && n.id === rc?.id);
    }

    s.renderer.setScissorTest(false);
    s.renderer.setViewport(0, 0, w, h);
    if (letterboxed) {
      // letterbox the camera view to meta.renderSize inside the canvas
      const { w: rw, h: rh } = scene.meta.renderSize;
      const scale = Math.min(w / rw, h / rh);
      const vw = Math.round(rw * scale), vh = Math.round(rh * scale);
      const vx = Math.round((w - vw) / 2), vy = Math.round((h - vh) / 2);
      s.camFrame = { x: vx, y: vy, w: vw, h: vh };
      s.renderer.setClearColor(0x06070a, 1);
      s.renderer.clear();
      s.renderer.setScissorTest(true);
      s.renderer.setViewport(vx, vy, vw, vh);
      s.renderer.setScissor(vx, vy, vw, vh);
      s.renderer.setClearColor(new THREE.Color(scene.env.background), 1);
    }
    s.renderer.render(s.scene3d, viewCam);
    s.renderer.setScissorTest(false);
  };

  // playhead scrubbing while paused repaints
  useEffect(() => {
    const s = st.current;
    if (s) s.needsPaint = true;
  });

  const { w: rw, h: rh } = props.scene.meta.renderSize;
  const frame = st.current?.camFrame;
  const hostAspect = rw / rh;
  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-[#06070a]" data-testid="stage-viewport">
      {props.view === "cam" && (
        <div
          className="camview-frame pointer-events-none absolute border border-[var(--color-accent)]/40"
          style={{ aspectRatio: `${rw} / ${rh}` }}
          ref={(el) => {
            // keep the overlay div inside the canvas area at the scissor rect
            if (!el || !hostRef.current) return;
            const W = hostRef.current.clientWidth, H = hostRef.current.clientHeight;
            const scale = Math.min(W / rw, H / rh);
            el.style.width = `${Math.round(rw * scale)}px`;
            el.style.height = `${Math.round(rh * scale)}px`;
            el.style.left = `${Math.round((W - rw * scale) / 2)}px`;
            el.style.top = `${Math.round((H - rh * scale) / 2)}px`;
          }}
        />
      )}
      <span className="sr-only">{hostAspect}</span>
    </div>
  );
}


