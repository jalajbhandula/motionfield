import { z } from "zod";
import { ok, toolError, type ToolDef } from "../../registry.mts";

const Input = z.object({
  action: z.enum(["list", "get", "create"]),
  name: z.string().max(80).optional()
    .describe("the @ref name - slugifies to [a-z0-9-] ≤80 (get/create)"),
  category: z.enum(["character", "environment", "prop"]).optional()
    .describe("list filter; create default is character"),
  kind: z.enum(["person", "outfit", "prop", "place"]).optional()
    .describe("create only"),
  description: z.string().max(500).optional().describe("create only"),
  images: z.array(z.string().min(1)).min(1).max(10).optional()
    .describe("create only - 1-10 /files/ urls you own (upload or a job output)"),
  likeness_consent: z.boolean().optional()
    .describe("create only - required true for person/character refs"),
});

export default {
  name: "refs",
  toolset: "studio",
  capability: "refs",
  owner: "WS1 s6b",
  description:
    "Named @references - a subject/place/prop made of your own images, mentioned in briefs and " +
    "plans as @name (the planner fills media params with the ref's images). list{category?}, " +
    "get{name}, create{name, category?, kind?, description?, images[1-10], likeness_consent?} - " +
    "person/character needs consent:true; every image must be a /files/ url you own.",
  input: Input,
  async handler(args, ctx) {
    const a = Input.parse(args);
    switch (a.action) {
      case "list":
        return ok({ refs: await ctx.client.listRefs(a.category ? { category: a.category } : {}) });
      case "get": {
        if (!a.name) return toolError("invalid_params", "get needs name");
        return ok(await ctx.client.getRef(a.name.replace(/^@/, "")));
      }
      case "create": {
        if (!a.name) return toolError("invalid_params", "create needs name");
        if (!a.images?.length) return toolError("invalid_params", "create needs images - 1-10 /files/ urls you own");
        return ok(await ctx.client.createRef({
          name: a.name,
          ...(a.category !== undefined ? { category: a.category } : {}),
          ...(a.kind !== undefined ? { kind: a.kind } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          images: a.images,
          ...(a.likeness_consent !== undefined ? { likeness_consent: a.likeness_consent } : {}),
        }));
      }
    }
  },
} satisfies ToolDef;
