/**
 * License metadata checks:
 *  - licenses.generated.ts is up to date (regenerating in-memory must match)
 *  - every weight filename in every workflow has a WEIGHT_LICENSES entry
 *  - every catalog endpoint carries license info; ltx-backed → restricted,
 *    zimage/wan/vace-backed → open
 *  - explainer license resolves by params.motion_model
 *  - graph overrides can't sneak in banned classes / unlisted weights
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { WORKFLOW_LICENSES, ENDPOINT_GRAPHS, KNOWN_NODE_CLASSES } from "@/lib/catalog/licenses.generated";
import {
  WEIGHT_LICENSES, CLASS_COMPONENTS, RECIPE_LICENSES, KNOWN_NODES, PACK_LICENSES,
  explainerLicense, graphLicense, worstClass, endpointLicenseFor, mergeComponents,
  licenseClassForSpdx, RESTRICTED_WEIGHT_PATTERNS,
} from "@/lib/catalog/licenses";
import { endpointLicense, unremapGraph, RestrictedLicenseError } from "@/lib/catalog/license-gate";
import { ALL_MODELS, findEndpoint, MOTION_RENDER_ENDPOINT } from "@/lib/catalog/video-models";
import { buildWorkflowLicenses, knownNodeClasses } from "../../scripts/gen-licenses";
import { LICENSE_CLASS_ORDER } from "@/lib/catalog/types";
import type { LicenseClass, WorkflowDef } from "@/lib/catalog/types";

const WF_DIR = path.join(process.cwd(), "workflows");
const WEIGHT_EXT = /\.(safetensors|sft|pth|pt2|pkl|onnx|bin|ckpt|gguf|pt)$/i;

type GraphNode = { class_type?: unknown; inputs?: unknown };
const stubWorkflow = (providers: WorkflowDef["providers"]): WorkflowDef =>
  ({ id: "x", label: "X", endpointId: "motionfield/x/stub", kind: "video", params: [], cost: () => 0, providers });

describe("ws3 licenses", () => {
  it("licenses.generated.ts is up to date", async () => {
    const rebuilt = await buildWorkflowLicenses();
    expect(rebuilt).toEqual(WORKFLOW_LICENSES);
  });

  it("every weight filename in every workflow has a table entry", async () => {
    const missing: string[] = [];
    for (const file of (await fs.readdir(WF_DIR)).filter((f) => f.endsWith(".json"))) {
      const g = JSON.parse(await fs.readFile(path.join(WF_DIR, file), "utf8")) as Record<string, GraphNode>;
      for (const [id, node] of Object.entries(g)) {
        if (id === "_meta") continue;
        for (const v of Object.values((node.inputs ?? {}) as Record<string, unknown>))
          if (typeof v === "string" && WEIGHT_EXT.test(v) && !WEIGHT_LICENSES[v])
            missing.push(`${file}:${id}:${v}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every catalog endpoint carries license info", () => {
    const bare = ALL_MODELS.flatMap((m) => m.workflows)
      .filter((w) => !w.license).map((w) => w.endpointId);
    expect(bare).toEqual([]);
  });

  it("ltx-backed endpoints are restricted", () => {
    const restricted = [
      "motionfield/ltx-video/text-to-video",
      "motionfield/ltx-video/image-to-video",
      "motionfield/ltx-video/vfx-keyframe",
      "motionfield/lens/standard/image-to-video",
      "motionfield/musetalk/talking-portrait-ltx",
      "motionfield/musetalk/portrait-says-ltx",
    ];
    for (const id of restricted)
      expect(findEndpoint(id)?.workflow.license?.class, id).toBe("restricted");
  });

  it("the director is open on Wan VACE by default; its ltx backend is the restricted variant", () => {
    const wf = findEndpoint("motionfield/director/generate")?.workflow;
    expect(wf?.license?.class).toBe("open");
    // the backend select carries per-value licenses - the badge shows ltx
    // restricted before a submission is even made
    const v = wf?.licenseVariants;
    expect(v?.param).toBe("backend");
    expect(v?.byValue["wan-vace"]?.class).toBe("open");
    expect(v?.byValue["ltx"]?.class).toBe("restricted");
  });

  it("z-image / wan / vace endpoints are open", () => {
    const open = [
      "motionfield/z-image-turbo/text-to-image",
      "motionfield/z-image-turbo/img2img",
      "motionfield/wan-2.1/text-to-video",
      "motionfield/wan-2.1/image-to-video",
      "motionfield/wan-2.2/image-to-video",
      "motionfield/wan-vace/image-to-video",
      "motionfield/wan-vace/motion-transfer",
      "motionfield/wan-vace/object-swap",
      "motionfield/wan-vace/character-swap",
      "motionfield/wan-vace/restyle",
      "motionfield/reframe/v1.0",
      "motionfield/draw-to-video/v1.0",
      "motionfield/character/generate",
      "motionfield/wan-animate/character-swap",
      "motionfield/wan-s2v/talking-portrait",
    ];
    for (const id of open)
      expect(findEndpoint(id)?.workflow.license?.class, id).toBe("open");
  });

  it("motion-render is registered and open", () => {
    const wf = findEndpoint(MOTION_RENDER_ENDPOINT)?.workflow;
    expect(wf?.providers.recipe?.name).toBe("motion-render");
    expect(wf?.license?.class).toBe("open");
    expect(RECIPE_LICENSES["motion-render"].class).toBe("open");
    expect(RECIPE_LICENSES["motion-render"].components.map((c) => c.name)).toEqual(
      expect.arrayContaining([expect.stringContaining("three.js"), expect.stringContaining("ffmpeg")]),
    );
  });

  it("re-edit-assemble recipe resolves the merged VACE flow licenses (ws4's ReCut endpoint)", () => {
    // the assemble stage ends in an ffmpeg stitch - the recipe carries it too
    const ffmpeg = RECIPE_LICENSES["motion-render"].components.find((c) => c.name === "ffmpeg")!;
    const merged = mergeComponents([
      // character-swap windows ride the person-swap person pipeline (masked
      // matte pass + the BiRefNet ref cut-out) - not the full-frame graph
      WORKFLOW_LICENSES["person-swap-person.json"].components,
      WORKFLOW_LICENSES["person-swap-refcut.json"].components,
      WORKFLOW_LICENSES["vace-motion-transfer.json"].components,
      WORKFLOW_LICENSES["vace-restyle.json"].components,
      [ffmpeg],
    ]);
    expect(RECIPE_LICENSES["re-edit-assemble"].class).toBe("open");
    expect(RECIPE_LICENSES["re-edit-assemble"].components).toEqual(merged);
    // a recipe-provider workflow resolves through RECIPE_LICENSES, not a stub
    const wf = stubWorkflow({ recipe: { name: "re-edit-assemble" } });
    const lic = endpointLicense(wf, {});
    expect(lic.class).toBe("open");
    expect(lic.components).toEqual(merged);
  });

  it("ENDPOINT_GRAPHS covers every comfy-backed catalog endpoint", () => {
    for (const m of ALL_MODELS)
      for (const w of m.workflows) {
        if (w.providers.comfy?.workflow)
          expect(ENDPOINT_GRAPHS[w.endpointId], w.endpointId).toBe(w.providers.comfy.workflow);
      }
    expect(Object.keys(ENDPOINT_GRAPHS).length).toBeGreaterThan(0);
  });

  it("known violations are flagged as banned-known components", async () => {
    // the musetalk graphs no longer carry any banned-known part - the
    // patched pack blends through OF_MouthMask (DWPose landmarks); the
    // upstream face segmenter is gone. A stale re-add trips this.
    for (const f of ["lipsync-video.json", "lipsync-talking-portrait.json", "lipsync-talking-portrait-ltx.json", "lipsync-talk.json", "lipsync-talk-ltx.json"])
      expect(WORKFLOW_LICENSES[f].components.filter((c) => c.class === "banned-known"), f).toEqual([]);
    // vace-character-swap has a banned-known part only while its graph still uses a controlnet_aux preprocessor.
    const raw = await fs.readFile(path.join(process.cwd(), "workflows", "vace-character-swap.json"), "utf8");
    const usesAux = /DWPreprocessor|OpenposePreprocessor|controlnet_aux/.test(raw);
    const swap = WORKFLOW_LICENSES["vace-character-swap.json"].components.filter((c) => c.class === "banned-known");
    expect(swap.length > 0).toBe(usesAux);
  });

  it("explainer license follows params.motion_model (via the motion endpoint ids)", () => {
    const lic = (m: string | undefined) => explainerLicense(m === undefined ? {} : { motion_model: m }, WORKFLOW_LICENSES).class;
    expect(lic("ltx")).toBe("restricted");
    expect(lic("wan-vace")).toBe("open");
    expect(lic("wan22-ti2v")).toBe("open");
    expect(lic("still")).toBe("open");
    expect(lic(undefined)).toBe("open");
    expect(lic("bogus-motion")).toBe("restricted"); // unknown motion_model fails closed
    const ltx = explainerLicense({ motion_model: "ltx" }, WORKFLOW_LICENSES);
    expect(ltx.components.some((c) => c.license === "LTX-2.x Community")).toBe(true);
  });

  it("endpointLicenseFor resolves the explainer's params-dependent class", () => {
    const wf = findEndpoint("motionfield/explainer/video")!.workflow;
    expect(endpointLicenseFor(wf).class).toBe("open");
    expect(endpointLicenseFor(wf, { motion_model: "ltx" }).class).toBe("restricted");
  });

  it("graph_json override is scanned - a restricted weight gates an open endpoint", () => {
    const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
    const override = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "ltx-video-2b-v0.9.5.safetensors" } },
    };
    const lic = endpointLicense(wf, {}, override);
    expect(lic.class).toBe("restricted");
    expect(lic.components.some((c) => c.license === "Open RAIL-M")).toBe(true);
  });

  it("graph_json override with an unlisted weight fails closed", () => {
    const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
    const override = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "unlisted-weights.safetensors" } },
    };
    const lic = endpointLicense(wf, {}, override);
    expect(lic.class).toBe("restricted");
    expect(lic.components).toContainEqual({
      name: "unlisted-weights.safetensors", license: "unlisted", url: "", class: "restricted",
    });
  });

  it("graph_json override with an unlisted node class is banned", () => {
    const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
    const lic = endpointLicense(wf, {}, {
      "1": { class_type: "EasyUseSomething", inputs: {} },
    });
    expect(lic.class).toBe("banned");
    expect(lic.components).toContainEqual({
      name: "unlisted node EasyUseSomething", license: "unlisted", url: "", class: "banned",
    });
  });

  it("cam-i2v.json resolves open - its weights are Apache-2.0 and the rig nodes are the in-repo MIT pack", () => {
    expect(WORKFLOW_LICENSES["cam-i2v.json"].class).toBe("open");
    const wf = findEndpoint("motionfield/camera/image-to-video")?.workflow;
    expect(wf?.license?.class).toBe("open");
  });

  it("camera license rows: fun-graph override open, +unlisted banned before upload, workflowFor-ungenerated restricted", () => {
    const wf = findEndpoint("motionfield/camera/image-to-video")!.workflow;
    // the smoke-harness routing stays: rig (default) → cam-i2v.json,
    // fun → cam-i2v-fun.json (the param is refused at the endpoint gate
    // while the fun path is unverified; cam_scale drops silently)
    const pick = wf.providers.comfy!.workflowFor!;
    expect(wf.providers.comfy!.workflow).toBe("cam-i2v.json");
    expect(pick({})).toBeUndefined();
    expect(pick({ camera_path: "rig" })).toBeUndefined();
    expect(pick({ camera_path: "fun" })).toBe("cam-i2v-fun.json");
    expect(WORKFLOW_LICENSES["cam-i2v-fun.json"].class).toBe("open");
    expect(wf.validate?.({ camera_path: "fun" })).toMatch(/not available on this endpoint yet/);
    const scaled: Record<string, unknown> = { cam_scale: 2 };
    expect(wf.validate?.(scaled)).toBeNull();
    expect(scaled.cam_scale).toBeUndefined();

    // (a) a graph_json override running the Fun chain - start frame → poses →
    // Plücker embed → clip vision → camera-conditioned sampler on the Fun DiT
    // - resolves open (all classes known, all weights in the table)
    const funGraph = {
      "6": { class_type: "LoadImage", inputs: { image: "start.png" } },
      "7": { class_type: "OF_Trajectory", inputs: { moves: "arc-left-45", duration: 3, fps: 16 } },
      "17": { class_type: "OF_CameraEmbed", inputs: { poses_json: ["7", 0], width: 480, height: 272 } },
      "18": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip_vision_h.safetensors" } },
      "19": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["18", 0], image: ["6", 0] } },
      "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors" } },
      "20": { class_type: "WanCameraImageToVideo", inputs: { camera_conditions: ["17", 0], clip_vision_output: ["19", 0] } },
      "21": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["20", 0], negative: ["20", 1], latent_image: ["20", 2] } },
    };
    expect(endpointLicense(wf, {}, funGraph).class).toBe("open");

    // (b) the same graph plus one unlisted class resolves banned - the gate
    // throws before any upload (the e2e row in ws3-licenses.spec.ts proves
    // the refusal lands before a job or submit exists)
    const bad = endpointLicense(wf, {}, {
      ...funGraph,
      "99": { class_type: "TotallyUnlistedNode", inputs: {} },
    });
    expect(bad.class).toBe("banned");
    expect(bad.components).toContainEqual({
      name: "unlisted node TotallyUnlistedNode", license: "unlisted", url: "", class: "banned",
    });

    // (c) a workflowFor pick outside licenses.generated fails closed -
    // restricted, "not in licenses.generated", even though the base file is
    const stub = stubWorkflow({ comfy: { workflow: "cam-i2v.json", workflowFor: () => "never-generated.json" } });
    const lic = endpointLicense(stub, { camera_path: "fun" });
    expect(lic.class).toBe("restricted");
    expect(lic.components).toContainEqual({
      name: "never-generated.json: not in licenses.generated",
      license: "unlisted", url: "", class: "restricted",
    });
  });

  it("graph_json override built from the MotionField rig nodes passes the gate", () => {
    // OF_Trajectory/OF_CameraRig are in KNOWN_NODE_CLASSES and map to the
    // in-repo MIT pack - a forked camera graph must not turn "unlisted".
    const wf = findEndpoint("motionfield/camera/image-to-video")!.workflow;
    const lic = endpointLicense(wf, {}, {
      "7": { class_type: "OF_Trajectory", inputs: { moves: "dolly-in" } },
      "11": { class_type: "OF_CameraRig", inputs: { source: ["6", 0], poses_json: ["7", 0] } },
    });
    expect(lic.class).toBe("open");
  });

  it("graph_json override with an unlisted class is refused", () => {
    const wf = findEndpoint("motionfield/camera/image-to-video")!.workflow;
    const lic = endpointLicense(wf, {}, {
      "7": { class_type: "OF_Trajectory", inputs: {} },
      "99": { class_type: "TotallyUnlistedNode", inputs: {} },
    });
    expect(lic.class).toBe("banned");
    expect(lic.components).toContainEqual({
      name: "unlisted node TotallyUnlistedNode", license: "unlisted", url: "", class: "banned",
    });
  });

  it("graph_json override with a malformed node is banned", () => {
    const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
    const lic = endpointLicense(wf, {}, { "7": { notclass: true } });
    expect(lic.class).toBe("banned");
    expect(lic.components).toContainEqual({
      name: "malformed node 7", license: "unlisted", url: "", class: "banned",
    });
  });

  it("red-flag node classes resolve banned - core ComfyUI classes are no exception", () => {
    // these are core classes, but the gate must refuse them outright; opt-in
    // only unlocks "restricted", so "banned" can never run.
    for (const cls of ["Trellis1ImageToModel", "Hunyuan3Dv2Conditioning", "HunyuanVideo15ImageToVideo", "Kandinsky5ImageToVideo"]) {
      const lic = graphLicense({ "1": { class_type: cls, inputs: {} } });
      expect(lic.class, cls).toBe("banned");
      expect(lic.components).toContainEqual({
        name: `red-flag node ${cls}`, license: "unlisted", url: "", class: "banned",
      });
      expect(KNOWN_NODES.has(cls), cls).toBe(false); // left out of the allowed set
    }
  });

  it("a red-flag weight on a known class is banned (banned never unlocks via opt-in)", () => {
    const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
    const lic = endpointLicense(wf, {}, {
      "1": { class_type: "HunyuanVideo15ImageToVideo", inputs: { unet_name: "hunyuan_video_15_i2v.safetensors" } },
    });
    expect(lic.class).toBe("banned");
    expect(lic.components).toContainEqual({
      name: "red-flag weight hunyuan_video_15_i2v.safetensors", license: "unlisted", url: "", class: "banned",
    });
    // a *_name key is scanned even when the value has no weight extension
    const bare = endpointLicense(wf, {}, {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "hunyuan_video_15_i2v" } },
    });
    expect(bare.class).toBe("banned");
    // and a red-flag weight listed in WEIGHT_LICENSES would still be banned -
    // the flag check runs before the table lookup
    const listed = endpointLicense(wf, {}, {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_vace_1.3B_fp16.safetensors" } },
    });
    expect(listed.class).toBe("open");
  });

  it("a node class named 'constructor' can't reach the tables either", () => {
    const lic = graphLicense({ "1": { class_type: "constructor", inputs: {} } });
    expect(lic.class).toBe("banned"); // unlisted node - hasOwn guard, not a prototype hit
  });

  it(".sft weights are scanned like .safetensors", () => {
    const unlisted = graphLicense({
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mystery.sft" } },
    });
    expect(unlisted.class).toBe("restricted"); // fails closed on unlisted
    const flagged = graphLicense({
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "hunyuan_i2v.sft" } },
    });
    expect(flagged.class).toBe("banned"); // red-flag weight pattern still applies
  });

  it("prototype-looking names cannot reach the tables", () => {
    const lic = graphLicense({
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "constructor.safetensors" } },
    });
    expect(lic.class).toBe("restricted"); // unlisted weight, not a prototype hit
  });

  it("COMFY_MODEL_MAP reversal: a remapped weight resolves to its source license", () => {
    const prev = process.env.COMFY_MODEL_MAP;
    process.env.COMFY_MODEL_MAP = JSON.stringify({ "wan2.1_vace_1.3B_fp16.safetensors": "wan2.1_vace_14B_fp8scaled.safetensors" });
    try {
      const wf = findEndpoint("motionfield/z-image-turbo/text-to-image")!.workflow;
      const lic = endpointLicense(wf, {}, {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_vace_14B_fp8scaled.safetensors" } },
      });
      expect(lic.class).toBe("open");
      expect(lic.components.some((c) => c.name === "wan2.1_vace_1.3B_fp16.safetensors")).toBe(true);
      const g = unremapGraph({ "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_vace_14B_fp8scaled.safetensors", keep: "x" } } }) as Record<string, { inputs: Record<string, unknown> }>;
      expect(g["1"].inputs.unet_name).toBe("wan2.1_vace_1.3B_fp16.safetensors");
      expect(g["1"].inputs.keep).toBe("x");
    } finally {
      if (prev === undefined) delete process.env.COMFY_MODEL_MAP; else process.env.COMFY_MODEL_MAP = prev;
    }
  });

  it("comfy graph missing from licenses.generated fails closed", () => {
    const wf = stubWorkflow({ comfy: { workflow: "nobody-regenerated.json" } });
    const lic = endpointLicense(wf, {});
    expect(lic.class).toBe("restricted");
    expect(lic.components).toContainEqual({
      name: "nobody-regenerated.json: not in licenses.generated",
      license: "unlisted", url: "", class: "restricted",
    });
  });

  it("recipe with no resolver and no declared license fails closed", () => {
    const wf = stubWorkflow({ recipe: { name: "future-pipeline" } });
    const lic = endpointLicense(wf, {});
    expect(lic.class).toBe("restricted");
    expect(lic.components[0].name).toBe('motionfield/x/stub: recipe "future-pipeline" has no RECIPE_LICENSES entry');
  });

  it("endpoint with no providers at all fails closed", () => {
    const wf = stubWorkflow({});
    const lic = endpointLicense(wf, {});
    expect(lic.class).toBe("restricted");
  });

  it("graphLicense scans node classes as well as weight inputs", () => {
    const lic = graphLicense({ "1": { class_type: "MuseTalkRun", inputs: {} } });
    expect(lic.components.some((c) => c.name.includes("MuseTalk"))).toBe(true);
    expect(graphLicense({})).toEqual({ class: "open", components: [] });
  });

  it("worstClass ranking: banned > restricted > open; banned-known never promotes", () => {
    const mk = (cls: LicenseClass | "banned-known") => [{ name: "x", license: "L", url: "u", class: cls }];
    expect(worstClass(mk("open"))).toBe("open");
    expect(worstClass(mk("banned-known"))).toBe("open");
    expect(worstClass(mk("restricted"))).toBe("restricted");
    expect(worstClass([...mk("open"), ...mk("banned-known"), ...mk("restricted")])).toBe("restricted");
    expect(worstClass([...mk("restricted"), ...mk("banned")])).toBe("banned");
  });

  it("RestrictedLicenseError carries the right code per class", () => {
    const r = new RestrictedLicenseError("Open RAIL-M");
    expect(r.code).toBe("restricted_license");
    expect(r.body).toEqual({ error: { code: "restricted_license", license: "Open RAIL-M", enable_at: "/settings/licenses" } });
    const b = new RestrictedLicenseError("non-commercial", "banned_license");
    expect(b.code).toBe("banned_license");
    expect(b.body).toEqual({ error: { code: "banned_license", license: "non-commercial" } });
  });

  it("KNOWN_NODE_CLASSES covers every shipped class_type and CLASS_COMPONENTS key", async () => {
    const set = new Set(KNOWN_NODE_CLASSES);
    for (const file of (await fs.readdir(WF_DIR)).filter((f) => f.endsWith(".json"))) {
      const g = JSON.parse(await fs.readFile(path.join(WF_DIR, file), "utf8")) as Record<string, GraphNode>;
      for (const [id, node] of Object.entries(g)) {
        if (id === "_meta") continue;
        expect(set.has(node.class_type as string), `${file}:${id} ${String(node.class_type)}`).toBe(true);
      }
    }
    for (const k of Object.keys(CLASS_COMPONENTS)) expect(set.has(k), k).toBe(true);
    expect(KNOWN_NODES.size).toBe(set.size);
  });

  it("knownNodeClasses skips comfy_api_nodes.* modules, red-flag and denylisted class names", async () => {
    const known = await knownNodeClasses([], {
      PlainCore: { custom: false, python_module: "nodes" },
      FlaggedApi: { custom: false, api_node: true },
      // no api_node flag - the module namespace alone marks it a partner node
      ModuleOnlyApi: { custom: false, python_module: "comfy_api_nodes.nodes_partner" },
      CustomPack: { custom: true, python_module: "custom_nodes.pack" },
      Trellis1ImageToModel: { custom: false, python_module: "nodes" },  // red-flag prefix
      BrandXCoreNode: { custom: false, python_module: "nodes" },        // denylist substring
    }, [/brandx/i]);
    expect(known.has("PlainCore")).toBe(true);
    expect(known.has("FlaggedApi")).toBe(false);
    expect(known.has("ModuleOnlyApi")).toBe(false);
    expect(known.has("CustomPack")).toBe(false);
    expect(known.has("Trellis1ImageToModel")).toBe(false);
    expect(known.has("BrandXCoreNode")).toBe(false);
  });

  it("CLASS_COMPONENTS entries exist for python-side loaders", () => {
    for (const k of ["MuseTalkRun", "KokoroGenerator", "KokoroSpeaker", "ChatterboxTTS", "DWPreprocessor"])
      expect(CLASS_COMPONENTS[k]?.length, k).toBeGreaterThan(0);
  });
});

describe("ws3 s2b - 3D licensing classes", () => {
  const TRELLIS_PACK = PACK_LICENSES.find((p) => p.id === "trellis2");


  it("worstClass ordering: permissive-terms sits between open and restricted", () => {
    const mk = (cls: LicenseClass) => [{ name: "x", license: "L", url: "u", class: cls }];
    expect(worstClass([...mk("open"), ...mk("permissive-terms")])).toBe("permissive-terms");
    expect(worstClass([...mk("permissive-terms"), ...mk("restricted")])).toBe("restricted");
    expect(worstClass([...mk("restricted"), ...mk("banned")])).toBe("banned");
    expect(LICENSE_CLASS_ORDER["permissive-terms"]).toBeGreaterThan(LICENSE_CLASS_ORDER.open);
    expect(LICENSE_CLASS_ORDER["permissive-terms"]).toBeLessThan(LICENSE_CLASS_ORDER.restricted);
  });

  it("licenseClassForSpdx: {class, reason} mapping - open / restricted / permissive-terms / refused", () => {
    for (const [id, want] of [
      ["mit", "open"], ["apache-2.0", "open"], ["bsd-3-clause", "open"],
      ["isc", "open"], ["ofl-1.1", "open"], ["cc0-1.0", "open"],
      ["ltx-community", "restricted"], ["gemma", "restricted"], ["dinov3", "restricted"],
      ["open-rail-m", "restricted"], ["llama3", "restricted"],
      ["cc-by-4.0", "permissive-terms"],
      ["cc-by-nc-4.0", "refused"], ["CC-BY-NC-4.0", "refused"],
      ["cc-by-4.0_nc", "refused"], ["cc_by_nc-sa-4.0", "refused"],
      ["tencent-hunyuan-community", "refused"],   // community suffix can't launder the Hunyuan ban
      ["other", "refused"], ["unknown", "refused"],
      ["unlisted", "refused"], ["gated", "refused"], ["", "refused"], ["weird-license-9x", "refused"],
    ] as const) {
      const got = licenseClassForSpdx(id);
      expect(got.class, id).toBe(want);
      expect(got.reason, id).toBeTruthy();
    }
  });

  it("3D pack classes: DINOv3 / Trellis2 / Pixal3D / TripoSplat resolve restricted, Hunyuan3D banned", () => {
    // class-level: trellis2 + pixal3d + triposplat classes carry restricted components
    for (const cls of ["Trellis2Conditioning", "Trellis2ShapeStage", "Pixal3DConditioning",
      "EmptyTrellis2LatentStructure", "VaeDecodeTextureTrellis", "VaeDecodeShapeTrellis",
      "TripoSplatConditioning", "VAEDecodeTripoSplat"]) {
      const lic = graphLicense({ "1": { class_type: cls, inputs: {} } });
      expect(lic.class, cls).toBe("restricted");
      expect(KNOWN_NODES.has(cls), cls).toBe(true); // gated ≠ banned
    }
    // hunyuan3d / tencent pack: non-commercial - banned outright
    for (const cls of ["Hunyuan3Dv2Conditioning", "EmptyLatentHunyuan3Dv2", "VAEDecodeHunyuan3D", "TencentImageToModelNode"]) {
      const lic = graphLicense({ "1": { class_type: cls, inputs: {} } });
      expect(lic.class, cls).toBe("banned");
      expect(KNOWN_NODES.has(cls), cls).toBe(false);
    }
  });

  it("weight-name patterns catch separator variants (unanchored)", () => {
    for (const f of ["dino_v3_vit_l.safetensors", "dinov3_vitl16.safetensors",
      "trellis_2_int8_convrot.safetensors", "Trellis2-bf16.safetensors",
      "pixal3d.safetensors", "pixal-3d-vae.safetensors",
      "triposplat_v1.safetensors", "TripoSplat-DiT.safetensors"])
      expect(RESTRICTED_WEIGHT_PATTERNS.some((re) => re.test(f)), f).toBe(true);
    // a graph naming an unlisted restricted-pattern weight gets a restricted component
    const lic = graphLicense({ "1": { class_type: "UNETLoader", inputs: { unet_name: "Trellis2-bf16.safetensors" } } });
    expect(lic.class).toBe("restricted");
    expect(lic.components[0].name).toContain("Trellis2-bf16");
    // the named table entry wins for vetted weights - trellis_2_int8_convrot is MIT
    const t2 = graphLicense({ "1": { class_type: "UNETLoader", inputs: { unet_name: "trellis_2_int8_convrot.safetensors" } } });
    expect(t2.class).toBe("open");
    expect(t2.components[0].license).toBe("MIT");
    // the table entry wins - dino_v3_vit_l is a named weight
    const d = graphLicense({ "1": { class_type: "CLIPVisionLoader", inputs: { clip_name: "dino_v3_vit_l.safetensors" } } });
    expect(d.class).toBe("restricted");
    expect(d.components[0].license).toBe("DINOv3");
    // and the pack-level component carries the "Built with DINOv3" notice
    expect(TRELLIS_PACK?.components.some((x) => x.notice?.includes("Built with DINOv3"))).toBe(true);
  });

  it("PACK_LICENSES lists the 3D packs + CMU mocap; trellis2 + triposplat restricted, cmu permissive-terms", () => {
    const ids = PACK_LICENSES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["triposg", "trellis1-image", "unirig", "marigold-v2", "trellis2", "triposplat", "cmu-mocap"]));
    expect(worstClass(PACK_LICENSES.find((p) => p.id === "trellis2")!.components)).toBe("restricted");
    expect(worstClass(PACK_LICENSES.find((p) => p.id === "triposplat")!.components)).toBe("restricted");
    expect(worstClass(PACK_LICENSES.find((p) => p.id === "triposg")!.components)).toBe("open");
    const cmu = PACK_LICENSES.find((p) => p.id === "cmu-mocap")!;
    expect(worstClass(cmu.components)).toBe("permissive-terms");
    expect(cmu.components[0].notice).toBeTruthy();
    expect(cmu.components[0].url).toContain("mocap.cs.cmu.edu");
  });
});
