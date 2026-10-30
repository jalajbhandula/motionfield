"use client";
import { useEffect, useRef, useState } from "react";

/** Minimal orbitable GLB preview for generated 3D outputs. three.js loads
 *  lazily so non-3D pages never pay the bundle cost. */
export function GlbViewer({ url, className, autoRotate = false, bare = false }: {
  url: string; className?: string;
  /** slow turntable until the user grabs it */
  autoRotate?: boolean;
  /** fill the parent, no download link (showcase tiles) */
  bare?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    (async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      const el = host.current;
      if (!el || disposed) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      const w = el.clientWidth || 640, h = el.clientHeight || 480;
      // updateStyle false: a sized canvas inside this box was feeding ResizeObserver
      // and growing the homepage tile forever.
      renderer.setSize(w, h, false);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x101018);
      // soft studio reflections - metallic/glossy PBR materials read black without one
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 2.0);
      key.position.set(3, 5, 4);
      scene.add(key);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 1.6;
      controls.addEventListener("start", () => { controls.autoRotate = false; });

      new GLTFLoader().load(url, (gltf) => {
        if (disposed) return;
        scene.add(gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        controls.target.copy(center);
        // fit the bounding sphere in the narrower of the two fields of view
        const vfov = (camera.fov * Math.PI) / 180;
        const fit = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect));
        const dist = Math.max((size / 2) / Math.sin(fit / 2) * 1.05, size * 0.6);
        camera.position.copy(center).add(new THREE.Vector3(1, 0.55, 1).normalize().multiplyScalar(dist));
        camera.near = size / 1000; camera.far = size * 10;
        camera.updateProjectionMatrix();
      }, undefined, (e) => setError(e instanceof Error ? e.message : "failed to load model"));

      renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
      const onResize = () => {
        const w2 = el.clientWidth, h2 = el.clientHeight;
        if (!w2 || !h2) return;
        camera.aspect = w2 / h2; camera.updateProjectionMatrix(); renderer.setSize(w2, h2, false);
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(el);
      cleanup = () => {
        ro.disconnect();
        renderer.setAnimationLoop(null);
        controls.dispose();
        pmrem.dispose();
        renderer.dispose();
        el.removeChild(renderer.domElement);
      };
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; cleanup?.(); };
  }, [url, autoRotate]);

  if (bare) return (
    <div className={className ?? "h-full w-full"}>
      <div ref={host} className="relative h-full w-full overflow-hidden" />
      {error && <p className="absolute bottom-2 left-2 text-xs text-red-400">{error}</p>}
    </div>
  );
  return (
    <div className={className ?? "w-full"}>
      <div ref={host} className="relative aspect-square w-full overflow-hidden" />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      <a href={url} download className="mt-1 inline-block text-xs underline opacity-70 hover:opacity-100">Download .glb</a>
    </div>
  );
}
