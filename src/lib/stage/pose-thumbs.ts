import * as THREE from "three";
import { buildMannequin } from "./mannequin";
import type { MannequinPose } from "./scene";

/**
 * Pose-picker thumbnails - rendered by the same procedural mannequin the
 * viewport draws, one shared offscreen WebGL context. Poses render lazily
 * (the picker asks for one at a time as it mounts) and cache forever; the
 * cache never invalidates because a pose's joint data is build-time
 * constant. Client-only - every entry point no-ops to null on the server.
 */

const cache = new Map<MannequinPose, string>();
let ctx: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera } | null = null;
let failed = false;

function thumbCtx() {
  if (ctx || failed || typeof document === "undefined") return ctx;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 128;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(96, 128, false);
    const scene = new THREE.Scene();
    const key = new THREE.DirectionalLight("#ffffff", 2.2);
    key.position.set(2, 4, 3);
    scene.add(key, new THREE.AmbientLight("#aab4cc", 1.4));
    const cam = new THREE.PerspectiveCamera(30, 96 / 128, 0.1, 20);
    cam.position.set(0.6, 1.35, 3.1);
    cam.lookAt(0, 0.85, 0);
    ctx = { renderer, scene, cam };
  } catch {
    failed = true; // software-webgl-off environments: the picker shows names only
  }
  return ctx;
}

/** data-URL thumbnail for a pose, or null when WebGL isn't available */
export function poseThumb(pose: MannequinPose): string | null {
  const hit = cache.get(pose);
  if (hit) return hit;
  const c = thumbCtx();
  if (!c) return null;
  const fig = buildMannequin(THREE, pose, 1.7);
  c.scene.add(fig);
  c.renderer.render(c.scene, c.cam);
  const url = c.renderer.domElement.toDataURL("image/png");
  c.scene.remove(fig);
  fig.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose();
    }
  });
  cache.set(pose, url);
  return url;
}
