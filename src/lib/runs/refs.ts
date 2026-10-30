import { JobError } from "@/lib/jobs";
import { refByName } from "@/lib/agent/tools/refs";
import type { Plan } from "./plan";

/**
 * "@<ref-name>" values in plan media params. A whole string value "@name" or
 * an array item "@name" resolves to the caller's own elements row - the
 * ref's first image fills the param. Unknown or another user's name refuses
 * (the session path asks "no ref named @x" before ever posting a plan; a
 * literal POST /runs gets the plain 422 here). Prompt text keeps @tokens
 * literal - only whole-value params resolve.
 */

/** The slug shape the refs API actually writes ([a-z0-9-], ≤80 chars) -
 *  keeping this in sync means a name the API accepts always resolves here. */
const REF_TOKEN = /^@([a-z0-9][a-z0-9-]{0,79})$/i;

/** Collect the @names a plan's param values name (strings + array items). */
export function planRefNames(plan: Plan): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = REF_TOKEN.exec(v);
      if (m) out.add(m[1].toLowerCase());
      return;
    }
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const s of plan.steps) visit(s.params);
  return [...out];
}

/** Resolve every @name against the caller's refs and rewrite the params.
 *  A missing name or an image-less ref refuses with plain wording. */
export async function resolveAtRefs(userId: string, plan: Plan): Promise<Plan> {
  const names = planRefNames(plan);
  if (!names.length) return plan;

  const byName = new Map<string, string>(); // name → image url
  for (const name of names) {
    const ref = await refByName(userId, name);
    if (!ref) throw new JobError(`no ref named @${name} - create it under Refs first`, 422);
    // only a stored /files/ image may fill a job's media param - a ref row
    // pointing anywhere else never reaches the provider
    const image = ref.images.find((u) => u.startsWith("/files/"));
    if (!image) throw new JobError(`ref @${name} has no stored images`, 422);
    byName.set(name, image);
  }

  const rewriteParams = (p: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(p).map(([k, x]) => [k, rewrite(x)]));
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = REF_TOKEN.exec(v);
      return m ? byName.get(m[1].toLowerCase()) ?? v : v;
    }
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    }
    return v;
  };

  return {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s, params: rewriteParams(s.params) })),
  };
}
