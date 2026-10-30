/**
 * Stage-render GPU smoke — call stageRenderRecipe directly (no API):
 *
 *   gpu-run lane-stage -- env GENERATION_PROVIDER=comfy \
 *     npx tsx scripts/render/stage-smoke.ts --base http://localhost:3205 \
 *       [--control depth|pose] [--duration 3] [--steps 30] [--seed 7]
 *
 * Needs a dev server already running at --base pointed at the live ComfyUI
 * (the recipe drives /render/stage headlessly and submits window graphs to
 * GENERATION_PROVIDER). Seeds a throwaway user + stage_scenes row +
 * create-revision row + jobs row in the local db, then runs the recipe.
 *
 * The seeded scene is the lane's evidence shot: a walking mannequin keyed
 * across the stage, a prop totem to walk past, and a dolly-in baked onto
 * the render camera via applyMoveToCamera — the same code path the editor
 * and the apply_move op take. Output lands in public/files/generated/.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// own PGlite (like person-swap-smoke) so a running dev server can't fight the handle
process.env.PGLITE_DIR ??= "/tmp/of-stage-smoke";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = arg("base") || `http://localhost:${process.env.PORT || "3150"}`;
  const control = arg("control") || "depth";
  const duration = Number(arg("duration") || "3");
  const steps = Number(arg("steps") || "0");
  const seed = Number(arg("seed") || "7");
  const move = arg("move") || "dolly-in";

  execFileSync("node", ["--experimental-strip-types", "scripts/migrate.ts"], { stdio: "pipe" });
  // import through jobs first (same as person-swap-smoke): the recipe graph
  // initializes via jobs → generation → recipes in order, so stage-render
  // is never the head of the index↔recipe import cycle
  await import("../../src/lib/jobs");
  const { getDb, schema } = await import("../../src/db/index");
  const { emptyScene, makeNode } = await import("../../src/lib/stage/scene");
  const { insertCreateRevision } = await import("../../src/lib/stage/revisions");
  const { applyMoveToCamera } = await import("../../src/lib/stage/moves");
  const { stageRenderRecipe } = await import("../../src/lib/generation/recipes/stage-render");

  const db = await getDb();
  const uid = `smoke-sr-${Date.now()}`;
  await db.insert(schema.user).values({ id: uid, name: "smoke", email: `${uid}@test.local` });

  const scene = emptyScene({ title: "Stage lane smoke — walker dolly-in", duration: Math.max(3.5, duration + 0.5) });

  // the walker — walk pose, keyed to stride across the stage over the shot
  scene.nodes.push(makeNode("mannequin", {
    id: "walker", name: "Walker",
    prompt: "a courier in a dark jacket, mid-stride",
    transform: { pos: [-1.6, 0, 0], rot: [0, 90, 0], scale: [1, 1, 1] },
    props: { pose: "walk", height: 1.75 },
  }));
  scene.nodes[scene.nodes.length - 1].keys = [
    { t: 0, path: "transform.pos", value: [-1.6, 0, 0] },
    { t: duration, path: "transform.pos", value: [1.6, 0, 0] },
  ];

  // the prop — a low crate the walker passes in FRONT of (z gap keeps the
  // stride clear of its bbox; it still reads as a pass-by in the parallax)
  scene.nodes.push(makeNode("primitive", {
    id: "crate", name: "Crate", prompt: "a weathered wooden crate",
    transform: { pos: [0.9, 0.45, -1.6], rot: [0, 20, 0], scale: [1, 1, 1] },
    props: { shape: "box", size: [0.9, 0.9, 0.9], color: "#7a6248" },
  }));

  // bbox sanity — no prop's box may contain any point of the walker's
  // straight-line stride (sampled at eighths; the mannequin's ~0.3 m radius
  // counts as clearance too; flat planes are the floor it walks ON)
  for (const n of scene.nodes) {
    if (n.kind !== "primitive" || n.props.shape === "plane") continue;
    const [sx, , sz] = n.props.size;
    for (let i = 0; i <= 8; i++) {
      const wx = -1.6 + (3.2 * i) / 8;
      if (Math.abs(wx - n.transform.pos[0]) < sx / 2 + 0.3
        && Math.abs(0 - n.transform.pos[2]) < sz / 2 + 0.3) {
        throw new Error(`walker path intersects "${n.id}" near x=${wx.toFixed(2)}`);
      }
    }
  }

  // dolly-in on the render camera — identical to POST …/ops {op:"apply_move"}
  const cam = scene.nodes.find(
    (n): n is import("../../src/lib/stage/scene").StageCameraNode =>
      n.kind === "camera" && n.props.isRender);
  if (cam) {
    cam.transform.pos = [0, 1.5, 5.5];
    cam.transform.rot = [-6, 0, 0];
    cam.props.lookAt = "walker";
    applyMoveToCamera(scene, cam.id, move, { strength: 1, durationS: duration });
  }

  const [row] = await db.insert(schema.stageScenes)
    .values({ userId: uid, title: scene.meta.title, scene, refs: [], refsRead: false })
    .returning({ id: schema.stageScenes.id, revision: schema.stageScenes.revision });
  await insertCreateRevision(row.id, uid, scene);
  console.log(`seeded scene ${row.id} rev ${row.revision} (${scene.nodes.length} nodes)`);

  const jobId = crypto.randomUUID();
  await db.insert(schema.jobs).values({
    id: jobId, userId: uid, kind: "video", modelId: "stage-render",
    endpointId: "motionfield/stage/render", workflow: "render", provider: "recipe",
  });

  const ac = new AbortController();
  // slot budget guard — a gpu-run slot is ~20 min and jobs must finish inside
  // it. The window phase reports its own % (s contains "window"); once enough
  // samples exist, project the finish time from the measured rate and abort
  // early (plus a best-effort ComfyUI interrupt) rather than burn the slot.
  const WIN_BUDGET_MS = Number(arg("budget_min") || "17") * 60_000;
  const winSamples: [number, number][] = [];
  let winStart = 0, aborted = false;
  const interrupt = async () => {
    for (const url of [`${process.env.COMFY_BASE_URL}/interrupt`, "http://127.0.0.1:8188/interrupt"]) {
      try { await fetch(url, { method: "POST", signal: AbortSignal.timeout(3000) }); } catch { /* best effort */ }
    }
  };
  const comfyUp = async () => {
    try {
      const r = await fetch("http://127.0.0.1:8188/queue", { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  };
  // orphan lane jobs bypass gpu-run and crash ComfyUI under memory pressure —
  // before resubmitting, wait for the backend to be reachable AND idle so the
  // retry doesn't collide with the interloper that just killed the attempt.
  const comfyIdle = async () => {
    try {
      const r = await fetch("http://127.0.0.1:8188/queue", { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return false;
      const q = (await r.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
      return (q.queue_running?.length ?? 1) === 0 && (q.queue_pending?.length ?? 1) === 0;
    } catch { return false; }
  };
  const attempt = () =>
    stageRenderRecipe(
      {
        jobId,
        model: {} as never,
        workflow: {} as never,
        params: {
          scene_id: row.id, revision: row.revision, start_s: 0,
          duration_s: duration, control, seed,
          ...(steps > 0 ? { steps } : {}),
          prompt:
            "a lone courier crossing a concrete rooftop at dusk, cinematic overcast light",
        },
        appBaseUrl: base,
      },
      {
        signal: ac.signal,
        progress: (p, s) => {
          process.stdout.write(`\r${p}% ${s ?? ""}   `);
          if (!s?.includes("window") || aborted) return;
          const now = Date.now();
          if (!winStart) winStart = now;
          winSamples.push([p, now]);
          if (winSamples.length > 8) winSamples.shift();
          const [p0, t0] = winSamples[0];
          const rate = (p - p0) / (now - t0); // window-% per ms
          if (winSamples.length >= 4 && rate > 0 && now - t0 > 20_000) {
            const eta = now + (100 - p) / rate;
            if (eta - winStart > WIN_BUDGET_MS) {
              aborted = true;
              console.error(`\nABORT: window eta ${((eta - winStart) / 60000).toFixed(1)}min exceeds ${WIN_BUDGET_MS / 60000}min slot budget — killing job instead of burning the slot`);
              void interrupt();
              ac.abort();
            }
          }
        },
      },
    );
  // retries inside the slot: external ComfyUI restarts (orphan lane jobs +
  // proxy restarts) drop in-flight prompts — wait for the server to be idle,
  // then resubmit rather than burn the whole slot.
  let items;
  const MAX_TRIES = 3;
  for (let t = 1; ; t++) {
    try {
      items = await attempt();
      break;
    } catch (e) {
      if (aborted || t >= MAX_TRIES) throw e;
      console.error(`\nattempt ${t} failed (${(e as Error).message}) — waiting for ComfyUI idle, retrying`);
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !(await comfyIdle())) await new Promise((r) => setTimeout(r, 4000));
      if (!(await comfyUp())) throw e;
      winSamples.length = 0; winStart = 0;
    }
  }
  console.log("\nitems:", JSON.stringify(items));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
