import { describe, expect, it } from "vitest";
import { placeholders } from "@/lib/generation/comfy";
import { WAN_2_2 } from "@/lib/catalog/video/generate";
import fs from "node:fs";

describe("A14B requested clip duration", () => {
  for (const workflow of WAN_2_2.workflows.filter((w) => w.id.startsWith("a14b-"))) {
    it(`${workflow.id} sizes its latent for the graph's output frame rate`, () => {
      const graph = JSON.parse(fs.readFileSync(`workflows/${workflow.providers.comfy!.workflow}`, "utf8")) as Record<string, { class_type?: string; inputs?: { frame_rate?: number } }>;
      const output = Object.values(graph).find((node) => node.class_type === "VHS_VideoCombine");
      const rate = Number(output?.inputs?.frame_rate);
      expect(rate).toBe(16);
      for (const duration of [3, 5]) {
        const map = placeholders({ jobId: "a14b-test", workflow, params: { duration } } as never);
        expect(Math.abs(Number(map.FRAMES) / rate - duration)).toBeLessThanOrEqual(1 / rate);
      }
    });
  }
});
