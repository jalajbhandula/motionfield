import { cameraAt, worldOf } from "./sample";
import { nodeCorners, projectPoint, STAGE_MAX_DURATION_S } from "./render-plan";
import { ASPECT_SIZE, type StageCameraNode, type StageNode, type StageScene, type Vec3 } from "./scene";

/**
 * GET /api/stage/:id/inspect - the read-only, agent-facing scene report.
 * `view` picks the report: "meta" (scene meta + env + counts), "tree"
 * (the full world-transform dump), "shots" (the render camera's path
 * broken into segments), "physics" (per-node extents/volume/animation
 * state at t), "problems" (a health-check list). Node transforms come
 * from the SAME worldOf() the viewport draws (camera nodes keep the
 * un-flipped trajectory-frame quaternion - the view flip lives on the
 * gizmo inner, not the node), so a caller's math matches the canvas
 * pixel-for-pixel.
 */

export const INSPECT_VIEWS = ["meta", "tree", "shots", "physics", "problems"] as const;
export type InspectView = (typeof INSPECT_VIEWS)[number];

/** rough per-kind half-extent so `bounds` frames content, not just origins */
function halfExtent(n: StageNode, scale: Vec3): Vec3 {
  if (n.kind === "primitive") {
    return [n.props.size[0] * scale[0] / 2, n.props.size[1] * scale[1] / 2, n.props.size[2] * scale[2] / 2];
  }
  if (n.kind === "mannequin") {
    const h = n.props.height * scale[1];
    return [0.3 * h, h / 2, 0.3 * h];
  }
  return [scale[0] / 2, scale[1] / 2, scale[2] / 2]; // gizmo-ish footprint
}

/** approximate volume in m³ - honest estimate per shape, not a simulation */
function approxVolume(n: StageNode, scale: Vec3): number | null {
  if (n.kind === "primitive") {
    const [sx, sy, sz] = n.props.size;
    const [ax, ay, az] = [Math.abs(sx * scale[0]), Math.abs(sy * scale[1]), Math.abs(sz * scale[2])];
    switch (n.props.shape) {
      case "sphere": return (4 / 3) * Math.PI * (ax / 2) * (ay / 2) * (az / 2);
      case "cylinder":
      case "capsule": return Math.PI * (ax / 2) * (az / 2) * ay;
      case "pyramid": return (ax * ay * az) / 3;
      case "plane": return 0;
      default: return ax * ay * az; // box
    }
  }
  if (n.kind === "mannequin") {
    const h = n.props.height * scale[1];
    return h * (0.3 * h) * (0.3 * h); // stylised ~ 0.3h × 0.3h torso box
  }
  return null; // lights/cameras/models - no meaningful volume claim
}

function treeView(scene: StageScene, t: number) {
  const nodes = scene.nodes.map((n) => {
    const w = worldOf(scene, n.id, t);
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      parent: n.parent ?? null,
      pos: w?.pos ?? ([0, 0, 0] as Vec3),
      quat: w?.quat ?? ([0, 0, 0, 1] as [number, number, number, number]),
      scale: w?.scale ?? ([1, 1, 1] as Vec3),
    };
  });

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodes.length; i++) {
    const he = halfExtent(scene.nodes[i], nodes[i].scale);
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], nodes[i].pos[c] - he[c]);
      max[c] = Math.max(max[c], nodes[i].pos[c] + he[c]);
    }
  }
  const bounds = nodes.length
    ? { min, max }
    : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };

  return {
    view: "tree" as const,
    t,
    meta: scene.meta,
    camera: cameraAt(scene, t),
    nodes,
    bounds,
  };
}

