import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { getDb, schema, sql } from "@/db";
import { eq } from "drizzle-orm";
import { grantCredits } from "@/lib/credits";
import { PLANS, TOP_UP_PACKS, BOOST_PACKS, planById } from "@/lib/catalog/plans";
import { JobError } from "@/lib/jobs";
import { stripeEnabled, subscriptionCheckout, packCheckout } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * With STRIPE_SECRET_KEY set, returns a Checkout Session URL - fulfillment
 * happens in /api/stripe/webhook. Without keys, grants instantly (dev mode).
 */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const body = await req.json();
    const db = await getDb();
    const action = String(body.action);

    if (stripeEnabled()) {
      if (action === "subscribe") return json({ checkout_url: await subscriptionCheckout(user.id, user.email, String(body.plan_id), !!body.annual) });
      if (action === "topup" || action === "boost") return json({ checkout_url: await packCheckout(user.id, user.email, String(body.pack_id ?? body.boost_id)) });
    }

    if (action === "subscribe") {
      const plan = PLANS.find((p) => p.id === body.plan_id);
      if (!plan) throw new JobError("unknown plan");
      await db.update(schema.profiles)
        .set({ planId: plan.id, planRenewsAt: new Date(Date.now() + 30 * 86400_000), updatedAt: new Date() })
        .where(eq(schema.profiles.userId, user.id));
      if (plan.creditsPerMonth > 0)
        await grantCredits(user.id, plan.creditsPerMonth, "plan_grant", "plan", plan.id, `${plan.name} monthly credits`);
      return json({ ok: true, plan });
    }

    if (action === "topup") {
      const pack = TOP_UP_PACKS.find((p) => p.id === body.pack_id);
      if (!pack) throw new JobError("unknown pack");
      await grantCredits(user.id, pack.credits, "topup", "pack", pack.id, `${pack.credits} credit top-up`);
      return json({ ok: true, credits: pack.credits });
    }

    if (action === "boost") {
      const boost = BOOST_PACKS.find((b) => b.id === body.boost_id);
      if (!boost) throw new JobError("unknown boost pack");
      await sql(`UPDATE profiles SET boost_slots = boost_slots + $2 WHERE user_id = $1`, [user.id, boost.slots]);
      await grantCredits(user.id, boost.credits, "purchase", "boost", boost.id, `+${boost.slots} concurrency boost`);
      return json({ ok: true, boost });
    }

    if (action === "cancel_plan") {
      await db.update(schema.profiles).set({ planId: "free", planRenewsAt: null }).where(eq(schema.profiles.userId, user.id));
      return json({ ok: true, plan: planById("free") });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return err(e);
  }
}
