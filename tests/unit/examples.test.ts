import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FEATURE_EXAMPLES, PAGE_EXAMPLES, SKILL_EXAMPLES, exampleFor } from "@/lib/examples";
import { SKILLS } from "@/lib/catalog/skills";
import { IMAGE_MODELS } from "@/lib/catalog/image-models";
import { VIDEO_MODELS, AUDIO_MODELS } from "@/lib/catalog/video-models";

const pub = (u: string) => path.join(__dirname, "..", "..", "public", u);
const lists = { image: IMAGE_MODELS, video: VIDEO_MODELS, audio: AUDIO_MODELS };

describe("Try this example", () => {
  it.each(FEATURE_EXAMPLES.map((e) => [e.endpoint, e] as const))("%s - media, inputs and studio workflow exist", (_, e) => {
    expect(fs.existsSync(pub(e.media))).toBe(true);
    if (e.before) expect(fs.existsSync(pub(e.before))).toBe(true);
    for (const v of Object.values(e.inputs ?? {})) for (const f of [v].flat()) expect(fs.existsSync(pub(f))).toBe(true);
    if (e.tryHref) return; // its tool page loads the example itself
    const wf = lists[e.studio].flatMap((m) => m.workflows).find((w) => w.endpointId === e.endpoint);
    expect(wf, `${e.endpoint} is not a workflow in the ${e.studio} studio`).toBeTruthy();
    for (const k of [...Object.keys(e.params), ...Object.keys(e.inputs ?? {})])
      expect(wf!.params.map((p) => p.name), `${e.endpoint}: unknown param ${k}`).toContain(k);
  });
  it("every page example points at a shipped example", () => {
    for (const eps of Object.values(PAGE_EXAMPLES)) for (const ep of eps) expect(exampleFor(ep)).toBeTruthy();
  });
  it("every skill example is a real skill with shipped media", () => {
    for (const k of SKILL_EXAMPLES) {
      expect(SKILLS.some((s) => s.id === k.id), k.id).toBe(true);
      expect(fs.existsSync(pub(k.media)), k.media).toBe(true);
    }
  });
});