function metaView(scene: StageScene, t: number) {
  const counts: Record<string, number> = {};
  for (const n of scene.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  return {
    view: "meta" as const,
    t,
    meta: scene.meta,
    env: scene.env,
    nodeCount: scene.nodes.length,
    counts,
  };
}

function shotsView(scene: StageScene, t: number) {
  const dur = scene.meta.duration;
  type Shot = {
    index: number; kind: "static" | "path-segment";
    start: number; end: number;
    from: Vec3 | null; to: Vec3 | null; fov: number | null; focalMm: number | null;
  };
  /** shot segments for one camera - its path's time grid is the shot grid,
   *  with a leading/trailing hold outside the covered range ("static") */
  const segments = (cam: StageCameraNode): Shot[] => {
    const shots: Shot[] = [];
    const push = (kind: Shot["kind"], start: number, end: number) => {
      const a = cameraAt(scene, start, cam.id);
      const b = cameraAt(scene, end, cam.id);
      shots.push({
        index: shots.length, kind, start, end,
        from: a?.pos ?? null, to: b?.pos ?? null,
        fov: a?.fov ?? null, focalMm: a?.focalMm ?? null,
      });
    };
    const path = cam.props.path;
    if (path && path.points.length >= 2 && path.times.length >= 2) {
      const times = [...path.times].sort((a, b) => a - b);
      if (times[0] > 0) push("static", 0, times[0]);
      for (let i = 0; i < times.length - 1; i++) push("path-segment", times[i], times[i + 1]);
      const last = times[times.length - 1];
      if (last < dur) push("static", last, dur);
    } else {
      push("static", 0, dur);
    }
    return shots;
  };

  // every camera gets a report - the render camera first - so an agent can
  // see the blocking helpers and what each one covers, not just the shot
  const cams = scene.nodes.filter((n): n is StageCameraNode => n.kind === "camera")
    .sort((a, b) => Number(b.props.isRender ?? false) - Number(a.props.isRender ?? false));
  const cameras = cams.map((cam) => {
    const pose = cameraAt(scene, t, cam.id);
    return {
      id: cam.id,
      name: cam.name,
      isRender: cam.props.isRender === true,
      lookAt: cam.props.lookAt ?? null,
      pos: pose?.pos ?? null,
      fov: pose?.fov ?? null,
      focalMm: pose?.focalMm ?? null,
      shots: segments(cam),
    };
  });
  const shots = cameras.find((c) => c.isRender)?.shots ?? [];
  return { view: "shots" as const, t, duration: dur, shots, cameras };
}

function physicsView(scene: StageScene, t: number) {
  return {
    view: "physics" as const,
    t,
    // the scene has no real engine - this is the derived kinematic state an
    // agent needs (world pos, half-extent, volume, animation, groundedness)
    // at time t. `grounded` reports the bottom of the node's box against the
    // y=0 floor in metres - negative is under, positive is airborne.
    bodies: scene.nodes.map((n) => {
      const w = worldOf(scene, n.id, t);
      const scale = w?.scale ?? ([1, 1, 1] as Vec3);
      const he = halfExtent(n, scale);
      const corners = nodeCorners(scene, n, t);
      const bottom = corners.length ? Math.min(...corners.map((c) => c[1])) : (w?.pos[1] ?? 0) - he[1];
      return {
        id: n.id,
        kind: n.kind,
        parent: n.parent ?? null,
        animated: (n.keys?.length ?? 0) > 0,
        pos: w?.pos ?? ([0, 0, 0] as Vec3),
        halfExtent: he,
        volumeM3: approxVolume(n, scale),
        groundedM: Math.round(bottom * 100) / 100,
      };
    }),
  };
}

function problemsView(scene: StageScene, t: number) {
  const problems: { code: string; message: string; node?: string }[] = [];
  if (!scene.nodes.length) {
    problems.push({ code: "empty-scene", message: "scene has no nodes - nothing will render" });
  }
  const lit = scene.env.ambient > 0 || scene.env.sun.intensity > 0
    || scene.nodes.some((n) => n.kind === "light" && (n.props.intensity ?? 0) > 0);
  if (!lit && scene.nodes.length) {
    problems.push({ code: "unlit-scene", message: "ambient and sun are 0 and no light nodes - the render comes out black" });
  }
  for (const n of scene.nodes) {
    for (const k of n.keys ?? []) {
      if (k.t > scene.meta.duration) {
        problems.push({
          code: "key-past-duration",
          message: `"${n.id}" has a key at ${k.t}s - the scene ends at ${scene.meta.duration}s and it never plays`,
          node: n.id,
        });
      }
    }
    const w = worldOf(scene, n.id, t);
    const s = w?.scale ?? [1, 1, 1];
    if (s.some((v) => v === 0)) {
      problems.push({ code: "zero-scale", message: `"${n.id}" has a zero scale axis at t=${t} - invisible`, node: n.id });
    }
  }
  const cam = scene.nodes.find(
    (n): n is StageCameraNode => n.kind === "camera" && n.props.isRender);
  if (!cam) {
    problems.push({ code: "no-render-camera", message: "no camera is marked isRender - a render has nothing to shoot through" });
  }
  if (scene.meta.duration > STAGE_MAX_DURATION_S) {
    problems.push({
      code: "duration-over-render-cap",
      message: `scene is ${scene.meta.duration}s - the local renderer tops out at ${STAGE_MAX_DURATION_S}s (${STAGE_MAX_DURATION_S * 16} frames); the tail past the cap won't render`,
    });
  }
  // groundedness + render-frustum coverage for content nodes at t
  if (cam) {
    const pose = cameraAt(scene, t, cam.id);
    const { w: fw, h: fh } = ASPECT_SIZE[scene.meta.aspect];
    for (const n of scene.nodes) {
      if (n.kind === "light" || n.kind === "camera") continue;
      const corners = nodeCorners(scene, n, t);
      if (!corners.length) continue;
      const bottom = Math.min(...corners.map((c) => c[1]));
      const animated = (n.keys?.length ?? 0) > 0;
      if (bottom < -0.05) {
        problems.push({ code: "below-ground", message: `"${n.id}" is ${bottom.toFixed(2)}m under the floor at t=${t}s`, node: n.id });
      } else if (bottom > 0.05 && !animated) {
        problems.push({ code: "floating", message: `"${n.id}" floats ${bottom.toFixed(2)}m above the floor at t=${t}s and has no keys - it will hang there`, node: n.id });
      }
      if (pose) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of corners) {
          const p = projectPoint(pose, fw, fh, c);
          if (!p) continue; // behind the camera - no projection at all
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        // in front but fully off-screen is still outside the frustum -
        // projected points can sit anywhere, not just inside [0,w]×[0,h]
        const offscreen = Number.isFinite(minX)
          && (maxX < 0 || minX > fw || maxY < 0 || minY > fh);
        if (!Number.isFinite(minX) || offscreen) {
          problems.push({ code: "outside-frustum", message: `"${n.id}" is outside the render camera's frame at t=${t}s - it never reaches the shot`, node: n.id });
        } else {
          // framing health - a subject that reads as a speck or sits on the
          // frame edge won't carry the AI shot (figures + user models only;
          // set dressing can live anywhere in frame)
          if (n.kind === "mannequin" || n.kind === "model") {
            const hRatio = (maxY - minY) / fh;
            if (hRatio < 0.3) {
              problems.push({
                code: "subject-underframed",
                message: `"${n.id}" fills ${(hRatio * 100).toFixed(0)}% of frame height at t=${t}s (<30%) - the subject won't carry the shot`,
                node: n.id,
              });
            }
            const cx = (minX + maxX) / 2 / fw, cy = (minY + maxY) / 2 / fh;
            if (cx < 0.2 || cx > 0.8 || cy < 0.2 || cy > 0.8) {
              problems.push({
                code: "subject-off-center",
                message: `"${n.id}" centres at (${(cx * 100).toFixed(0)}%, ${(cy * 100).toFixed(0)}%) - outside the middle 60% of the frame at t=${t}s`,
                node: n.id,
              });
            }
          }
        }
      }
    }
  }
  if (cam?.props.path) {
    const times = [...cam.props.path.times].sort((a, b) => a - b);
    if (times.length >= 2 && times[0] > 0)
      problems.push({ code: "path-head-hold", message: `camera path starts at ${times[0]}s - the first ${times[0]}s hold the start pose`, node: cam.id });
    const last = times[times.length - 1];
    if (times.length >= 2 && last < scene.meta.duration)
      problems.push({ code: "path-tail-hold", message: `camera path ends at ${last}s - the last ${(scene.meta.duration - last).toFixed(2)}s hold the end pose`, node: cam.id });
    const raw = cam.props.path.times;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] < raw[i - 1]) {
        problems.push({ code: "path-times-unsorted", message: `camera path times are not sorted (${raw[i - 1]}s then ${raw[i]}s)`, node: cam.id });
        break;
      }
    }
  }
  // identical world origins at t - two bodies stacked exactly read as a bug
  // (flat planes exempt: a ground plane's origin coincides with whatever
  // stands on it by design)
  const atPos = new Map<string, string>();
  for (const n of scene.nodes) {
    if (n.kind === "light" || n.kind === "camera") continue;
    if (n.kind === "primitive" && n.props.shape === "plane") continue;
    const w = worldOf(scene, n.id, t);
    const key = (w?.pos ?? [0, 0, 0]).map((v) => v.toFixed(2)).join(",");
    const prev = atPos.get(key);
    if (prev) problems.push({ code: "overlapping-origin", message: `"${n.id}" and "${prev}" sit at the same position (${key})`, node: n.id });
    else atPos.set(key, n.id);
  }
  return { view: "problems" as const, t, problems };
}

export function inspectScene(scene: StageScene, t: number, view: InspectView = "tree") {
  switch (view) {
    case "meta": return metaView(scene, t);
    case "shots": return shotsView(scene, t);
    case "physics": return physicsView(scene, t);
    case "problems": return problemsView(scene, t);
    default: return treeView(scene, t);
  }
}
