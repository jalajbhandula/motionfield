import { NextRequest } from "next/server";
import { json, err, apiUser } from "@/lib/api";
import { planById } from "@/lib/catalog/plans";
import { applyDailyCredits } from "@/lib/jobs";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { activeProviderName } from "@/lib/generation";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const ctx = await apiUser(req);
    if (!ctx) return json({ error: "unauthorized" }, 401);
    await applyDailyCredits(ctx.user.id);
    const db = await getDb();
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, ctx.user.id)).limit(1);
    return json({
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, image: ctx.user.image },
      profile, plan: planById(profile?.planId), provider: activeProviderName(),
    });
  } catch (e) {
    return err(e);
  }
}
