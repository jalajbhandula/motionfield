import { promises as fs } from "fs";
import { chat } from "@/lib/llm/index";
import { filePathFor } from "@/lib/storage";
import type { StageScene } from "./scene";

/**
 * Ref descriptions - when the caller's LLM routing has a "vision" route,
 * each owned image ref is described in ≤60 words for the scene-writer's
 * brief. Non-image refs and vision failures degrade to "not previewed":
 * the ref still lands on the scene row, the note is the UI's cue that the
 * bytes weren't read.
 */

export interface StageRef { url: string; description?: string }

/**
 * Model-node srcs must point at a /files/….glb the CALLER owns - enforced
 * server-side against uploads/assets rows (the schema only checks the path
 * shape). Returns the list of unowned srcs, [] when clean.
 */
export async function unownedModelSrcs(scene: StageScene, userId: string): Promise<string[]> {
  const srcs = [...new Set(
    scene.nodes.filter((n) => n.kind === "model").map((n) => n.props.src),
  )];
  if (!srcs.length) return [];
  const { getDb, schema } = await import("@/db");
  const { and, eq, inArray } = await import("drizzle-orm");
  const db = await getDb();
  const up = await db.select({ url: schema.uploads.url }).from(schema.uploads)
    .where(and(eq(schema.uploads.userId, userId), inArray(schema.uploads.url, srcs)));
  const as = await db.select({ url: schema.assets.url }).from(schema.assets)
    .where(and(eq(schema.assets.userId, userId), inArray(schema.assets.url, srcs)));
  const owned = new Set([...up.map((r: { url: string }) => r.url), ...as.map((r: { url: string }) => r.url)]);
  return srcs.filter((s) => !owned.has(s));
}

export async function describeRefs(
  refs: { url: string; mime?: string | null }[],
  opts: { userId?: string; signal?: AbortSignal } = {},
): Promise<StageRef[]> {
  const out: StageRef[] = refs.map((r) => ({ url: r.url }));
  for (let i = 0; i < out.length; i++) {
    const mime = refs[i].mime ?? "";
    if (!mime.startsWith("image/")) continue;
    try {
      const fp = filePathFor(refs[i].url);
      if (!fp) continue; // path outside the /files root - nothing to read
      const bytes = await fs.readFile(fp);
      const res = await chat("vision", {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this reference image for a 3D scene-blocking brief - subject, arrangement, palette. ≤60 words, plain text." },
            { type: "image", mime, base64: bytes.toString("base64") },
          ],
        }],
        think: false,
        signal: opts.signal,
      }, { userId: opts.userId });
      const desc = res.text.trim().slice(0, 300);
      if (desc) out[i].description = desc;
    } catch {
      // unread refs stay attached - the page surfaces the note
    }
  }
  return out;
}
