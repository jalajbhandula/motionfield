/**
 * WS2 honesty checks for the skill catalog + shared agent defaults:
 *  - every skill step / intent / fallback endpoint exists and runs on a
 *    bundled workflow file or a recipe (no ghost endpoints);
 *  - step params only carry fields the endpoint declares, and select values
 *    sit inside the declared enum;
 *  - step cost equals the endpoint's own cost function;
 *  - default surfaces stay on open-license endpoints;
 *  - required media inputs are fillable from refSlots or earlier step outputs;
 *  - intake answers reach the params they're labeled for.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { SKILLS, SKILL_ALIASES, skillById } from "@/lib/catalog/skills";
import { findEndpoint } from "@/lib/catalog/video-models";
import { endpointLicense } from "@/lib/catalog/license-gate";
import { EP, INTENTS, fallbackPlanSteps } from "@/lib/agent-defaults";

const WF_DIR = path.join(process.cwd(), "workflows");
const BRIEF = "a test brief about a red sneaker";

function runnable(endpoint: string) {
  const found = findEndpoint(endpoint);
  return found;
}

describe("ws2 skills honesty", () => {
  it("every skill step endpoint exists and is runnable", async () => {
    const files = new Set(await fs.readdir(WF_DIR));
    for (const s of SKILLS) {
      for (const step of s.steps(BRIEF)) {
        const found = runnable(step.endpoint);
        expect(found, `${s.id} → ${step.endpoint}`).toBeTruthy();
        const wf = found!.workflow;
        const ok = !!wf.providers.recipe?.name || files.has(wf.providers.comfy?.workflow ?? "");
        expect(ok, `${s.id} step "${step.label}" - no bundled graph/recipe`).toBe(true);
      }
    }
  });

  it("step params only carry declared fields; selects fit the enum", () => {
    for (const s of SKILLS) {
      for (const step of s.steps(BRIEF)) {
        const wf = findEndpoint(step.endpoint)!.workflow;
        const declared = new Map(wf.params.map((f) => [f.name, f]));
        for (const [k, v] of Object.entries(step.params)) {
          const f = declared.get(k);
          expect(f, `${s.id}/${step.endpoint} sends undeclared param "${k}"`).toBeTruthy();
          if (Array.isArray(f!.enum) && f!.enum.length && v !== undefined && v !== null) {
            expect(f!.enum as unknown[], `${s.id}/${step.endpoint} param ${k}=${String(v)} not in enum`).toContain(v);
          }
        }
      }
    }
  });

  it("step cost matches the endpoint cost function", () => {
    for (const s of SKILLS) {
      for (const step of s.steps(BRIEF)) {
        const wf = findEndpoint(step.endpoint)!.workflow;
        expect(step.cost, `${s.id}/${step.label}`).toBe(wf.cost(step.params));
      }
    }
  });

  it("every skill step stays on an open-license endpoint", () => {
    for (const s of SKILLS) {
      for (const step of s.steps(BRIEF)) {
        const wf = findEndpoint(step.endpoint)!.workflow;
        const lic = endpointLicense(wf, step.params);
        expect(lic.class, `${s.id}/${step.endpoint} is ${lic.class}`).toBe("open");
      }
    }
  });

  it("required media params are fillable from refSlots or earlier step outputs", () => {
    const MEDIA = new Set(["image", "images", "video", "audio", "media"]);
    for (const s of SKILLS) {
      const produced = new Set<string>();
      for (const step of s.steps(BRIEF)) {
        const wf = findEndpoint(step.endpoint)!.workflow;
        for (const f of wf.params) {
          if (!f.required || !MEDIA.has(f.type) || step.params[f.name] != null) continue;
          const kind = f.type === "images" || f.type === "media" ? "image" : f.type;
          const hasRef = (s.refSlots ?? []).some((r) => r.accept.split(",").some((a) => a.startsWith(`${kind}/`)));
          expect(hasRef || produced.has(kind),
            `${s.id}/${step.endpoint} needs ${f.name} (${kind}) - no ref slot or prior ${kind} output`).toBe(true);
        }
        produced.add(["image", "edit", "upscale", "character", "threed"].includes(wf.kind) ? "image" : wf.kind === "audio" ? "audio" : "video");
      }
    }
  });

  it("intake answers reach the params they describe", () => {
    const explain = skillById("narrated-explainer")!;
    const s0 = explain.steps(BRIEF, { scenes: "5", voice: "Calm male (am_adam)", aspect: "9:16" });
    expect(s0[0].params.scenes).toBe(5);
    expect(s0[0].params.voice).toBe("am_adam");
    expect(s0[0].params.aspect_ratio).toBe("9:16");
    expect(s0[0].cost).toBe(3 + 5 * 5);

    const tp = skillById("talking-portrait")!;
    expect(tp.steps(BRIEF, { voice: "British male (bm_george)", line: "I am the walrus" })[0].params)
      .toMatchObject({ prompt: "I am the walrus", voice: "bm_george" });

    const lip = skillById("lip-sync-dub")!;
    // the consent intake gates the likeness-bearing endpoint - only an
    // explicit yes sends the flag (the fps select is gone: output follows
    // the source clip's frame rate via video_info)
    expect(lip.steps(BRIEF, { consent: "yes" })[0].params.likeness_consent).toBe(true);
    expect(lip.steps(BRIEF)[0].params.likeness_consent).toBeUndefined();

    const character = skillById("character-photoshoot")!;
    expect(character.steps(BRIEF, { count: "4" })[0].params.batch_size).toBe(4);
    expect(character.steps(BRIEF, { count: "3" })[0].params.batch_size).toBe(2); // snapped to nearest enum

    const head = skillById("headline-variants")!;
    expect(head.steps(BRIEF, { n: "5" })).toHaveLength(5);
  });

  it("ids are slugs of our own names; old ids resolve through the alias map", () => {
    for (const s of SKILLS) expect(s.id, s.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const [oldId, newId] of Object.entries(SKILL_ALIASES)) {
      const viaAlias = skillById(oldId);
      expect(viaAlias, `alias ${oldId}`).toBeTruthy();
      expect(viaAlias!.id).toBe(newId);
    }
    expect(skillById("explain")!.id).toBe("narrated-explainer");
    expect(skillById("scene-builder")!.id).toBe("set-dressing");
    // no id appears both live and aliased
    for (const oldId of Object.keys(SKILL_ALIASES)) {
      expect(SKILLS.find((s) => s.id === oldId), `old id "${oldId}" still live`).toBeUndefined();
    }
  });

  it("narration steps say what they read; Set Dressing names only its step", () => {
    const narrationSteps = SKILLS.flatMap((s) => s.steps(BRIEF)).filter((t) => t.readsScript);
    expect(narrationSteps.length).toBeGreaterThanOrEqual(2);
    for (const t of narrationSteps) {
      expect(t.label).toMatch(/reads your text/i);
      expect(t.endpoint).toBe("motionfield/kokoro/text-to-speech");
    }
    // Set Dressing is one animate step - the blurb must not promise a compose stage
    const sd = skillById("set-dressing")!;
    expect(sd.blurb).not.toMatch(/composite/i);
    expect(sd.steps(BRIEF)).toHaveLength(1);
  });
});

describe("ws2 shared agent defaults", () => {
  it("every EP constant resolves to a runnable endpoint", async () => {
    const files = new Set(await fs.readdir(WF_DIR));
    for (const [k, endpoint] of Object.entries(EP)) {
      const found = findEndpoint(endpoint);
      expect(found, `EP.${k} → ${endpoint}`).toBeTruthy();
      const wf = found!.workflow;
      expect(!!wf.providers.recipe?.name || files.has(wf.providers.comfy?.workflow ?? ""),
        `EP.${k} ${endpoint} has no runnable provider`).toBe(true);
    }
  });

  it("intents map to real endpoints with declared params only", () => {
    for (const intent of INTENTS) {
      const found = findEndpoint(intent.endpoint);
      expect(found, `intent "${intent.label}"`).toBeTruthy();
      const declared = new Map(found!.workflow.params.map((f) => [f.name, f]));
      for (const [k, v] of Object.entries(intent.params)) {
        const f = declared.get(k);
        expect(f, `${intent.label} sends undeclared param "${k}"`).toBeTruthy();
        if (Array.isArray(f!.enum) && f!.enum.length)
          expect(f!.enum as unknown[]).toContain(v);
      }
    }
  });

  it("video/image intents and the fallback plan use open-license defaults", () => {
    const video = INTENTS.find((i) => i.endpoint === EP.textToVideo)!;
    expect(EP.textToVideo).toBe("motionfield/wan-2.1/text-to-video");
    expect(endpointLicense(findEndpoint(EP.textToVideo)!.workflow).class).toBe("open");
    expect(endpointLicense(findEndpoint(EP.imageToVideo)!.workflow).class).toBe("open");
    expect(endpointLicense(findEndpoint(EP.textToImage)!.workflow).class).toBe("open");

    const videoSteps = fallbackPlanSteps("make a video about rockets");
    expect(videoSteps).toHaveLength(2);
    expect(videoSteps[1].endpoint).toBe(EP.imageToVideo);
    for (const st of videoSteps) {
      const wf = findEndpoint(st.endpoint)!.workflow;
      expect(endpointLicense(wf).class).toBe("open");
      expect(st.cost).toBe(wf.cost(st.params));
    }
    expect(fallbackPlanSteps("just an image please")).toHaveLength(1);
  });

  it("intent matching: generic video brief → wan-2.1 t2v (never ltx)", () => {
    const scored = INTENTS.map((i) => ({ i, m: i.re.exec("generate a video of a neon city at night") }))
      .filter((x) => !!x.m).sort((a, b) => a.m!.index - b.m!.index);
    expect(scored[0].i.endpoint).toBe(EP.textToVideo);
    expect(scored[0].i.endpoint).not.toContain("ltx");
  });
});
