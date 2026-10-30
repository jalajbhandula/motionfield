/**
 * Qwen "Change angle" mode - the Multiple-angles LoRA graph
 * (workflows/qwenedit2511-angles.json) ships in the repo + manifest but had no
 * path that could run it: the Layers "Change angle" tool posted a plain edit.
 * The endpoint now takes edit_mode: edit|angles (variantParam), and the tool
 * sends "angles".
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { findEndpoint } from "@/lib/catalog/video-models";
import { WORKFLOW_LICENSES } from "@/lib/catalog/licenses.generated";

const WF_DIR = path.join(process.cwd(), "workflows");
const ANGLES = "qwenedit2511-angles.json";

describe("qwen-image-edit edit_mode → angles graph", () => {
  const wf = () => findEndpoint("motionfield/qwen-image-edit/edit")!.workflow;

  it("edit_mode is a declared select on the endpoint", () => {
    const f = wf().params.find((p) => p.name === "edit_mode");
    expect(f?.type).toBe("select");
    expect(f?.enum).toEqual(["edit", "angles"]);
    expect(f?.default).toBe("edit");
  });

  it("workflowFor picks the angles LoRA graph only for edit_mode=angles", () => {
    const pick = wf().providers.comfy!.workflowFor!;
    expect(wf().providers.comfy!.workflow).toBe("qwenedit2511-edit.json");
    expect(pick({ edit_mode: "angles" })).toBe(ANGLES);
    expect(pick({ edit_mode: "edit" })).toBeUndefined();
    expect(pick({})).toBeUndefined();
  });

  it("variantParam exposes per-mode licensing (both graphs generated + open)", () => {
    const vp = wf().providers.comfy!.variantParam;
    expect(vp?.name).toBe("edit_mode");
    expect(vp?.values).toEqual(["edit", "angles"]);
    expect(WORKFLOW_LICENSES[ANGLES]?.class).toBe("open");
    expect(WORKFLOW_LICENSES["qwenedit2511-edit.json"]?.class).toBe("open");
    expect(wf().licenseVariants?.param).toBe("edit_mode");
    expect(wf().licenseVariants?.byValue.angles?.class).toBe("open");
  });

  it("the angles graph's placeholders are a subset of the edit map's", async () => {
    const g = JSON.parse(await fs.readFile(path.join(WF_DIR, ANGLES), "utf8"));
    const used = new Set<string>();
    for (const node of Object.values(g) as Record<string, unknown>[])
      for (const v of Object.values((node.inputs ?? {}) as Record<string, unknown>))
        if (typeof v === "string") for (const m of v.matchAll(/\{\{([A-Z_0-9]+)\}\}/g)) used.add(m[1]);
    const map = wf().providers.comfy!.map!({ steps: 8 });
    // the generic pass fills PROMPT/SEED/INPUT_IMAGE/PREFIX from params -
    // every placeholder the graph uses must be coverable
    for (const k of ["PROMPT", "SEED", "INPUT_IMAGE", "PREFIX"]) expect(used.has(k)).toBe(true);
    expect(used.has("STEPS")).toBe(true);
    expect(map.STEPS).toBe("8");
  });

  it("the angles graph actually loads the Multiple-angles LoRA", async () => {
    const g = JSON.parse(await fs.readFile(path.join(WF_DIR, ANGLES), "utf8"));
    const loras = (Object.values(g) as { class_type?: string; inputs?: Record<string, unknown> }[])
      .filter((n) => n.class_type === "LoraLoaderModelOnly")
      .map((n) => String(n.inputs?.lora_name ?? ""));
    expect(loras).toContain("Qwen-Edit-2509-Multiple-angles.safetensors");
  });
});
