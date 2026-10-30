import Stripe from "stripe";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { PLANS, TOP_UP_PACKS, BOOST_PACKS } from "@/lib/catalog/plans";
import { grantCredits } from "@/lib/credits";

const g = globalThis as unknown as { __ofStripe?: Stripe };

export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!g.__ofStripe) g.__ofStripe = new Stripe(key);
  return g.__ofStripe;
}

export const stripeEnabled = () => !!process.env.STRIPE_SECRET_KEY;

const appUrl = () => process.env.PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000";

/** Find-or-create the Stripe customer for a user. */
async function customerFor(userId: string, email: string): Promise<string> {
  const db = await getDb();
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  if (p?.stripeCustomerId) return p.stripeCustomerId;
  const s = stripe()!;
  const customer = await s.customers.create({ email, metadata: { motionfield_user_id: userId } });
  await db.update(schema.profiles).set({ stripeCustomerId: customer.id }).where(eq(schema.profiles.userId, userId));
  return customer.id;
}

const label8 = () => `of_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Subscription checkout - one Stripe Product per plan; monthly & annual are
 * two Prices on that Product (per Stripe guidance). Price IDs come from env:
 *   STRIPE_PRICE_BASIC_MONTHLY / _ANNUAL, STRIPE_PRICE_PRO_*, STRIPE_PRICE_MAX_*
 * If price IDs aren't configured, we create ad-hoc price_data on a per-plan
 * product resolved via STRIPE_PRODUCT_<PLAN> or auto-created once.
 */
export async function subscriptionCheckout(userId: string, email: string, planId: string, annual: boolean) {
  const s = stripe();
  if (!s) throw new Error("stripe not configured");
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan || plan.tier === 0) throw new Error("unknown paid plan");

  const envKey = `STRIPE_PRICE_${planId.toUpperCase()}_${annual ? "ANNUAL" : "MONTHLY"}`;
  const priceId = process.env[envKey];
  const customer = await customerFor(userId, email);

  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round((annual ? plan.annualMonthlyPrice : plan.monthlyPrice) * 100) * (annual ? 12 : 1),
          recurring: { interval: (annual ? "year" : "month") as "year" | "month" },
          product_data: { name: `MotionField ${plan.name}`, metadata: { plan_id: plan.id } },
        },
      };

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    integration_identifier: label8(),
    line_items: [lineItem],
    success_url: `${appUrl()}/me/settings?checkout=success&plan=${plan.id}`,
    cancel_url: `${appUrl()}/pricing`,
    subscription_data: { metadata: { motionfield_user_id: userId, plan_id: plan.id } },
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "true" },
  });
  return session.url!;
}

export async function packCheckout(userId: string, email: string, packId: string) {
  const s = stripe();
  if (!s) throw new Error("stripe not configured");
  const pack = TOP_UP_PACKS.find((p) => p.id === packId) ?? BOOST_PACKS.find((b) => b.id === packId);
  if (!pack) throw new Error("unknown pack");
  const customer = await customerFor(userId, email);
  const isBoost = "slots" in pack;
  const session = await s.checkout.sessions.create({
    mode: "payment",
    customer,
    integration_identifier: label8(),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: Math.round(pack.price * 100),
        product_data: { name: isBoost ? `Concurrency boost +${(pack as { slots: number }).slots}` : `${pack.credits} credits`, metadata: { pack_id: pack.id } },
      },
    }],
    success_url: `${appUrl()}/me/settings?checkout=success`,
    cancel_url: `${appUrl()}/pricing`,
    metadata: { motionfield_user_id: userId, pack_id: pack.id },
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "true" },
  });
  return session.url!;
}

export async function portalSession(userId: string, email: string) {
  const s = stripe();
  if (!s) throw new Error("stripe not configured");
  const customer = await customerFor(userId, email);
  const session = await s.billingPortal.sessions.create({
    customer,
    return_url: `${appUrl()}/me/settings`,
  });
  return session.url;
}

/* ---------- webhook fulfillment ---------- */

export async function applySubscription(userId: string, planId: string, subscriptionId: string | null, renewsAt: Date | null) {
  const db = await getDb();
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) return;
  await db.update(schema.profiles)
    .set({ planId: plan.id, planRenewsAt: renewsAt, stripeSubscriptionId: subscriptionId, updatedAt: new Date() })
    .where(eq(schema.profiles.userId, userId));
}

export async function fulfillPack(userId: string, packId: string) {
  const db = await getDb();
  const pack = TOP_UP_PACKS.find((p) => p.id === packId);
  if (pack) {
    await grantCredits(userId, pack.credits, "topup", "stripe_pack", pack.id, `${pack.credits} credit top-up`);
    return;
  }
  const boost = BOOST_PACKS.find((b) => b.id === packId);
  if (boost) {
    await (await import("@/db")).sql(`UPDATE profiles SET boost_slots = boost_slots + $2 WHERE user_id = $1`, [userId, boost.slots]);
    await grantCredits(userId, boost.credits, "purchase", "stripe_boost", boost.id, `+${boost.slots} concurrency boost`);
  }
}

export async function grantPlanCredits(userId: string, planId: string, invoiceId: string) {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan || plan.creditsPerMonth <= 0) return;
  // idempotent per invoice
  const { sql } = await import("@/db");
  const [{ n }] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM credit_ledger WHERE ref_type='stripe_invoice' AND ref_id=$1`, [invoiceId]);
  if (n > 0) return;
  await grantCredits(userId, plan.creditsPerMonth, "plan_grant", "stripe_invoice", invoiceId, `${plan.name} credits`);
}
