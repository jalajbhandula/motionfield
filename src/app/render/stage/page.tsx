"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { parseStageScene, type StageNode, type StageScene } from "@/lib/stage/scene";
import { cameraAt, worldOf } from "@/lib/stage/sample";
import { buildMannequin } from "@/lib/stage/mannequin";
import { STAGE_RENDER_FPS, depthRange, projectPoint } from "@/lib/stage/render-plan";

/**
 * Chrome-less Stage render page - headless passes for the stage-render
 * recipe. scripts/render/stage.ts injects
 *
 *   window.__OF_STAGE_RENDER__ = { scene, startS, fps }
 *
 * and drives the exposed handle:
 *
 *   __ofStage.ready - scene + GLBs built, safe to render
 *   __ofStage.setPass({kind,w,h}) - "previz" | "depth" | "pose"
 *   __ofStage.renderFrame(i) - PNG dataURL of frame i
 *
 * previz = the same grey-box look the editor's PNG export produces (real
 * lights, no gizmos); depth = a MeshDepthMaterial pass under one range-wide
 * near/far; pose = an OpenPose-style skeleton drawn from the mannequin's
 * named joints on a 2D canvas - all from the cameraAt render camera.
 */

export type StagePassKind = "previz" | "depth" | "pose";

export interface StageRenderHandle {
  ready: Promise<void>;
  setPass(p: { kind: StagePassKind; w: number; h: number }): void;
  renderFrame(i: number): Promise<string>;
}

declare global {
  interface Window {
    __OF_STAGE_RENDER__?: { scene: unknown; startS?: number; fps?: number; frames?: number };
    __ofStage?: StageRenderHandle;
    __ofStageError?: string;
  }
}

const DEG = Math.PI / 180;
/** gain applied to lit passes - the grey-box read to VACE comes out
 *  under-exposed at the scene env defaults and VACE inherits the dark
 *  look from the anchor frame; depth/pose stay untouched */
const STAGE_LIT_EXPOSURE = 1.6;

/* Linear-view-depth override for the control pass. THREE's stock
 * MeshDepthMaterial packs the NONLINEAR depth-buffer z - under a near/far
 * range of a few metres everything past ~2×near lands at z≈0.9+ and the
 * whole clip reads near-black, so VACE ignores it. This shader writes
 * linear view distance mapped onto depthRange()'s 2-98 percentile span
 * (near=white, far=black) with a mild gamma lift on mid-tones. */
function makeDepthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 24 }, uGamma: { value: 0.85 } },
    vertexShader: /* glsl */ `
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vDepth;
      uniform float uNear, uFar, uGamma;
      void main() {
        float g = 1.0 - clamp((vDepth - uNear) / (uFar - uNear), 0.0, 1.0);
        gl_FragColor = vec4(vec3(pow(g, uGamma)), 1.0);
      }`,
  });
}

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
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: n.props.color, roughness: 0.9, metalness: 0.02 }),
  );
  mesh.castShadow = n.props.shape !== "plane";
  mesh.receiveShadow = true;
  if (n.props.shape === "plane") mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/* the render pass lights the scene with real lights only - the editor's
 * gizmo furniture (bulb sphere, cone wireframe, frustum lines) is hidden in
 * its own still export, so it never exists here */
function lightObject(n: Extract<StageNode, { kind: "light" }>): THREE.Object3D {
  const { light, color, intensity, angle, range } = n.props;
  const g = new THREE.Group();
  if (light === "point") {
    g.add(new THREE.PointLight(color, intensity, range));
  } else if (light === "spot") {
    const spot = new THREE.SpotLight(color, intensity, range, angle * DEG, 0.4, 1);
    const tgt = new THREE.Object3D();
    tgt.position.set(0, 0, -3);
    g.add(tgt);
    spot.target = tgt;
    g.add(spot);
  } else {
    const sun = new THREE.DirectionalLight(color, intensity);
    const tgt = new THREE.Object3D();
    tgt.position.set(0, 0, -3);
    g.add(tgt);
    sun.target = tgt;
    g.add(sun);
  }
  return g;
}

/* OpenPose BODY_18 layout onto the mannequin's named joints - one entry per
 * keypoint slot; joints missing under the camera just don't draw */
