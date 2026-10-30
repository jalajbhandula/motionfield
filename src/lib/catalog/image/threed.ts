import type { ModelDef } from "../types";
import { seed, inputImage } from "./params";

/** TRELLIS.2 (Microsoft, MIT) + MoGe-2 (MIT) image-to-3D - native ComfyUI
 *  0.41 3D node stack, no custom packs. Two modes on one model card:
 *  the quality path (TRELLIS.2 full diffusion pipeline, textured GLB) and
 *  the draft scan (MoGe-2 monocular point-mesh, seconds not minutes). */
export const THREED_MODELS: ModelDef[] = [{
  id: "image-to-3d",
  label: "Image to 3D",
  vendor: "Microsoft TRELLIS.2 / MoGe",
  kind: "threed",
  description: "Turn a single image into a textured GLB you can drop into a 3D Scene, a game, or a render. TRELLIS.2 builds the shape and PBR texture; MoGe scan is the fast draft. Background removal runs on MIT-licensed BiRefNet.",
  tags: ["3d", "glb", "heavy"],
  workflows: [
    {
      id: "textured-mesh", label: "Textured mesh (TRELLIS.2)", endpointId: "motionfield/trellis2/image-to-3d", kind: "threed",
      params: [inputImage(), seed,
        { name: "upres", label: "Detail", type: "select", default: 1536, enum: [1024, 1536, 2048],
          description: "voxel resolution of the upsampled shape - 1536 is the official template default; 2048 needs more VRAM" },
        { name: "faces", label: "Face budget", type: "select", default: 700000, enum: [100000, 300000, 700000, 1500000],
          description: "decimation target - 700k is the official template default" }],
      cost: () => 2,
      providers: { comfy: { workflow: "trellis2-image-to-3d.json",
        map: (p) => {
          const s = Number(p.seed) || Math.floor(Math.random() * 1e9);
          return { SEED: String(s), SEED_SHAPE: String(s + 1), SEED_UP: String(s + 2), SEED_TEX: String(s + 3),
                   UPRES: String(p.upres ?? 1536), FACES: String(p.faces ?? 700000) };
        } } },
      heavy: "TRELLIS.2 4B + two VAEs + DINOv3-NAF (~8 GB weights) - needs a CUDA GPU; minutes per mesh, not seconds.",
    },
    {
      id: "geometry-scan", label: "Geometry scan (MoGe-2, fast)", endpointId: "motionfield/moge/geometry-scan", kind: "threed",
      params: [inputImage(),
        { name: "resolution_level", label: "Detail", type: "select", default: 9, enum: [3, 6, 9],
          description: "MoGe point-cloud density - 9 is the official template default" },
        { name: "decimation", label: "Vertex stride", type: "select", default: 1, enum: [1, 2, 4],
          description: "1 keeps every reconstructed vertex" }],
      cost: () => 0.5,
      providers: { comfy: { workflow: "moge-perspective-mesh.json",
        map: (p) => ({ RESOLUTION_LEVEL: String(p.resolution_level ?? 9), DECIMATION: String(p.decimation ?? 1) }) } },
      heavy: "MoGe-2 ViT-L (~700 MB) - still wants a GPU for a clean point map.",
    },
  ],
}];
