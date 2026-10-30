import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WS4 license fix: no workflow may reference the comfyui_controlnet_aux pack -
 * its dwpose preprocessor module carries a non-commercial CMU license header.
 * Pose/depth now come from OF_DWPose (motionfield_nodes) and the native DA3 nodes.
 */

const WF_DIR = resolve(__dirname, "../../workflows");

// class_type names shipped by the comfyui_controlnet_aux pack.
const AUX_CLASS_TYPES = new Set([
  "AIO_Preprocessor",
  "AnimalPosePreprocessor",
  "AnimeFace_SemSegPreprocessor",
  "AnimeLineArtPreprocessor",
  "AnyLineArtPreprocessor_aux",
  "BAE-NormalMapPreprocessor",
  "BinaryPreprocessor",
  "CannyEdgePreprocessor",
  "ColorPreprocessor",
  "DSINE-NormalMapPreprocessor",
  "DWPreprocessor",
  "DensePosePreprocessor",
  "DepthAnythingPreprocessor",
  "DepthAnythingV2Preprocessor",
  "DiffusionEdge_Preprocessor",
  "FakeScribblePreprocessor",
  "HEDPreprocessor",
  "HintImageEnchance",
  "ImageGenResolutionFromImage",
  "ImageGenResolutionFromLatent",
  "ImageIntensityDetector",
  "ImageLuminanceDetector",
  "InpaintPreprocessor",
  "LeReS-DepthMapPreprocessor",
  "LineArtPreprocessor",
  "LineartAnimePreprocessor",
  "LineartStandardPreprocessor",
  "M-LSDPreprocessor",
  "Manga2Anime_LineArt_Preprocessor",
  "MediaPipe-FaceMeshPreprocessor",
  "MeshGraphormer-DepthMapPreprocessor",
  "Metric3D-DepthMapPreprocessor",
  "Metric3D-NormalMapPreprocessor",
  "Metric_DepthAnythingPreprocessor",
  "MiDaS-DepthMapPreprocessor",
  "OneFormer-ADE20K-SemSegPreprocessor",
  "OneFormer-COCO-SemSegPreprocessor",
  "OpenposePreprocessor",
  "PiDiNetPreprocessor",
  "PixelPerfectResolution",
  "PyraCannyPreprocessor",
  "SAMPreprocessor",
  "SavePoseKpsAsJson",
  "ScribblePreprocessor",
  "Scribble_PiDiNet_Preprocessor",
  "Scribble_XDoG_Preprocessor",
  "SemSegPreprocessor",
  "ShufflePreprocessor",
  "TEEDPreprocessor",
  "TilePreprocessor",
  "UniFormer-SemSegPreprocessor",
  "Unimatch_OptFlowPreprocessor",
  "Zoe-DepthMapPreprocessor",
  "ZoeDepthPreprocessor",
]);

// *Preprocessor class types not shipped by comfyui_controlnet_aux, if a future
// workflow legitimately needs one.
const ALLOWED_PREPROCESSORS = new Set<string>([]);

const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".json"));

describe("ws4: workflows carry no comfyui_controlnet_aux references", () => {
  it("found workflow files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} has no controlnet_aux class_type`, () => {
      const raw = readFileSync(join(WF_DIR, file), "utf8");
      expect(raw.toLowerCase()).not.toContain("controlnet_aux");
      const wf = JSON.parse(raw) as Record<string, { class_type?: string }>;
      for (const [id, node] of Object.entries(wf)) {
        if (id === "_meta" || !node || typeof node !== "object") continue;
        const ct = node.class_type;
        if (!ct) continue;
        expect(AUX_CLASS_TYPES.has(ct), `node ${id}: ${ct} is a comfyui_controlnet_aux class`).toBe(false);
        if (ct.endsWith("Preprocessor")) {
          expect(
            ALLOWED_PREPROCESSORS.has(ct),
            `node ${id}: ${ct} looks like a preprocessor node - confirm its pack's license before use`,
          ).toBe(true);
        }
      }
    });
  }
});