const POSE_KP: [number, string][] = [
  [0, "j_nose"], [1, "j_head"], // neck = head group origin
  [2, "j_upperArmR"], [3, "j_forearmR"], [4, "j_handR"],
  [5, "j_upperArmL"], [6, "j_forearmL"], [7, "j_handL"],
  [8, "j_thighR"], [9, "j_shinR"], [10, "j_footR"],
  [11, "j_thighL"], [12, "j_shinL"], [13, "j_footL"],
  [14, "j_eyeR"], [15, "j_eyeL"], [16, "j_earR"], [17, "j_earL"],
];
const POSE_PAIRS: [number, number, string][] = [
  [1, 2, "#ff5252"], [2, 3, "#ff5252"], [3, 4, "#ff5252"],
  [1, 5, "#69f0ae"], [5, 6, "#69f0ae"], [6, 7, "#69f0ae"],
  [1, 19, "#ffd740"], // neck → mid-hip (synthetic point)
  [19, 8, "#40c4ff"], [8, 9, "#40c4ff"], [9, 10, "#40c4ff"],
  [19, 11, "#b388ff"], [11, 12, "#b388ff"], [12, 13, "#b388ff"],
  [1, 0, "#ffd740"], [0, 14, "#ff5252"], [14, 16, "#ff5252"],
  [0, 15, "#69f0ae"], [15, 17, "#69f0ae"],
];

