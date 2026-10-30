import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { grantCredits } from "@/lib/credits";
import { JobError } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const code = String((await req.json()).code || "").trim().toUpperCase();
    const db = await getDb();
    const [promo] = await db.select().from(schema.promocodes).where(eq(schema.promocodes.code, code)).limit(1);
    if (!promo) throw new JobError("invalid code", 404);
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new JobError("code expired");
    if (promo.maxRedemptions && promo.redeemed >= promo.maxRedemptions) throw new JobError("code exhausted");
    const [used] = await db.select().from(schema.promocodeRedemptions)
      .where(eq(schema.promocodeRedemptions.code, code)).limit(1);
    // check this user hasn't redeemed
    const [mine] = await db.select().from(schema.promocodeRedemptions)
      .where(eq(schema.promocodeRedemptions.userId, user.id)).limit(1);
    if (used && mine) throw new JobError("already redeemed");
    if (mine) throw new JobError("already redeemed");
    await db.insert(schema.promocodeRedemptions).values({ code, userId: user.id });
    await db.update(schema.promocodes).set({ redeemed: promo.redeemed + 1 }).where(eq(schema.promocodes.code, code));
    if (Number(promo.credits) > 0)
      await grantCredits(user.id, Number(promo.credits), "purchase", "promocode", code, `Promo ${code}`);
    if (promo.planId) {
      await db.update(schema.profiles).set({ planId: promo.planId }).where(eq(schema.profiles.userId, user.id));
    }
    return json({ ok: true, credits: Number(promo.credits), plan: promo.planId });
  } catch (e) {
    return err(e);
  }
}
