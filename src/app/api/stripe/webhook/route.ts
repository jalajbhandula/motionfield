import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { stripe, applySubscription, fulfillPack, grantPlanCredits } from "@/lib/stripe";
import { getDb, sql } from "@/db";

export const runtime = "nodejs";

/**
 * Stripe webhook - REQUIRED for this integration.
 * Fulfillment lives here, not on the success page.
 * Handled: checkout.session.completed, checkout.session.async_payment_succeeded,
 * invoice.paid, invoice.payment_failed, customer.subscription.updated/deleted.
 */
export async function POST(req: NextRequest) {
  const s = stripe();
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !whSecret) return json({ error: "stripe not configured" }, 503);

  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  let event;
  try {
    event = await s.webhooks.constructEventAsync(payload, sig, whSecret);
  } catch (e) {
    return json({ error: `signature verification failed: ${e instanceof Error ? e.message : e}` }, 400);
  }

  // idempotency - skip already-processed events
  const db = await getDb();
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_events WHERE id = $1`, [event.id]);
  if (n > 0) return json({ received: true, deduped: true });
  await sql(`INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [event.id, event.type]);

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as {
          payment_status?: string; mode?: string;
          metadata?: Record<string, string>;
          subscription?: string | { id: string } | null;
        };
        if (session.payment_status === "unpaid") break; // delayed-notification methods: wait for async_payment_succeeded
        const userId = session.metadata?.motionfield_user_id;
        if (!userId) break;
        if (session.mode === "payment" && session.metadata?.pack_id) {
          await fulfillPack(userId, session.metadata.pack_id);
        } else if (session.mode === "subscription" && session.metadata?.plan_id) {
          const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
          await applySubscription(userId, session.metadata.plan_id, subId, null);
        }
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as {
          subscription?: string | { id: string } | null;
          parent?: { subscription_details?: { subscription?: string; metadata?: Record<string, string> } };
          lines?: { data: { metadata?: Record<string, string> }[] };
        };
        const subId = typeof inv.subscription === "string" ? inv.subscription
          : inv.subscription?.id ?? inv.parent?.subscription_details?.subscription ?? null;
        if (!subId) break;
        const sub = await s.subscriptions.retrieve(subId);
        const userId = sub.metadata?.motionfield_user_id;
        const planId = sub.metadata?.plan_id;
        if (userId && planId) {
          await grantPlanCredits(userId, planId, (event.data.object as { id: string }).id);
          const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
          await applySubscription(userId, planId, subId, periodEnd ? new Date(periodEnd * 1000) : null);
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as { subscription?: string | { id: string } | null };
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? null;
        if (!subId) break;
        const sub = await s.subscriptions.retrieve(subId);
        const userId = sub.metadata?.motionfield_user_id;
        if (userId) {
          const { notify } = await import("@/lib/jobs");
          await notify(userId, "system", "Payment failed - please update your payment method", undefined, "/me/settings");
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as { id: string; status: string; metadata?: Record<string, string>; cancel_at_period_end?: boolean; current_period_end?: number };
        const userId = sub.metadata?.motionfield_user_id;
        if (userId) {
          if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
            await applySubscription(userId, "free", null, null);
          } else if (sub.status === "active" || sub.status === "trialing") {
            await applySubscription(userId, sub.metadata?.plan_id ?? "free", sub.id,
              sub.current_period_end ? new Date(sub.current_period_end * 1000) : null);
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as { metadata?: Record<string, string> };
        const userId = sub.metadata?.motionfield_user_id;
        if (userId) await applySubscription(userId, "free", null, null);
        break;
      }
      default:
        break; // unhandled events acknowledged
    }
  } catch (e) {
    console.error("webhook handler error", e);
    return json({ error: "handler error" }, 500);
  }
  return json({ received: true });
}
