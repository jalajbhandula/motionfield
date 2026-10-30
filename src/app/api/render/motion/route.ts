import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import {
  buildMotionSpec,
  generateMotionSpec,
  motionFormatSchema,
  NeedsLlm,
  templateDraft,
  writerReady,
} from "@/lib/render/generate";
import { motionTemplateById } from "@/lib/render/templates";
import { fetchBrandContext, type BrandContext } from "@/lib/render/brand";
import type { SceneSpec } from "@/lib/render/spec";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  // optional: the no-LLM template path doesn't need one
  prompt: z.string().max(4000).optional(),
  template_id: z.string().max(80).optional(),
  url: z.url().max(2000).optional(),
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  duration: z.number().min(2).max(30).optional(),
});

const titleOf = (prompt: string) =>
  (prompt.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 80) || "motion").replace(/\.+$/, "");

const NEEDS_LLM_BODY = {
  code: "NEEDS_LLM",
  error: "spec-writing LLM isn't configured (set LLM_* or pick a provider in Settings)",
} as const;

/** one budget over the whole request: client disconnect OR 5 min, whichever first */
const requestBudget = (req: NextRequest) =>
  AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]);

/**
 * POST /api/render/motion - prompt (+ optional website URL for brand
 * context, optional template) → SceneSpec → stored row.
 *
 * - LLM on (env or the user's Settings provider): generateMotionSpec writes
 *   the draft through the "writer" route with think off; a brand URL is
 *   fetched first and stored on the row for refine.
 * - LLM off + template: deterministic path - buildMotionSpec over the
 *   template's time-rescaled draft; the brand URL is never fetched.
 * - LLM off + no template: 503 NEEDS_LLM before anything is fetched.
 * Everything downstream shares one 5-minute budget signal.
 */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "bad body" }, 400);
    const body = parsed.data;
    const prompt = (body.prompt ?? "").trim();

    const format = motionFormatSchema.parse({
      aspect: body.aspect ?? "16:9",
      resolution: body.resolution ?? "720p",
      fps: body.fps ?? 24,
      duration: body.duration ?? 4,
    });

    const tpl = body.template_id ? motionTemplateById(body.template_id) : null;
    if (body.template_id && !tpl) return json({ error: "unknown template_id" }, 400);

    // a provider set in Settings must work - per-user route beats env-only llmOn()
    const llmReady = await writerReady(user.id);
    const budget = requestBudget(req);

    let spec: SceneSpec;
    let brand: BrandContext | undefined;
    // a template with no prompt is the deterministic path even when an LLM is set up
    if (!llmReady || (tpl && !prompt)) {
      if (!tpl) return json(NEEDS_LLM_BODY, 503); // before any fetch
      spec = buildMotionSpec(format, templateDraft(tpl, format.duration));
    } else {
      if (!prompt) return json({ error: "prompt is required" }, 400);
      if (body.url) {
        try {
          brand = await fetchBrandContext(body.url, { signal: budget });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "can't fetch that URL" }, 400);
        }
      }
      try {
        spec = await generateMotionSpec({
          prompt, brand, templateId: tpl?.id, format, signal: budget, userId: user.id,
        });
      } catch (e) {
        if (e instanceof NeedsLlm) return json(NEEDS_LLM_BODY, 503);
        return json({ error: e instanceof Error ? e.message : "spec generation failed" }, 502);
      }
    }

    const db = await getDb();
    const [row] = await db.insert(schema.renderSpecs).values({
      userId: user.id,
      spec,
      title: prompt ? titleOf(prompt) : (tpl?.label ?? "motion"),
      prompt: prompt || null,
      sourceUrl: body.url ?? null,
      brand: brand ?? null,
      parentId: null,
    }).returning({ id: schema.renderSpecs.id });
    return json({ id: row.id, spec }, 201);
  } catch (e) {
    return err(e);
  }
}