export default function RenderStagePage() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const c2Ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const payload = window.__OF_STAGE_RENDER__;
    const fail = (m: string) => { window.__ofStageError = m; };
    if (!payload?.scene) { fail("no scene - inject window.__OF_STAGE_RENDER__"); return; }
    let scene: StageScene;
    try {
      scene = parseStageScene(payload.scene);
    } catch (e) {
      fail(`scene parse failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const startS = payload.startS ?? 0;
    const fps = payload.fps ?? STAGE_RENDER_FPS;
    const frames = Math.max(1, Math.round(payload.frames ?? fps));
    const gl = glRef.current, c2 = c2Ref.current;
    if (!gl || !c2) return;

    const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
    // LinearToneMapping so toneMappingExposure is a plain linear gain
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = STAGE_LIT_EXPOSURE;
    const s3 = new THREE.Scene();
    s3.background = new THREE.Color(scene.env.background);
    const ambient = new THREE.AmbientLight(0xffffff, scene.env.ambient);
    const sun = new THREE.DirectionalLight(0xffffff, scene.env.sun.intensity);
    sun.position.copy(new THREE.Vector3(...scene.env.sun.direction).normalize().multiplyScalar(-18));
    s3.add(ambient, sun, sun.target);

    const objs = new Map<string, THREE.Object3D>();
    const readyJobs: Promise<unknown>[] = [];
    for (const n of scene.nodes) {
      if (n.kind === "camera") continue; // furniture - never rendered
      const root = new THREE.Group();
      if (n.kind === "primitive") root.add(primitiveMesh(n));
      else if (n.kind === "mannequin") root.add(buildMannequin(THREE, n.props.pose, n.props.height));
      else if (n.kind === "light") root.add(lightObject(n));
      else if (n.kind === "model") {
        // same load the editor does - real GLB normalized to ~1 m, the
        // wireframe proxy stays if it can't be fetched
        const proxy = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({ color: "#5a6474", wireframe: true }),
        );
        proxy.name = "model-proxy";
        root.add(proxy);
        readyJobs.push(
          new GLTFLoader().loadAsync(n.props.src).then((g) => {
            const inner = root.getObjectByName("model-proxy");
            if (inner) root.remove(inner);
            const box = new THREE.Box3().setFromObject(g.scene);
            const size = box.getSize(new THREE.Vector3());
            const m = Math.max(size.x, size.y, size.z) || 1;
            g.scene.scale.setScalar(1 / m);
            g.scene.name = "model-proxy";
            g.scene.position.y = -box.min.y / m;
            root.add(g.scene);
          }).catch(() => { /* placeholder stays - same as the editor */ }),
        );
      }
      s3.add(root);
      objs.set(n.id, root);
    }

    let pass: { kind: StagePassKind; w: number; h: number } = { kind: "previz", w: 640, h: 360 };
    let depth: { near: number; far: number } = { near: 0.1, far: 24 };
    const depthMat = makeDepthMaterial();
    const ctx2 = c2.getContext("2d")!;

    const poseAt = (i: number) => {
      const t = startS + i / fps;
      for (const n of scene.nodes) {
        if (n.kind === "camera") continue;
        const w = worldOf(scene, n.id, t);
        const o = objs.get(n.id);
        if (!w || !o) continue;
        o.position.set(...w.pos);
        o.quaternion.set(...w.quat);
        o.scale.set(...w.scale);
      }
      return t;
    };

    const camFor = (t: number, w: number, h: number, near: number, far: number) => {
      const cam = new THREE.PerspectiveCamera(40, w / h, near, far);
      const pose = cameraAt(scene, t);
      if (!pose) throw new Error("scene has no render camera");
      cam.position.set(...pose.pos);
      const fy = Math.sin(pose.pitch * DEG);
      const fh = Math.cos(pose.pitch * DEG);
      const f = new THREE.Vector3(Math.sin(pose.yaw * DEG) * fh, fy, Math.cos(pose.yaw * DEG) * fh);
      cam.up.set(0, 1, 0).applyAxisAngle(f, -pose.roll * DEG);
      cam.lookAt(cam.position.clone().add(f));
      // pose.fov is horizontal degrees - convert to three's vertical fov
      cam.fov = (2 * Math.atan(Math.tan((pose.fov / 2) * DEG) * (h / w))) / DEG;
      cam.updateProjectionMatrix();
      return cam;
    };

    const drawPose = (t: number) => {
      const pose = cameraAt(scene, t)!;
      ctx2.fillStyle = "#000";
      ctx2.fillRect(0, 0, pass.w, pass.h);
      s3.updateMatrixWorld(true);
      for (const n of scene.nodes) {
        if (n.kind !== "mannequin") continue;
        const root = objs.get(n.id);
        if (!root) continue;
        const pts: (THREE.Vector3 | null)[] = new Array(20).fill(null);
        for (const [kp, name] of POSE_KP) {
          const j = root.getObjectByName(name);
          if (j) pts[kp] = j.getWorldPosition(new THREE.Vector3());
        }
        if (pts[8] && pts[11]) {
          pts[19] = pts[8].clone().add(pts[11]).multiplyScalar(0.5); // mid-hip
        }
        const px = pts.map((v) => (v ? projectPoint(pose, pass.w, pass.h, [v.x, v.y, v.z]) : null));
        const lw = Math.max(2, Math.round(pass.w / 160));
        ctx2.lineWidth = lw;
        ctx2.lineCap = "round";
        for (const [a, b, color] of POSE_PAIRS) {
          const pa = px[a], pb = px[b];
          if (!pa || !pb) continue;
          ctx2.strokeStyle = color;
          ctx2.beginPath();
          ctx2.moveTo(pa.x, pa.y);
          ctx2.lineTo(pb.x, pb.y);
          ctx2.stroke();
        }
        ctx2.fillStyle = "#fff";
        for (const p of px) {
          if (!p) continue;
          ctx2.beginPath();
          ctx2.arc(p.x, p.y, Math.max(2, lw * 0.8), 0, Math.PI * 2);
          ctx2.fill();
        }
      }
      return c2.toDataURL("image/png");
    };

    window.__ofStage = {
      ready: Promise.allSettled(readyJobs).then(() => undefined),
      setPass(p) {
        pass = { ...p };
        renderer.setSize(p.w, p.h, false);
        c2.width = p.w;
        c2.height = p.h;
        if (p.kind === "depth") {
          // one near/far for the whole request - per-frame re-normalization
          // would let the same surface's gray crawl between frames
          depth = depthRange(scene, startS, frames);
          depthMat.uniforms.uNear.value = depth.near;
          depthMat.uniforms.uFar.value = depth.far;
          s3.overrideMaterial = depthMat;
          s3.background = new THREE.Color("#000");
          renderer.toneMappingExposure = 1; // a depth map isn't a photo
        } else {
          s3.overrideMaterial = null;
          s3.background = new THREE.Color(scene.env.background);
          renderer.toneMappingExposure = STAGE_LIT_EXPOSURE;
        }
      },
      async renderFrame(i) {
        const t = poseAt(i);
        if (pass.kind === "pose") return drawPose(t);
        const cam = camFor(t, pass.w, pass.h, 0.05, pass.kind === "depth" ? Math.max(500, depth.far * 2) : 500);
        renderer.setClearColor(pass.kind === "depth" ? new THREE.Color("#000") : new THREE.Color(scene.env.background), 1);
        renderer.render(s3, cam);
        return gl.toDataURL("image/png");
      },
    };
    return () => {
      delete window.__ofStage;
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <canvas ref={glRef} data-testid="stage-gl" style={{ display: "block" }} />
      <canvas ref={c2Ref} data-testid="stage-2d" style={{ display: "none" }} />
    </div>
  );
}
