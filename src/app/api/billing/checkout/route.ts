import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { stripeEnabled, subscriptionCheckout, packCheckout, portalSession } from "@/lib/stripe";

export const runtime = "nodejs";

/** POST {type: "subscription"|"pack"|"portal", plan_id?, pack_id?, annual?} → {url} */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    if (!stripeEnabled()) return json({ error: "stripe not configured", stripe: false }, 503);
    const body = await req.json();
    let url: string;
    if (body.type === "portal") url = await portalSession(user.id, user.email);
    else if (body.type === "subscription") url = await subscriptionCheckout(user.id, user.email, String(body.plan_id), !!body.annual);
    else url = await packCheckout(user.id, user.email, String(body.pack_id));
    return json({ url });
  } catch (e) {
    return err(e);
  }
}
