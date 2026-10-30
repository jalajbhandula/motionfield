import { z } from "zod";
import { ok, type ToolDef } from "../../registry.mts";

export default {
  name: "system_status",
  toolset: "core",
  capability: "system",
  description:
    "Deployment status plus the caller's account summary - queue depth of the account's " +
    "live jobs, machine-wide gpu.busy, tier, free disk, and {plan, credits}. Never returns " +
    "the API key.",
  input: z.object({}),
  async handler(_args, ctx) {
    const [system, me] = await Promise.all([ctx.client.system(), ctx.client.me()]);
    return ok({ system, account: { plan: me.plan, credits: me.credits } });
  },
} satisfies ToolDef;
