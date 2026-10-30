import { z } from "zod";
import type { Model } from "../../../../sdk-ts/src/index.ts";
import { ok, type ToolDef } from "../../registry.mts";

/** Lowercase word tokens - "wan-2.1/image-to-video" → [wan,2,1,image,to,video]. */
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** Deterministic `goal` ranking: count the distinct goal words that appear
 *  as tokens in the model's id, label or tags; ties break on the id. No LLM,
 *  no weights - same input, same order, every time. */
function rankByGoal(models: Model[], goal: string): Model[] {
  const want = new Set(words(goal));
  if (!want.size) return models;
  const scored = models.map((m) => {
    const have = new Set([
      ...words(m.id),
      ...words(m.label),
      ...m.tags.flatMap((t) => words(t)),
    ]);
    let score = 0;
    for (const w of want) if (have.has(w)) score++;
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id));
  return scored.map((s) => s.m);
}

const Input = z.object({
  kind: z.string().optional().describe("filter by job kind - image, video, audio, edit, upscale, character, v2v, avatar, threed"),
  goal: z.string().optional().describe("what you want to do in plain words - ranks endpoints by token overlap with id/label/tags"),
});

export default {
  name: "models_list",
  toolset: "core",
  capability: "models",
  description:
    "List the callable generation endpoints. Each entry carries its endpoint id, kind, license, " +
    "inputs JSON Schema and a credit estimate - these ids are what `generate` accepts. " +
    "`goal` re-ranks by plain word overlap with id/label/tags (deterministic, no LLM). " +
    "Restricted-license endpoints appear only after the account opts in.",
  input: Input,
  async handler(args, ctx) {
    const { kind, goal } = Input.parse(args);
    let models = await ctx.client.models();
    if (kind) models = models.filter((m) => m.kind === kind);
    if (goal) models = rankByGoal(models, goal);
    return ok({ models });
  },
} satisfies ToolDef;
